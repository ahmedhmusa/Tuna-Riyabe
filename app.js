/* ============================================================
   ISLAND TUNA — Business Management PWA
   Phase 1: Dashboard, Customers, Fresh Tuna Purchases & Sales,
            Credit Ledger, Payments, Inventory, Backup/Restore,
            Suppliers, Settings, basic Daily Report, Search.
   Local-first: all data is persisted via the host's key-value
   storage (window.storage) when running as a Claude artifact,
   falling back to in-memory-only storage otherwise (e.g. if this
   file is opened directly outside the artifact preview — data
   will not survive a reload in that fallback case).
   ============================================================ */

/* ---- global safety net: show ANY failure on screen instead of a silent frozen splash ---- */
function showFatalError(msg){
  try{
    let el = document.getElementById('splash');
    if(!el){
      el = document.createElement('div');
      el.id = 'splash';
      document.body.appendChild(el);
    }
    const backend = (typeof StorageBackend !== 'undefined' && StorageBackend) ? StorageBackend.kind : 'not initialised';
    el.innerHTML =
      '<div><svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.3l9.3 16.2H2.7L12 3.3z"/><line x1="12" y1="9.5" x2="12" y2="13.8"/><circle cx="12" cy="16.6" r=".95" fill="currentColor" stroke="none"/></svg></div>' +
      '<div style="font-family:sans-serif;font-size:14px;max-width:300px;text-align:center;line-height:1.5;padding:0 20px;">' +
      'The app hit a problem while starting:<br><br>' +
      '<code style="font-size:12px; opacity:0.9; word-break:break-word;">' + String(msg).replace(/</g,'&lt;') + '</code>' +
      '<br><br><span style="font-size:11px; opacity:0.7;">storage backend: ' + backend + '</span></div>';
  }catch(e){ /* nothing more we can do */ }
}
let APP_STARTED = false;
window.addEventListener('error', function(e){
  if(APP_STARTED) return;
  showFatalError((e && (e.message || (e.error && e.error.message))) || 'Unknown error');
});
window.addEventListener('unhandledrejection', function(e){
  if(APP_STARTED) return;
  showFatalError((e.reason && e.reason.message) || e.reason || 'Unhandled promise rejection');
});

/** Races a promise against a timeout; resolves with `fallback` if it doesn't settle in time. */
function withTimeout(promise, ms, fallback){
  return new Promise((resolve)=>{
    let done = false;
    const t = setTimeout(()=>{ if(!done){ done = true; resolve(fallback); } }, ms);
    Promise.resolve(promise).then(
      v => { if(!done){ done = true; clearTimeout(t); resolve(v); } },
      () => { if(!done){ done = true; clearTimeout(t); resolve(fallback); } }
    );
  });
}

/* ============================================================
   STORAGE BACKEND
   Picks the best available persistence layer:
     1. window.storage  — when running inside a Claude artifact
     2. IndexedDB       — normal browsers / GitHub Pages / installed PWA
     3. localStorage    — last-resort fallback
   All three expose the same tiny get/set key-value interface.
   ============================================================ */
const StorageBackend = (function(){
  // --- 1. host-provided storage ---
  if(typeof window !== 'undefined' && window.storage){
    return {
      kind: 'host',
      get: (k)=> withTimeout(
        Promise.resolve(window.storage.get(k, false)).then(r => (r && r.value) ? r.value : null).catch(()=>null),
        1200, null),
      set: (k,v)=>{ try{ Promise.resolve(window.storage.set(k, v, false)).catch(()=>{}); }catch(e){} }
    };
  }

  // --- 3. localStorage (also used as a runtime fallback if IndexedDB fails) ---
  const localBackend = {
    kind: 'localstorage',
    get: async (k)=>{ try{ return localStorage.getItem(k); }catch(e){ return null; } },
    set: (k,v)=>{ try{ localStorage.setItem(k, v); }catch(e){} }
  };

  // --- 2. IndexedDB (preferred for real browsers) ---
  const idbUsable = (function(){
    try{ return typeof indexedDB !== 'undefined' && indexedDB !== null && typeof indexedDB.open === 'function'; }
    catch(e){ return false; }
  })();

  if(idbUsable){
    let dbPromise = null;
    let brokenIdb = false;   // flips to true on any failure; we then use localStorage
    function openDb(){
      if(dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject)=>{
        let req;
        try{ req = indexedDB.open('IslandTunaDB', 1); }
        catch(e){ reject(e); return; }
        req.onupgradeneeded = ()=>{
          const d = req.result;
          if(!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        };
        req.onsuccess = ()=> resolve(req.result);
        req.onerror = ()=> reject(req.error || new Error('IndexedDB open failed'));
        req.onblocked = ()=> reject(new Error('IndexedDB blocked'));
        setTimeout(()=> reject(new Error('IndexedDB open timed out')), 3000);
      });
      dbPromise.catch(()=>{ brokenIdb = true; });
      return dbPromise;
    }
    return {
      kind: 'indexeddb',
      get: async (k)=>{
        if(brokenIdb) return localBackend.get(k);
        try{
          const d = await openDb();
          return await new Promise((resolve)=>{
            const tx = d.transaction('kv','readonly');
            const rq = tx.objectStore('kv').get(k);
            rq.onsuccess = ()=> resolve(rq.result != null ? rq.result : null);
            rq.onerror = ()=> resolve(null);
            setTimeout(()=> resolve(null), 2500);
          });
        }catch(e){
          brokenIdb = true;
          return localBackend.get(k);   // don't lose access to previously saved data
        }
      },
      set: (k,v)=>{
        // Always mirror to localStorage: cheap insurance, and the only copy if IDB breaks.
        localBackend.set(k, v);
        if(brokenIdb) return;
        openDb().then(d=>{
          const tx = d.transaction('kv','readwrite');
          tx.objectStore('kv').put(v, k);
        }).catch(()=>{ brokenIdb = true; });
      }
    };
  }

  return localBackend;
})();

const HAS_PERSISTENT_STORAGE = true; // one of the three backends above always applies
console.log('Island Tuna storage backend:', StorageBackend.kind);

/** A single "table": an array of records, persisted as one JSON blob under its own key. */
class ShimTable{
  constructor(name){ this.name = name; this._rows = null; this._nextId = 1; }
  async _load(){
    if(this._rows !== null) return;
    this._rows = [];
    const raw = await StorageBackend.get('table:'+this.name);
    if(raw){
      try{ const parsed = JSON.parse(raw); if(Array.isArray(parsed)) this._rows = parsed; }
      catch(e){ this._rows = []; }
    }
    this._nextId = this._rows.reduce((m,r)=> Math.max(m, Number(r.id)||0), 0) + 1;
  }
  /* Fire-and-forget: the in-memory rows are the source of truth during a session,
     so the UI never waits on a slow or unresponsive storage backend. */
  _save(){
    try{ StorageBackend.set('table:'+this.name, JSON.stringify(this._rows)); }
    catch(e){ /* ignore persistence failures */ }
  }
  async add(obj){
    await this._load();
    const id = this._nextId++;
    this._rows.push({ ...obj, id });
    await this._save();
    return id;
  }
  async put(obj){
    await this._load();
    const idx = this._rows.findIndex(r=> r.id === obj.id);
    if(idx>=0) this._rows[idx] = obj; else this._rows.push(obj);
    if(Number(obj.id) >= this._nextId) this._nextId = Number(obj.id)+1;
    await this._save();
    return obj;
  }
  async get(id){ await this._load(); return this._rows.find(r=> r.id === id); }
  async update(id, patch){
    await this._load();
    const r = this._rows.find(r=> r.id === id);
    if(r){ Object.assign(r, patch); await this._save(); }
    return r;
  }
  async clear(){ await this._load(); this._rows = []; this._nextId = 1; await this._save(); }
  async toArray(){ await this._load(); return [...this._rows]; }
  async bulkAdd(arr){
    await this._load();
    for(const o of arr){
      const id = (o.id != null) ? o.id : this._nextId++;
      if(Number(id) >= this._nextId) this._nextId = Number(id)+1;
      this._rows.push({ ...o, id });
    }
    await this._save();
  }
  orderBy(field){
    const self = this;
    const sortedAsc = async ()=>{ await self._load(); return [...self._rows].sort((a,b)=> (a[field] > b[field] ? 1 : (a[field] < b[field] ? -1 : 0))); };
    return {
      toArray: sortedAsc,
      reverse: ()=> ({
        toArray: async ()=>{ const r = await sortedAsc(); return r.reverse(); },
        limit: (n)=> ({ toArray: async ()=>{ const r = await sortedAsc(); return r.reverse().slice(0,n); } })
      })
    };
  }
  where(field){
    const self = this;
    return {
      equals: (val)=> ({
        toArray: async ()=>{ await self._load(); return self._rows.filter(r=> r[field] === val); },
        reverse: ()=> ({
          sortBy: async (sortField)=>{
            await self._load();
            return self._rows.filter(r=> r[field] === val).sort((a,b)=> new Date(b[sortField]) - new Date(a[sortField]));
          }
        })
      })
    };
  }
}

const TABLE_NAMES = ['settings','customers','suppliers','products','sales','payments','customerTx','purchases','supplierPayments','supplierTx','inventoryTx','productionBatches','expenses','auditLogs'];
const db = {};
for(const name of TABLE_NAMES) db[name] = new ShimTable(name);
db.transaction = async (mode, tables, fn) => fn(); // no real atomicity needed for this app's usage

let SETTINGS = null;
let STATE = { tab: 'home', theme: 'light' };

/* ---------------- utils ---------------- */
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

