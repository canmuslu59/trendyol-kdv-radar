import { chromium } from 'playwright-core';
import db from './db.js';

const PAGE_DELAY_MS = Number(process.env.PAGE_DELAY_MS || process.env.REQUEST_DELAY_MS || 1200);
const TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || process.env.REQUEST_TIMEOUT_MS || 30000);
const DEFAULT_MAX_PAGES = Number(process.env.MAX_PAGES_PER_CATEGORY ?? 25);
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

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
    if (!/(^|\.)trendyol\.com$/i.test(u.hostname)) return null;
    u.hostname = 'www.trendyol.com';
    return u.toString();
  } catch { return null; }
}

function pageUrl(base, pageNo) {
  const u = new URL(base);
  u.searchParams.set('pi', String(pageNo));
  return u.toString();
}

function productIdFromUrl(url) {
  return url?.match(/-p-(\d+)/)?.[1] || null;
}

function parseIntegerText(s) {
  if (s == null || s === '') return null;
  const text = String(s).trim();
  const suffix = text.match(/([\d.,]+)\s*([KkBbMm])\+?/);
  if (suffix) {
    let n = Number(suffix[1].replace(',', '.'));
    if (!Number.isFinite(n)) return null;
    const x = suffix[2].toLowerCase();
    if (x === 'k' || x === 'b') n *= 1000;
    if (x === 'm') n *= 1000000;
    return Math.round(n);
  }
  const cleaned = text.replace(/\s/g, '').replace(/\./g, '').replace(/,/g, '');
  const digits = cleaned.replace(/\D/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function parsePriceText(s) {
  if (!s) return null;
  let t = String(s).replace(/TL|₺/gi, '').trim().replace(/\s/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}\.\d{3}$/.test(t) || (t.match(/\./g) || []).length > 1) t = t.replace(/\./g, '');
  const m = t.match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function excluded(category, text) {
  const rules = String(category.exclude_keywords || '').split('|').map(s => s.trim().toLocaleLowerCase('tr-TR')).filter(Boolean);
  const hay = String(text || '').toLocaleLowerCase('tr-TR');
  return rules.some(k => hay.includes(k));
}

async function createBrowser() {
  return chromium.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-background-networking', '--disable-features=Translate,BackForwardCache',
      '--window-size=1440,2200'
    ]
  });
}

async function renderedCards(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
  await page.waitForTimeout(1800);

  // Results can be lazy-rendered. A few short scrolls are enough to populate the first result page.
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, Math.max(700, window.innerHeight * 0.9)));
    await page.waitForTimeout(350);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(250);

  const bodyText = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')) || '';
  if (/access denied|captcha|robot değilim|olağandışı trafik|erişim engellendi|forbidden/i.test(bodyText)) {
    throw new Error('Trendyol erişim koruması sayfası döndürdü. Sunucu IP adresi engellenmiş olabilir.');
  }

  const raw = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="-p-"]'));
    const byId = new Map();
    const textOf = el => (el?.textContent || '').replace(/\s+/g, ' ').trim();

    for (const a of anchors) {
      const href = a.href || a.getAttribute('href') || '';
      const m = href.match(/-p-(\d+)/);
      if (!m) continue;
      const pid = m[1];
      const card = a.closest('.p-card-wrppr, .product-card, [data-testid*="product-card"], [class*="product-card"], [class*="p-card"]')
        || a.parentElement?.parentElement?.parentElement || a.parentElement;
      const cardText = textOf(card);

      const brandEl = card?.querySelector('.prdct-desc-cntnr-ttl, [class*="product-brand"], [class*="brand-name"]');
      const nameEl = card?.querySelector('.prdct-desc-cntnr-name, [class*="product-name"], [class*="product-title"]');
      const brand = textOf(brandEl);
      let name = textOf(nameEl) || a.getAttribute('title') || textOf(a);
      if (!name || name.length > 300) name = cardText.slice(0, 220);

      const ratingEls = Array.from(card?.querySelectorAll('.ratings-container, [class*="rating"], [class*="review"]') || []);
      const ratingText = ratingEls.map(textOf).filter(Boolean).join(' | ');

      const priceSelectors = [
        '.prc-box-dscntd', '.prc-box-sllng', '.prc-dsc', '.prc-slg',
        '[data-testid*="price"]', '[class*="price-item"]', '[class*="price-current"]',
        '[class*="discountedPrice"]', '[class*="selling-price"]'
      ];
      const priceTexts = [];
      for (const sel of priceSelectors) {
        for (const el of Array.from(card?.querySelectorAll(sel) || [])) {
          const t = textOf(el);
          if (t && /(?:TL|₺|\d+[.,]\d{2})/i.test(t)) priceTexts.push(t);
        }
      }

      const row = { pid, href, brand, name, cardText, ratingText, priceTexts };
      const old = byId.get(pid);
      if (!old || row.cardText.length > old.cardText.length) byId.set(pid, row);
    }
    return Array.from(byId.values());
  });

  return raw.map(r => {
    const url2 = normalizeUrl(r.href);
    if (!url2) return null;

    // Ratings on cards are usually shown as "(1.234)"; fall back to "1.234 Değerlendirme/Yorum".
    let ratingCount = null;
    const ratingCandidates = `${r.ratingText || ''} ${r.cardText || ''}`;
    const parenMatches = [...ratingCandidates.matchAll(/\(([\d.]+(?:,[\d]+)?\s*[KkBbMm]?)\)/g)]
      .map(m => parseIntegerText(m[1])).filter(Number.isFinite);
    if (parenMatches.length) ratingCount = Math.max(...parenMatches);
    if (ratingCount == null) {
      const m = ratingCandidates.match(/([\d.,]+\s*[KkBbMm]?\+?)\s*(?:Değerlendirme|Yorum)/i);
      if (m) ratingCount = parseIntegerText(m[1]);
    }

    const prices = (r.priceTexts || []).map(parsePriceText).filter(Number.isFinite);
    if (!prices.length) {
      for (const m of String(r.cardText || '').matchAll(/([\d.]+(?:,[\d]{1,2})?)\s*(?:TL|₺)/g)) {
        const p = parsePriceText(m[1]);
        if (Number.isFinite(p)) prices.push(p);
      }
    }
    const price = prices.length ? Math.min(...prices) : null;

    return {
      trendyolProductId: r.pid,
      url: url2,
      brand: r.brand || null,
      name: r.name || `Trendyol Ürün ${r.pid}`,
      ratingCount,
      reviewCount: ratingCount,
      price,
      sellerCount: null,
      available: !/stokta yok|tükendi|satışa kapalı/i.test(r.cardText || '')
    };
  }).filter(Boolean);
}

