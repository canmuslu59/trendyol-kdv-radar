import axios from 'axios';
import * as cheerio from 'cheerio';
import db from './db.js';

const UA = process.env.CRAWLER_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36';
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 1400);
const TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function todayIstanbul() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function normalizeUrl(href) {
  if (!href) return null;
  try {
    const u = new URL(href, 'https://www.trendyol.com');
    u.search = '';
    u.hash = '';
    if (u.hostname !== 'www.trendyol.com') return null;
    return u.toString();
  } catch { return null; }
}

function pageUrl(base, page) {
  const u = new URL(base);
  u.searchParams.set('pi', String(page));
  return u.toString();
}

async function fetchHtml(url) {
  const res = await axios.get(url, {
    timeout: TIMEOUT_MS,
    headers: {
      'user-agent': UA,
      'accept-language': 'tr-TR,tr;q=0.9,en;q=0.7',
      'accept': 'text/html,application/xhtml+xml'
    },
    validateStatus: s => s >= 200 && s < 500
  });
  if (res.status === 429) throw new Error('HTTP 429: Trendyol hız sınırı. Tarama durduruldu; istek aralığını artırın.');
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  return String(res.data || '');
}

function productIdFromUrl(url) {
  return url?.match(/-p-(\d+)/)?.[1] || null;
}

function parseIntegerText(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/\s/g, '').replace(/\./g, '').replace(/,/g, '');
  const n = Number(cleaned.replace(/\D/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parsePriceText(s) {
  if (!s) return null;
  let t = String(s).replace(/TL|₺/gi, '').trim().replace(/\s/g, '');
  // Turkish format: 1.299,90 -> 1299.90 ; 399 -> 399
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}\.\d{3}$/.test(t) || (t.match(/\./g) || []).length > 1) t = t.replace(/\./g, '');
  const m = t.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function parseJsonLd($) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const value = JSON.parse($(el).text());
      if (Array.isArray(value)) out.push(...value); else out.push(value);
    } catch {}
  });
  return out.flatMap(x => x?.['@graph'] ? x['@graph'] : [x]);
}

export function parseProductPage(html, url) {
  const $ = cheerio.load(html);
  const jsonLd = parseJsonLd($);
  const productLd = jsonLd.find(x => x && (x['@type'] === 'Product' || (Array.isArray(x['@type']) && x['@type'].includes('Product'))));

  const bodyText = $('body').text().replace(/\s+/g, ' ');
  const name = productLd?.name || $('h1').first().text().trim() || $('title').text().split('|')[0].trim() || 'Ürün';
  const brand = typeof productLd?.brand === 'string' ? productLd.brand : (productLd?.brand?.name || null);

  let ratingCount = Number(productLd?.aggregateRating?.ratingCount || productLd?.aggregateRating?.reviewCount || NaN);
  if (!Number.isFinite(ratingCount)) {
    const m = bodyText.match(/([\d\.]+)\s*Değerlendirme/i) || bodyText.match(/([\d\.]+)\s*değerlendirme/i);
    ratingCount = m ? parseIntegerText(m[1]) : null;
  }

  let reviewCount = Number(productLd?.aggregateRating?.reviewCount || NaN);
  if (!Number.isFinite(reviewCount)) {
    const m = bodyText.match(/([\d\.]+)\s*Yorum/i);
    reviewCount = m ? parseIntegerText(m[1]) : null;
  }

  let price = parsePriceText(productLd?.offers?.lowPrice || productLd?.offers?.price);
  if (price == null && Array.isArray(productLd?.offers)) {
    const vals = productLd.offers.map(o => parsePriceText(o?.price)).filter(Number.isFinite);
    if (vals.length) price = Math.min(...vals);
  }
  if (price == null) {
    const selectors = ['.prc-dsc', '.prc-slg', '[data-testid="price-current-price"]', '[class*="price"]'];
    for (const sel of selectors) {
      const vals = $(sel).map((_,el) => parsePriceText($(el).text())).get().filter(v => Number.isFinite(v) && v > 0);
      if (vals.length) { price = Math.min(...vals); break; }
    }
  }
  if (price == null) {
    const matches = [...bodyText.matchAll(/(?:₺\s*)?([\d\.]+(?:,\d{1,2})?)\s*(?:TL|₺)/g)].map(m => parsePriceText(m[1])).filter(v => v > 5);
    if (matches.length) price = Math.min(...matches);
  }

  let sellerCount = null;
  const sellerText = bodyText.match(/([\d\.]+)\s*(?:farklı\s*)?satıcı/i);
  if (sellerText) sellerCount = parseIntegerText(sellerText[1]);

  return {
    trendyolProductId: productIdFromUrl(url),
    name, brand, price, ratingCount, reviewCount, sellerCount,
    available: !/stokta yok|tükendi|satışa kapalı/i.test(bodyText)
  };
}

