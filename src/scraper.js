import db from './db.js';
import dns from 'node:dns';
import https from 'node:https';

// Railway/Cloud egress can occasionally prefer an unreachable IPv6 route.
// Prefer IPv4 but keep normal DNS fallback behaviour.
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

const PAGE_DELAY_MS = Number(process.env.PAGE_DELAY_MS || process.env.REQUEST_DELAY_MS || 900);
const TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || process.env.REQUEST_TIMEOUT_MS || 25000);
const DEFAULT_MAX_PAGES = Number(process.env.MAX_PAGES_PER_CATEGORY ?? 25);
const DETAIL_FALLBACK = String(process.env.DETAIL_FALLBACK ?? '1') !== '0';
const API_HOSTS = String(process.env.TRENDYOL_API_HOSTS || 'public.trendyol.com,apigw.trendyol.com')
  .split(',').map(s => s.trim()).filter(Boolean);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function todayIstanbul() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function categoryIdFromUrl(url) {
  const m = String(url || '').match(/-x-c(\d+)/i);
  return m?.[1] || null;
}

function categorySlugFromUrl(url) {
  try {
    const u = new URL(url, 'https://www.trendyol.com');
    return u.pathname.replace(/^\/+|\/+$/g, '');
  } catch {
    return String(url || '').replace(/^.*trendyol\.com\//i, '').split('?')[0].replace(/^\/+|\/+$/g, '');
  }
}

function normalizeUrl(href, id) {
  if (!href && id) return `https://www.trendyol.com/p-p-${id}`;
  if (!href) return null;
  try {
    const u = new URL(href, 'https://www.trendyol.com');
    u.hostname = 'www.trendyol.com';
    u.protocol = 'https:';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch { return null; }
}

function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/TL|₺/gi, '').replace(/\s/g, '');
  if (!s) return null;
  let t = s;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if ((t.match(/\./g) || []).length > 1 || /^\d{1,3}\.\d{3}$/.test(t)) t = t.replace(/\./g, '');
  const m = t.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function intVal(v) { const n = num(v); return n == null ? null : Math.round(n); }
function first(...vals) { for (const v of vals) if (v !== undefined && v !== null && v !== '') return v; return null; }
function brandName(p) { return first(p?.brand?.name, p?.brandName, p?.brand, p?.merchant?.brandName); }
function ratingCountFrom(p) {
  return intVal(first(p?.ratingScore?.totalRatingCount,p?.ratingScore?.totalCount,p?.ratingScore?.ratingCount,p?.ratingCount,p?.totalRatingCount,p?.ratingsCount,p?.reviewSummary?.totalRatingCount,p?.reviewSummary?.ratingCount,p?.reviews?.totalRatingCount));
}
function commentCountFrom(p) {
  return intVal(first(p?.ratingScore?.totalCommentCount,p?.ratingScore?.commentCount,p?.commentCount,p?.totalCommentCount,p?.reviewCount,p?.reviewsCount,p?.reviewSummary?.totalCommentCount));
}
function priceFrom(p) {
  return num(first(p?.price?.discountedPrice?.value,p?.price?.discountedPrice,p?.price?.sellingPrice?.value,p?.price?.sellingPrice,p?.discountedPrice?.value,p?.discountedPrice,p?.sellingPrice?.value,p?.sellingPrice,p?.price?.value,p?.price,p?.salePrice,p?.lowestPrice));
}
function excluded(category, text) {
  const rules = String(category.exclude_keywords || '').split('|').map(s => s.trim().toLocaleLowerCase('tr-TR')).filter(Boolean);
  const hay = String(text || '').toLocaleLowerCase('tr-TR');
  return rules.some(k => hay.includes(k));
}

function errorText(e) {
  const c = e?.cause || {};
  const details = [
    e?.message,
    c?.code,
    c?.errno,
    c?.syscall,
    c?.hostname || c?.host,
    c?.address,
    c?.port
  ].filter(v => v !== undefined && v !== null && v !== '').map(String);
  return [...new Set(details)].join(' | ');
}

function fetchViaHttps(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: 443,
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      family: 4,
      timeout: TIMEOUT_MS,
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6',
        origin: 'https://www.trendyol.com',
        referer: 'https://www.trendyol.com/',
        'user-agent': process.env.CRAWLER_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
      }
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { if (body.length < 2_000_000) body += chunk; });
      res.on('end', () => {
        const status = Number(res.statusCode || 0);
        if (status < 200 || status >= 300) return reject(new Error(`HTTP ${status}: ${body.slice(0,180)}`));
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`JSON beklenirken farklı yanıt geldi: ${body.slice(0,180)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`HTTPS timeout ${TIMEOUT_MS}ms`)));
    req.on('error', reject);
    req.end();
  });
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let fetchErr = null;
  try {
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          accept: 'application/json, text/plain, */*',
          'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.7,en;q=0.6',
          origin: 'https://www.trendyol.com',
          referer: 'https://www.trendyol.com/',
          'user-agent': process.env.CRAWLER_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'
        }
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0,180)}`);
      try { return JSON.parse(text); }
      catch { throw new Error(`JSON beklenirken farklı yanıt geldi: ${text.slice(0,180)}`); }
    } catch (e) {
      fetchErr = e;
    }
  } finally {
    clearTimeout(timer);
  }

  // Native fetch can fail before HTTP on some cloud DNS/IPv6 routes. Retry using
  // node:https with family:4 so we get either a working response or a useful cause.
  try { return await fetchViaHttps(url); }
  catch (httpsErr) {
    throw new Error(`fetch: ${errorText(fetchErr)} || https/IPv4: ${errorText(httpsErr)}`);
  }
}