function fmtMoney(n){
  const cur = (SETTINGS && SETTINGS.currency) || 'MVR';
  const v = Number(n||0);
  return `${cur} ${v.toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2})}`;
}
function fmtKg(n){ return `${Number(n||0).toLocaleString(undefined,{minimumFractionDigits:1,maximumFractionDigits:2})} kg`; }
function todayISO(){ return new Date().toISOString().slice(0,10); }
function nowISO(){ return new Date().toISOString(); }
function fmtDate(iso){
  const d = new Date(iso);
  return d.toLocaleDateString(undefined,{day:'2-digit', month:'short', year:'numeric'});
}
function fmtDateTime(iso){
  const d = new Date(iso);
  return d.toLocaleDateString(undefined,{day:'2-digit', month:'short'}) + ', ' +
         d.toLocaleTimeString(undefined,{hour:'2-digit', minute:'2-digit'});
}
function pad(n,len){ return String(n).padStart(len,'0'); }
function dateCode(d){ const dt=new Date(d); return `${dt.getFullYear()}${pad(dt.getMonth()+1,2)}${pad(dt.getDate(),2)}`; }
function daysBetween(a,b){ return Math.floor((new Date(b) - new Date(a)) / 86400000); }
function toast(msg, ms=2200){
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(()=>{ el.hidden = true; }, ms);
}
function escapeHtml(s){ return String(s??'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ============================================================
   ICONS — small original line-icon set (24x24, stroke-based)
   replacing emoji throughout the app for a cleaner, consistent look.
   ============================================================ */
const ICONS = {
  home:     '<path d="M4 11L12 4l8 7"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9"/>',
  trending: '<polyline points="3,17 9,11 13,15 21,7"/><polyline points="15,7 21,7 21,13"/>',
  anchor:   '<circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="21"/><path d="M5 12a7 7 0 0 0 14 0"/><line x1="5" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="19" y2="12"/>',
  package:  '<path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/><line x1="12" y1="13" x2="12" y2="21"/>',
  dots:     '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  fish:     '<g fill="currentColor" stroke="none"><path fill-rule="evenodd" d="M21.3,12C18,8 13,6.6 8.2,7.6C5.8,8.1 4.2,9.6 3.4,12C4.2,14.4 5.8,15.9 8.2,16.4C13,17.4 18,16 21.3,12Z M19.3,10.3a0.6,0.6 0 1 0 0.02,0Z M17.6,9.2C18.1,10.7 18.1,13.3 17.6,14.8C17.1,13.3 17.1,10.7 17.6,9.2Z"/><path d="M10.5,7.6C11,5 12,3 13.4,2.2C13.6,4.3 14.2,6.2 15.2,7.9C13.5,7.5 11.9,7.4 10.5,7.6Z"/><path d="M3.6,12C2.2,9.4 1.1,6.6 0.5,3.6C2.4,6.4 3.9,9 4.7,11.3L4.7,12.7C3.9,15 2.4,17.6 0.5,20.4C1.1,17.4 2.2,14.6 3.6,12Z"/><path d="M16.3,14.1C15.9,15.7 15.2,17.1 14.2,18.2C15.5,17.2 17.1,16.1 18.1,14.5C17.5,14.2 16.9,14.1 16.3,14.1Z"/></g>',
  jar:      '<path d="M8 3.5h8"/><path d="M9 3.5L8 7h8l-1-3.5"/><path d="M6 7h12v11a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 6 18V7z"/>',
  card:     '<rect x="2" y="5" width="20" height="14" rx="2.2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="5.5" y1="15" x2="9.5" y2="15"/>',
  alert:    '<path d="M12 3.3l9.3 16.2H2.7L12 3.3z"/><line x1="12" y1="9.5" x2="12" y2="13.8"/><circle cx="12" cy="16.6" r=".95" fill="currentColor" stroke="none"/>',
  receipt:  '<path d="M6 3h12v18l-2-1.2-2 1.2-2-1.2-2 1.2-2-1.2-2 1.2V3z"/><line x1="8.5" y1="7.5" x2="15.5" y2="7.5"/><line x1="8.5" y1="11.5" x2="15.5" y2="11.5"/><line x1="8.5" y1="15.5" x2="13" y2="15.5"/>',
  chart:    '<line x1="4" y1="20" x2="20" y2="20"/><rect x="6" y="12" width="3.2" height="8"/><rect x="10.4" y="7.5" width="3.2" height="12.5"/><rect x="14.8" y="4" width="3.2" height="16"/>',
  basket:   '<path d="M4 9h16l-1.4 9.6a2.1 2.1 0 0 1-2.1 1.8H7.5a2.1 2.1 0 0 1-2.1-1.8L4 9z"/><path d="M8.2 9l1-4.2"/><path d="M15.8 9l-1-4.2"/><line x1="12" y1="12.2" x2="12" y2="16.8"/>',
  factory:  '<path d="M3 21V10.5l5.5 3.8v-3.8l5.5 3.8v-3.8l5.5 3.8V21H3z"/><line x1="3" y1="21" x2="21" y2="21"/><line x1="7" y1="7.5" x2="7" y2="10.5" />',
  users:    '<circle cx="9" cy="8" r="3"/><path d="M3.2 20c0-3.3 2.6-6 5.8-6s5.8 2.7 5.8 6"/><circle cx="17.2" cy="9" r="2.3"/><path d="M15.6 13.3c2.6.3 4.6 2.7 4.6 5.4"/>',
  arrow:    '<line x1="4" y1="12" x2="18.5" y2="12"/><polyline points="13.5,6.5 19.5,12 13.5,17.5"/>',
  share:    '<path d="M12 3.2v11.3"/><path d="M8 7.3l4-4.1 4 4.1"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  edit:     '<path d="M4 20l.8-3.7L16 5a1.6 1.6 0 0 1 2.3 0l0.7.7a1.6 1.6 0 0 1 0 2.3L8 19.2 4 20z"/><line x1="14.6" y1="6.4" x2="17.6" y2="9.4"/>',
  check:    '<circle cx="12" cy="12" r="9"/><polyline points="8,12.4 11,15.4 16,9"/>',
  tag:      '<path d="M12 2.3h5.7a2 2 0 0 1 2 2v5.7L10.2 19.5a2 2 0 0 1-2.8 0l-4.9-4.9a2 2 0 0 1 0-2.8L12 2.3z"/><circle cx="15.3" cy="7.7" r="1.3" fill="currentColor" stroke="none"/>',
  save:     '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><rect x="8" y="14" width="8" height="5"/>',
  gear:     '<circle cx="12" cy="12" r="3.1"/><path d="M19.4 13.4a7.7 7.7 0 0 0 0-2.8l1.9-1.5-2-3.4-2.3.9a7.9 7.9 0 0 0-2.4-1.4L14.2 3H9.8l-.4 2.2a7.9 7.9 0 0 0-2.4 1.4l-2.3-.9-2 3.4 1.9 1.5a7.7 7.7 0 0 0 0 2.8l-1.9 1.5 2 3.4 2.3-.9a7.9 7.9 0 0 0 2.4 1.4l.4 2.2h4.4l.4-2.2a7.9 7.9 0 0 0 2.4-1.4l2.3.9 2-3.4z"/>',
  hourglass:'<path d="M6.5 3h11"/><path d="M6.5 21h11"/><path d="M7.5 3c0 5 4.2 6.3 4.5 9-0.3 2.7-4.5 4-4.5 9"/><path d="M16.5 3c0 5-4.2 6.3-4.5 9 0.3 2.7 4.5 4 4.5 9"/>',
  x:        '<line x1="5.5" y1="5.5" x2="18.5" y2="18.5"/><line x1="18.5" y1="5.5" x2="5.5" y2="18.5"/>',
  lock:     '<rect x="5" y="10.5" width="14" height="10" rx="1.8"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'
};
function icon(name, size){
  const s = ICONS[name];
  if(!s) return '';
  const px = size || 18;
  return `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-4px; flex-shrink:0;" aria-hidden="true">${s}</svg>`;
}
// Populate any static placeholders already in the DOM (splash, nav bar, lock button)
// as soon as this script runs — no need to wait for boot(), the markup already exists.
document.querySelectorAll('[data-icon]').forEach(el=>{
  el.innerHTML = icon(el.dataset.icon, Number(el.dataset.iconSize)||20);
});

async function audit(action, entity, entityId, details){
  await db.auditLogs.add({ date: nowISO(), action, entity, entityId, details: details||'' });
}

/* transaction numbers, per-day counters */
async function nextNumber(prefix, table, dateFilterFn){
  const d = new Date();
  const code = dateCode(d);
  const all = await table.toArray();
  const countToday = all.filter(dateFilterFn(code)).length;
  return `${prefix}-${code}-${pad(countToday+1,3)}`;
}

/* ---------------- confirm dialog (custom, non-native) ---------------- */
function confirmDialog(title, message, opts={}){
  return new Promise(resolve=>{
    const sheet = $('#sheet');
    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <h2>${escapeHtml(title)}</h2>
      <p style="color:var(--muted); font-size:14px; margin-top:10px; line-height:1.5;">${escapeHtml(message)}</p>
      <div class="stack" style="margin-top:20px;">
        <button class="btn ${opts.dangerConfirm?'btn-danger':'btn-primary'} btn-block" id="cfYes">${escapeHtml(opts.yesLabel||'Confirm')}</button>
        <button class="btn btn-ghost btn-block" id="cfNo">${escapeHtml(opts.noLabel||'Cancel')}</button>
      </div>`;
    openSheet();
    $('#cfYes').onclick = ()=>{ closeSheet(); resolve(true); };
    $('#cfNo').onclick = ()=>{ closeSheet(); resolve(false); };
  });
}
function openSheet(){ $('#sheetOverlay').hidden = false; }
function closeSheet(){ $('#sheetOverlay').hidden = true; $('#sheet').innerHTML=''; }
$('#sheetOverlay').addEventListener('click', (e)=>{ if(e.target.id==='sheetOverlay') closeSheet(); });

/* ============================================================
   SETTINGS / FIRST RUN
   ============================================================ */
async function loadSettings(){
  SETTINGS = await db.settings.get(1);
  return SETTINGS;
}
async function saveSettings(patch){
  SETTINGS = { ...SETTINGS, ...patch };
  await db.settings.put(SETTINGS);
  applyTheme();
  $('#bizNameTop').textContent = SETTINGS.businessName || 'ISLAND TUNA';
}
function applyTheme(){
  const t = SETTINGS?.theme || 'light';
  if(t === 'system'){
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark?'dark':'light');
  } else {
    document.documentElement.setAttribute('data-theme', t);
  }
}

async function firstRunWizard(){
  return new Promise(resolve=>{
    let step = 0;
    const data = { businessName:'ISLAND TUNA', island:'', phone:'', currency:'MVR' };
    render();
    function render(){
      const view = $('#view');
      document.getElementById('app').hidden = true;
      let html = '';
      if(step===0){
        html = `
          <div style="min-height:80vh; display:flex; flex-direction:column; justify-content:center; gap:22px; max-width:420px; margin:0 auto;">
            <div style="text-align:center;">${icon('fish',44)}</div>
            <h1 style="text-align:center;">Welcome to Island Tuna</h1>
            <p style="text-align:center; color:var(--muted); font-size:15px;">Let's set up your business. This takes a minute — everything stays on this device.</p>
            <div class="field"><label>Business name</label><input id="fBiz" value="${escapeHtml(data.businessName)}"></div>
            <div class="field"><label>Island</label><input id="fIsland" placeholder="e.g. Hulhumalé" value="${escapeHtml(data.island)}"></div>
            <div class="field"><label>Phone number</label><input id="fPhone" placeholder="7xxxxxx" value="${escapeHtml(data.phone)}"></div>
            <div class="field"><label>Currency</label><input id="fCur" value="${escapeHtml(data.currency)}"></div>
            <button class="btn btn-primary btn-lg btn-block" id="wizNext">Continue</button>
          </div>`;
      } else {
        html = `
          <div style="min-height:80vh; display:flex; flex-direction:column; justify-content:center; gap:18px; max-width:420px; margin:0 auto;">
            <div style="text-align:center;">${icon('chart',40)}</div>
            <h1 style="text-align:center;">Load sample data?</h1>
            <p style="text-align:center; color:var(--muted); font-size:15px;">Demo mode fills the app with example customers, sales and stock so you can explore it. You can clear it anytime from Settings.</p>
            <button class="btn btn-primary btn-lg btn-block" id="wizDemo">Yes — Demo Mode</button>
            <button class="btn btn-ghost btn-lg btn-block" id="wizEmpty">No — Start Empty</button>
          </div>`;
      }
      view.innerHTML = `<div style="padding-top:20px;">${html}</div>`;
      document.getElementById('app').hidden = false;
      $('.bottomnav').style.display='none';
      $('.topbar').style.display='none';

      if(step===0){
        $('#wizNext').onclick = ()=>{
          data.businessName = $('#fBiz').value.trim() || 'ISLAND TUNA';
          data.island = $('#fIsland').value.trim();
          data.phone = $('#fPhone').value.trim();
          data.currency = $('#fCur').value.trim() || 'MVR';
          step = 1; render();
        };
      } else {
        $('#wizDemo').onclick = ()=> finish(true);
        $('#wizEmpty').onclick = ()=> finish(false);
      }
    }
    async function finish(demo){
      const view = $('#view');
      view.innerHTML = `<div style="min-height:70vh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px;">
        <div>${icon('fish',36)}</div>
        <div style="font-family:sans-serif; color:var(--muted); font-size:14px;">${demo? 'Preparing your sample data…' : 'Setting things up…'}</div>
      </div>`;
      await new Promise(r=> setTimeout(r, 30)); // let the screen paint before the work starts
      await db.settings.put({
        id:1, businessName:data.businessName, island:data.island, phone:data.phone,
        address:'', currency:data.currency, theme:'light',
        defaultFreshPrice: 90, freshTunaStock: 0, lowStockKg: 10,
        pinEnabled:false, pinHash:'', allowNegativeStock:false, demoMode:false, lastBackup:null
      });
      await loadSettings();
      await seedProductsIfEmpty();
      $('.bottomnav').style.display='';
      $('.topbar').style.display='';
      if(demo){
        try{ await loadDemoData(); }
        catch(e){ console.error('demo data failed', e); }
      }
      resolve();
    }
  });
}

/* ============================================================
   DEMO DATA
   ============================================================ */
async function loadDemoData(){
  const custNames = ['Ali','Hassan','Ibrahim','Ahmed','Mohamed'];
  const custIds = [];
  for(const n of custNames){
    const id = await db.customers.add({ name:n, phone:'7'+Math.floor(700000+Math.random()*99999), island:SETTINGS.island||'', address:'', notes:'', creditLimit:2000, active:true, balance:0, createdAt:nowISO() });
    custIds.push(id);
  }
  const supNames = ['Local Fisherman 1','Local Fisherman 2','Local Fisherman 3'];
  const supIds = [];
  for(const n of supNames){
    const id = await db.suppliers.add({ name:n, phone:'7'+Math.floor(700000+Math.random()*99999), boat:'', island:SETTINGS.island||'', notes:'', balance:0, createdAt:nowISO() });
    supIds.push(id);
  }
  // a few purchases over the last several days
  let stock = 0;
  for(let i=6;i>=0;i--){
    const d = new Date(); d.setDate(d.getDate()-i);
    const weight = 20 + Math.round(Math.random()*20);
    const price = 85 + Math.round(Math.random()*15);
    await recordPurchase({
      supplierId: supIds[i % supIds.length], supplierName: supNames[i % supIds.length],
      date: d.toISOString(), weightKg: weight, pricePerKg: price,
      paymentType: i%2===0 ? 'cash':'partial', amountPaid: i%2===0 ? weight*price : Math.round(weight*price*0.6),
      notes:'Demo data', silent:true
    });
  }
  for(let i=5;i>=0;i--){
    const d = new Date(); d.setDate(d.getDate()-i);
    const cust = custIds[i % custIds.length];
    const custName = custNames[i % custIds.length];
    const weight = 2 + Math.round(Math.random()*5);
    const price = SETTINGS.defaultFreshPrice;
    const ptype = ['cash','credit','partial','bank'][i%4];
    await recordSale({
      customerId: cust, customerName: custName, date: d.toISOString(),
      weightKg: weight, pricePerKg: price, paymentType: ptype,
      amountPaid: ptype==='partial' ? Math.round(weight*price*0.5) : undefined,
      notes:'Demo data', silent:true, skipWarnings:true
    });
  }
  // --- production, packaged sales and expenses ---
  await seedProductsIfEmpty();
  const products = await db.products.toArray();
  const dried200 = products.find(p=>p.sku==='DT-200');
  const dried500 = products.find(p=>p.sku==='DT-500');
  const rk250 = products.find(p=>p.sku==='RK-250');

  const d3 = new Date(); d3.setDate(d3.getDate()-3);
  await recordProduction({ kind:'dried', productId: dried200.id, freshUsedKg:20, finishedKg:6,
    unitsProduced:30, packagingCost:120, otherCost:80, date:d3.toISOString(), notes:'Demo batch', silent:true });
  const d2 = new Date(); d2.setDate(d2.getDate()-2);
  await recordProduction({ kind:'dried', productId: dried500.id, freshUsedKg:15, finishedKg:4.5,
    unitsProduced:9, packagingCost:70, otherCost:40, date:d2.toISOString(), notes:'Demo batch', silent:true });
  await recordProduction({ kind:'rihaakuru', productId: rk250.id, freshUsedKg:12, finishedKg:5,
    unitsProduced:20, packagingCost:140, otherCost:60, date:d2.toISOString(), notes:'Demo batch', silent:true });

  // a couple of packaged-product sales
  await recordGeneralSale({
    customerId: custIds[1], customerName: custNames[1],
    items:[
      { kind:'product', productId: dried200.id, name: dried200.name, qty:3, unitPrice: dried200.sellPrice },
      { kind:'product', productId: rk250.id, name: rk250.name, qty:2, unitPrice: rk250.sellPrice }
    ],
    discount:0, paymentType:'cash', notes:'Demo data', silent:true
  });
  await recordGeneralSale({
    customerId: custIds[3], customerName: custNames[3],
    items:[
      { kind:'fresh', name:'Fresh Yellowfin Tuna', qty:2, unitPrice: SETTINGS.defaultFreshPrice },
      { kind:'product', productId: dried500.id, name: dried500.name, qty:1, unitPrice: dried500.sellPrice }
    ],
    discount:20, paymentType:'credit', notes:'Demo data', silent:true
  });

  const expenseSeed = [
    ['Ice', 'Ice blocks for cold box', 180, 0],
    ['Vacuum bags', 'Vacuum pack rolls', 350, 1],
    ['Fuel', 'Boat fuel contribution', 400, 2],
    ['Electricity', 'Monthly electricity', 620, 3],
    ['Transport', 'Delivery to harbour', 150, 0]
  ];
  for(const [category, description, amount, daysAgo] of expenseSeed){
    const ed = new Date(); ed.setDate(ed.getDate()-daysAgo);
    await recordExpense({ category, description, amount, method:'cash', date: ed.toISOString(), silent:true });
  }

  toast('Demo data loaded');
}

async function clearAllData(){
  await db.customers.clear(); await db.suppliers.clear(); await db.sales.clear();
  await db.payments.clear(); await db.customerTx.clear(); await db.purchases.clear();
  await db.supplierPayments.clear(); await db.supplierTx.clear(); await db.inventoryTx.clear();
  await db.productionBatches.clear(); await db.expenses.clear(); await db.products.clear();
  await db.auditLogs.clear();
  await saveSettings({ freshTunaStock: 0 });
  await seedProductsIfEmpty();
}

/* ============================================================
   INVENTORY
   ============================================================ */
async function adjustInventory(deltaKg, type, refType, refId, notes){
  const newStock = Math.round(((SETTINGS.freshTunaStock||0) + deltaKg) * 1000) / 1000;
  await db.inventoryTx.add({ date: nowISO(), type, deltaKg, runningStock:newStock, refType, refId, notes: notes||'' });
  await saveSettings({ freshTunaStock: newStock });
  return newStock;
}

/* ============================================================
   CUSTOMERS & LEDGER
   ============================================================ */
async function getCustomerBalance(customerId){
  const cust = await db.customers.get(customerId);
  return cust ? (cust.balance||0) : 0;
}
async function addCustomerLedgerEntry(customerId, type, amount, refType, refId, notes){
  const cust = await db.customers.get(customerId);
  const prev = cust.balance || 0;
  const newBal = type==='credit' ? prev+amount : prev-amount;
  await db.customerTx.add({ customerId, date: nowISO(), type, amount, refType, refId, runningBalance:newBal, notes: notes||'' });
  await db.customers.update(customerId, { balance: newBal });
  return newBal;
}

/* ============================================================
   PRODUCTS (packaged: dried tuna & Rihaakuru)
   ============================================================ */
const DEFAULT_PRODUCTS = [
  { name:'Dried Tuna 100g',  type:'dried',     sku:'DT-100',  packSize:0.1,  sellPrice:60,  lowStock:10 },
  { name:'Dried Tuna 200g',  type:'dried',     sku:'DT-200',  packSize:0.2,  sellPrice:115, lowStock:10 },
  { name:'Dried Tuna 250g',  type:'dried',     sku:'DT-250',  packSize:0.25, sellPrice:140, lowStock:10 },
  { name:'Dried Tuna 500g',  type:'dried',     sku:'DT-500',  packSize:0.5,  sellPrice:270, lowStock:8  },
  { name:'Dried Tuna 1kg',   type:'dried',     sku:'DT-1000', packSize:1,    sellPrice:520, lowStock:5  },
  { name:'Rihaakuru 250g',   type:'rihaakuru', sku:'RK-250',  packSize:0.25, sellPrice:85,  lowStock:8  },
  { name:'Rihaakuru 500g',   type:'rihaakuru', sku:'RK-500',  packSize:0.5,  sellPrice:160, lowStock:8  },
  { name:'Rihaakuru 1kg',    type:'rihaakuru', sku:'RK-1000', packSize:1,    sellPrice:300, lowStock:5  }
];

async function seedProductsIfEmpty(){
  const existing = await db.products.toArray();
  if(existing.length) return;
  for(const p of DEFAULT_PRODUCTS){
    await db.products.add({ ...p, costPrice:0, stock:0, active:true, createdAt: nowISO() });
  }
}

/** Change a packaged product's stock and log the movement. */
async function adjustProductStock(productId, deltaUnits, type, refType, refId, notes){
  const p = await db.products.get(productId);
  if(!p) return null;
  const newStock = Math.round(((p.stock||0) + deltaUnits) * 100) / 100;
  await db.products.update(productId, { stock: newStock });
  await db.inventoryTx.add({
    date: nowISO(), type, deltaKg: 0, deltaUnits, productId, productName: p.name,
    runningStock: newStock, refType, refId, notes: notes||''
  });
  return newStock;
}

/* ============================================================
   PRODUCTION (dried tuna & Rihaakuru batches)
   ============================================================ */
async function recordProduction({kind, productId, freshUsedKg, finishedKg, unitsProduced, packagingCost, otherCost, notes, date, silent}){
  freshUsedKg = Number(freshUsedKg||0);
  unitsProduced = Number(unitsProduced||0);
  finishedKg = Number(finishedKg||0);
  packagingCost = Number(packagingCost||0);
  otherCost = Number(otherCost||0);
  if(!(freshUsedKg>0)) throw new Error('Fresh tuna used must be greater than 0.');
  if(!(unitsProduced>0)) throw new Error('Number of packs produced must be greater than 0.');
  if(packagingCost<0 || otherCost<0) throw new Error('Costs cannot be negative.');

  if((SETTINGS.freshTunaStock||0) < freshUsedKg && !SETTINGS.allowNegativeStock && !silent){
    const ok = await confirmDialog('Not enough fresh tuna',
      `Only ${fmtKg(SETTINGS.freshTunaStock||0)} in stock but this batch uses ${fmtKg(freshUsedKg)}. Continue anyway?`,
      {yesLabel:'Continue', dangerConfirm:true});
    if(!ok) return null;
  }

  const product = await db.products.get(productId);
  const avgCost = await averageFreshCostPerKg();
  const freshCost = Math.round(avgCost * freshUsedKg * 100) / 100;
  const totalCost = Math.round((freshCost + packagingCost + otherCost) * 100) / 100;
  const costPerUnit = unitsProduced ? Math.round((totalCost/unitsProduced)*100)/100 : 0;
  const expectedValue = product ? Math.round(product.sellPrice * unitsProduced * 100)/100 : 0;

  const prefix = kind==='dried' ? 'DT' : 'RK';
  const batchNo = await nextNumber(prefix, db.productionBatches, code => b => b.batchNo && b.batchNo.includes(code));

  const id = await db.productionBatches.add({
    batchNo, kind, date: date||nowISO(), productId, productName: product?.name || '',
    freshUsedKg, finishedKg, unitsProduced, packagingCost, otherCost,
    freshCost, totalCost, costPerUnit, expectedValue,
    expectedProfit: Math.round((expectedValue - totalCost)*100)/100,
    notes: notes||'', createdAt: nowISO()
  });

  await adjustInventory(-freshUsedKg, 'production_usage', 'production', id, `Used in batch ${batchNo}`);
  await adjustProductStock(productId, unitsProduced, 'production_output', 'production', id, `Produced in batch ${batchNo}`);
  // keep the product's cost price current so profit figures stay meaningful
  if(costPerUnit>0) await db.products.update(productId, { costPrice: costPerUnit });

  await audit('create','production',id, `${batchNo} ${unitsProduced} units`);
  if(!silent) toast(`Batch saved · ${batchNo}`);
  return { id, batchNo, totalCost, costPerUnit };
}

/** Weighted average purchase cost per kg of fresh tuna, used for cost estimates. */
async function averageFreshCostPerKg(){
  const purchases = (await db.purchases.toArray()).filter(p=>!p.voided);
  const totalKg = purchases.reduce((a,p)=>a+p.weightKg,0);
  const totalCost = purchases.reduce((a,p)=>a+p.total,0);
  return totalKg>0 ? totalCost/totalKg : 0;
}

/* ============================================================
   EXPENSES
   ============================================================ */
const EXPENSE_CATEGORIES = ['Ice','Packaging','Vacuum bags','Bottles','Labels','Electricity','Transport','Fuel','Equipment','Repairs','Cleaning','Other'];

async function recordExpense({date, category, description, amount, method, notes, silent}){
  amount = Number(amount);
  if(!(amount>0)) throw new Error('Amount must be greater than 0.');
  const id = await db.expenses.add({
    date: date||nowISO(), category: category||'Other', description: description||'',
    amount, method: method||'cash', notes: notes||'', createdAt: nowISO()
  });
  await audit('create','expense',id, `${category} ${fmtMoney(amount)}`);
  if(!silent) toast('Expense saved');
  return id;
}

/* ============================================================
   GENERAL (multi-product) SALE
   ============================================================ */
async function recordGeneralSale({customerId, customerName, items, discount, paymentType, amountPaid, notes, date, silent}){
  // items: [{ kind:'fresh'|'product', productId?, name, qty, unitPrice }]
  if(!items || !items.length) throw new Error('Add at least one item to the sale.');
  let subtotal = 0;
  for(const it of items){
    if(!(it.qty>0)) throw new Error(`Quantity for ${it.name} must be greater than 0.`);
    if(it.unitPrice<0) throw new Error('Price cannot be negative.');
    it.lineTotal = Math.round(it.qty * it.unitPrice * 100)/100;
    subtotal += it.lineTotal;
  }
  discount = Number(discount||0);
  if(discount<0) throw new Error('Discount cannot be negative.');
  const total = Math.round((subtotal - discount)*100)/100;
  if(total<0) throw new Error('Discount cannot be more than the subtotal.');

  let paid, balance;
  if(paymentType==='credit'){ paid=0; balance=total; }
  else if(paymentType==='partial'){
    paid = Number(amountPaid||0);
    if(paid<0) throw new Error('Amount paid cannot be negative.');
    if(paid>total) paid = total;
    balance = Math.round((total-paid)*100)/100;
  } else { paid=total; balance=0; }

  if(!silent){
    // stock checks
    for(const it of items){
      if(it.kind==='fresh' && (SETTINGS.freshTunaStock||0) < it.qty && !SETTINGS.allowNegativeStock){
        const ok = await confirmDialog('Not enough fresh tuna', `Only ${fmtKg(SETTINGS.freshTunaStock||0)} in stock. Sell anyway?`, {yesLabel:'Sell anyway', dangerConfirm:true});
        if(!ok) return null;
      }
      if(it.kind==='product'){
        const p = await db.products.get(it.productId);
        if(p && (p.stock||0) < it.qty && !SETTINGS.allowNegativeStock){
          const ok = await confirmDialog('Not enough stock', `Only ${p.stock} of ${p.name} in stock. Sell anyway?`, {yesLabel:'Sell anyway', dangerConfirm:true});
          if(!ok) return null;
        }
      }
    }
    if(balance>0 && customerId){
      const cust = await db.customers.get(customerId);
      const limit = cust?.creditLimit||0;
      const newBal = (cust?.balance||0)+balance;
      if(cust && (cust.balance||0) > 0){
        const ok = await confirmDialog('Existing balance', `${cust.name} already owes ${fmtMoney(cust.balance)}. This sale adds ${fmtMoney(balance)}, bringing the total to ${fmtMoney(newBal)}. Continue?`, {yesLabel:'Continue'});
        if(!ok) return null;
      }
      if(limit>0 && newBal>limit){
        const ok = await confirmDialog('Credit limit exceeded', `${cust.name}'s balance would become ${fmtMoney(newBal)}, above their limit of ${fmtMoney(limit)}. Continue anyway?`, {yesLabel:'Continue', dangerConfirm:true});
        if(!ok) return null;
      }
    }
  }

  const saleNo = await nextNumber('SALE', db.sales, code => s => s.saleNo && s.saleNo.includes(code));
  const weightKg = items.filter(i=>i.kind==='fresh').reduce((a,i)=>a+i.qty,0);
  const id = await db.sales.add({
    saleNo, date: date||nowISO(), customerId: customerId||null, customerName: customerName||'Walk-in',
    items, subtotal, discount, total, paid, balance, paymentType, weightKg,
    pricePerKg: weightKg? Math.round((items.find(i=>i.kind==='fresh').unitPrice)*100)/100 : 0,
    status: balance<=0?'paid':(paid>0?'partial':'credit'),
    notes: notes||'', createdAt: nowISO(), voided:false, multi:true
  });

  for(const it of items){
    if(it.kind==='fresh') await adjustInventory(-it.qty, 'sale', 'sale', id, `Sale ${saleNo}`);
    else await adjustProductStock(it.productId, -it.qty, 'sale', 'sale', id, `Sale ${saleNo}`);
  }
  if(balance>0 && customerId){
    await addCustomerLedgerEntry(customerId, 'credit', balance, 'sale', id, `Sale ${saleNo}`);
  }
  await audit('create','sale',id, `${saleNo} ${items.length} items`);
  if(!silent) toast(`Sale saved · ${saleNo}`);
  return { id, saleNo, total, paid, balance };
}

/* ============================================================
   SALES (Fresh Tuna)
   ============================================================ */
async function recordSale({customerId, customerName, date, weightKg, pricePerKg, paymentType, amountPaid, notes, skipWarnings, silent}){
  weightKg = Number(weightKg); pricePerKg = Number(pricePerKg);
  if(!(weightKg>0)) throw new Error('Weight must be greater than 0.');
  if(!(pricePerKg>=0)) throw new Error('Price cannot be negative.');
  const total = Math.round(weightKg*pricePerKg*100)/100;
  let paid, balance;
  if(paymentType==='credit'){ paid = 0; balance = total; }
  else if(paymentType==='partial'){
    paid = Number(amountPaid||0);
    if(paid < 0) throw new Error('Amount paid cannot be negative.');
    if(paid > total) paid = total;
    balance = Math.round((total-paid)*100)/100;
  } else { paid = total; balance = 0; } // cash or bank

  if(!skipWarnings){
    if((SETTINGS.freshTunaStock||0) < weightKg && !SETTINGS.allowNegativeStock){
      const ok = await confirmDialog('Not enough stock', `Only ${fmtKg(SETTINGS.freshTunaStock||0)} of fresh tuna in stock. Sell anyway? Stock will go negative.`, {yesLabel:'Sell anyway', dangerConfirm:true});
      if(!ok) return null;
    }
    if(balance > 0 && customerId){
      const cust = await db.customers.get(customerId);
      const limit = cust?.creditLimit || 0;
      const newBal = (cust?.balance||0) + balance;
      if(limit>0 && newBal > limit){
        const ok = await confirmDialog('Credit limit exceeded', `${cust.name}'s balance would become ${fmtMoney(newBal)}, above their limit of ${fmtMoney(limit)}. Continue anyway?`, {yesLabel:'Continue', dangerConfirm:true});
        if(!ok) return null;
      }
    }
  }

  const saleNo = await nextNumber('SALE', db.sales, code => s => s.saleNo && s.saleNo.includes(code));
  const id = await db.sales.add({
    saleNo, date: date||nowISO(), customerId: customerId||null, customerName: customerName||'Walk-in',
    weightKg, pricePerKg, total, paid, balance, paymentType, status: balance<=0?'paid':(paid>0?'partial':'credit'),
    notes: notes||'', createdAt: nowISO(), voided:false
  });
  const newStock = await adjustInventory(-weightKg, 'sale', 'sale', id, `Sale ${saleNo}`);
  if(balance>0 && customerId){
    await addCustomerLedgerEntry(customerId, 'credit', balance, 'sale', id, `Fresh tuna ${fmtKg(weightKg)} — ${saleNo}`);
  }
  await audit('create','sale',id,`${saleNo} ${fmtKg(weightKg)} @ ${pricePerKg}`);
  if(!silent) toast(`Sale saved · ${saleNo}`);
  return { id, saleNo, total, paid, balance, newStock };
}

async function voidSale(saleId){
  const sale = await db.sales.get(saleId);
  if(!sale || sale.voided) return;
  await db.sales.update(saleId, { voided:true, voidedAt: nowISO() });
  if(sale.items && sale.items.length){
    for(const it of sale.items){
      if(it.kind==='fresh') await adjustInventory(it.qty, 'adjustment', 'void_sale', saleId, `Reversal of voided sale ${sale.saleNo}`);
      else await adjustProductStock(it.productId, it.qty, 'adjustment', 'void_sale', saleId, `Reversal of voided sale ${sale.saleNo}`);
    }
  } else {
    await adjustInventory(sale.weightKg, 'adjustment', 'void_sale', saleId, `Reversal of voided sale ${sale.saleNo}`);
  }
  if(sale.balance>0 && sale.customerId){
    await addCustomerLedgerEntry(sale.customerId, 'payment', sale.balance, 'void_sale', saleId, `Reversal of voided sale ${sale.saleNo}`);
  }
  await audit('void','sale',saleId, sale.saleNo);
  toast('Sale voided');
}

/** Record a payment against one specific sale — settles that sale's own
    balance/status and mirrors the same amount as a payment in the
    customer's overall ledger, so the two stay consistent. */
async function recordSalePayment(saleId, amount){
  const sale = await db.sales.get(saleId);
  if(!sale || sale.voided) throw new Error('Sale not found');
  amount = Number(amount);
  if(!(amount>0)) throw new Error('Enter a payment amount greater than 0.');
  if(amount > sale.balance + 0.001) amount = sale.balance; // never overshoot this sale's own balance

  const newPaid = Math.round((sale.paid+amount)*100)/100;
  const newBalance = Math.round((sale.total-newPaid)*100)/100;
  const newStatus = newBalance<=0.001 ? 'paid' : 'partial';
  await db.sales.update(saleId, { paid:newPaid, balance:Math.max(0,newBalance), status:newStatus });

  if(sale.customerId){
    await addCustomerLedgerEntry(sale.customerId, 'payment', amount, 'sale_payment', saleId, `Payment against ${sale.saleNo}`);
    await db.payments.add({ customerId: sale.customerId, amount, method:'cash', date: nowISO(), notes:`Against ${sale.saleNo}`, createdAt: nowISO() });
  }
  await audit('update','sale',saleId, `Payment of ${fmtMoney(amount)} recorded, now ${newStatus}`);
  return { newPaid, newBalance: Math.max(0,newBalance), newStatus };
}

/* ============================================================
   PURCHASES (Fresh Tuna from suppliers)
   ============================================================ */
async function recordPurchase({supplierId, supplierName, date, weightKg, pricePerKg, paymentType, amountPaid, notes, silent}){
  weightKg = Number(weightKg); pricePerKg = Number(pricePerKg);
  if(!(weightKg>0)) throw new Error('Weight must be greater than 0.');
  if(!(pricePerKg>=0)) throw new Error('Price cannot be negative.');
  const total = Math.round(weightKg*pricePerKg*100)/100;
  let paid, balance;
  if(paymentType==='credit'){ paid=0; balance=total; }
  else if(paymentType==='partial'){
    paid = Number(amountPaid||0);
    if(paid>total) paid = total;
    balance = Math.round((total-paid)*100)/100;
  } else { paid = total; balance = 0; }

  const purchaseNo = await nextNumber('PUR', db.purchases, code => p => p.purchaseNo && p.purchaseNo.includes(code));
  const id = await db.purchases.add({
    purchaseNo, date: date||nowISO(), supplierId: supplierId||null, supplierName: supplierName||'Unknown',
    weightKg, pricePerKg, total, paid, balance, paymentType,
    status: balance<=0?'paid':(paid>0?'partial':'credit'), notes: notes||'', createdAt: nowISO(), voided:false
  });
  await adjustInventory(weightKg, 'purchase', 'purchase', id, `Purchase ${purchaseNo}`);
  if(balance>0 && supplierId){
    const sup = await db.suppliers.get(supplierId);
    const prev = sup.balance||0;
    const newBal = prev+balance;
    await db.supplierTx.add({ supplierId, date:nowISO(), type:'credit', amount:balance, refType:'purchase', refId:id, runningBalance:newBal, notes:`${fmtKg(weightKg)} — ${purchaseNo}` });
    await db.suppliers.update(supplierId, { balance:newBal });
  }
  await audit('create','purchase',id,`${purchaseNo} ${fmtKg(weightKg)} @ ${pricePerKg}`);
  if(!silent) toast(`Purchase saved · ${purchaseNo}`);
  return { id, purchaseNo, total, paid, balance };
}

async function recordSupplierPayment({supplierId, amount, method, date, notes}){
  amount = Number(amount);
  if(!(amount>0)) throw new Error('Payment amount must be greater than 0.');
  const id = await db.supplierPayments.add({ supplierId, amount, method, date: date||nowISO(), notes: notes||'', createdAt: nowISO() });
  const sup = await db.suppliers.get(supplierId);
  const prev = sup.balance||0;
  const newBal = Math.round((prev-amount)*100)/100;
  await db.supplierTx.add({ supplierId, date: nowISO(), type:'payment', amount, refType:'payment', refId:id, runningBalance:newBal, notes: notes||'' });
  await db.suppliers.update(supplierId, { balance:newBal });
  await audit('create','supplierPayment',id, `${fmtMoney(amount)} to supplier ${supplierId}`);
  toast('Payment recorded');
  return newBal;
}

/* ============================================================
   ROUTER / SHELL
   ============================================================ */
function setTab(tab){
  STATE.tab = tab;
  $$('.navbtn').forEach(b=> b.classList.toggle('active', b.dataset.tab===tab));
  renderView();
}
$$('.navbtn').forEach(b=> b.addEventListener('click', ()=> setTab(b.dataset.tab)));

function renderView(){
  const view = $('#view');
  switch(STATE.tab){
    case 'home': return renderHome(view);
    case 'sales': return renderSalesList(view);
    case 'purchases': return renderPurchasesList(view);
    case 'inventory': return renderInventory(view);
    case 'more': return renderMore(view);
    case 'customers': return renderCustomers(view);
    case 'customerDetail': return renderCustomerDetail(view, STATE.customerId);
    case 'suppliers': return renderSuppliers(view);
    case 'supplierDetail': return renderSupplierDetail(view, STATE.supplierId);
    case 'credit': return renderCreditDashboard(view);
    case 'reports': return renderReports(view);
    case 'products': return renderProducts(view);
    case 'production': return renderProduction(view);
    case 'expenses': return renderExpenses(view);
    case 'backup': return renderBackup(view);
    case 'settings': return renderSettings(view);
    case 'comingSoon': return renderComingSoon(view, STATE.comingSoonLabel);
    default: return renderHome(view);
  }
}
function go(tab, extra){ Object.assign(STATE, extra||{}); STATE.tab = tab;
  $$('.navbtn').forEach(b=> b.classList.toggle('active', b.dataset.tab===tab));
  renderView(); $('.view').scrollTop = 0;
}

/* ============================================================
   HOME / DASHBOARD
   ============================================================ */
async function renderHome(view){
  const today = todayISO();
  const [sales, purchases, customers, products, expenses] = await Promise.all([
    db.sales.toArray(), db.purchases.toArray(), db.customers.toArray(),
    db.products.toArray(), db.expenses.toArray()
  ]);
  const todaySales = sales.filter(s=>!s.voided && s.date.slice(0,10)===today);
  const todayPurchases = purchases.filter(p=>!p.voided && p.date.slice(0,10)===today);
  const todayExpenses = expenses.filter(e=>e.date.slice(0,10)===today);
  const todaySalesTotal = todaySales.reduce((a,s)=>a+s.total,0);
  const todayPurchasesTotal = todayPurchases.reduce((a,p)=>a+p.total,0);
  const todayExpensesTotal = todayExpenses.reduce((a,e)=>a+e.amount,0);
  const totalCredit = customers.reduce((a,c)=>a+(c.balance||0),0);
  const custWithCredit = customers.filter(c=>(c.balance||0)>0);

  const driedPacks = products.filter(p=>p.type==='dried').reduce((a,p)=>a+(p.stock||0),0);
  const rkBottles = products.filter(p=>p.type==='rihaakuru').reduce((a,p)=>a+(p.stock||0),0);
  const lowStockProducts = products.filter(p=>p.active!==false && (p.stock||0) <= (p.lowStock||0));

  // estimated profit today
  const avgBuy = await averageFreshCostPerKg();
  let cogs = 0;
  for(const s of todaySales){
    const lines = s.items && s.items.length ? s.items
      : [{ kind:'fresh', qty:s.weightKg, unitPrice:s.pricePerKg }];
    for(const l of lines){
      if(l.kind==='fresh') cogs += avgBuy*l.qty;
      else { const p = products.find(x=>x.id===l.productId); cogs += (p?.costPrice||0)*l.qty; }
    }
  }
  const todayProfit = todaySalesTotal - cogs - todayExpensesTotal;

  view.innerHTML = `
    <div class="section">
      <div class="eyebrow">${fmtDate(nowISO())}</div>
      <h1>${escapeHtml(SETTINGS.businessName||'Island Tuna')}</h1>
      ${SETTINGS.island? `<div style="color:var(--muted); font-size:14px; margin-top:2px;">${escapeHtml(SETTINGS.island)}</div>` : ''}
    </div>

    <div class="section hero-card">
      <div class="label">Today's Sales</div>
      <div class="value num">${fmtMoney(todaySalesTotal)}</div>
      <div class="sub">${todaySales.length} sale${todaySales.length===1?'':'s'} · est. profit ${fmtMoney(todayProfit)}</div>
    </div>

    <div class="section grid2">
      <div class="card stat-card tappable" data-nav="inventory"><div class="label">${icon('fish')} Fresh Tuna</div><div class="value num">${fmtKg(SETTINGS.freshTunaStock||0)}</div>
        ${(SETTINGS.freshTunaStock||0) <= (SETTINGS.lowStockKg||10) ? '<div class="sub" style="color:var(--coral)">Low stock</div>' : '<div class="sub">In stock</div>'}</div>
      <div class="card stat-card tappable" data-nav="inventory"><div class="label">${icon('package')} Dried Tuna</div><div class="value num">${driedPacks}</div><div class="sub">packs available</div></div>
      <div class="card stat-card tappable" data-nav="inventory"><div class="label">${icon('jar')} Rihaakuru</div><div class="value num">${rkBottles}</div><div class="sub">bottles available</div></div>
      <div class="card stat-card tappable" data-nav="purchases"><div class="label">${icon('anchor')} Today's Purchases</div><div class="value num" style="font-size:18px;">${fmtMoney(todayPurchasesTotal)}</div><div class="sub">${todayPurchases.length} purchase${todayPurchases.length===1?'':'s'}</div></div>
      <div class="card stat-card tappable" data-nav="expenses"><div class="label">${icon('receipt')} Today's Expenses</div><div class="value num" style="font-size:18px;">${fmtMoney(todayExpensesTotal)}</div><div class="sub">${todayExpenses.length} entr${todayExpenses.length===1?'y':'ies'}</div></div>
      <div class="card stat-card tappable" data-nav="credit"><div class="label">${icon('card')} Customer Credit</div><div class="value num" style="font-size:18px;">${fmtMoney(totalCredit)}</div><div class="sub">${custWithCredit.length} owing</div></div>
    </div>

    ${custWithCredit.length>0 ? `
    <div class="section">
      <div class="warn-banner" id="creditWarnBanner" style="cursor:pointer;">
        <div><div class="wtitle">${icon('alert',16)} Credit requires attention</div><div class="wsub">${custWithCredit.length} customers owe you · Total ${fmtMoney(totalCredit)}</div></div>
        <span class="chev">›</span>
      </div>
    </div>` : ''}

    ${lowStockProducts.length>0 ? `
    <div class="section">
      <div class="warn-banner" id="lowStockBanner" style="cursor:pointer;">
        <div><div class="wtitle">${icon('package',16)} Low stock</div><div class="wsub">${lowStockProducts.map(p=>escapeHtml(p.name)).slice(0,3).join(', ')}${lowStockProducts.length>3? ` +${lowStockProducts.length-3} more`:''}</div></div>
        <span class="chev">›</span>
      </div>
    </div>` : ''}

    <div class="section">
      <h2>Quick Actions</h2>
      <button class="btn btn-primary btn-lg btn-block" id="qaSell" style="margin-top:10px;">${icon('fish')} Sell Tuna</button>
      <div class="quick-grid">
        <button class="quick-btn" id="qaGeneralSale"><span class="qicon">${icon('basket')}</span>Multi-Item Sale</button>
        <button class="quick-btn" id="qaPurchase"><span class="qicon">${icon('anchor')}</span>Record Purchase</button>
        <button class="quick-btn" id="qaPayment"><span class="qicon">${icon('card')}</span>Record Payment</button>
        <button class="quick-btn" id="qaExpense"><span class="qicon">${icon('receipt')}</span>Add Expense</button>
        <button class="quick-btn" id="qaProduction"><span class="qicon">${icon('factory')}</span>Add Production</button>
        <button class="quick-btn" id="qaCustomer"><span class="qicon">${icon('users')}</span>Add Customer</button>
      </div>
    </div>
  `;
  $$('.stat-card.tappable', view).forEach(card=> card.addEventListener('click', ()=> go(card.dataset.nav)));
  $('#qaSell')?.addEventListener('click', openQuickSale);
  $('#qaGeneralSale')?.addEventListener('click', openGeneralSale);
  $('#qaPurchase')?.addEventListener('click', openQuickPurchase);
  $('#qaPayment')?.addEventListener('click', ()=> openPaymentPicker());
  $('#qaExpense')?.addEventListener('click', openExpenseForm);
  $('#qaProduction')?.addEventListener('click', ()=> go('production'));
  $('#qaCustomer')?.addEventListener('click', ()=> openCustomerForm());
  $('#creditWarnBanner')?.addEventListener('click', ()=> go('credit'));
  $('#lowStockBanner')?.addEventListener('click', ()=> go('products'));
}

/* ============================================================
   QUICK SALE (fresh tuna) — the core, fast flow
   ============================================================ */
async function openQuickSale(){
  const customers = (await db.customers.toArray()).filter(c=>c.active!==false);
  let selectedCustomer = null; // null = walk-in
  let paymentType = 'cash';

  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header"><h2>Fresh Tuna Sale</h2><button class="sheet-close" id="scClose">${icon('x',16)}</button></div>
    <div class="field">
      <label>Customer</label>
      <div class="pill-row" id="custPills">
        <button class="customer-pill active" data-id="">Walk-in</button>
        ${customers.map(c=>`<button class="customer-pill" data-id="${c.id}">${escapeHtml(c.name)}</button>`).join('')}
        <button class="customer-pill" id="pillNewCust" style="border-style:dashed;">+ New Customer</button>
      </div>
    </div>
    <div class="field"><label>Weight (kg)</label><input type="number" inputmode="decimal" step="0.01" id="sWeight" placeholder="0.0" autofocus></div>
    <div class="field"><label>Price per kg (${SETTINGS.currency})</label><input type="number" inputmode="decimal" step="0.01" id="sPrice" value="${SETTINGS.defaultFreshPrice||''}"></div>
    <div class="card" style="background:var(--foam); border:none; margin-bottom:14px;">
      <div class="totalline grand"><span>Total</span><span class="num" id="sTotal">${fmtMoney(0)}</span></div>
    </div>
    <div class="field">
      <label>Payment</label>
      <div class="seg" id="payType">
        <button data-v="cash" class="active">Cash</button>
        <button data-v="bank">Bank</button>
        <button data-v="credit">Credit</button>
        <button data-v="partial">Partial</button>
      </div>
    </div>
    <div class="field" id="partialField" hidden><label>Amount paid now (${SETTINGS.currency})</label><input type="number" step="0.01" id="sPartialAmt"></div>
    <div class="field"><label>Notes (optional)</label><input id="sNotes" placeholder="Add a note"></div>
    <button class="btn btn-primary btn-lg btn-block" id="sSave">Save Sale</button>
  `;
  openSheet();
  $('#scClose').onclick = closeSheet;

  function recalc(){
    const w = Number($('#sWeight').value||0), p = Number($('#sPrice').value||0);
    $('#sTotal').textContent = fmtMoney(w*p);
  }
  $('#sWeight').addEventListener('input', recalc);
  $('#sPrice').addEventListener('input', recalc);

  $('#custPills').addEventListener('click', (e)=>{
    const btn = e.target.closest('.customer-pill'); if(!btn) return;
    if(btn.id==='pillNewCust'){ openCustomerForm(async (newCust)=>{ await openQuickSale(); const pills = $('#custPills'); }); return; }
    $$('.customer-pill', $('#custPills')).forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const id = btn.dataset.id;
    selectedCustomer = id ? customers.find(c=>String(c.id)===id) : null;
  });

  $('#payType').addEventListener('click', (e)=>{
    const btn = e.target.closest('button'); if(!btn) return;
    $$('#payType button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    paymentType = btn.dataset.v;
    $('#partialField').hidden = paymentType!=='partial';
  });

  $('#sSave').onclick = async ()=>{
    try{
      const weightKg = Number($('#sWeight').value);
      const pricePerKg = Number($('#sPrice').value);
      if(!(weightKg>0)){ toast('Enter a weight greater than 0'); return; }
      if(paymentType==='credit' && !selectedCustomer){ toast('Select a customer for credit sales'); return; }
      const amountPaid = $('#sPartialAmt').value ? Number($('#sPartialAmt').value) : undefined;
      if(paymentType==='partial' && !(amountPaid>=0)){ toast('Enter amount paid'); return; }
      const result = await recordSale({
        customerId: selectedCustomer?.id, customerName: selectedCustomer?.name || 'Walk-in',
        weightKg, pricePerKg, paymentType, amountPaid, notes: $('#sNotes').value.trim()
      });
      if(result){ closeSheet(); renderView(); }
    }catch(err){ toast(err.message); }
  };
}

async function openQuickPurchase(){
  const suppliers = await db.suppliers.toArray();
  let selectedSupplier = suppliers[0] || null;
  let paymentType = 'cash';
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header"><h2>Record Purchase</h2><button class="sheet-close" id="pcClose">${icon('x',16)}</button></div>
    <div class="field">
      <label>Supplier / Fisherman</label>
      <select id="pSupplier">
        ${suppliers.length? suppliers.map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('') : '<option value="">No suppliers yet</option>'}
      </select>
      <button class="link-btn" id="pNewSupplier" style="margin-top:8px;">+ New supplier</button>
    </div>
    <div class="field"><label>Weight (kg)</label><input type="number" step="0.01" id="pWeight" placeholder="0.0"></div>
    <div class="field"><label>Price per kg (${SETTINGS.currency})</label><input type="number" step="0.01" id="pPrice"></div>
    <div class="card" style="background:var(--foam); border:none; margin-bottom:14px;">
      <div class="totalline grand"><span>Total</span><span class="num" id="pTotal">${fmtMoney(0)}</span></div>
    </div>
    <div class="field">
      <label>Payment</label>
      <div class="seg" id="pPayType">
        <button data-v="cash" class="active">Paid</button>
        <button data-v="partial">Partial</button>
        <button data-v="credit">Credit</button>
      </div>
    </div>
    <div class="field" id="pPartialField" hidden><label>Amount paid now</label><input type="number" step="0.01" id="pPartialAmt"></div>
    <div class="field"><label>Notes (optional)</label><input id="pNotes"></div>
    <button class="btn btn-primary btn-lg btn-block" id="pSave">Save Purchase</button>
  `;
  openSheet();
  $('#pcClose').onclick = closeSheet;
  function recalc(){ const w=Number($('#pWeight').value||0), p=Number($('#pPrice').value||0); $('#pTotal').textContent = fmtMoney(w*p); }
  $('#pWeight').addEventListener('input', recalc);
  $('#pPrice').addEventListener('input', recalc);
  $('#pPayType').addEventListener('click', e=>{
    const btn = e.target.closest('button'); if(!btn) return;
    $$('#pPayType button').forEach(b=>b.classList.remove('active')); btn.classList.add('active');
    paymentType = btn.dataset.v; $('#pPartialField').hidden = paymentType!=='partial';
  });
  $('#pNewSupplier').onclick = ()=> openSupplierForm(async ()=>{ await openQuickPurchase(); });
  $('#pSave').onclick = async ()=>{
    try{
      const supplierId = Number($('#pSupplier').value);
      if(!supplierId){ toast('Add a supplier first'); return; }
      const supplier = suppliers.find(s=>s.id===supplierId);
      const weightKg = Number($('#pWeight').value);
      const pricePerKg = Number($('#pPrice').value);
      if(!(weightKg>0)){ toast('Enter a weight greater than 0'); return; }
      const amountPaid = $('#pPartialAmt').value ? Number($('#pPartialAmt').value) : undefined;
      await recordPurchase({ supplierId, supplierName: supplier.name, weightKg, pricePerKg, paymentType, amountPaid, notes: $('#pNotes').value.trim() });
      closeSheet(); renderView();
    }catch(err){ toast(err.message); }
  };
}

/* payment picker: choose customer then open payment form */
async function openPaymentPicker(){
  const customers = (await db.customers.toArray()).filter(c=>(c.balance||0)>0).sort((a,b)=>(b.balance||0)-(a.balance||0));
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header"><h2>Record Payment</h2><button class="sheet-close" id="ppClose">${icon('x',16)}</button></div>
    ${customers.length===0 ? '<div class="empty">No customers currently owe you money.</div>' : `
    <div class="list-card">
      ${customers.map(c=>`
        <div class="list-item" data-id="${c.id}" style="cursor:pointer;">
          <div class="li-main"><div class="li-title">${escapeHtml(c.name)}</div></div>
          <div class="li-right"><div class="li-amount num">${fmtMoney(c.balance)}</div></div>
        </div>`).join('')}
    </div>`}
  `;
  openSheet();
  $('#ppClose').onclick = closeSheet;
  $$('.list-item', sheet).forEach(li=> li.addEventListener('click', ()=>{
    const id = Number(li.dataset.id);
    openPaymentForm(id);
  }));
}

async function openPaymentForm(customerId){
  const cust = await db.customers.get(customerId);
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header"><h2>Record Payment</h2><button class="sheet-close" id="pfClose">${icon('x',16)}</button></div>
    <div class="card" style="margin-bottom:16px;">
      <div class="row"><span style="color:var(--muted); font-size:13.5px;">${escapeHtml(cust.name)}</span><span class="num" style="font-weight:700;">${fmtMoney(cust.balance)}</span></div>
      <div style="font-size:12px; color:var(--muted); margin-top:2px;">Outstanding balance</div>
    </div>
    <div class="field"><label>Payment amount (${SETTINGS.currency})</label><input type="number" step="0.01" id="payAmt" value="${cust.balance}"></div>
    <div class="field">
      <label>Payment method</label>
      <div class="seg" id="payMethod"><button data-v="cash" class="active">Cash</button><button data-v="bank">Bank/Online</button><button data-v="other">Other</button></div>
    </div>
    <div class="field"><label>Notes (optional)</label><input id="payNotes"></div>
    <button class="btn btn-primary btn-lg btn-block" id="paySave">Save Payment</button>
  `;
  openSheet();
  $('#pfClose').onclick = closeSheet;
  let method = 'cash';
  $('#payMethod').addEventListener('click', e=>{
    const btn = e.target.closest('button'); if(!btn) return;
    $$('#payMethod button').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); method = btn.dataset.v;
  });
  $('#paySave').onclick = async ()=>{
    const amount = Number($('#payAmt').value);
    if(!(amount>0)){ toast('Enter a payment amount'); return; }
    const newBal = await addCustomerLedgerEntry(customerId, 'payment', amount, 'payment', null, $('#payNotes').value.trim());
    await db.payments.add({ customerId, amount, method, date: nowISO(), notes: $('#payNotes').value.trim(), createdAt: nowISO() });
    await audit('create','payment',customerId, `${fmtMoney(amount)}`);
    toast(`Payment saved · New balance ${fmtMoney(newBal)}`);
    closeSheet(); renderView();
  };
}

