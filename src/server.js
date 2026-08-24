import express from 'express';
import helmet from 'helmet';
import cron from 'node-cron';
import path from 'node:path';
import db from './db.js';
import { runFullScan } from './scraper.js';

const app = express();
const port = Number(process.env.PORT || 3000);
let scanState = { running: false, startedAt: null, finishedAt: null, lastResult: null, progress: null, error: null };

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));

const password = process.env.APP_PASSWORD;
if (password) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization || '';
    const [type, token] = auth.split(' ');
    if (type === 'Basic' && token) {
      const raw = Buffer.from(token, 'base64').toString();
      const [, p] = raw.split(':');
      if (p === password) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="KDV Radar"');
    res.status(401).send('Yetkilendirme gerekli');
  });
}

app.use(express.static(path.resolve('public')));

function dateOffset(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year:'numeric', month:'2-digit', day:'2-digit' }).format(d);
}

app.get('/api/health', (_, res) => res.json({ ok: true, scanState }));
app.get('/api/categories', (_, res) => res.json(db.prepare('SELECT * FROM categories ORDER BY name').all()));

app.post('/api/categories', (req, res) => {
  const b = req.body || {};
  const info = db.prepare(`INSERT INTO categories(name,trendyol_url,vat_rate,base_commission,enabled,max_pages,exclude_keywords,note)
    VALUES(?,?,?,?,?,?,?,?)`).run(b.name, b.trendyol_url, Number(b.vat_rate ?? 1), b.base_commission === '' ? null : Number(b.base_commission), b.enabled ? 1 : 0, Number(b.max_pages || 0), b.exclude_keywords || '', b.note || '');
  res.json({ id: info.lastInsertRowid });
});

app.put('/api/categories/:id', (req, res) => {
  const b = req.body || {};
  db.prepare(`UPDATE categories SET name=?,trendyol_url=?,vat_rate=?,base_commission=?,enabled=?,max_pages=?,exclude_keywords=?,note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(b.name, b.trendyol_url, Number(b.vat_rate ?? 1), b.base_commission === '' ? null : Number(b.base_commission), b.enabled ? 1 : 0, Number(b.max_pages || 0), b.exclude_keywords || '', b.note || '', Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/categories/:id', (req, res) => {
  db.prepare('DELETE FROM categories WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/api/products', (req, res) => {
  const { q='', category='', minPrice='', maxPrice='', minD1='', minD7='', minD15='', minD30='', sort='d30', dir='desc', limit='500' } = req.query;
  const targets = { d1: dateOffset(1), d7: dateOffset(7), d15: dateOffset(15), d30: dateOffset(30) };
  const params = [targets.d1, targets.d7, targets.d15, targets.d30];
  const wh = ['p.active=1'];
  if (q) { wh.push('(p.name LIKE ? OR p.brand LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (category) { wh.push('c.id=?'); params.push(Number(category)); }
  if (minPrice) { wh.push('s.price>=?'); params.push(Number(minPrice)); }
  if (maxPrice) { wh.push('s.price<=?'); params.push(Number(maxPrice)); }
  if (minD1) { wh.push('(s.rating_count-s1.rating_count)>=?'); params.push(Number(minD1)); }
  if (minD7) { wh.push('(s.rating_count-s7.rating_count)>=?'); params.push(Number(minD7)); }
  if (minD15) { wh.push('(s.rating_count-s15.rating_count)>=?'); params.push(Number(minD15)); }
  if (minD30) { wh.push('(s.rating_count-s30.rating_count)>=?'); params.push(Number(minD30)); }
  const sortMap = { price:'s.price', rating:'s.rating_count', d1:'d1', d7:'d7', d15:'d15', d30:'d30', sellers:'s.seller_count', name:'p.name' };
  const order = sortMap[sort] || 'd30';
  const direction = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const sql = `
    WITH latest AS (SELECT product_id, MAX(scan_date) scan_date FROM snapshots GROUP BY product_id)
    SELECT p.id,p.trendyol_product_id,p.name,p.brand,p.url,p.last_error,c.name category,c.vat_rate,c.base_commission,
           s.scan_date,s.rating_count,s.review_count,s.price,s.seller_count,s.available,
           CASE WHEN s1.rating_count IS NULL OR s.rating_count IS NULL THEN NULL ELSE s.rating_count-s1.rating_count END d1,
           CASE WHEN s7.rating_count IS NULL OR s.rating_count IS NULL THEN NULL ELSE s.rating_count-s7.rating_count END d7,
           CASE WHEN s15.rating_count IS NULL OR s.rating_count IS NULL THEN NULL ELSE s.rating_count-s15.rating_count END d15,
           CASE WHEN s30.rating_count IS NULL OR s.rating_count IS NULL THEN NULL ELSE s.rating_count-s30.rating_count END d30
    FROM products p
    JOIN categories c ON c.id=p.category_id
    LEFT JOIN latest l ON l.product_id=p.id
    LEFT JOIN snapshots s ON s.product_id=p.id AND s.scan_date=l.scan_date
    LEFT JOIN snapshots s1 ON s1.product_id=p.id AND s1.scan_date=?
    LEFT JOIN snapshots s7 ON s7.product_id=p.id AND s7.scan_date=?
    LEFT JOIN snapshots s15 ON s15.product_id=p.id AND s15.scan_date=?
    LEFT JOIN snapshots s30 ON s30.product_id=p.id AND s30.scan_date=?
    WHERE ${wh.join(' AND ')}
    ORDER BY ${order} ${direction}, p.id DESC
    LIMIT ${Math.min(5000, Math.max(1, Number(limit)||500))}
  `;
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/stats', (_, res) => {
  const total = db.prepare('SELECT COUNT(*) n FROM products WHERE active=1').get().n;
  const scannedToday = db.prepare("SELECT COUNT(*) n FROM snapshots WHERE scan_date=date('now','+3 hours')").get().n;
  const cats = db.prepare('SELECT COUNT(*) n FROM categories WHERE enabled=1').get().n;
  res.json({ totalProducts: total, scannedToday, enabledCategories: cats, scanState });
});

async function triggerScan(discover=true) {
  if (scanState.running) return false;
  scanState = { running:true, startedAt:new Date().toISOString(), finishedAt:null, lastResult:null, progress:null, error:null };
  (async () => {
    try {
      const result = await runFullScan({ discover, onProgress: p => scanState.progress = p });
      scanState.lastResult = result;
    } catch (e) {
      scanState.error = e.message;
    } finally {
      scanState.running = false;
      scanState.finishedAt = new Date().toISOString();
    }
  })();
  return true;
}

app.post('/api/scan', async (req, res) => {
  const ok = await triggerScan(req.body?.discover !== false);
  if (!ok) return res.status(409).json({ error:'Tarama zaten çalışıyor' });
  res.json({ ok:true });
});

// Daily at 03:10 Istanbul. Conservative single-process scan; 429 stops the run.
cron.schedule(process.env.CRON_SCHEDULE || '10 3 * * *', () => triggerScan(true), { timezone:'Europe/Istanbul' });

app.use((_, res) => res.sendFile(path.resolve('public/index.html')));
app.listen(port, () => console.log(`KDV Radar http://0.0.0.0:${port}`));