function commonSearchParams(u, pageNo) {
  const offset = Math.max(0, (pageNo - 1) * 24);
  u.searchParams.set('os','1'); u.searchParams.set('sk','1'); u.searchParams.set('pi',String(pageNo));
  u.searchParams.set('culture','tr-TR'); u.searchParams.set('userGenderId','1'); u.searchParams.set('pId','0');
  u.searchParams.set('scoringAlgorithmId','2'); u.searchParams.set('categoryRelevancyEnabled','false');
  u.searchParams.set('isLegalRequirementConfirmed','false'); u.searchParams.set('searchStrategyType','DEFAULT');
  u.searchParams.set('productStampType','TypeA'); u.searchParams.set('fixSlotProductAdsIncluded','true');
  u.searchParams.set('offset',String(offset));
  return u;
}

function searchApiCandidates(category, pageNo) {
  const cid = categoryIdFromUrl(category.trendyol_url);
  const slug = categorySlugFromUrl(category.trendyol_url);
  if (!cid) throw new Error(`Kategori ID çıkarılamadı: ${category.trendyol_url}`);
  const urls = [];
  for (const host of API_HOSTS) {
    if (slug) {
      const direct = commonSearchParams(new URL(`https://${host}/discovery-web-searchgw-service/v2/api/infinite-scroll/${slug}`), pageNo);
      urls.push(direct.toString());
    }
    const sr = commonSearchParams(new URL(`https://${host}/discovery-web-searchgw-service/v2/api/infinite-scroll/sr`), pageNo);
    sr.searchParams.set('wc', cid);
    urls.push(sr.toString());
  }
  return urls;
}

function detailApiCandidates(id) {
  return API_HOSTS.map(host => {
    const u = new URL(`https://${host}/discovery-web-productgw-service/api/productDetail/${id}`);
    u.searchParams.set('sav','false'); u.searchParams.set('storefrontId','1'); u.searchParams.set('culture','tr-TR');
    u.searchParams.set('linearVariants','true'); u.searchParams.set('isLegalRequirementConfirmed','false');
    return u.toString();
  });
}

async function firstWorkingJson(urls) {
  const errs = [];
  for (const url of urls) {
    try { return { json: await fetchJson(url), url }; }
    catch (e) { errs.push(`${new URL(url).hostname}${new URL(url).pathname}: ${e.message}`); }
  }
  throw new Error(errs.join(' ~~ '));
}

function fromSearchProduct(p) {
  const id = String(first(p?.id,p?.contentId,p?.productId) || '');
  if (!id) return null;
  const href = first(p?.url,p?.productUrl,p?.link);
  return { trendyolProductId:id,url:normalizeUrl(href,id),brand:brandName(p),name:first(p?.name,p?.title,p?.productName)||`Trendyol Ürün ${id}`,ratingCount:ratingCountFrom(p),reviewCount:commentCountFrom(p),price:priceFrom(p),sellerCount:intVal(first(p?.merchantCount,p?.sellerCount,p?.otherMerchantCount)),available:first(p?.inStock,p?.sellable,p?.available)!==false,_raw:p };
}

function mergeDetail(base,d) {
  if (!d) return base;
  const id = String(first(d?.id,d?.contentId,base?.trendyolProductId)||base?.trendyolProductId||'');
  const href = first(d?.url,d?.productUrl,base?.url);
  const otherMerchants = Array.isArray(d?.otherMerchants) ? d.otherMerchants.length : null;
  return { trendyolProductId:id,url:normalizeUrl(href,id)||base.url,brand:brandName(d)||base.brand,name:first(d?.name,d?.title,base?.name)||base.name,ratingCount:ratingCountFrom(d)??base.ratingCount,reviewCount:commentCountFrom(d)??base.reviewCount,price:priceFrom(d)??base.price,sellerCount:otherMerchants==null?base.sellerCount:otherMerchants+1,available:first(d?.sellable,d?.inStock,d?.available)!==false };
}

async function fetchCategoryPage(category,pageNo) {
  const { json, url } = await firstWorkingJson(searchApiCandidates(category,pageNo));
  const result = json?.result || json?.data || json;
  const products = Array.isArray(result?.products) ? result.products : [];
  const totalCount = intVal(first(result?.totalCount,result?.total,result?.productCount));
  return { products,totalCount,sourceHost:new URL(url).hostname };
}

