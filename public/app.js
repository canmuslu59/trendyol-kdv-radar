const $ = s => document.querySelector(s);
const fmt = n => n==null ? '—' : new Intl.NumberFormat('tr-TR').format(n);
const money = n => n==null ? '—' : new Intl.NumberFormat('tr-TR',{style:'currency',currency:'TRY',maximumFractionDigits:2}).format(n);
let categories=[];
let sortState={ key:'rating', dir:'desc' };

async function json(url,opt){ const r=await fetch(url,opt); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function loadCategories(){
  categories=await json('/api/categories');
  $('#category').innerHTML='<option value="">Takviye Edici Gıda & Vitamin</option>'+categories.filter(x=>x.enabled).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
}
function esc(s=''){return String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function delta(n){if(n==null)return '—';return `<span class="delta ${n>0?'pos':n<0?'neg':''}">${n>0?'+':''}${fmt(n)}</span>`}
function scanNote(state={},agent={}){
  const agentTxt=agent.online?'Ajan bağlı':'Ajan bağlı değil';
  if(state.running){
    if(state.status==='pending') return `${agentTxt} — görev bekliyor`;
    const p=state.progress||{}; return `${agentTxt}${p.category?` — ${p.category}${p.page?` / sayfa ${p.page}`:''}`:''}`;
  }
  if(state.error) return `${agentTxt} — Hata: ${state.error}`;
  const r=state.lastResult; if(!r) return agentTxt;
  const e=(r.errors||[]).length;
  return `${agentTxt} — ${fmt(r.products||0)} ürün / ${fmt(r.pages||0)} sayfa${e?` / ${e} hata`:''}` + (e?` — ${r.errors[0]}`:'');
}
function renderStats(s){
 const state=s.scanState||{},agent=s.agent||{};
 $('#stats').innerHTML=`
  <div class="stat"><div class="l">Aktif ürün</div><div class="n">${fmt(s.totalProducts)}</div></div>
  <div class="stat"><div class="l">Bugün taranan</div><div class="n">${fmt(s.scannedToday)}</div></div>
  <div class="stat"><div class="l">Whitelist kategori</div><div class="n">${fmt(s.enabledCategories)}</div></div>
  <div class="stat"><div class="l">Tarama</div><div class="n">${state.running?'Çalışıyor':'Hazır'}</div><div class="status">${esc(scanNote(state,agent))}</div></div>`;
 $('#scanBtn').disabled=!!state.running;
 $('#scanBtn').textContent=state.running?'Taranıyor…':'Şimdi Tara';
}
async function loadStats(){renderStats(await json('/api/stats'))}

function updateSortUi(){
  document.querySelectorAll('th.sortable').forEach(th=>{
    const active=th.dataset.sort===sortState.key;
    th.classList.toggle('active-sort',active);
    const indicator=th.querySelector('.sort-indicator');
    if(indicator) indicator.textContent=active ? (sortState.dir==='desc'?'↓':'↑') : '↕';
    th.setAttribute('aria-sort',active ? (sortState.dir==='desc'?'descending':'ascending') : 'none');
  });
  const sortSelect=$('#sort'); if(sortSelect) sortSelect.value=sortState.key;
  const dirSelect=$('#dir'); if(dirSelect) dirSelect.value=sortState.dir;
}

async function loadProducts(){
 const p=new URLSearchParams();
 for(const id of ['q','category','minPrice','maxPrice','minD7','minD30']){
   const el=$('#'+id); const v=el?.value; if(v)p.set(id,v);
 }
 p.set('sort',sortState.key);
 p.set('dir',sortState.dir);
 const rows=await json('/api/products?'+p.toString());
 $('#tbody').innerHTML=rows.map(r=>`<tr>
   <td class="product"><div class="brand">${esc(r.brand||'')}</div><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a></td>
   <td>${esc(r.category)}</td><td><span class="pill">%${r.vat_rate}</span></td><td>${r.base_commission==null?'—':'%'+r.base_commission}</td>
   <td><b>${money(r.price)}</b></td><td>${fmt(r.rating_count)}</td><td>${delta(r.d1)}</td><td>${delta(r.d7)}</td><td>${delta(r.d15)}</td><td>${delta(r.d30)}</td><td>${esc(r.scan_date||'—')}</td>
 </tr>`).join('');
 $('#empty').hidden=rows.length>0;
 updateSortUi();
}

function setSort(key,dir=null){
  if(sortState.key===key && !dir) sortState.dir=sortState.dir==='desc'?'asc':'desc';
  else { sortState.key=key; sortState.dir=dir || 'desc'; }
  updateSortUi();
  loadProducts().catch(e=>alert('Liste sıralanamadı: '+e.message));
}

function bindSortableHeaders(){
  document.querySelectorAll('th.sortable').forEach(th=>{
    th.addEventListener('click',()=>setSort(th.dataset.sort));
    th.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){e.preventDefault();setSort(th.dataset.sort)} });
  });
  updateSortUi();
}