export function parseCategoryLinks(html) {
  const $ = cheerio.load(html);
  const seen = new Set();
  $('a[href*="-p-"]').each((_, el) => {
    const u = normalizeUrl($(el).attr('href'));
    if (u && productIdFromUrl(u)) seen.add(u);
  });
  return [...seen];
}

function excluded(category, text) {
  const rules = String(category.exclude_keywords || '').split('|').map(s => s.trim().toLocaleLowerCase('tr-TR')).filter(Boolean);
  const hay = String(text || '').toLocaleLowerCase('tr-TR');
  return rules.some(k => hay.includes(k));
}

export async function discoverCategory(category, onProgress = () => {}) {
  const maxPages = Number(category.max_pages || 0);
  let page = 1, totalNew = 0, stagnant = 0;
  const upsert = db.prepare(`
    INSERT INTO products(trendyol_product_id, category_id, name, url, last_seen_at)
    VALUES (@pid, @categoryId, @name, @url, CURRENT_TIMESTAMP)
    ON CONFLICT(trendyol_product_id) DO UPDATE SET
      category_id=excluded.category_id, url=excluded.url, last_seen_at=CURRENT_TIMESTAMP,
      active=1, updated_at=CURRENT_TIMESTAMP
  `);

  while (true) {
    if (maxPages > 0 && page > maxPages) break;
    const url = pageUrl(category.trendyol_url, page);
    onProgress({ phase: 'discover', category: category.name, page });
    const html = await fetchHtml(url);
    const links = parseCategoryLinks(html);
    if (!links.length) break;
    let pageNew = 0;
    for (const link of links) {
      const pid = productIdFromUrl(link);
      if (!pid) continue;
      const exists = db.prepare('SELECT id FROM products WHERE trendyol_product_id=?').get(pid);
      if (!exists) pageNew++;
      upsert.run({ pid, categoryId: category.id, name: `Trendyol Ürün ${pid}`, url: link });
    }
    totalNew += pageNew;
    stagnant = pageNew === 0 ? stagnant + 1 : 0;
    if (stagnant >= 2) break;
    page++;
    await sleep(REQUEST_DELAY_MS);
  }
  return { totalNew, pages: page };
}

export async function scanProduct(product, category, onProgress = () => {}) {
  const html = await fetchHtml(product.url);
  const data = parseProductPage(html, product.url);
  if (!data.trendyolProductId) throw new Error('Ürün ID okunamadı');
  if (excluded(category, `${data.name} ${data.brand || ''}`)) {
    db.prepare('UPDATE products SET active=0, last_error=? WHERE id=?').run('Whitelist hariç anahtar kelime', product.id);
    return { excluded: true };
  }

  db.prepare(`UPDATE products SET name=?, brand=?, active=1, last_seen_at=CURRENT_TIMESTAMP, last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(data.name, data.brand, product.id);

  db.prepare(`
    INSERT INTO snapshots(product_id, scan_date, rating_count, review_count, price, seller_count, available, raw_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id, scan_date) DO UPDATE SET
      scanned_at=CURRENT_TIMESTAMP, rating_count=excluded.rating_count, review_count=excluded.review_count,
      price=excluded.price, seller_count=excluded.seller_count, available=excluded.available, raw_note=excluded.raw_note
  `).run(product.id, todayIstanbul(), data.ratingCount, data.reviewCount, data.price, data.sellerCount, data.available ? 1 : 0, null);

  onProgress({ phase: 'scan', product: data.name, productId: product.id });
  return data;
}

export async function runFullScan({ discover = true, onProgress = () => {} } = {}) {
  const categories = db.prepare('SELECT * FROM categories WHERE enabled=1 ORDER BY id').all();
  const results = { categories: 0, products: 0, errors: [] };
  for (const category of categories) {
    results.categories++;
    try {
      if (discover) await discoverCategory(category, onProgress);
    } catch (e) {
      results.errors.push(`${category.name} discovery: ${e.message}`);
      if (String(e.message).includes('429')) throw e;
    }
    const products = db.prepare('SELECT * FROM products WHERE category_id=? AND active=1 ORDER BY id').all(category.id);
    for (const product of products) {
      try {
        await scanProduct(product, category, onProgress);
        results.products++;
      } catch (e) {
        db.prepare('UPDATE products SET last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(String(e.message).slice(0,500), product.id);
        results.errors.push(`${product.trendyol_product_id}: ${e.message}`);
        if (String(e.message).includes('429')) throw e;
      }
      await sleep(REQUEST_DELAY_MS);
    }
  }
  return results;
}