async function maybeEnrich(card) {
  if (!DETAIL_FALLBACK) return card;
  if (card.ratingCount != null && card.price != null && card.name) return card;
  try {
    const { json } = await firstWorkingJson(detailApiCandidates(card.trendyolProductId));
    return mergeDetail(card,json?.result||json?.data||json);
  } catch { return card; }
}

function saveCard(category,data) {
  if (excluded(category,`${data.name} ${data.brand||''}`)) return { excluded:true };
  db.prepare(`INSERT INTO products(trendyol_product_id,category_id,name,brand,url,active,last_seen_at,last_error)
    VALUES(?,?,?,?,?,1,CURRENT_TIMESTAMP,NULL)
    ON CONFLICT(trendyol_product_id) DO UPDATE SET category_id=excluded.category_id,name=excluded.name,brand=excluded.brand,url=excluded.url,active=1,last_seen_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP`)
    .run(data.trendyolProductId,category.id,data.name,data.brand,data.url);
  const product = db.prepare('SELECT id FROM products WHERE trendyol_product_id=?').get(data.trendyolProductId);
  db.prepare(`INSERT INTO snapshots(product_id,scan_date,rating_count,review_count,price,seller_count,available,raw_note)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(product_id,scan_date) DO UPDATE SET scanned_at=CURRENT_TIMESTAMP,rating_count=excluded.rating_count,review_count=excluded.review_count,price=excluded.price,seller_count=excluded.seller_count,available=excluded.available,raw_note=excluded.raw_note`)
    .run(product.id,todayIstanbul(),data.ratingCount,data.reviewCount,data.price,data.sellerCount,data.available?1:0,'search-api-v5');
  return { saved:true };
}

export async function runFullScan({ discover=true,onProgress=()=>{} }={}) {
  const categories = db.prepare('SELECT * FROM categories WHERE enabled=1 ORDER BY id').all();
  const results = { categories:0,products:0,pages:0,errors:[],mode:'trendyol-api-v5-ipv4-fallback',hosts:API_HOSTS };
  for (const category of categories) {
    results.categories++;
    let pageNo=1,stagnant=0,totalCount=null;
    const configured=Number(category.max_pages||0);
    const maxPages=configured>0?configured:DEFAULT_MAX_PAGES;
    const seenThisCategory=new Set();
    while (maxPages===0 || pageNo<=maxPages) {
      onProgress({phase:'discover',category:category.name,page:pageNo});
      try {
        const pageData=await fetchCategoryPage(category,pageNo);
        results.pages++; totalCount=pageData.totalCount??totalCount;
        const rawProducts=pageData.products;
        if (!rawProducts.length) { if (pageNo===1) results.errors.push(`${category.name} sayfa 1: API 0 ürün döndürdü (${pageData.sourceHost})`); break; }
        let newOnPage=0,savedOnPage=0;
        for (const raw of rawProducts) {
          let card=fromSearchProduct(raw); if (!card) continue;
          if (!seenThisCategory.has(card.trendyolProductId)) newOnPage++;
          seenThisCategory.add(card.trendyolProductId);
          card=await maybeEnrich(card);
          const r=saveCard(category,card);
          if (!r.excluded) { savedOnPage++; results.products++; }
        }
        onProgress({phase:'scan',category:category.name,page:pageNo,product:`${savedOnPage} ürün`,host:pageData.sourceHost});
        stagnant=newOnPage===0?stagnant+1:0;
        if (stagnant>=2) break;
        if (totalCount!=null && seenThisCategory.size>=totalCount) break;
        if (rawProducts.length<24) break;
      } catch(e) {
        results.errors.push(`${category.name} sayfa ${pageNo}: ${e.message}`);
        break;
      }
      pageNo++;
      if (PAGE_DELAY_MS>0) await sleep(PAGE_DELAY_MS);
    }
  }
  return results;
}

export async function networkDiagnostics() {
  const hosts = [...new Set([...API_HOSTS,'www.trendyol.com'])];
  const out=[];
  for (const host of hosts) {
    const row={host,dns:null,https:null};
    try {
      row.dns = await new Promise((resolve,reject)=>dns.lookup(host,{all:true},(e,a)=>e?reject(e):resolve(a)));
    } catch(e) { row.dns={error:errorText(e)}; }
    try {
      const u=`https://${host}/`;
      await new Promise((resolve,reject)=>{
        const req=https.request(u,{method:'HEAD',family:4,timeout:8000,headers:{'user-agent':'Mozilla/5.0'}},res=>{ row.https={status:res.statusCode}; res.resume(); resolve(); });
        req.on('timeout',()=>req.destroy(new Error('timeout'))); req.on('error',reject); req.end();
      });
    } catch(e) { row.https={error:errorText(e)}; }
    out.push(row);
  }
  return out;
}