function saveCard(category, data) {
  if (excluded(category, `${data.name} ${data.brand || ''}`)) return { excluded: true };

  const upsert = db.prepare(`
    INSERT INTO products(trendyol_product_id, category_id, name, brand, url, active, last_seen_at, last_error)
    VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, NULL)
    ON CONFLICT(trendyol_product_id) DO UPDATE SET
      category_id=excluded.category_id, name=excluded.name, brand=excluded.brand, url=excluded.url,
      active=1, last_seen_at=CURRENT_TIMESTAMP, last_error=NULL, updated_at=CURRENT_TIMESTAMP
  `);
  upsert.run(data.trendyolProductId, category.id, data.name, data.brand, data.url);
  const product = db.prepare('SELECT id FROM products WHERE trendyol_product_id=?').get(data.trendyolProductId);

  db.prepare(`
    INSERT INTO snapshots(product_id, scan_date, rating_count, review_count, price, seller_count, available, raw_note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id, scan_date) DO UPDATE SET
      scanned_at=CURRENT_TIMESTAMP, rating_count=excluded.rating_count, review_count=excluded.review_count,
      price=excluded.price, seller_count=excluded.seller_count, available=excluded.available, raw_note=excluded.raw_note
  `).run(product.id, todayIstanbul(), data.ratingCount, data.reviewCount, data.price, data.sellerCount, data.available ? 1 : 0, 'category-card');
  return { saved: true };
}

export async function runFullScan({ discover = true, onProgress = () => {} } = {}) {
  const categories = db.prepare('SELECT * FROM categories WHERE enabled=1 ORDER BY id').all();
  const results = { categories: 0, products: 0, pages: 0, errors: [], mode: 'rendered-category-cards' };
  let browser;

  try {
    browser = await createBrowser();
    const context = await browser.newContext({
      locale: 'tr-TR',
      timezoneId: 'Europe/Istanbul',
      viewport: { width: 1440, height: 1800 },
      userAgent: process.env.CRAWLER_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);

    // Save bandwidth. Product cards do not need images/video/fonts to render their text data.
    await page.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) return route.abort();
      return route.continue();
    });

    for (const category of categories) {
      results.categories++;
      let pageNo = 1;
      let stagnant = 0;
      const configured = Number(category.max_pages || 0);
      const maxPages = configured > 0 ? configured : DEFAULT_MAX_PAGES;
      const seenThisCategory = new Set();

      while (maxPages === 0 || pageNo <= maxPages) {
        const url = pageUrl(category.trendyol_url, pageNo);
        onProgress({ phase: 'discover', category: category.name, page: pageNo });
        try {
          const cards = await renderedCards(page, url);
          results.pages++;
          if (!cards.length) {
            results.errors.push(`${category.name} sayfa ${pageNo}: render sonrası ürün kartı bulunamadı`);
            break;
          }

          let newOnPage = 0;
          for (const card of cards) {
            if (!seenThisCategory.has(card.trendyolProductId)) newOnPage++;
            seenThisCategory.add(card.trendyolProductId);
            saveCard(category, card);
            results.products++;
          }

          onProgress({ phase: 'scan', category: category.name, page: pageNo, product: `${cards.length} ürün kartı` });
          stagnant = newOnPage === 0 ? stagnant + 1 : 0;
          if (stagnant >= 2) break;
          pageNo++;
          await sleep(PAGE_DELAY_MS);
        } catch (e) {
          results.errors.push(`${category.name} sayfa ${pageNo}: ${e.message}`);
          break;
        }
      }
    }
    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return results;
}
