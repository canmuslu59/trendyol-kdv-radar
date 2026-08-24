import express from 'express';
import helmet from 'helmet';
import cron from 'node-cron';
import path from 'node:path';
import db from './db.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const agentSecret = process.env.AGENT_TOKEN || process.env.APP_PASSWORD || '';

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '4mb' }));

function nowIso(){ return new Date().toISOString(); }
function todayIstanbul() {
  return new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Istanbul', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
}
function setSetting(key,value){
  db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key,String(value));
}
function getSetting(key){ return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value ?? null; }
function agentAuthorized(req){
  if (!agentSecret) return false;
  const token = req.get('x-agent-token') || '';
  return token === agentSecret;
}
function currentJob(){
  return db.prepare(`SELECT * FROM agent_jobs WHERE status IN ('pending','running') ORDER BY id DESC LIMIT 1`).get() || null;
}
function lastJob(){ return db.prepare(`SELECT * FROM agent_jobs ORDER BY id DESC LIMIT 1`).get() || null; }
function parseJson(s,fallback=null){ try{return s?JSON.parse(s):fallback}catch{return fallback} }
function agentOnline(){
  const last=getSetting('agent_last_seen');
  if(!last) return false;
  const t=Date.parse(last); return Number.isFinite(t) && Date.now()-t < 120000;
}

// --- Local Chrome agent API. Intentionally before dashboard Basic Auth. ---
app.use('/api/agent', (req,res,next) => {
  if (!agentAuthorized(req)) return res.status(401).json({error:'Geçersiz ajan anahtarı'});
  next();
});

app.post('/api/agent/heartbeat', (req,res) => {
  setSetting('agent_last_seen', nowIso());
  if (req.body?.version) setSetting('agent_version', req.body.version);
  if (req.body?.browser) setSetting('agent_browser', req.body.browser);
  res.json({ok:true, serverTime:nowIso()});
});

app.get('/api/agent/job', (req,res) => {
  setSetting('agent_last_seen', nowIso());
  let job = db.prepare(`SELECT * FROM agent_jobs WHERE status='running' ORDER BY id DESC LIMIT 1`).get();
  if (!job) {
    const pending = db.prepare(`SELECT * FROM agent_jobs WHERE status='pending' ORDER BY id ASC LIMIT 1`).get();
    if (pending) {
      db.prepare(`UPDATE agent_jobs SET status='running',started_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`).run(pending.id);
      job = db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(pending.id);
    }
  }
  if (!job) return res.json({job:null});
  const categories = db.prepare('SELECT * FROM categories WHERE enabled=1 ORDER BY id').all();
  res.json({
    job:{id:job.id,status:job.status,requestedAt:job.requested_at},
    categories:categories.map(c=>({
      id:c.id,name:c.name,trendyol_url:c.trendyol_url,vat_rate:c.vat_rate,base_commission:c.base_commission,
      max_pages:c.max_pages,exclude_keywords:c.exclude_keywords
    }))
  });
});

function excluded(category,text){
  const words=String(category.exclude_keywords||'').split('|').map(x=>x.trim().toLocaleLowerCase('tr-TR')).filter(Boolean);
  const hay=String(text||'').toLocaleLowerCase('tr-TR');
  return words.some(w=>hay.includes(w));
}
function saveAgentProduct(category, data){
  if(!data?.trendyolProductId || !data?.url) return {skipped:true};
  if(excluded(category,`${data.name||''} ${data.brand||''}`)) return {excluded:true};
  db.prepare(`INSERT INTO products(trendyol_product_id,category_id,name,brand,url,active,last_seen_at,last_error)
    VALUES(?,?,?,?,?,1,CURRENT_TIMESTAMP,NULL)
    ON CONFLICT(trendyol_product_id) DO UPDATE SET category_id=excluded.category_id,name=excluded.name,brand=excluded.brand,url=excluded.url,active=1,last_seen_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP`)
    .run(String(data.trendyolProductId),category.id,String(data.name||`Trendyol Ürün ${data.trendyolProductId}`),data.brand||null,String(data.url));
  const product=db.prepare('SELECT id FROM products WHERE trendyol_product_id=?').get(String(data.trendyolProductId));
  db.prepare(`INSERT INTO snapshots(product_id,scan_date,rating_count,review_count,price,seller_count,available,raw_note)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(product_id,scan_date) DO UPDATE SET scanned_at=CURRENT_TIMESTAMP,rating_count=excluded.rating_count,review_count=excluded.review_count,price=excluded.price,seller_count=excluded.seller_count,available=excluded.available,raw_note=excluded.raw_note`)
    .run(product.id,todayIstanbul(),data.ratingCount??null,data.reviewCount??null,data.price??null,data.sellerCount??null,data.available===false?0:1,'chrome-agent-v6');
  return {saved:true};
}