/* ============================================================
   SALES LIST
   ============================================================ */
async function renderSalesList(view){
  STATE.salesFilter = STATE.salesFilter || 'today';
  const sales = (await db.sales.orderBy('date').reverse().toArray());
  const filtered = filterByPeriod(sales, STATE.salesFilter);
  const q = (STATE.salesSearch||'').toLowerCase();
  const shown = q ? filtered.filter(s=> s.customerName.toLowerCase().includes(q) || s.saleNo.toLowerCase().includes(q)) : filtered;
  const totalToday = shown.reduce((a,s)=> s.voided?a:a+s.total, 0);

  view.innerHTML = `
    <div class="section row"><h1>Sales</h1></div>
    <div class="searchbar"><input id="salesSearch" placeholder="Search by customer or sale number" value="${escapeHtml(STATE.salesSearch||'')}"></div>
    <div class="pill-row section">
      ${periodPills(STATE.salesFilter, 'salesFilter')}
    </div>
    <div class="card stat-card section"><div class="label">Total (${periodLabel(STATE.salesFilter)})</div><div class="value num">${fmtMoney(totalToday)}</div><div class="sub">${shown.length} sale${shown.length===1?'':'s'}</div></div>
    <div class="list-card section">
      ${shown.length===0 ? '<div class="empty">No sales in this period.</div>' : shown.map(s=>`
        <div class="list-item" data-id="${s.id}" style="cursor:pointer; ${s.voided?'opacity:0.45;':''}">
          <div class="li-main"><div class="li-title">${escapeHtml(s.customerName)}${s.voided?' (voided)':''}</div><div class="li-sub">${s.saleNo} · ${(s.items&&s.items.length)? s.items.length+' items' : fmtKg(s.weightKg)} · ${fmtDateTime(s.date)}</div></div>
          <div class="li-right"><div class="li-amount num">${fmtMoney(s.total)}</div><span class="badge badge-${s.status}">${s.status.toUpperCase()}</span></div>
        </div>`).join('')}
    </div>
    <button class="btn btn-primary btn-lg btn-block" id="newSaleBtn" style="margin-top:6px;">${icon('fish')} Quick Fresh Tuna Sale</button>
    <button class="btn btn-ghost btn-block" id="newMultiBtn" style="margin-top:10px;">${icon('basket')} Multi-Item Sale</button>
  `;
  $('#salesSearch').addEventListener('input', e=>{ STATE.salesSearch = e.target.value; renderSalesList(view); });
  $$('.pill-filter', view).forEach(b=> b.addEventListener('click', ()=>{ STATE.salesFilter = b.dataset.v; renderSalesList(view); }));
  $$('.list-item', view).forEach(li=> li.addEventListener('click', ()=> openSaleDetail(Number(li.dataset.id))));
  $('#newSaleBtn').addEventListener('click', openQuickSale);
  $('#newMultiBtn').addEventListener('click', openGeneralSale);
}
function periodPills(current, key){
  const opts = [['today','Today'],['week','This Week'],['month','This Month'],['all','All']];
  return opts.map(([v,l])=>`<button class="customer-pill pill-filter ${current===v?'active':''}" data-v="${v}">${l}</button>`).join('');
}
function periodLabel(v){ return {today:'Today', week:'This Week', month:'This Month', all:'All Time'}[v]||v; }
function filterByPeriod(items, period){
  const now = new Date();
  return items.filter(it=>{
    const d = new Date(it.date);
    if(period==='today') return d.toDateString()===now.toDateString();
    if(period==='week'){ const diff=daysBetween(d,now); return diff>=0 && diff<7; }
    if(period==='month') return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear();
    return true;
  });
}