async function renderSettings(){ await loadCategories(); $('#categoriesList').innerHTML=categories.map(c=>`<div class="cat-row" data-id="${c.id}">
  <input data-k="name" value="${esc(c.name)}"><input data-k="trendyol_url" value="${esc(c.trendyol_url)}">
  <input data-k="vat_rate" type="number" step=".01" value="${c.vat_rate}"><input data-k="base_commission" type="number" step=".01" value="${c.base_commission??''}">
  <label><input data-k="enabled" type="checkbox" ${c.enabled?'checked':''}> aktif</label><input data-k="exclude_keywords" value="${esc(c.exclude_keywords||'')}" placeholder="Hariç kelimeler"><button class="saveCat">Kaydet</button></div>`).join('');
 document.querySelectorAll('.saveCat').forEach(b=>b.onclick=saveCategory);
}
async function saveCategory(e){ const row=e.target.closest('.cat-row'),body={}; row.querySelectorAll('[data-k]').forEach(i=>body[i.dataset.k]=i.type==='checkbox'?i.checked:i.value); body.max_pages=categories.find(c=>c.id==row.dataset.id)?.max_pages||0; body.note=''; await json('/api/categories/'+row.dataset.id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); e.target.textContent='Kaydedildi';setTimeout(()=>e.target.textContent='Kaydet',900); }

$('#apply').onclick=()=>{
  if($('#sort')) sortState.key=$('#sort').value || sortState.key;
  if($('#dir')) sortState.dir=$('#dir').value || sortState.dir;
  loadProducts();
};
$('#sort')?.addEventListener('change',e=>{ sortState.key=e.target.value; loadProducts(); });
$('#dir')?.addEventListener('change',e=>{ sortState.dir=e.target.value; loadProducts(); });
$('#scanBtn').onclick=async()=>{
 const btn=$('#scanBtn'); try{ btn.disabled=true;btn.textContent='Görev oluşturuluyor…'; const r=await json('/api/scan',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}); window.postMessage({type:'KDV_RADAR_SCAN_REQUESTED'},'*'); await loadStats(); if(!r.agentOnline) alert('Tarama görevi oluşturuldu. Chrome tarama ajanı bağlı değilse uzantıyı açıp bağlantıyı kaydet.'); }catch(e){alert('Tarama başlatılamadı: '+e.message);btn.disabled=false;btn.textContent='Şimdi Tara';}
};
$('#settingsBtn').onclick=async()=>{await renderSettings();$('#settingsDialog').showModal()}; $('#closeDialog').onclick=()=>$('#settingsDialog').close();
$('#addCategory').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.target);const b=Object.fromEntries(fd.entries());b.enabled=true;await json('/api/categories',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});e.target.reset();await renderSettings()};

bindSortableHeaders();
await loadCategories(); await Promise.all([loadStats(),loadProducts()]); let wasRunning=false;
setInterval(async()=>{try{const s=await json('/api/stats');const running=!!s.scanState?.running;renderStats(s);if(wasRunning&&!running)await loadProducts();wasRunning=running;}catch(e){console.error(e)}},3000);