app.post('/api/agent/upload', (req,res) => {
  setSetting('agent_last_seen', nowIso());
  const {jobId,categoryId,page,products=[]} = req.body || {};
  const job=db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(Number(jobId));
  if(!job || !['running','pending'].includes(job.status)) return res.status(409).json({error:'Aktif iş bulunamadı'});
  const category=db.prepare('SELECT * FROM categories WHERE id=?').get(Number(categoryId));
  if(!category) return res.status(400).json({error:'Kategori bulunamadı'});
  let saved=0,excludedCount=0;
  const tx=db.transaction(()=>{
    for(const p of Array.isArray(products)?products:[]){
      const r=saveAgentProduct(category,p);
      if(r.saved) saved++; else if(r.excluded) excludedCount++;
    }
  });
  tx();
  const progress={category:category.name,page:Number(page)||1,saved,lastBatch:Array.isArray(products)?products.length:0,at:nowIso()};
  db.prepare(`UPDATE agent_jobs SET progress_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(JSON.stringify(progress),job.id);
  res.json({ok:true,saved,excluded:excludedCount});
});

app.post('/api/agent/complete', (req,res) => {
  setSetting('agent_last_seen', nowIso());
  const {jobId,result={}}=req.body||{};
  db.prepare(`UPDATE agent_jobs SET status='completed',finished_at=CURRENT_TIMESTAMP,result_json=?,error=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(JSON.stringify(result),Number(jobId));
  res.json({ok:true});
});
app.post('/api/agent/fail', (req,res) => {
  setSetting('agent_last_seen', nowIso());
  const {jobId,error='Ajan taraması başarısız'}=req.body||{};
  db.prepare(`UPDATE agent_jobs SET status='failed',finished_at=CURRENT_TIMESTAMP,error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(String(error).slice(0,4000),Number(jobId));
  res.json({ok:true});
});

// --- Dashboard auth ---
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
  const d = new Date(); d.setUTCDate(d.getUTCDate() - days);
  return new Intl.DateTimeFormat('en-CA', { timeZone:'Europe/Istanbul', year:'numeric', month:'2-digit', day:'2-digit' }).format(d);
}

app.get('/api/health', (_,res)=>res.json({ok:true,agentOnline:agentOnline()}));
app.get('/api/categories', (_, res) => res.json(db.prepare('SELECT * FROM categories ORDER BY name').all()));
app.post('/api/categories', (req,res)=>{
  const b=req.body||{};
  const info=db.prepare(`INSERT INTO categories(name,trendyol_url,vat_rate,base_commission,enabled,max_pages,exclude_keywords,note) VALUES(?,?,?,?,?,?,?,?)`)
    .run(b.name,b.trendyol_url,Number(b.vat_rate??1),b.base_commission===''?null:Number(b.base_commission),b.enabled?1:0,Number(b.max_pages||0),b.exclude_keywords||'',b.note||'');
  res.json({id:info.lastInsertRowid});
});
app.put('/api/categories/:id',(req,res)=>{
  const b=req.body||{};
  db.prepare(`UPDATE categories SET name=?,trendyol_url=?,vat_rate=?,base_commission=?,enabled=?,max_pages=?,exclude_keywords=?,note=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(b.name,b.trendyol_url,Number(b.vat_rate??1),b.base_commission===''?null:Number(b.base_commission),b.enabled?1:0,Number(b.max_pages||0),b.exclude_keywords||'',b.note||'',Number(req.params.id));
  res.json({ok:true});
});
app.delete('/api/categories/:id',(req,res)=>{db.prepare('DELETE FROM categories WHERE id=?').run(Number(req.params.id));res.json({ok:true})});

app.get('/api/products',(req,res)=>{
  const {q='',category='',minPrice='',maxPrice='',minD1='',minD7='',minD15='',minD30='',sort='d30',dir='desc',limit='500'}=req.query;
  const targets={d1:dateOffset(1),d7:dateOffset(7),d15:dateOffset(15),d30:dateOffset(30)};
  const params=[targets.d1,targets.d7,targets.d15,targets.d30]; const wh=['p.active=1'];
  if(q){wh.push('(p.name LIKE ? OR p.brand LIKE ?)');params.push(`%${q}%`,`%${q}%`)}
  if(category){wh.push('c.id=?');params.push(Number(category))}
  if(minPrice){wh.push('s.price>=?');params.push(Number(minPrice))} if(maxPrice){wh.push('s.price<=?');params.push(Number(maxPrice))}
  if(minD1){wh.push('(s.rating_count-s1.rating_count)>=?');params.push(Number(minD1))} if(minD7){wh.push('(s.rating_count-s7.rating_count)>=?');params.push(Number(minD7))}
  if(minD15){wh.push('(s.rating_count-s15.rating_count)>=?');params.push(Number(minD15))} if(minD30){wh.push('(s.rating_count-s30.rating_count)>=?');params.push(Number(minD30))}
  const sortMap={price:'s.price',rating:'s.rating_count',d1:'d1',d7:'d7',d15:'d15',d30:'d30',sellers:'s.seller_count',name:'p.name'};
  const order=sortMap[sort]||'d30',direction=String(dir).toLowerCase()==='asc'?'ASC':'DESC';
  const sql=`WITH latest AS (SELECT product_id,MAX(scan_date) scan_date FROM snapshots GROUP BY product_id)
    SELECT p.id,p.trendyol_product_id,p.name,p.brand,p.url,p.last_error,c.name category,c.vat_rate,c.base_commission,
      s.scan_date,s.rating_count,s.review_count,s.price,s.seller_count,s.available,
      CASE WHEN s1.rating_count IS NULL OR s.rating_count IS NULL THEN NULL ELSE s.rating_count-s1.rating_count END d1,
      CASE WHEN s7.rating_count IS NULL OR s.rating_count IS NULL THEN NULL ELSE s.rating_count-s7.rating_count END d7,
      CASE WHEN s15.rating_count IS NULL OR s.rating_count IS NULL THEN NULL ELSE s.rating_count-s15.rating_count END d15,
      CASE WHEN s30.rating_count IS NULL OR s.rating_count IS NULL THEN NULL ELSE s.rating_count-s30.rating_count END d30
    FROM products p JOIN categories c ON c.id=p.category_id
    LEFT JOIN latest l ON l.product_id=p.id LEFT JOIN snapshots s ON s.product_id=p.id AND s.scan_date=l.scan_date
    LEFT JOIN snapshots s1 ON s1.product_id=p.id AND s1.scan_date=? LEFT JOIN snapshots s7 ON s7.product_id=p.id AND s7.scan_date=?
    LEFT JOIN snapshots s15 ON s15.product_id=p.id AND s15.scan_date=? LEFT JOIN snapshots s30 ON s30.product_id=p.id AND s30.scan_date=?
    WHERE ${wh.join(' AND ')} ORDER BY ${order} ${direction},p.id DESC LIMIT ${Math.min(5000,Math.max(1,Number(limit)||500))}`;
  res.json(db.prepare(sql).all(...params));
});

function publicScanState(){
  const job=currentJob() || lastJob();
  if(!job) return {running:false,startedAt:null,finishedAt:null,lastResult:null,progress:null,error:null,mode:'local-chrome-agent'};
  const running=['pending','running'].includes(job.status);
  const result=parseJson(job.result_json,null);
  const progress=parseJson(job.progress_json,null);
  return {running,startedAt:job.started_at||job.requested_at,finishedAt:job.finished_at,lastResult:result,progress,error:job.error||null,status:job.status,mode:'local-chrome-agent'};
}
app.get('/api/stats',(_,res)=>{
  const total=db.prepare('SELECT COUNT(*) n FROM products WHERE active=1').get().n;
  const scannedToday=db.prepare("SELECT COUNT(*) n FROM snapshots WHERE scan_date=date('now','+3 hours')").get().n;
  const cats=db.prepare('SELECT COUNT(*) n FROM categories WHERE enabled=1').get().n;
  res.json({totalProducts:total,scannedToday,enabledCategories:cats,scanState:publicScanState(),agent:{online:agentOnline(),lastSeen:getSetting('agent_last_seen'),version:getSetting('agent_version')}});
});

function enqueueAgentJob(source='manual'){
  const existing=currentJob(); if(existing) return {created:false,job:existing};
  const info=db.prepare(`INSERT INTO agent_jobs(status,source,requested_at,updated_at) VALUES('pending',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).run(source);
  return {created:true,job:db.prepare('SELECT * FROM agent_jobs WHERE id=?').get(info.lastInsertRowid)};
}
app.post('/api/scan',(req,res)=>{
  const r=enqueueAgentJob('manual');
  if(!r.created) return res.status(409).json({error:'Tarama zaten sırada veya çalışıyor',jobId:r.job.id});
  res.json({ok:true,jobId:r.job.id,agentOnline:agentOnline(),message:agentOnline()?'Yerel Chrome ajanına gönderildi':'Görev oluşturuldu; Chrome ajanı bağlanınca başlayacak'});
});

cron.schedule(process.env.CRON_SCHEDULE || '10 3 * * *',()=>enqueueAgentJob('cron'),{timezone:'Europe/Istanbul'});

app.use((_,res)=>res.sendFile(path.resolve('public/index.html')));
app.listen(port,()=>console.log(`KDV Radar http://0.0.0.0:${port} — local agent mode`));