async function openSaleDetail(id){
  const s = await db.sales.get(id);
  const sheet = $('#sheet');
  function render(){
    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-header"><h2>${s.saleNo}</h2><button class="sheet-close" id="sdClose">${icon('x',16)}</button></div>
      <div class="stack">
        <div class="row"><span style="color:var(--muted)">Customer</span><span style="font-weight:600;">${escapeHtml(s.customerName)}</span></div>
        <div class="row"><span style="color:var(--muted)">Date</span><span>${fmtDateTime(s.date)}</span></div>
        ${(s.items && s.items.length)
          ? s.items.map(it=>`<div class="row"><span style="color:var(--muted)">${escapeHtml(it.name)}</span><span class="num">${it.qty}${it.kind==='fresh'?' kg':' ×'} @ ${fmtMoney(it.unitPrice)} = ${fmtMoney(it.qty*it.unitPrice)}</span></div>`).join('')
          : `<div class="row"><span style="color:var(--muted)">Weight</span><span class="num">${fmtKg(s.weightKg)}</span></div>
             <div class="row"><span style="color:var(--muted)">Price/kg</span><span class="num">${fmtMoney(s.pricePerKg)}</span></div>`}
        ${s.discount? `<div class="row"><span style="color:var(--muted)">Discount</span><span class="num">−${fmtMoney(s.discount)}</span></div>`:''}
        <div class="divider"></div>
        <div class="row"><span style="color:var(--muted)">Total</span><span class="num" style="font-weight:700;">${fmtMoney(s.total)}</span></div>
        <div class="row"><span style="color:var(--muted)">Paid</span><span class="num">${fmtMoney(s.paid)}</span></div>
        <div class="row"><span style="color:var(--muted)">Balance</span><span class="num" style="color:${s.balance>0?'var(--danger)':'var(--good)'}">${fmtMoney(s.balance)}</span></div>
        <div class="row"><span style="color:var(--muted)">Status</span><span class="badge badge-${s.status}">${s.status.toUpperCase()}</span></div>
        ${s.notes? `<div class="row"><span style="color:var(--muted)">Notes</span><span>${escapeHtml(s.notes)}</span></div>`:''}
      </div>
      ${s.voided ? '<div class="warn-banner" style="margin-top:16px;"><div class="wtitle">This sale was voided</div></div>' : `
        ${s.balance>0 && s.customerId ? `
          <div class="divider"></div>
          <h3 style="margin-bottom:10px;">Record payment for this sale</h3>
          <div class="field"><label>Amount (${SETTINGS.currency})</label><input type="number" step="0.01" id="sdPayAmt" value="${s.balance}"></div>
          <div class="stack">
            <button class="btn btn-primary btn-block" id="sdMarkPaid">Mark as Fully Paid</button>
            <button class="btn btn-ghost btn-block" id="sdAddPayment">Record This Amount</button>
          </div>
        ` : ''}
        <button class="btn btn-danger btn-block" id="voidBtn" style="margin-top:20px;">Void this sale</button>
      `}
    `;
    $('#sdClose').onclick = closeSheet;
    $('#sdMarkPaid')?.addEventListener('click', async ()=>{
      try{
        await recordSalePayment(id, s.balance);
        const fresh = await db.sales.get(id);
        Object.assign(s, fresh);
        toast('Sale marked as paid');
        render();
        renderView();
      }catch(err){ toast(err.message); }
    });
    $('#sdAddPayment')?.addEventListener('click', async ()=>{
      try{
        const amt = Number($('#sdPayAmt').value);
        await recordSalePayment(id, amt);
        const fresh = await db.sales.get(id);
        Object.assign(s, fresh);
        toast('Payment recorded');
        render();
        renderView();
      }catch(err){ toast(err.message); }
    });
    $('#voidBtn')?.addEventListener('click', async ()=>{
      const ok = await confirmDialog('Void this sale?', `This will reverse the inventory and credit effects of ${s.saleNo}. This cannot be undone.`, {yesLabel:'Void sale', dangerConfirm:true});
      if(ok){ await voidSale(id); closeSheet(); renderView(); }
    });
  }
  render();
  openSheet();
}

/* ============================================================
   PURCHASES LIST
   ============================================================ */
async function renderPurchasesList(view){
  STATE.purchFilter = STATE.purchFilter || 'today';
  const purchases = (await db.purchases.orderBy('date').reverse().toArray());
  const shown = filterByPeriod(purchases, STATE.purchFilter);
  const total = shown.reduce((a,p)=>p.voided?a:a+p.total,0);
  view.innerHTML = `
    <div class="section row"><h1>Purchases</h1></div>
    <div class="pill-row section">${periodPills(STATE.purchFilter,'purchFilter')}</div>
    <div class="card stat-card section"><div class="label">Total (${periodLabel(STATE.purchFilter)})</div><div class="value num">${fmtMoney(total)}</div><div class="sub">${shown.length} purchase${shown.length===1?'':'s'}</div></div>
    <div class="list-card section">
      ${shown.length===0? '<div class="empty">No purchases in this period.</div>' : shown.map(p=>`
        <div class="list-item">
          <div class="li-main"><div class="li-title">${escapeHtml(p.supplierName)}</div><div class="li-sub">${p.purchaseNo} · ${fmtKg(p.weightKg)} · ${fmtDateTime(p.date)}</div></div>
          <div class="li-right"><div class="li-amount num">${fmtMoney(p.total)}</div><span class="badge badge-${p.status}">${p.status.toUpperCase()}</span></div>
        </div>`).join('')}
    </div>
    <button class="btn btn-primary btn-lg btn-block" id="newPurchBtn" style="margin-top:6px;">+ Record Purchase</button>
  `;
  $$('.pill-filter', view).forEach(b=> b.addEventListener('click', ()=>{ STATE.purchFilter = b.dataset.v; renderPurchasesList(view); }));
  $('#newPurchBtn').addEventListener('click', openQuickPurchase);
}

/* ============================================================
   INVENTORY
   ============================================================ */
async function renderInventory(view){
  const [txAll, products] = await Promise.all([db.inventoryTx.toArray(), db.products.toArray()]);
  const tx = txAll.sort((a,b)=> new Date(b.date)-new Date(a.date)).slice(0,50);
  const dried = products.filter(p=>p.type==='dried' && p.active!==false);
  const rk = products.filter(p=>p.type==='rihaakuru' && p.active!==false);
  const stockRows = (list, unitWord) => list.map(p=>`
    <div class="list-item">
      <div class="li-main"><div class="li-title">${escapeHtml(p.name)}</div><div class="li-sub">${escapeHtml(p.sku||'')}</div></div>
      <div class="li-right"><div class="li-amount num" style="color:${(p.stock||0)<=(p.lowStock||0)?'var(--coral)':'var(--ink)'}">${p.stock||0}</div>
        <div class="li-sub">${unitWord}${(p.stock||0)<=(p.lowStock||0)?' · low':''}</div></div>
    </div>`).join('');

  view.innerHTML = `
    <div class="section row"><h1>Inventory</h1></div>
    <div class="hero-card section">
      <div class="label">${icon('fish')} Fresh Tuna Stock</div>
      <div class="value num">${fmtKg(SETTINGS.freshTunaStock||0)}</div>
      <div class="sub">${(SETTINGS.freshTunaStock||0) <= (SETTINGS.lowStockKg||10) ? (icon('alert',13)+' Below low-stock threshold ('+fmtKg(SETTINGS.lowStockKg||10)+')') : 'Above low-stock threshold'}</div>
    </div>
    <button class="btn btn-ghost btn-block section" id="adjBtn">+ Adjust Fresh Tuna Stock</button>

    ${dried.length? `<h2 class="section">${icon('package')} Dried Tuna</h2><div class="list-card section">${stockRows(dried,'packs')}</div>`:''}
    ${rk.length? `<h2 class="section">${icon('jar')} Rihaakuru</h2><div class="list-card section">${stockRows(rk,'bottles')}</div>`:''}

    <h2 class="section">Recent Movements</h2>
    <div class="list-card section">
      ${tx.length===0? '<div class="empty">No inventory movements yet.</div>' : tx.map(t=>{
        const isProduct = !!t.productId;
        const delta = isProduct ? (t.deltaUnits||0) : (t.deltaKg||0);
        const unit = isProduct ? ' units' : ' kg';
        return `
        <div class="list-item">
          <div class="li-main"><div class="li-title">${labelForTxType(t.type)}${isProduct? ' · '+escapeHtml(t.productName||''):''}</div>
            <div class="li-sub">${fmtDateTime(t.date)}${t.notes? ' · '+escapeHtml(t.notes):''}</div></div>
          <div class="li-right"><div class="li-amount num" style="color:${delta>=0?'var(--good)':'var(--danger)'}">${delta>=0?'+':''}${Number(delta).toLocaleString(undefined,{maximumFractionDigits:2})}${unit}</div>
            <div class="li-sub num">Now: ${Number(t.runningStock).toLocaleString(undefined,{maximumFractionDigits:2})}</div></div>
        </div>`;
      }).join('')}
    </div>
  `;
  $('#adjBtn').addEventListener('click', openInventoryAdjustForm);
}
function labelForTxType(t){
  return { sale:'Sale', purchase:'Fresh tuna purchase', adjustment:'Manual adjustment', production_usage:'Used in production', production_output:'Produced', waste:'Waste/loss' }[t] || t;
}
async function openInventoryAdjustForm(){
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header"><h2>Manual Adjustment</h2><button class="sheet-close" id="iaClose">${icon('x',16)}</button></div>
    <div class="field">
      <label>Adjustment type</label>
      <div class="seg" id="iaType"><button data-v="add" class="active">Add stock</button><button data-v="remove">Remove / waste</button></div>
    </div>
    <div class="field"><label>Weight (kg)</label><input type="number" step="0.01" id="iaWeight"></div>
    <div class="field"><label>Reason</label><input id="iaReason" placeholder="e.g. spoilage, stock count correction"></div>
    <button class="btn btn-primary btn-lg btn-block" id="iaSave">Save Adjustment</button>
  `;
  openSheet();
  let mode = 'add';
  $('#iaClose').onclick = closeSheet;
  $('#iaType').addEventListener('click', e=>{ const b=e.target.closest('button'); if(!b) return; $$('#iaType button').forEach(x=>x.classList.remove('active')); b.classList.add('active'); mode=b.dataset.v; });
  $('#iaSave').onclick = async ()=>{
    const w = Number($('#iaWeight').value);
    if(!(w>0)){ toast('Enter a weight greater than 0'); return; }
    const delta = mode==='add' ? w : -w;
    await adjustInventory(delta, mode==='add'?'adjustment':'waste', 'manual', null, $('#iaReason').value.trim());
    await audit('adjust','inventory',null, `${delta} kg — ${$('#iaReason').value.trim()}`);
    toast('Inventory updated'); closeSheet(); renderView();
  };
}

/* ============================================================
   CUSTOMERS
   ============================================================ */
async function renderCustomers(view){
  const q = (STATE.custSearch||'').toLowerCase();
  STATE.custFilter = STATE.custFilter || 'all';
  let customers = await db.customers.orderBy('name').toArray();
  if(q) customers = customers.filter(c=> c.name.toLowerCase().includes(q) || (c.phone||'').includes(q));

  const totalCount = customers.length;
  const owingCount = customers.filter(c=>(c.balance||0)>0).length;
  const paidCount = customers.filter(c=>(c.balance||0)<=0).length;
  if(STATE.custFilter==='owing') customers = customers.filter(c=>(c.balance||0)>0);
  else if(STATE.custFilter==='paid') customers = customers.filter(c=>(c.balance||0)<=0);

  view.innerHTML = `
    <div class="section row"><h1>Customers</h1></div>
    <div class="searchbar"><input id="custSearchInput" placeholder="Search customers" value="${escapeHtml(STATE.custSearch||'')}"></div>
    <div class="pill-row section">
      <button class="customer-pill cust-filter-pill ${STATE.custFilter==='all'?'active':''}" data-v="all">All (${totalCount})</button>
      <button class="customer-pill cust-filter-pill ${STATE.custFilter==='owing'?'active':''}" data-v="owing">Owing (${owingCount})</button>
      <button class="customer-pill cust-filter-pill ${STATE.custFilter==='paid'?'active':''}" data-v="paid">Paid up (${paidCount})</button>
    </div>
    <div class="list-card section">
      ${customers.length===0? '<div class="empty">No customers in this view.</div>' : customers.map(c=>`
        <div class="list-item" data-id="${c.id}" style="cursor:pointer;">
          <div class="li-main"><div class="li-title">${escapeHtml(c.name)}</div><div class="li-sub">${escapeHtml(c.phone||'')}${c.island? ' · '+escapeHtml(c.island):''}</div></div>
          <div class="li-right"><div class="li-amount num" style="color:${(c.balance||0)>0?'var(--danger)':'var(--good)'}">${fmtMoney(c.balance||0)}</div><div class="li-sub">${(c.balance||0)>0?'owing':'paid up'}</div></div>
        </div>`).join('')}
    </div>
    <button class="btn btn-primary btn-lg btn-block" id="newCustBtn">+ New Customer</button>
  `;
  $('#custSearchInput').addEventListener('input', e=>{ STATE.custSearch = e.target.value; renderCustomers(view); });
  $$('.cust-filter-pill', view).forEach(b=> b.addEventListener('click', ()=>{ STATE.custFilter = b.dataset.v; renderCustomers(view); }));
  $$('.list-item', view).forEach(li=> li.addEventListener('click', ()=> go('customerDetail', {customerId:Number(li.dataset.id)})));
  $('#newCustBtn').addEventListener('click', ()=> openCustomerForm());
}

function openCustomerForm(onSaved){
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header"><h2>New Customer</h2><button class="sheet-close" id="ncClose">${icon('x',16)}</button></div>
    <div class="field"><label>Name *</label><input id="ncName" autofocus></div>
    <div class="field"><label>Phone</label><input id="ncPhone" inputmode="tel"></div>
    <div class="field"><label>Island</label><input id="ncIsland" value="${escapeHtml(SETTINGS.island||'')}"></div>
    <div class="field"><label>Credit limit (${SETTINGS.currency}, optional)</label><input type="number" id="ncLimit" placeholder="0 = no limit"></div>
    <button class="btn btn-primary btn-lg btn-block" id="ncSave">Save Customer</button>
  `;
  openSheet();
  $('#ncClose').onclick = closeSheet;
  $('#ncSave').onclick = async ()=>{
    const name = $('#ncName').value.trim();
    if(!name){ toast('Enter a customer name'); return; }
    const id = await db.customers.add({
      name, phone: $('#ncPhone').value.trim(), island: $('#ncIsland').value.trim(), address:'', notes:'',
      creditLimit: Number($('#ncLimit').value||0), active:true, balance:0, createdAt: nowISO()
    });
    await audit('create','customer',id,name);
    toast('Customer added'); closeSheet();
    const cust = await db.customers.get(id);
    if(onSaved) onSaved(cust); else renderView();
  };
}

async function renderCustomerDetail(view, customerId){
  const cust = await db.customers.get(customerId);
  if(!cust){ go('customers'); return; }
  const ledger = await db.customerTx.where('customerId').equals(customerId).reverse().sortBy('date');
  const sales = await db.sales.where('customerId').equals(customerId).toArray();
  const payments = await db.payments.where('customerId').equals(customerId).toArray();
  const totalPurchases = sales.filter(s=>!s.voided).reduce((a,s)=>a+s.total,0);
  const totalPayments = payments.reduce((a,p)=>a+p.amount,0);
  const lastPurchase = sales.length? sales.reduce((a,b)=> new Date(a.date)>new Date(b.date)?a:b) : null;
  const lastPayment = payments.length? payments.reduce((a,b)=> new Date(a.date)>new Date(b.date)?a:b) : null;

  view.innerHTML = `
    <button class="link-btn" id="backBtn">‹ Customers</button>
    <div class="section" style="margin-top:10px;">
      <h1>${escapeHtml(cust.name)}</h1>
      <div style="color:var(--muted); font-size:13.5px; margin-top:2px;">${escapeHtml(cust.phone||'')}${cust.island?' · '+escapeHtml(cust.island):''}</div>
    </div>
    <div class="hero-card section">
      <div class="label">Outstanding Balance</div>
      <div class="value num">${fmtMoney(cust.balance||0)}</div>
      ${cust.creditLimit>0? `<div class="sub">Credit limit: ${fmtMoney(cust.creditLimit)}</div>`:''}
    </div>
    <div class="grid2 section">
      <div class="card stat-card"><div class="label">Total Purchases</div><div class="value num" style="font-size:18px;">${fmtMoney(totalPurchases)}</div><div class="sub">${sales.filter(s=>!s.voided).length} sales</div></div>
      <div class="card stat-card"><div class="label">Total Payments</div><div class="value num" style="font-size:18px;">${fmtMoney(totalPayments)}</div><div class="sub">${payments.length} payments</div></div>
      <div class="card stat-card"><div class="label">Last Purchase</div><div class="value num" style="font-size:15px;">${lastPurchase? fmtDate(lastPurchase.date):'—'}</div></div>
      <div class="card stat-card"><div class="label">Last Payment</div><div class="value num" style="font-size:15px;">${lastPayment? fmtDate(lastPayment.date):'—'}</div></div>
    </div>
    <div class="quick-grid section">
      <button class="quick-btn" id="cdSell"><span class="qicon">${icon('fish')}</span>Sell Tuna</button>
      <button class="quick-btn" id="cdPay" ${(cust.balance||0)<=0?'disabled':''} style="${(cust.balance||0)<=0?'opacity:0.5;':''}"><span class="qicon">${icon('card')}</span>Record Payment</button>
      <button class="quick-btn" id="cdRemind"><span class="qicon">${icon('share')}</span>Share Reminder</button>
      <button class="quick-btn" id="cdEdit"><span class="qicon">${icon('edit')}</span>Edit Customer</button>
    </div>
    <h2 class="section">Ledger</h2>
    <div class="list-card section">
      ${ledger.length===0? '<div class="empty">No transactions yet.</div>' : ledger.map(t=>`
        <div class="list-item">
          <div class="li-main"><div class="li-title">${t.type==='credit'?'Credit sale':'Payment'}</div><div class="li-sub">${fmtDateTime(t.date)}${t.notes? ' · '+escapeHtml(t.notes):''}</div></div>
          <div class="li-right"><div class="li-amount num" style="color:${t.type==='credit'?'var(--danger)':'var(--good)'}">${t.type==='credit'?'+':'-'}${fmtMoney(t.amount)}</div><div class="li-sub num">Bal: ${fmtMoney(t.runningBalance)}</div></div>
        </div>`).join('')}
    </div>
  `;
  $('#backBtn').addEventListener('click', ()=> go('customers'));
  $('#cdSell').addEventListener('click', ()=> openQuickSalePreset(cust));
  $('#cdPay').addEventListener('click', ()=> openPaymentForm(cust.id));
  $('#cdRemind').addEventListener('click', ()=> shareReminder(cust));
  $('#cdEdit').addEventListener('click', ()=> openCustomerEditForm(cust));
}

async function openQuickSalePreset(cust){
  await openQuickSale();
  // pre-select the customer pill if present
  const btn = $(`.customer-pill[data-id="${cust.id}"]`);
  if(btn){ btn.click(); }
}

function shareReminder(cust){
  const msg = `Hi ${cust.name}, your current outstanding balance for ${SETTINGS.businessName||'Island Tuna'} purchases is ${fmtMoney(cust.balance||0)}. Thank you.`;
  if(navigator.share){
    navigator.share({ text: msg }).catch(()=>{});
  } else {
    navigator.clipboard?.writeText(msg);
    toast('Reminder copied to clipboard');
  }
}

function openCustomerEditForm(cust){
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header"><h2>Edit Customer</h2><button class="sheet-close" id="ecClose">${icon('x',16)}</button></div>
    <div class="field"><label>Name</label><input id="ecName" value="${escapeHtml(cust.name)}"></div>
    <div class="field"><label>Phone</label><input id="ecPhone" value="${escapeHtml(cust.phone||'')}"></div>
    <div class="field"><label>Island</label><input id="ecIsland" value="${escapeHtml(cust.island||'')}"></div>
    <div class="field"><label>Credit limit</label><input type="number" id="ecLimit" value="${cust.creditLimit||0}"></div>
    <div class="field">
      <label>Status</label>
      <div class="seg" id="ecActive"><button data-v="1" class="${cust.active!==false?'active':''}">Active</button><button data-v="0" class="${cust.active===false?'active':''}">Inactive</button></div>
    </div>
    <button class="btn btn-primary btn-lg btn-block" id="ecSave">Save Changes</button>
  `;
  openSheet();
  let active = cust.active!==false;
  $('#ecClose').onclick = closeSheet;
  $('#ecActive').addEventListener('click', e=>{ const b=e.target.closest('button'); if(!b) return; $$('#ecActive button').forEach(x=>x.classList.remove('active')); b.classList.add('active'); active = b.dataset.v==='1'; });
  $('#ecSave').onclick = async ()=>{
    await db.customers.update(cust.id, { name: $('#ecName').value.trim(), phone: $('#ecPhone').value.trim(), island: $('#ecIsland').value.trim(), creditLimit: Number($('#ecLimit').value||0), active });
    toast('Customer updated'); closeSheet(); renderView();
  };
}

/* ============================================================
   SUPPLIERS
   ============================================================ */
async function renderSuppliers(view){
  const suppliers = await db.suppliers.orderBy('name').toArray();
  view.innerHTML = `
    <button class="link-btn" id="backBtn">‹ More</button>
    <div class="section row" style="margin-top:10px;"><h1>Suppliers</h1></div>
    <div class="list-card section">
      ${suppliers.length===0? '<div class="empty">No suppliers yet.</div>' : suppliers.map(s=>`
        <div class="list-item" data-id="${s.id}" style="cursor:pointer;">
          <div class="li-main"><div class="li-title">${escapeHtml(s.name)}</div><div class="li-sub">${escapeHtml(s.phone||'')}</div></div>
          <div class="li-right"><div class="li-amount num" style="color:${(s.balance||0)>0?'var(--danger)':'var(--good)'}">${fmtMoney(s.balance||0)}</div><div class="li-sub">owed</div></div>
        </div>`).join('')}
    </div>
    <button class="btn btn-primary btn-lg btn-block" id="newSupBtn">+ New Supplier</button>
  `;
  $('#backBtn').addEventListener('click', ()=> go('more'));
  $$('.list-item', view).forEach(li=> li.addEventListener('click', ()=> go('supplierDetail', {supplierId:Number(li.dataset.id)})));
  $('#newSupBtn').addEventListener('click', ()=> openSupplierForm());
}
function openSupplierForm(onSaved){
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header"><h2>New Supplier</h2><button class="sheet-close" id="nsClose">${icon('x',16)}</button></div>
    <div class="field"><label>Fisherman / supplier name *</label><input id="nsName" autofocus></div>
    <div class="field"><label>Phone</label><input id="nsPhone" inputmode="tel"></div>
    <div class="field"><label>Boat name</label><input id="nsBoat"></div>
    <div class="field"><label>Island</label><input id="nsIsland" value="${escapeHtml(SETTINGS.island||'')}"></div>
    <button class="btn btn-primary btn-lg btn-block" id="nsSave">Save Supplier</button>
  `;
  openSheet();
  $('#nsClose').onclick = closeSheet;
  $('#nsSave').onclick = async ()=>{
    const name = $('#nsName').value.trim();
    if(!name){ toast('Enter a name'); return; }
    const id = await db.suppliers.add({ name, phone:$('#nsPhone').value.trim(), boat:$('#nsBoat').value.trim(), island:$('#nsIsland').value.trim(), notes:'', balance:0, createdAt:nowISO() });
    toast('Supplier added'); closeSheet();
    const sup = await db.suppliers.get(id);
    if(onSaved) onSaved(sup); else renderView();
  };
}
async function renderSupplierDetail(view, supplierId){
  const sup = await db.suppliers.get(supplierId);
  if(!sup){ go('suppliers'); return; }
  const purchases = await db.purchases.where('supplierId').equals(supplierId).toArray();
  const ledger = await db.supplierTx.where('supplierId').equals(supplierId).reverse().sortBy('date');
  const totalWeight = purchases.filter(p=>!p.voided).reduce((a,p)=>a+p.weightKg,0);
  const totalAmount = purchases.filter(p=>!p.voided).reduce((a,p)=>a+p.total,0);
  const totalPaid = purchases.filter(p=>!p.voided).reduce((a,p)=>a+p.paid,0);
  view.innerHTML = `
    <button class="link-btn" id="backBtn">‹ Suppliers</button>
    <div class="section" style="margin-top:10px;"><h1>${escapeHtml(sup.name)}</h1><div style="color:var(--muted); font-size:13.5px;">${escapeHtml(sup.phone||'')}</div></div>
    <div class="hero-card section"><div class="label">Amount Outstanding</div><div class="value num">${fmtMoney(sup.balance||0)}</div></div>
    <div class="grid2 section">
      <div class="card stat-card"><div class="label">Total Supplied</div><div class="value num" style="font-size:18px;">${fmtKg(totalWeight)}</div></div>
      <div class="card stat-card"><div class="label">Total Purchased</div><div class="value num" style="font-size:18px;">${fmtMoney(totalAmount)}</div></div>
      <div class="card stat-card"><div class="label">Amount Paid</div><div class="value num" style="font-size:18px;">${fmtMoney(totalPaid)}</div></div>
      <div class="card stat-card"><div class="label">Outstanding</div><div class="value num" style="font-size:18px;">${fmtMoney(sup.balance||0)}</div></div>
    </div>
    <button class="btn btn-primary btn-lg btn-block section" id="paySupBtn" ${(sup.balance||0)<=0?'disabled':''}>Record Payment to Supplier</button>
    <h2 class="section">History</h2>
    <div class="list-card section">
      ${ledger.length===0? '<div class="empty">No transactions yet.</div>' : ledger.map(t=>`
        <div class="list-item"><div class="li-main"><div class="li-title">${t.type==='credit'?'Purchase on credit':'Payment made'}</div><div class="li-sub">${fmtDateTime(t.date)}${t.notes?' · '+escapeHtml(t.notes):''}</div></div>
        <div class="li-right"><div class="li-amount num" style="color:${t.type==='credit'?'var(--danger)':'var(--good)'}">${t.type==='credit'?'+':'-'}${fmtMoney(t.amount)}</div><div class="li-sub num">Bal: ${fmtMoney(t.runningBalance)}</div></div></div>`).join('')}
    </div>
  `;
  $('#backBtn').addEventListener('click', ()=> go('suppliers'));
  $('#paySupBtn').addEventListener('click', ()=> openSupplierPaymentForm(sup));
}
function openSupplierPaymentForm(sup){
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header"><h2>Pay ${escapeHtml(sup.name)}</h2><button class="sheet-close" id="spClose">${icon('x',16)}</button></div>
    <div class="field"><label>Amount</label><input type="number" step="0.01" id="spAmt" value="${sup.balance}"></div>
    <div class="field"><label>Method</label>
      <div class="seg" id="spMethod"><button data-v="cash" class="active">Cash</button><button data-v="bank">Bank</button></div>
    </div>
    <button class="btn btn-primary btn-lg btn-block" id="spSave">Save Payment</button>
  `;
  openSheet();
  let method='cash';
  $('#spClose').onclick = closeSheet;
  $('#spMethod').addEventListener('click', e=>{ const b=e.target.closest('button'); if(!b) return; $$('#spMethod button').forEach(x=>x.classList.remove('active')); b.classList.add('active'); method=b.dataset.v; });
  $('#spSave').onclick = async ()=>{
    const amount = Number($('#spAmt').value);
    if(!(amount>0)){ toast('Enter an amount'); return; }
    await recordSupplierPayment({ supplierId: sup.id, amount, method, date: nowISO() });
    closeSheet(); renderView();
  };
}

/* ============================================================
   CREDIT DASHBOARD
   ============================================================ */
async function renderCreditDashboard(view){
  const customers = (await db.customers.toArray()).filter(c=>(c.balance||0)>0);
  const ledgerByCust = {};
  for(const c of customers){
    const tx = await db.customerTx.where('customerId').equals(c.id).reverse().sortBy('date');
    ledgerByCust[c.id] = tx[0]?.date || c.createdAt;
  }
  const now = new Date();
  const buckets = {b0:0,b1:0,b2:0,b3:0};
  const rows = customers.map(c=>{
    const lastDate = ledgerByCust[c.id];
    const age = Math.max(0, daysBetween(lastDate, now));
    let bucket;
    if(age<=7){ bucket='b0'; } else if(age<=14){ bucket='b1'; } else if(age<=30){ bucket='b2'; } else { bucket='b3'; }
    buckets[bucket]+=c.balance;
    return { ...c, age, bucket };
  });
  STATE.creditSort = STATE.creditSort || 'balance';
  rows.sort((a,b)=>{
    if(STATE.creditSort==='balance') return b.balance-a.balance;
    if(STATE.creditSort==='oldest') return b.age-a.age;
    if(STATE.creditSort==='newest') return a.age-b.age;
    return a.name.localeCompare(b.name);
  });
  const total = customers.reduce((a,c)=>a+c.balance,0);
  view.innerHTML = `
    <div class="section row"><h1>Credit</h1></div>
    <div class="hero-card section"><div class="label">Total Customer Credit</div><div class="value num">${fmtMoney(total)}</div><div class="sub">${customers.length} customers owing</div></div>
    <div class="grid2 section">
      <div class="card stat-card"><div class="label">0–7 days</div><div class="value num tag-age-0" style="font-size:18px;">${fmtMoney(buckets.b0)}</div></div>
      <div class="card stat-card"><div class="label">8–14 days</div><div class="value num tag-age-1" style="font-size:18px;">${fmtMoney(buckets.b1)}</div></div>
      <div class="card stat-card"><div class="label">15–30 days</div><div class="value num tag-age-1" style="font-size:18px;">${fmtMoney(buckets.b2)}</div></div>
      <div class="card stat-card"><div class="label">30+ days</div><div class="value num tag-age-2" style="font-size:18px;">${fmtMoney(buckets.b3)}</div></div>
    </div>
    <div class="pill-row section">
      <button class="customer-pill sort-pill ${STATE.creditSort==='balance'?'active':''}" data-v="balance">Highest balance</button>
      <button class="customer-pill sort-pill ${STATE.creditSort==='oldest'?'active':''}" data-v="oldest">Oldest debt</button>
      <button class="customer-pill sort-pill ${STATE.creditSort==='newest'?'active':''}" data-v="newest">Newest debt</button>
      <button class="customer-pill sort-pill ${STATE.creditSort==='name'?'active':''}" data-v="name">Name</button>
    </div>
    <div class="list-card section">
      ${rows.length===0? `<div class="empty">No outstanding credit. ${icon('check',16)}</div>` : rows.map(c=>`
        <div class="list-item" data-id="${c.id}" style="cursor:pointer;">
          <div class="li-main"><div class="li-title">${escapeHtml(c.name)}</div><div class="li-sub">Last activity ${c.age}d ago</div></div>
          <div class="li-right"><div class="li-amount num" style="color:var(--danger)">${fmtMoney(c.balance)}</div><span class="badge badge-credit">${c.age<=7?'RECENT':c.age<=30?'DUE':'OVERDUE'}</span></div>
        </div>`).join('')}
    </div>
  `;
  $$('.sort-pill', view).forEach(b=> b.addEventListener('click', ()=>{ STATE.creditSort=b.dataset.v; renderCreditDashboard(view); }));
  $$('.list-item', view).forEach(li=> li.addEventListener('click', ()=> go('customerDetail', {customerId:Number(li.dataset.id)})));
}

/* ============================================================
   PRODUCTS
   ============================================================ */
async function renderProducts(view){
  const products = await db.products.toArray();
  const dried = products.filter(p=>p.type==='dried');
  const rk = products.filter(p=>p.type==='rihaakuru');
  const groupHtml = (list, title, unitWord) => `
    <h2 class="section">${title}</h2>
    <div class="list-card section">
      ${list.length===0? '<div class="empty">No products yet.</div>' : list.map(p=>`
        <div class="list-item" data-id="${p.id}" style="cursor:pointer; ${p.active===false?'opacity:0.5;':''}">
          <div class="li-main">
            <div class="li-title">${escapeHtml(p.name)}</div>
            <div class="li-sub">${escapeHtml(p.sku)} · ${fmtMoney(p.sellPrice)}${p.costPrice?` · cost ${fmtMoney(p.costPrice)}`:''}</div>
          </div>
          <div class="li-right">
            <div class="li-amount num" style="color:${(p.stock||0)<=(p.lowStock||0)?'var(--coral)':'var(--ink)'}">${p.stock||0}</div>
            <div class="li-sub">${unitWord}${(p.stock||0)<=(p.lowStock||0)?' · low':''}</div>
          </div>
        </div>`).join('')}
    </div>`;
  view.innerHTML = `
    <button class="link-btn" id="backBtn">‹ More</button>
    <div class="section" style="margin-top:10px;"><h1>Products</h1></div>
    ${groupHtml(dried,`${icon('package')} Dried Tuna`,'packs')}
    ${groupHtml(rk,`${icon('jar')} Rihaakuru`,'bottles')}
    <button class="btn btn-primary btn-block section" id="newProdBtn">+ New Product</button>
  `;
  $('#backBtn').addEventListener('click', ()=> go('more'));
  $$('.list-item', view).forEach(li=> li.addEventListener('click', ()=> openProductForm(Number(li.dataset.id))));
  $('#newProdBtn').addEventListener('click', ()=> openProductForm(null));
}

async function openProductForm(productId){
  const p = productId ? await db.products.get(productId) : null;
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header"><h2>${p? 'Edit Product':'New Product'}</h2><button class="sheet-close" id="prClose">${icon('x',16)}</button></div>
    <div class="field"><label>Product name</label><input id="prName" value="${escapeHtml(p?.name||'')}"></div>
    <div class="field"><label>SKU</label><input id="prSku" value="${escapeHtml(p?.sku||'')}"></div>
    <div class="field"><label>Type</label>
      <div class="seg" id="prType">
        <button data-v="dried" class="${!p || p.type==='dried'?'active':''}">Dried Tuna</button>
        <button data-v="rihaakuru" class="${p?.type==='rihaakuru'?'active':''}">Rihaakuru</button>
      </div>
    </div>
    <div class="field"><label>Pack size (kg)</label><input type="number" step="0.01" id="prSize" value="${p?.packSize||''}"></div>
    <div class="field"><label>Selling price (${SETTINGS.currency})</label><input type="number" step="0.01" id="prPrice" value="${p?.sellPrice||''}"></div>
    <div class="field"><label>Low-stock threshold</label><input type="number" id="prLow" value="${p?.lowStock??5}"></div>
    ${p? `<div class="field"><label>Current stock (units)</label><input type="number" step="0.01" id="prStock" value="${p.stock||0}"><div style="font-size:11.5px;color:var(--muted);margin-top:5px;">Changing this records a manual stock adjustment.</div></div>`:''}
    <button class="btn btn-primary btn-lg btn-block" id="prSave">${p?'Save Changes':'Add Product'}</button>
  `;
  openSheet();
  let type = p?.type || 'dried';
  $('#prClose').onclick = closeSheet;
  $('#prType').addEventListener('click', e=>{ const b=e.target.closest('button'); if(!b) return; $$('#prType button').forEach(x=>x.classList.remove('active')); b.classList.add('active'); type=b.dataset.v; });
  $('#prSave').onclick = async ()=>{
    const name = $('#prName').value.trim();
    if(!name){ toast('Enter a product name'); return; }
    const sellPrice = Number($('#prPrice').value||0);
    if(sellPrice<0){ toast('Price cannot be negative'); return; }
    const payload = { name, sku: $('#prSku').value.trim(), type, packSize: Number($('#prSize').value||0),
      sellPrice, lowStock: Number($('#prLow').value||0) };
    if(p){
      await db.products.update(p.id, payload);
      const newStock = Number($('#prStock').value||0);
      const delta = Math.round((newStock - (p.stock||0))*100)/100;
      if(delta !== 0) await adjustProductStock(p.id, delta, 'adjustment', 'manual', null, 'Manual stock correction');
      toast('Product updated');
    } else {
      await db.products.add({ ...payload, costPrice:0, stock:0, active:true, createdAt: nowISO() });
      toast('Product added');
    }
    closeSheet(); renderView();
  };
}

/* ============================================================
   PRODUCTION
   ============================================================ */
async function renderProduction(view){
  const batches = (await db.productionBatches.toArray()).sort((a,b)=> new Date(b.date)-new Date(a.date));
  view.innerHTML = `
    <button class="link-btn" id="backBtn">‹ More</button>
    <div class="section" style="margin-top:10px;"><h1>Production</h1></div>
    <div class="grid2 section">
      <button class="quick-btn" id="newDried"><span class="qicon">${icon('package')}</span>Dried Tuna Batch</button>
      <button class="quick-btn" id="newRk"><span class="qicon">${icon('jar')}</span>Rihaakuru Batch</button>
    </div>
    <h2 class="section">Recent Batches</h2>
    <div class="list-card section">
      ${batches.length===0? '<div class="empty">No production batches yet.</div>' : batches.map(b=>`
        <div class="list-item" data-id="${b.id}" style="cursor:pointer;">
          <div class="li-main"><div class="li-title">${escapeHtml(b.productName||b.kind)}</div>
            <div class="li-sub">${b.batchNo} · ${fmtKg(b.freshUsedKg)} ${icon('arrow',13)} ${b.unitsProduced} units · ${fmtDate(b.date)}</div></div>
          <div class="li-right"><div class="li-amount num">${fmtMoney(b.totalCost)}</div><div class="li-sub num">${fmtMoney(b.costPerUnit)}/unit</div></div>
        </div>`).join('')}
    </div>
  `;
  $('#backBtn').addEventListener('click', ()=> go('more'));
  $('#newDried').addEventListener('click', ()=> openProductionForm('dried'));
  $('#newRk').addEventListener('click', ()=> openProductionForm('rihaakuru'));
  $$('.list-item', view).forEach(li=> li.addEventListener('click', ()=> openBatchDetail(Number(li.dataset.id))));
}

async function openProductionForm(kind){
  const products = (await db.products.toArray()).filter(p=>p.type===kind && p.active!==false);
  if(!products.length){ toast('Add a product for this type first'); return; }
  const avgCost = await averageFreshCostPerKg();
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header"><h2>${kind==='dried'?'Dried Tuna':'Rihaakuru'} Batch</h2><button class="sheet-close" id="pdClose">${icon('x',16)}</button></div>
    <div class="field"><label>Product / pack size</label>
      <select id="pdProduct">${products.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Fresh tuna used (kg)</label><input type="number" step="0.01" id="pdFresh" placeholder="0.0"></div>
    <div class="field"><label>Finished weight (kg, optional)</label><input type="number" step="0.01" id="pdFinished"></div>
    <div class="field"><label>Number of ${kind==='dried'?'packs':'bottles'} produced</label><input type="number" step="1" id="pdUnits"></div>
    <div class="field"><label>Packaging cost (${SETTINGS.currency})</label><input type="number" step="0.01" id="pdPack" value="0"></div>
    <div class="field"><label>Other production cost (${SETTINGS.currency})</label><input type="number" step="0.01" id="pdOther" value="0"></div>
    <div class="card" style="background:var(--foam); border:none; margin-bottom:14px;">
      <div class="totalline"><span>Fresh tuna cost (est.)</span><span class="num" id="pdFreshCost">${fmtMoney(0)}</span></div>
      <div class="totalline"><span>Total batch cost</span><span class="num" id="pdTotalCost">${fmtMoney(0)}</span></div>
      <div class="totalline grand"><span>Cost per unit</span><span class="num" id="pdPerUnit">${fmtMoney(0)}</span></div>
      <div class="totalline"><span>Expected sales value</span><span class="num" id="pdValue">${fmtMoney(0)}</span></div>
      <div class="totalline"><span>Estimated profit</span><span class="num" id="pdProfit">${fmtMoney(0)}</span></div>
    </div>
    <div class="field"><label>Notes (optional)</label><input id="pdNotes"></div>
    <button class="btn btn-primary btn-lg btn-block" id="pdSave">Save Batch</button>
    <p style="color:var(--muted); font-size:11.5px; margin-top:10px;">Fresh tuna cost uses your average purchase price of ${fmtMoney(avgCost)}/kg, so profit here is an estimate.</p>
  `;
  openSheet();
  $('#pdClose').onclick = closeSheet;
  function recalc(){
    const fresh = Number($('#pdFresh').value||0);
    const units = Number($('#pdUnits').value||0);
    const pack = Number($('#pdPack').value||0);
    const other = Number($('#pdOther').value||0);
    const prod = products.find(p=>p.id===Number($('#pdProduct').value));
    const freshCost = avgCost*fresh;
    const totalCost = freshCost+pack+other;
    const perUnit = units? totalCost/units : 0;
    const value = prod? prod.sellPrice*units : 0;
    $('#pdFreshCost').textContent = fmtMoney(freshCost);
    $('#pdTotalCost').textContent = fmtMoney(totalCost);
    $('#pdPerUnit').textContent = fmtMoney(perUnit);
    $('#pdValue').textContent = fmtMoney(value);
    $('#pdProfit').textContent = fmtMoney(value-totalCost);
  }
  ['pdFresh','pdUnits','pdPack','pdOther'].forEach(id=> $('#'+id).addEventListener('input', recalc));
  $('#pdProduct').addEventListener('change', recalc);
  $('#pdSave').onclick = async ()=>{
    try{
      const res = await recordProduction({
        kind, productId: Number($('#pdProduct').value),
        freshUsedKg: $('#pdFresh').value, finishedKg: $('#pdFinished').value,
        unitsProduced: $('#pdUnits').value, packagingCost: $('#pdPack').value,
        otherCost: $('#pdOther').value, notes: $('#pdNotes').value.trim()
      });
      if(res){ closeSheet(); renderView(); }
    }catch(err){ toast(err.message); }
  };
}

async function openBatchDetail(id){
  const b = await db.productionBatches.get(id);
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header"><h2>${b.batchNo}</h2><button class="sheet-close" id="bdClose">${icon('x',16)}</button></div>
    <div class="stack">
      <div class="row"><span style="color:var(--muted)">Product</span><span style="font-weight:600;">${escapeHtml(b.productName)}</span></div>
      <div class="row"><span style="color:var(--muted)">Date</span><span>${fmtDateTime(b.date)}</span></div>
      <div class="row"><span style="color:var(--muted)">Fresh tuna used</span><span class="num">${fmtKg(b.freshUsedKg)}</span></div>
      ${b.finishedKg? `<div class="row"><span style="color:var(--muted)">Finished weight</span><span class="num">${fmtKg(b.finishedKg)}</span></div>`:''}
      <div class="row"><span style="color:var(--muted)">Units produced</span><span class="num">${b.unitsProduced}</span></div>
      <div class="divider"></div>
      <div class="row"><span style="color:var(--muted)">Fresh tuna cost</span><span class="num">${fmtMoney(b.freshCost)}</span></div>
      <div class="row"><span style="color:var(--muted)">Packaging</span><span class="num">${fmtMoney(b.packagingCost)}</span></div>
      <div class="row"><span style="color:var(--muted)">Other costs</span><span class="num">${fmtMoney(b.otherCost)}</span></div>
      <div class="row"><span style="color:var(--muted)">Total batch cost</span><span class="num" style="font-weight:700;">${fmtMoney(b.totalCost)}</span></div>
      <div class="row"><span style="color:var(--muted)">Cost per unit</span><span class="num">${fmtMoney(b.costPerUnit)}</span></div>
      <div class="divider"></div>
      <div class="row"><span style="color:var(--muted)">Expected sales value</span><span class="num">${fmtMoney(b.expectedValue)}</span></div>
      <div class="row"><span style="color:var(--muted)">Estimated profit</span><span class="num" style="color:${b.expectedProfit>=0?'var(--good)':'var(--danger)'}">${fmtMoney(b.expectedProfit)}</span></div>
      ${b.notes? `<div class="row"><span style="color:var(--muted)">Notes</span><span>${escapeHtml(b.notes)}</span></div>`:''}
    </div>
  `;
  openSheet();
  $('#bdClose').onclick = closeSheet;
}

/* ============================================================
   EXPENSES
   ============================================================ */
async function renderExpenses(view){
  STATE.expFilter = STATE.expFilter || 'month';
  const all = (await db.expenses.toArray()).sort((a,b)=> new Date(b.date)-new Date(a.date));
  const shown = filterByPeriod(all, STATE.expFilter);
  const total = shown.reduce((a,e)=>a+e.amount,0);
  const byCat = {};
  shown.forEach(e=>{ byCat[e.category] = (byCat[e.category]||0)+e.amount; });
  const cats = Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  view.innerHTML = `
    <button class="link-btn" id="backBtn">‹ More</button>
    <div class="section" style="margin-top:10px;"><h1>Expenses</h1></div>
    <div class="pill-row section">${periodPills(STATE.expFilter)}</div>
    <div class="hero-card section"><div class="label">Total (${periodLabel(STATE.expFilter)})</div><div class="value num">${fmtMoney(total)}</div><div class="sub">${shown.length} entr${shown.length===1?'y':'ies'}</div></div>
    ${cats.length? `<h2 class="section">By Category</h2>
    <div class="list-card section">
      ${cats.map(([c,amt])=>`<div class="list-item"><div class="li-main"><div class="li-title">${escapeHtml(c)}</div></div>
        <div class="li-right"><div class="li-amount num">${fmtMoney(amt)}</div><div class="li-sub">${Math.round(amt/total*100)}%</div></div></div>`).join('')}
    </div>`:''}
    <h2 class="section">Entries</h2>
    <div class="list-card section">
      ${shown.length===0? '<div class="empty">No expenses in this period.</div>' : shown.map(e=>`
        <div class="list-item">
          <div class="li-main"><div class="li-title">${escapeHtml(e.category)}</div><div class="li-sub">${escapeHtml(e.description||'')}${e.description?' · ':''}${fmtDate(e.date)}</div></div>
          <div class="li-right"><div class="li-amount num">${fmtMoney(e.amount)}</div></div>
        </div>`).join('')}
    </div>
    <button class="btn btn-primary btn-lg btn-block" id="newExpBtn">+ Add Expense</button>
  `;
  $('#backBtn').addEventListener('click', ()=> go('more'));
  $$('.pill-filter', view).forEach(b=> b.addEventListener('click', ()=>{ STATE.expFilter=b.dataset.v; renderExpenses(view); }));
  $('#newExpBtn').addEventListener('click', openExpenseForm);
}

function openExpenseForm(){
  const sheet = $('#sheet');
  sheet.innerHTML = `
    <div class="sheet-handle"></div>
    <div class="sheet-header"><h2>Add Expense</h2><button class="sheet-close" id="exClose">${icon('x',16)}</button></div>
    <div class="field"><label>Category</label>
      <select id="exCat">${EXPENSE_CATEGORIES.map(c=>`<option value="${c}">${c}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Amount (${SETTINGS.currency})</label><input type="number" step="0.01" id="exAmt" autofocus></div>
    <div class="field"><label>Description</label><input id="exDesc" placeholder="What was it for?"></div>
    <div class="field"><label>Payment method</label>
      <div class="seg" id="exMethod"><button data-v="cash" class="active">Cash</button><button data-v="bank">Bank</button><button data-v="other">Other</button></div>
    </div>
    <button class="btn btn-primary btn-lg btn-block" id="exSave">Save Expense</button>
  `;
  openSheet();
  let method='cash';
  $('#exClose').onclick = closeSheet;
  $('#exMethod').addEventListener('click', e=>{ const b=e.target.closest('button'); if(!b) return; $$('#exMethod button').forEach(x=>x.classList.remove('active')); b.classList.add('active'); method=b.dataset.v; });
  $('#exSave').onclick = async ()=>{
    try{
      await recordExpense({ category: $('#exCat').value, amount: $('#exAmt').value, description: $('#exDesc').value.trim(), method });
      closeSheet(); renderView();
    }catch(err){ toast(err.message); }
  };
}

/* ============================================================
   GENERAL SALE SCREEN (multi-product)
   ============================================================ */
async function openGeneralSale(){
  const customers = (await db.customers.toArray()).filter(c=>c.active!==false);
  const products = (await db.products.toArray()).filter(p=>p.active!==false);
  let selectedCustomer = null;
  let paymentType = 'cash';
  let items = [];

  const sheet = $('#sheet');
  function render(){
    const subtotal = items.reduce((a,i)=>a+i.qty*i.unitPrice,0);
    const discount = Number($('#gDiscount')?.value||0);
    const total = Math.max(0, subtotal-discount);
    sheet.innerHTML = `
      <div class="sheet-handle"></div>
      <div class="sheet-header"><h2>New Sale</h2><button class="sheet-close" id="gClose">${icon('x',16)}</button></div>
      <div class="field"><label>Customer</label>
        <div class="pill-row" id="gCustPills">
          <button class="customer-pill ${!selectedCustomer?'active':''}" data-id="">Walk-in</button>
          ${customers.map(c=>`<button class="customer-pill ${selectedCustomer?.id===c.id?'active':''}" data-id="${c.id}">${escapeHtml(c.name)}</button>`).join('')}
        </div>
        ${selectedCustomer && (selectedCustomer.balance||0)>0 ? `<div style="font-size:12px;color:var(--coral);margin-top:8px;">Already owes ${fmtMoney(selectedCustomer.balance)}</div>`:''}
      </div>
      <h3 style="margin-bottom:8px;">Items</h3>
      <div class="list-card" style="margin-bottom:10px;">
        ${items.length===0? '<div class="empty">No items added yet.</div>' : items.map((it,idx)=>`
          <div class="list-item">
            <div class="li-main"><div class="li-title">${escapeHtml(it.name)}</div>
              <div class="li-sub">${it.qty} ${it.kind==='fresh'?'kg':'×'} ${fmtMoney(it.unitPrice)}</div></div>
            <div class="li-right"><div class="li-amount num">${fmtMoney(it.qty*it.unitPrice)}</div>
              <button class="link-btn gRemove" data-idx="${idx}" style="color:var(--danger);font-size:12px;">Remove</button></div>
          </div>`).join('')}
      </div>
      <div class="grid2" style="margin-bottom:14px;">
        <button class="btn btn-ghost btn-sm" id="gAddFresh">+ Fresh Tuna</button>
        <button class="btn btn-ghost btn-sm" id="gAddProduct">+ Packaged Item</button>
      </div>
      <div class="field"><label>Discount (${SETTINGS.currency})</label><input type="number" step="0.01" id="gDiscount" value="${discount||''}"></div>
      <div class="card" style="background:var(--foam); border:none; margin-bottom:14px;">
        <div class="totalline"><span>Subtotal</span><span class="num">${fmtMoney(subtotal)}</span></div>
        <div class="totalline"><span>Discount</span><span class="num">−${fmtMoney(discount)}</span></div>
        <div class="totalline grand"><span>Total</span><span class="num">${fmtMoney(total)}</span></div>
      </div>
      <div class="field"><label>Payment</label>
        <div class="seg" id="gPayType">
          <button data-v="cash" class="${paymentType==='cash'?'active':''}">Cash</button>
          <button data-v="bank" class="${paymentType==='bank'?'active':''}">Bank</button>
          <button data-v="credit" class="${paymentType==='credit'?'active':''}">Credit</button>
          <button data-v="partial" class="${paymentType==='partial'?'active':''}">Partial</button>
        </div>
      </div>
      <div class="field" ${paymentType!=='partial'?'hidden':''}><label>Amount paid now</label><input type="number" step="0.01" id="gPaid"></div>
      <button class="btn btn-primary btn-lg btn-block" id="gSave">Save Sale</button>
    `;
    bind();
  }
  function bind(){
    $('#gClose').onclick = closeSheet;
    $('#gCustPills').addEventListener('click', e=>{
      const b = e.target.closest('.customer-pill'); if(!b) return;
      selectedCustomer = b.dataset.id ? customers.find(c=>String(c.id)===b.dataset.id) : null;
      render();
    });
    $('#gPayType').addEventListener('click', e=>{
      const b = e.target.closest('button'); if(!b) return;
      paymentType = b.dataset.v; render();
    });
    $$('.gRemove', sheet).forEach(btn=> btn.addEventListener('click', ()=>{ items.splice(Number(btn.dataset.idx),1); render(); }));
    $('#gAddFresh').onclick = ()=> addItemPrompt('fresh');
    $('#gAddProduct').onclick = ()=> addItemPrompt('product');
    $('#gSave').onclick = save;
  }
  function addItemPrompt(kind){
    const inner = document.createElement('div');
    inner.innerHTML = kind==='fresh'
      ? `<div class="field"><label>Weight (kg)</label><input type="number" step="0.01" id="aiQty"></div>
         <div class="field"><label>Price per kg</label><input type="number" step="0.01" id="aiPrice" value="${SETTINGS.defaultFreshPrice||''}"></div>`
      : `<div class="field"><label>Product</label><select id="aiProd">${products.map(p=>`<option value="${p.id}">${escapeHtml(p.name)} — stock ${p.stock||0}</option>`).join('')}</select></div>
         <div class="field"><label>Quantity</label><input type="number" step="1" id="aiQty" value="1"></div>
         <div class="field"><label>Unit price</label><input type="number" step="0.01" id="aiPrice" value="${products[0]?.sellPrice||''}"></div>`;
    const prev = sheet.innerHTML;
    sheet.innerHTML = `<div class="sheet-handle"></div>
      <div class="sheet-header"><h2>Add ${kind==='fresh'?'Fresh Tuna':'Item'}</h2><button class="sheet-close" id="aiClose">${icon('x',16)}</button></div>`;
    sheet.appendChild(inner);
    const btn = document.createElement('button');
    btn.className='btn btn-primary btn-lg btn-block'; btn.textContent='Add to Sale';
    sheet.appendChild(btn);
    $('#aiClose').onclick = ()=> render();
    if(kind==='product'){
      $('#aiProd').addEventListener('change', ()=>{
        const p = products.find(x=>x.id===Number($('#aiProd').value));
        $('#aiPrice').value = p?.sellPrice||'';
      });
    }
    btn.onclick = ()=>{
      const qty = Number($('#aiQty').value||0);
      const unitPrice = Number($('#aiPrice').value||0);
      if(!(qty>0)){ toast('Enter a quantity greater than 0'); return; }
      if(kind==='fresh'){
        items.push({ kind:'fresh', name:'Fresh Yellowfin Tuna', qty, unitPrice });
      } else {
        const p = products.find(x=>x.id===Number($('#aiProd').value));
        items.push({ kind:'product', productId:p.id, name:p.name, qty, unitPrice });
      }
      render();
    };
  }
  async function save(){
    try{
      const res = await recordGeneralSale({
        customerId: selectedCustomer?.id, customerName: selectedCustomer?.name||'Walk-in',
        items, discount: Number($('#gDiscount').value||0), paymentType,
        amountPaid: $('#gPaid')? Number($('#gPaid').value||0) : 0
      });
      if(res){ closeSheet(); renderView(); }
    }catch(err){ toast(err.message); }
  }
  render();
  openSheet();
}
function renderMore(view){
  const items = [
    ['customers','users','Customers'], ['suppliers','anchor','Suppliers / Fishermen'], ['credit','card','Credit'],
    ['production','factory','Production'], ['expenses','receipt','Expenses'], ['reports','chart','Reports'],
    ['products','tag','Products'], ['backup','save','Backup & Restore'], ['settings','gear','Settings']
  ];
  view.innerHTML = `
    <div class="section"><h1>More</h1></div>
    <div class="list-card settings-list">
      ${items.map(([tab,iconName,label])=>`
        <div class="list-item" data-tab="${tab}" style="cursor:pointer;">
          <div class="li-main"><div class="li-title">${icon(iconName)} ${label}</div></div>
          <span class="chev">›</span>
        </div>`).join('')}
    </div>
  `;
  $$('.list-item', view).forEach(li=> li.addEventListener('click', ()=> go(li.dataset.tab)));
}

function renderComingSoon(view, label){
  view.innerHTML = `
    <button class="link-btn" id="backBtn">‹ More</button>
    <div style="min-height:60vh; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; text-align:center;">
      <div>${icon('hourglass',40)}</div>
      <h2>${escapeHtml(label||'')}</h2>
      <p style="color:var(--muted); font-size:14px; max-width:280px;">This module is planned for a later phase, alongside dried tuna, Rihaakuru production and detailed expense tracking.</p>
    </div>
  `;
  $('#backBtn').addEventListener('click', ()=> go('more'));
}

/* ============================================================
   REPORTS (Daily)
   ============================================================ */
async function renderReports(view){
  STATE.reportPeriod = STATE.reportPeriod || 'today';
  const period = STATE.reportPeriod;
  const [allSales, allPurchases, allPayments, allExpenses, products, customers] = await Promise.all([
    db.sales.toArray(), db.purchases.toArray(), db.payments.toArray(),
    db.expenses.toArray(), db.products.toArray(), db.customers.toArray()
  ]);
  const sales = filterByPeriod(allSales.filter(s=>!s.voided), period);
  const purchases = filterByPeriod(allPurchases.filter(p=>!p.voided), period);
  const payments = filterByPeriod(allPayments, period);
  const expenses = filterByPeriod(allExpenses, period);

  const revenue = sales.reduce((a,s)=>a+s.total,0);
  const purchaseCost = purchases.reduce((a,p)=>a+p.total,0);
  const expenseTotal = expenses.reduce((a,e)=>a+e.amount,0);
  const creditGiven = sales.reduce((a,s)=>a+s.balance,0);
  const collected = payments.reduce((a,p)=>a+p.amount,0);
  const avgBuy = await averageFreshCostPerKg();

  // per-product breakdown
  let freshKg = 0, freshRevenue = 0, freshCost = 0;
  const productStats = {}; // productId -> {name, units, revenue, cost}
  for(const s of sales){
    const lines = s.items && s.items.length ? s.items
      : [{ kind:'fresh', name:'Fresh Yellowfin Tuna', qty:s.weightKg, unitPrice:s.pricePerKg }];
    // spread any discount proportionally across lines
    const lineSum = lines.reduce((a,l)=>a+l.qty*l.unitPrice,0) || 1;
    const factor = s.total / lineSum;
    for(const l of lines){
      const lineRevenue = l.qty*l.unitPrice*factor;
      if(l.kind==='fresh'){
        freshKg += l.qty; freshRevenue += lineRevenue; freshCost += avgBuy*l.qty;
      } else {
        const p = products.find(x=>x.id===l.productId);
        const key = l.productId;
        if(!productStats[key]) productStats[key] = { name: l.name, units:0, revenue:0, cost:0 };
        productStats[key].units += l.qty;
        productStats[key].revenue += lineRevenue;
        productStats[key].cost += (p?.costPrice||0) * l.qty;
      }
    }
  }
  const packagedRevenue = Object.values(productStats).reduce((a,p)=>a+p.revenue,0);
  const packagedCost = Object.values(productStats).reduce((a,p)=>a+p.cost,0);
  const estCOGS = freshCost + packagedCost;
  const grossProfit = revenue - estCOGS;
  const netProfit = grossProfit - expenseTotal;

  const topProducts = Object.values(productStats).sort((a,b)=>b.revenue-a.revenue).slice(0,5);

  // top customers over the same period
  const custStats = {};
  for(const s of sales){
    if(!s.customerId) continue;
    if(!custStats[s.customerId]) custStats[s.customerId] = { name:s.customerName, spend:0, count:0 };
    custStats[s.customerId].spend += s.total;
    custStats[s.customerId].count += 1;
  }
  const topBySpend = Object.values(custStats).sort((a,b)=>b.spend-a.spend).slice(0,5);
  const topByCredit = customers.filter(c=>(c.balance||0)>0).sort((a,b)=>b.balance-a.balance).slice(0,5);

  view.innerHTML = `
    <button class="link-btn" id="backBtn">‹ More</button>
    <div class="section" style="margin-top:10px;"><h1>Reports</h1></div>
    <div class="pill-row section">
      <button class="customer-pill pill-filter ${period==='today'?'active':''}" data-v="today">Daily</button>
      <button class="customer-pill pill-filter ${period==='week'?'active':''}" data-v="week">Weekly</button>
      <button class="customer-pill pill-filter ${period==='month'?'active':''}" data-v="month">Monthly</button>
      <button class="customer-pill pill-filter ${period==='all'?'active':''}" data-v="all">All time</button>
    </div>

    <div class="hero-card section">
      <div class="label">Sales revenue · ${periodLabel(period)}</div>
      <div class="value num">${fmtMoney(revenue)}</div>
      <div class="sub">${sales.length} sale${sales.length===1?'':'s'}</div>
    </div>

    <div class="grid2 section">
      <div class="card stat-card"><div class="label">Purchases</div><div class="value num" style="font-size:18px;">${fmtMoney(purchaseCost)}</div></div>
      <div class="card stat-card"><div class="label">Expenses</div><div class="value num" style="font-size:18px;">${fmtMoney(expenseTotal)}</div></div>
      <div class="card stat-card"><div class="label">Credit given</div><div class="value num" style="font-size:18px; color:var(--danger)">${fmtMoney(creditGiven)}</div></div>
      <div class="card stat-card"><div class="label">Credit collected</div><div class="value num" style="font-size:18px; color:var(--good)">${fmtMoney(collected)}</div></div>
    </div>

    <h2 class="section">Estimated Profit</h2>
    <div class="list-card section">
      <div class="list-item"><div class="li-main">Revenue</div><div class="li-right num">${fmtMoney(revenue)}</div></div>
      <div class="list-item"><div class="li-main">Estimated cost of goods sold</div><div class="li-right num">−${fmtMoney(estCOGS)}</div></div>
      <div class="list-item"><div class="li-main" style="font-weight:600;">Estimated gross profit</div><div class="li-right num" style="font-weight:600; color:${grossProfit>=0?'var(--good)':'var(--danger)'}">${fmtMoney(grossProfit)}</div></div>
      <div class="list-item"><div class="li-main">Expenses</div><div class="li-right num">−${fmtMoney(expenseTotal)}</div></div>
      <div class="list-item"><div class="li-main" style="font-weight:700;">Estimated net profit</div><div class="li-right num" style="font-weight:700; color:${netProfit>=0?'var(--good)':'var(--danger)'}">${fmtMoney(netProfit)}</div></div>
    </div>
    <p style="color:var(--muted); font-size:11.5px; margin:-8px 0 20px;">Cost of goods sold uses your average fresh tuna purchase price (${fmtMoney(avgBuy)}/kg) and recorded batch costs, so these are estimates rather than exact allocations.</p>

    <h2 class="section">Product Breakdown</h2>
    <div class="list-card section">
      <div class="list-item"><div class="li-main"><div class="li-title">Fresh Tuna</div><div class="li-sub">${fmtKg(freshKg)} sold</div></div><div class="li-right num">${fmtMoney(freshRevenue)}</div></div>
      ${topProducts.length===0 ? '' : topProducts.map(p=>`
        <div class="list-item"><div class="li-main"><div class="li-title">${escapeHtml(p.name)}</div><div class="li-sub">${p.units} units sold</div></div>
        <div class="li-right"><div class="li-amount num">${fmtMoney(p.revenue)}</div><div class="li-sub num" style="color:${p.revenue-p.cost>=0?'var(--good)':'var(--danger)'}">${fmtMoney(p.revenue-p.cost)} est. profit</div></div></div>`).join('')}
      ${packagedRevenue===0? '<div class="empty">No packaged product sales in this period.</div>':''}
    </div>

    <h2 class="section">Top Customers</h2>
    <div class="list-card section">
      ${topBySpend.length===0? '<div class="empty">No customer sales in this period.</div>' : topBySpend.map((c,i)=>`
        <div class="list-item"><div class="li-main"><div class="li-title">${i+1}. ${escapeHtml(c.name)}</div><div class="li-sub">${c.count} purchase${c.count===1?'':'s'}</div></div>
        <div class="li-right num">${fmtMoney(c.spend)}</div></div>`).join('')}
    </div>

    <h2 class="section">Highest Outstanding Credit</h2>
    <div class="list-card section">
      ${topByCredit.length===0? '<div class="empty">No outstanding credit.</div>' : topByCredit.map(c=>`
        <div class="list-item"><div class="li-main"><div class="li-title">${escapeHtml(c.name)}</div></div>
        <div class="li-right num" style="color:var(--danger)">${fmtMoney(c.balance)}</div></div>`).join('')}
    </div>
  `;
  $('#backBtn').addEventListener('click', ()=> go('more'));
  $$('.pill-filter', view).forEach(b=> b.addEventListener('click', ()=>{ STATE.reportPeriod=b.dataset.v; renderReports(view); }));
}

/* ============================================================
   BACKUP & RESTORE
   ============================================================ */
async function exportBackupObject(){
  const tables = TABLE_NAMES;
  const data = {};
  for(const t of tables) data[t] = await db[t].toArray();
  return { app:'island-tuna', version:1, exportedAt: nowISO(), data };
}
async function downloadBackup(){
  const obj = await exportBackupObject();
  const blob = new Blob([JSON.stringify(obj,null,2)], {type:'application/json'});
  const filename = `island-tuna-backup-${todayISO()}.json`;
  triggerDownload(blob, filename);
  await saveSettings({ lastBackup: nowISO() });
  toast('Backup exported');
}
function triggerDownload(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 500);
}
function toCSV(rows, columns){
  const header = columns.map(c=>c.label).join(',');
  const lines = rows.map(r=> columns.map(c=>{
    let v = c.get(r); if(v==null) v='';
    v = String(v).replace(/"/g,'""');
    if(v.includes(',') || v.includes('\n')) v = `"${v}"`;
    return v;
  }).join(','));
  return [header, ...lines].join('\n');
}
async function exportSalesCSV(){
  const rows = await db.sales.toArray();
  const csv = toCSV(rows, [
    {label:'Sale No', get:r=>r.saleNo}, {label:'Date', get:r=>r.date}, {label:'Customer', get:r=>r.customerName},
    {label:'Weight (kg)', get:r=>r.weightKg}, {label:'Price/kg', get:r=>r.pricePerKg}, {label:'Total', get:r=>r.total},
    {label:'Paid', get:r=>r.paid}, {label:'Balance', get:r=>r.balance}, {label:'Status', get:r=>r.status}, {label:'Voided', get:r=>r.voided}
  ]);
  triggerDownload(new Blob([csv],{type:'text/csv'}), `island-tuna-sales-${todayISO()}.csv`);
}
async function exportCreditCSV(){
  const rows = await db.customers.toArray();
  const csv = toCSV(rows, [
    {label:'Name', get:r=>r.name}, {label:'Phone', get:r=>r.phone}, {label:'Balance', get:r=>r.balance||0}, {label:'Credit Limit', get:r=>r.creditLimit||0}
  ]);
  triggerDownload(new Blob([csv],{type:'text/csv'}), `island-tuna-credit-${todayISO()}.csv`);
}
async function exportPurchasesCSV(){
  const rows = await db.purchases.toArray();
  const csv = toCSV(rows, [
    {label:'Purchase No', get:r=>r.purchaseNo}, {label:'Date', get:r=>r.date}, {label:'Supplier', get:r=>r.supplierName},
    {label:'Weight (kg)', get:r=>r.weightKg}, {label:'Price/kg', get:r=>r.pricePerKg}, {label:'Total', get:r=>r.total},
    {label:'Paid', get:r=>r.paid}, {label:'Balance', get:r=>r.balance}, {label:'Status', get:r=>r.status}
  ]);
  triggerDownload(new Blob([csv],{type:'text/csv'}), `island-tuna-purchases-${todayISO()}.csv`);
}
async function exportInventoryCSV(){
  const rows = await db.inventoryTx.toArray();
  const csv = toCSV(rows, [
    {label:'Date', get:r=>r.date}, {label:'Type', get:r=>r.type}, {label:'Delta (kg)', get:r=>r.deltaKg}, {label:'Running Stock', get:r=>r.runningStock}, {label:'Notes', get:r=>r.notes}
  ]);
  triggerDownload(new Blob([csv],{type:'text/csv'}), `island-tuna-inventory-${todayISO()}.csv`);
}

async function exportExpensesCSV(){
  const rows = await db.expenses.toArray();
  const csv = toCSV(rows, [
    {label:'Date', get:r=>r.date}, {label:'Category', get:r=>r.category},
    {label:'Description', get:r=>r.description}, {label:'Amount', get:r=>r.amount}, {label:'Method', get:r=>r.method}
  ]);
  triggerDownload(new Blob([csv],{type:'text/csv'}), `island-tuna-expenses-${todayISO()}.csv`);
}
async function exportProductionCSV(){
  const rows = await db.productionBatches.toArray();
  const csv = toCSV(rows, [
    {label:'Batch No', get:r=>r.batchNo}, {label:'Date', get:r=>r.date}, {label:'Product', get:r=>r.productName},
    {label:'Fresh Used (kg)', get:r=>r.freshUsedKg}, {label:'Units Produced', get:r=>r.unitsProduced},
    {label:'Total Cost', get:r=>r.totalCost}, {label:'Cost/Unit', get:r=>r.costPerUnit}
  ]);
  triggerDownload(new Blob([csv],{type:'text/csv'}), `island-tuna-production-${todayISO()}.csv`);
}
async function exportProductsCSV(){
  const rows = await db.products.toArray();
  const csv = toCSV(rows, [
    {label:'Name', get:r=>r.name}, {label:'SKU', get:r=>r.sku}, {label:'Type', get:r=>r.type},
    {label:'Sell Price', get:r=>r.sellPrice}, {label:'Cost Price', get:r=>r.costPrice}, {label:'Stock', get:r=>r.stock}
  ]);
  triggerDownload(new Blob([csv],{type:'text/csv'}), `island-tuna-products-${todayISO()}.csv`);
}

async function importBackupFile(file){
  const text = await file.text();
  let obj;
  try{ obj = JSON.parse(text); } catch(e){ toast('Invalid backup file'); return; }
  if(!obj || obj.app!=='island-tuna' || !obj.data){ toast('This file is not a recognised Island Tuna backup'); return; }
  const ok = await confirmDialog('Restore backup?', 'Restoring a backup may replace current data. This cannot be undone.', {yesLabel:'Restore', dangerConfirm:true});
  if(!ok) return;
  const tables = Object.keys(obj.data);
  await db.transaction('rw', tables.map(t=>db[t]), async ()=>{
    for(const t of tables){
      await db[t].clear();
      if(obj.data[t].length) await db[t].bulkAdd(obj.data[t].map(r=>{ const c={...r}; return c; })).catch(async ()=>{
        // fallback if bulkAdd fails on key collisions: put one by one
        for(const rec of obj.data[t]) await db[t].put(rec);
      });
    }
  });
  await loadSettings();
  toast('Backup restored');
  go('home');
}

function renderBackup(view){
  view.innerHTML = `
    <button class="link-btn" id="backBtn">‹ More</button>
    <div class="section" style="margin-top:10px;"><h1>Backup & Restore</h1></div>
    <div class="card section">
      <div class="row"><span style="color:var(--muted); font-size:13.5px;">Last backup</span><span style="font-weight:600;">${SETTINGS.lastBackup? fmtDateTime(SETTINGS.lastBackup) : 'Never'}</span></div>
    </div>
    <div class="stack section">
      <button class="btn btn-primary btn-block" id="exportJsonBtn">Export Full Backup (.json)</button>
      <button class="btn btn-ghost btn-block" id="importJsonBtn">Restore from Backup File</button>
      <input type="file" id="importFileInput" accept="application/json" hidden>
    </div>
    <div class="divider"></div>
    <h2 class="section">CSV Exports</h2>
    <div class="stack section">
      <button class="btn btn-ghost btn-block" id="csvSales">Export Sales CSV</button>
      <button class="btn btn-ghost btn-block" id="csvCredit">Export Customer Credit CSV</button>
      <button class="btn btn-ghost btn-block" id="csvPurchases">Export Purchase CSV</button>
      <button class="btn btn-ghost btn-block" id="csvInventory">Export Inventory CSV</button>
      <button class="btn btn-ghost btn-block" id="csvExpenses">Export Expenses CSV</button>
      <button class="btn btn-ghost btn-block" id="csvProduction">Export Production CSV</button>
      <button class="btn btn-ghost btn-block" id="csvProducts">Export Products CSV</button>
    </div>
    <p style="color:var(--muted); font-size:12px; margin-top:10px;">All data is stored only on this device. Back up regularly — clearing browser data or losing the device will lose your records unless you have a recent backup file saved elsewhere.</p>
  `;
  $('#backBtn').addEventListener('click', ()=> go('more'));
  $('#exportJsonBtn').addEventListener('click', downloadBackup);
  $('#importJsonBtn').addEventListener('click', ()=> $('#importFileInput').click());
  $('#importFileInput').addEventListener('change', e=>{ if(e.target.files[0]) importBackupFile(e.target.files[0]); });
  $('#csvSales').addEventListener('click', exportSalesCSV);
  $('#csvCredit').addEventListener('click', exportCreditCSV);
  $('#csvPurchases').addEventListener('click', exportPurchasesCSV);
  $('#csvInventory').addEventListener('click', exportInventoryCSV);
  $('#csvExpenses').addEventListener('click', exportExpensesCSV);
  $('#csvProduction').addEventListener('click', exportProductionCSV);
  $('#csvProducts').addEventListener('click', exportProductsCSV);
}

/* ============================================================
   SETTINGS
   ============================================================ */
function renderSettings(view){
  view.innerHTML = `
    <button class="link-btn" id="backBtn">‹ More</button>
    <div class="section" style="margin-top:10px;"><h1>Settings</h1></div>
    <h2 class="section">Business Information</h2>
    <div class="stack section">
      <div class="field"><label>Business name</label><input id="setBiz" value="${escapeHtml(SETTINGS.businessName||'')}"></div>
      <div class="field"><label>Island</label><input id="setIsland" value="${escapeHtml(SETTINGS.island||'')}"></div>
      <div class="field"><label>Phone</label><input id="setPhone" value="${escapeHtml(SETTINGS.phone||'')}"></div>
      <div class="field"><label>Address</label><input id="setAddress" value="${escapeHtml(SETTINGS.address||'')}"></div>
      <div class="field"><label>Currency</label><input id="setCurrency" value="${escapeHtml(SETTINGS.currency||'MVR')}"></div>
    </div>
    <h2 class="section">Default Prices</h2>
    <div class="field section"><label>Fresh tuna price/kg</label><input type="number" id="setDefPrice" value="${SETTINGS.defaultFreshPrice||0}"></div>
    <h2 class="section">Inventory</h2>
    <div class="field section"><label>Low-stock threshold (kg)</label><input type="number" id="setLowStock" value="${SETTINGS.lowStockKg||10}"></div>
    <div class="field section">
      <label>Allow selling below zero stock</label>
      <div class="seg" id="setNegStock"><button data-v="0" class="${!SETTINGS.allowNegativeStock?'active':''}">No</button><button data-v="1" class="${SETTINGS.allowNegativeStock?'active':''}">Yes</button></div>
    </div>
    <h2 class="section">Appearance</h2>
    <div class="field section">
      <div class="seg" id="setTheme">
        <button data-v="light" class="${SETTINGS.theme==='light'?'active':''}">Light</button>
        <button data-v="dark" class="${SETTINGS.theme==='dark'?'active':''}">Dark</button>
        <button data-v="system" class="${SETTINGS.theme==='system'?'active':''}">System</button>
      </div>
    </div>
    <button class="btn btn-primary btn-block section" id="setSaveBtn">Save Settings</button>
    <div class="divider"></div>
    <h2 class="section">Demo Data</h2>
    <button class="btn btn-danger btn-block section" id="clearDemoBtn">Clear All Data</button>
  `;
  $('#backBtn').addEventListener('click', ()=> go('more'));
  let neg = !!SETTINGS.allowNegativeStock, theme = SETTINGS.theme||'light';
  $('#setNegStock').addEventListener('click', e=>{ const b=e.target.closest('button'); if(!b) return; $$('#setNegStock button').forEach(x=>x.classList.remove('active')); b.classList.add('active'); neg = b.dataset.v==='1'; });
  $('#setTheme').addEventListener('click', e=>{ const b=e.target.closest('button'); if(!b) return; $$('#setTheme button').forEach(x=>x.classList.remove('active')); b.classList.add('active'); theme = b.dataset.v; });
  $('#setSaveBtn').addEventListener('click', async ()=>{
    await saveSettings({
      businessName: $('#setBiz').value.trim() || 'Island Tuna', island: $('#setIsland').value.trim(),
      phone: $('#setPhone').value.trim(), address: $('#setAddress').value.trim(), currency: $('#setCurrency').value.trim() || 'MVR',
      defaultFreshPrice: Number($('#setDefPrice').value||0), lowStockKg: Number($('#setLowStock').value||10),
      allowNegativeStock: neg, theme
    });
    toast('Settings saved'); renderView();
  });
  $('#clearDemoBtn').addEventListener('click', async ()=>{
    const ok = await confirmDialog('Clear all data?', 'This permanently deletes every customer, sale, purchase and payment on this device. This cannot be undone. Export a backup first if you want to keep a copy.', {yesLabel:'Delete everything', dangerConfirm:true});
    if(ok){ await clearAllData(); toast('All data cleared'); go('home'); }
  });
}

/* ============================================================
   ONLINE / OFFLINE
   ============================================================ */
function updateOnlineStatus(){
  const online = navigator.onLine;
  $('#statusDot').classList.toggle('online', online);
  $('#statusDot').classList.toggle('offline', !online);
  $('#statusLabel').textContent = online ? 'Online' : 'Offline';
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

/* ============================================================
   BOOT
   ============================================================ */
async function boot(){
  try{
    // Load every table concurrently — chaining lazy loads would multiply any
    // per-read delay by the number of tables.
    await Promise.all(TABLE_NAMES.map(n => db[n]._load().catch(()=>{})));
    await loadSettings();
    if(SETTINGS) await seedProductsIfEmpty();

    // Remove the splash BEFORE anything that waits on the user, otherwise the
    // full-screen splash covers the setup wizard and blocks its buttons.
    const splashEl = document.getElementById('splash');
    if(splashEl) splashEl.remove();
    document.getElementById('app').hidden = false;

    if(!SETTINGS){
      // No setup form — go straight to a working dashboard with sensible
      // defaults. Business name, island, phone, and currency can all be
      // changed anytime from More → Settings.
      await db.settings.put({
        id:1, businessName:'Island Tuna', island:'', phone:'', address:'',
        currency:'MVR', theme:'light', defaultFreshPrice:90, freshTunaStock:0,
        lowStockKg:10, pinEnabled:false, pinHash:'', allowNegativeStock:false,
        demoMode:false, lastBackup:null
      });
      await loadSettings();
      await seedProductsIfEmpty();
    }
    applyTheme();
    $('#bizNameTop').textContent = SETTINGS.businessName || 'ISLAND TUNA';
    updateOnlineStatus();
    setTab('home');
    APP_STARTED = true;

    if('serviceWorker' in navigator){
      navigator.serviceWorker.register('sw.js').catch(()=>{});
    }
  }catch(err){
    console.error('Island Tuna failed to start:', err);
    showFatalError(err && err.message ? err.message : String(err));
  }
}
boot();
