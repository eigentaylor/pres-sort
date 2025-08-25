/*
  Presidential Preference Sorter & Tier List
  - Static app; no backend
  - Async interactive merge sort with persistent state
  - Tier board with drag & drop, PNG/JSON export, shareable URL
*/

const LS_KEY = 'pps.v1.state';
const ASSETS_KEY = 'pps.v1.assetsReady';
const DATA_URL = 'data/presidents.json';
const APP_VERSION = '1.0.0';

// --- Utilities --------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function toast(msg, { ok = false, error = false } = {}) {
  const el = $('#toast');
  el.textContent = msg;
  el.style.borderColor = error ? 'var(--danger)' : ok ? 'var(--ok)' : 'var(--border)';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

function debounce(fn, wait = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function base64urlEncode(obj) {
  const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const enc = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return enc;
}

function base64urlDecode(str) {
  try {
    const pad = str.length % 4 === 2 ? '==' : str.length % 4 === 3 ? '=' : '';
    const json = decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad)));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function download(filename, data, type = 'application/json') {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function seededRandom(seed) {
  // xorshift32
  let state = seed >>> 0 || 1;
  return () => {
    let x = state;
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17; x >>>= 0;
    x ^= x << 5;  x >>>= 0;
    state = x >>> 0;
    return (state & 0xffffffff) / 0x100000000;
  };
}

function seededShuffle(array, seed) {
    console.log('seededShuffle: before shuffle array', array);
    const rand = seededRandom();
    const a = [];
    if (Array.isArray(array)) {
      for (let i = 0; i < array.length; i++) {
        const v = array[i];
        if (v && typeof v === 'object' && v.id) a.push(v);
      }
    }
    for (let n = 0; n < 2 + Math.floor(rand() * 3); n++) { // Run the shuffle process between 2 and 4 times
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        if (a[i] && a[j]) {
          [a[i], a[j]] = [a[j], a[i]];
        }
      }
    }
    console.log('seededShuffle: after shuffle', a);
    console.log('seededShuffle: a[1]', a[1]);
    return a;
}

function imageWithFallback(src, alt, { width, height, className } = {}) {
  const img = new Image();
  if (width) img.width = width;
  if (height) img.height = height;
  if (className) img.className = className;
  img.alt = alt;
  img.loading = 'lazy';
  img.src = src;
  img.onerror = () => {
    // Leave handling to caller; replace with placeholder silhouette with initials
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    const initials = (alt.match(/\b([A-Z])[A-Za-z]+/g) || []).map(s => s[0]).slice(0, 2).join('');
    ph.textContent = initials || '👤';
    img.replaceWith(ph);
  };
  return img;
}

function resolveImageSrc(person) {
  // Try multiple patterns: explicit image, numbered variants matching provided img/ files
  const candidates = [];
  if (person.image) candidates.push(`img/${person.image}`);
  if (person.number != null) {
    const n = person.number;
    candidates.push(`img/President_${n}.png`);
    candidates.push(`img/President_${String(n).padStart(2,'0')}.png`);
    candidates.push(`img/President_${String(n)}.png`);
  }
  // generic fallbacks
  candidates.push(`img/${person.id}.jpg`, `img/${person.id}.png`, `img/${person.id}.jpeg`);
  return candidates;
}

function getSeed() {
  const url = new URL(location.href);
  const qsSeed = url.searchParams.get('seed');
  if (qsSeed) return Number(qsSeed) || 1337;
  return 1337; // default deterministic
}

// --- Data loading -----------------------------------------------------------
async function loadData() {
  try {
  console.log('pps: attempting fetch', DATA_URL);
  const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error('Failed to load data');
    const data = await res.json();
    await preflightImages(data);
    return data;
  } catch (err) {
    console.warn('Fetch failed, falling back to embedded JSON', err);
    // Try embedded script
    const el = document.getElementById('presidents-json');
    if (el) {
      try {
        const data = JSON.parse(el.textContent);
        await preflightImages(data);
        return data;
      } catch (e) { throw new Error('No embedded data available'); }
    }
    throw err;
  }
}

async function preflightImages(data) {
  const checks = data.map(p => new Promise(resolve => {
    const candidates = resolveImageSrc(p);
    // Try sequentially until one loads
    (async () => {
      for (const src of candidates) {
        const ok = await new Promise(r => {
          const img = new Image(); img.onload = () => r(true); img.onerror = () => r(false); img.src = src;
        });
        //console.debug('preflightImages:', p.id, src, ok ? 'OK' : 'no');
        if (ok) {
          // record resolved src on object for faster rendering
          try { p._resolved = src; } catch (e) {}
          return resolve(true);
        }
      }
      resolve(false);
    })();
  }));
  await Promise.allSettled(checks);
  localStorage.setItem(ASSETS_KEY, '1');
}

// --- State -----------------------------------------------------------------
const defaultState = () => ({
  version: APP_VERSION,
  seed: getSeed(),
  dataVersion: 1,
  timestamp: Date.now(),
  screen: 'welcome',
  data: [], // loaded presidents
  // sorter state
  sorter: {
    mode: 'merge', // 'merge' | 'elo'
    active: false,
    pendingResolve: null, // internal
    cache: {}, // key "A|B" -> 1 (A>B), 0 (tie), -1 (A<B)
    ties: {}, // key -> true
    progress: 0,
    stack: null, // serialized async mergesort state
    result: null, // array of ids when done
  undo: [], // stack of snapshots to support Back
    // ELO-specific
    elo: {
      ratings: {}, // id -> rating
      kFactor: 32,
      pairsDone: 0,
      totalPairs: 0,
      queue: [], // pending ids to compare
      history: {}, // id -> [r1, r2, ...] (recent values)
    },
    eloIntensity: 'balanced', // 'fast' | 'balanced' | 'accurate'
  },
  // tier board
  tiers: { SS: [], S: [], A: [], B: [], C: [], D: [], F: [], Unplaced: [] },
  // for share link and exports
  history: [],
});

function loadState() {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return sanitizeState(parsed);
  } catch { return null; }
}

function cleanArrayLike(arr) {
  // Produce a dense array of valid objects with id, ignoring custom props and negative keys.
  if (!arr) return [];
  if (!Array.isArray(arr)) {
    // If it's not a real array, try to collect by ascending numeric keys starting at 0
    const len = typeof arr.length === 'number' && arr.length >= 0 ? Math.floor(arr.length) : 0;
    const out = [];
    for (let i = 0; i < len; i++) {
      const v = arr[i];
      if (v && typeof v === 'object' && v.id) out.push(v);
    }
    return out;
  }
  const out = new Array(arr.length);
  let j = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (v && typeof v === 'object' && v.id) { out[j++] = v; }
  }
  if (j !== arr.length) {
    // shrink to actual size
    out.length = j;
    console.debug('cleanArrayLike: removed', arr.length - j, 'invalid or empty entries');
  }
  return out;
}

function sanitizeState(s) {
  if (!s || typeof s !== 'object') return s;
  try {
    // normalize data array
    if (s.data) s.data = cleanArrayLike(s.data);
    else s.data = [];

    // ensure tiers structure
    s.tiers = s.tiers || {};
    ['SS','S','A','B','C','D','F','Unplaced'].forEach(t => { if (!Array.isArray(s.tiers[t])) s.tiers[t] = []; });

    // sorter defaults
    s.sorter = s.sorter || {};
    s.sorter.cache = s.sorter.cache || {};
    s.sorter.ties = s.sorter.ties || {};
  s.sorter.undo = Array.isArray(s.sorter.undo) ? s.sorter.undo : [];
    if (Array.isArray(s.sorter.result)) s.sorter.result = s.sorter.result.filter(Boolean);

    // sanitize stack if present
    if (s.sorter.stack && s.data && s.data.length) {
      const ids = new Set(s.data.map(p => p.id));
      const fixIdList = (list) => Array.isArray(list) ? list.filter(x => typeof x === 'string' && ids.has(x)) : [];
      s.sorter.stack.arr = fixIdList(s.sorter.stack.arr);
      s.sorter.stack.L = fixIdList(s.sorter.stack.L);
      s.sorter.stack.R = fixIdList(s.sorter.stack.R);
      s.sorter.stack.out = fixIdList(s.sorter.stack.out);
      // clamp indices
      s.sorter.stack.li = Math.max(0, Math.min(s.sorter.stack.li|0, s.sorter.stack.L.length));
      s.sorter.stack.rj = Math.max(0, Math.min(s.sorter.stack.rj|0, s.sorter.stack.R.length));
      s.sorter.stack.i = Math.max(0, Math.min(s.sorter.stack.i|0, s.sorter.stack.arr.length));
      s.sorter.stack.width = Math.max(1, s.sorter.stack.width|0 || 1);
    }
  } catch (e) { console.warn('sanitizeState error', e); }
  return s;
}

const saveState = debounce(function save() {
  state.timestamp = Date.now();
  localStorage.setItem(LS_KEY, JSON.stringify(state));
  $('#toast') && toast('Saved', { ok: true });
}, 300);

function clearState() {
  localStorage.removeItem(LS_KEY);
  history.replaceState(null, '', location.pathname + location.search);
}

// --- Router ----------------------------------------------------------------
function showScreen(id) {
  $$('.screen').forEach(s => s.hidden = true);
  const el = $(id.startsWith('#') ? id : `#${id}`);
  if (el) el.hidden = false;
}

// --- Sorter UI --------------------------------------------------------------
function renderCard(el, person) {
  el.innerHTML = '';
  // render token to ignore stale async completions
  const renderToken = Symbol('render');
  el._renderToken = renderToken;
  const wrap = document.createElement('div');
  wrap.className = 'img-wrap';
  // Try candidate image sources in order
  const candidates = person._resolved ? [person._resolved] : resolveImageSrc(person);
  const imgNode = document.createElement('div');
  let loaded = false;
    // If we already resolved a path earlier, use it immediately (synchronous assignment)
    if (person._resolved) {
      try {
        // If another render started, abort this immediate write
        if (el._renderToken !== renderToken) return;
        wrap.style.backgroundImage = `url(${person._resolved})`;
        wrap.style.backgroundSize = 'cover'; wrap.style.backgroundPosition = 'center';
        const imgImmediate = new Image(); imgImmediate.alt = `Portrait of ${person.name}`; imgImmediate.loading = 'lazy'; imgImmediate.className = 'card-img'; imgImmediate.src = person._resolved;
        try { imgNode.remove(); } catch(e) {}
        if (el._renderToken === renderToken) wrap.appendChild(imgImmediate);
        //console.debug('renderCard: immediate resolved background for', person.id, person._resolved);
        loaded = true;
      } catch (e) { console.debug('renderCard: immediate resolved failed', e); }
    }
  (async () => {
    for (const src of candidates) {
      try {
        //console.debug('renderCard: trying', person.id, src);
        await new Promise(res => {
          //console.log('renderCard: loading image for', person.id, src);
          const img = new Image(); img.alt = `Portrait of ${person.name}`; img.loading = 'lazy';
          img.onload = () => { res(img); };
          img.onerror = () => { res(null); };
          img.src = src;
          //console.log('renderCard: got img.src', img.src);
        }).then(img => {
          // Ignore if a newer render started
          if (el._renderToken !== renderToken) { console.debug('renderCard: aborting stale completion for', person.id, src); return; }
          console.debug('renderCard: loaded', person.id, src);
          if (img && !loaded) {
            console.debug('renderCard: attaching image', person.id, src);
            img.className = 'card-img';
            // clear placeholder node and append image into the wrap
            try { imgNode.remove(); } catch(e) {}
            wrap.appendChild(img);
            // also set as background in case <img> doesn't render
            try { wrap.style.backgroundImage = `url(${src})`; wrap.style.backgroundSize = 'cover'; wrap.style.backgroundPosition = 'center'; } catch(e){}
            console.debug('renderCard: loaded', person.id, src);
            loaded = true;
          } else console.debug('renderCard: not loaded or already loaded', person.id, src);
        });
        if (loaded) {
          console.log('Image loaded successfully for', person.id, 'with source', src);
          break;
        }
      } catch {}
    }
    if (!loaded) {
      console.warn('renderCard: failed to load image for', person.id);
      const ph = document.createElement('div'); ph.className = 'placeholder';
      const initials = (person.name.match(/\b([A-Z])[A-Za-z]+/g) || []).map(s => s[0]).slice(0,2).join('');
      ph.textContent = initials || '👤';
  if (el._renderToken === renderToken) imgNode.replaceWith(ph);
    }
  })();
  wrap.appendChild(imgNode);
  const h3 = document.createElement('h3'); h3.textContent = person.name;
  const years = document.createElement('div'); years.className = 'years'; years.textContent = person.years;
  if (person.number != null) {
  const num = document.createElement('span'); num.className = 'pres-number';
  // Special cases for nonconsecutive terms
  if (person.id === 'cleveland') num.textContent = '#22 and #24';
  else if (person.id === 'trump') num.textContent = '#45 and #47';
  else num.textContent = `#${person.number}`;
    years.prepend(num, ' ');
  }
  el.append(wrap, h3, years);
}

function updateProgress(pct) {
  const bar = $('#progress-bar');
  bar.style.width = `${Math.round(pct)}%`;
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  const txt = $('#progress-text');
  if (txt) {
    const n = state?.sorter?.totalComparisons ?? 0;
    const done = countUniqueCachePairs(state?.sorter?.cache || {});
    txt.textContent = n > 0 ? `${done}/${n}` : '';
  }
}

// Count unique unordered comparison pairs in the cache (dedupe A|B vs B|A)
function countUniqueCachePairs(cache) {
  if (!cache || typeof cache !== 'object') return 0;
  const seen = new Set();
  for (const k of Object.keys(cache)) {
    const parts = k.split('|');
    if (parts.length !== 2) continue;
    const [a, b] = parts;
    const canon = a < b ? `${a}|${b}` : `${b}|${a}`;
    seen.add(canon);
  }
  return seen.size;
}

// Build a provisional ranking from current merge-sort state for live display
function computeProvisionalRanking() {
  const st = state?.sorter?.stack;
  const idMap = new Map(state.data.map(p => [p.id, p]));
  if (!st) return state.sorter.result || [];
  const N = st.arr.length;
  const blockEnd = Math.min(N, st.i + 2 * st.width);
  const before = st.arr.slice(0, st.i);
  const after = st.arr.slice(blockEnd);
  const out = (st.out || []);
  const leftTail = (st.L || []).slice(st.li);
  const rightTail = (st.R || []).slice(st.rj);
  const inBlock = out.concat(leftTail, rightTail);
  const ids = before.concat(inBlock, after);
  return ids.map(id => idMap.get(id)).filter(Boolean);
}

// Render live ranking list with equal-number ties; optionally highlight a current pair
function renderLiveRanking(currentPairIds = null) {
  const listEl = $('#live-ranking-list');
  if (!listEl) return;
  let items;
  if (state.sorter.mode === 'elo') {
    const elo = state.sorter.elo;
    if (elo && elo.ratings && Object.keys(elo.ratings).length) {
      const idMap = new Map(state.data.map(p => [p.id, p]));
      const ids = Object.keys(elo.ratings).sort((a,b) => elo.ratings[b] - elo.ratings[a]);
      items = ids.map(id => idMap.get(id)).filter(Boolean);
    } else {
      items = state.sorter.result || [];
    }
  } else {
    items = state.sorter.stack ? computeProvisionalRanking() : (state.sorter.result || []);
  }
  listEl.innerHTML = '';
  let rank = 1;
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    const li = document.createElement('li');
    li.className = 'live-item';
    if (i > 0) {
      const prev = items[i - 1];
      const tieKey = `${prev.id}|${p.id}`;
      const isTie = !!(state.sorter.ties[tieKey] || state.sorter.ties[`${p.id}|${prev.id}`]);
      if (!isTie) rank = i + 1;
    }
    const num = document.createElement('span'); num.className = 'rankno'; num.textContent = `${rank}.`;
    const name = document.createElement('span'); name.textContent = ' ' + p.name;
    li.append(num, name);
    // If in ELO mode, show rounded rating to the right
    if (state.sorter.mode === 'elo' && state.sorter.elo && state.sorter.elo.ratings) {
      const rating = Math.round((state.sorter.elo.ratings[p.id] || 0));
      const rspan = document.createElement('span');
      rspan.className = 'elo-rating';
      rspan.textContent = String(rating);
      // show delta if available
      let deltaSpan = null;
      try {
        const hist = state.sorter.elo.history && state.sorter.elo.history[p.id];
        if (Array.isArray(hist) && hist.length >= 2) {
          const prev = hist[hist.length - 2];
          const delta = Math.round(rating - prev);
          deltaSpan = document.createElement('span');
          deltaSpan.className = 'rating-delta';
          deltaSpan.textContent = delta > 0 ? `+${delta}` : String(delta);
          deltaSpan.title = `Recent ratings: ${hist.join(', ')}`;
        }
      } catch (e) {}
      li.appendChild(rspan);
      if (deltaSpan) li.appendChild(deltaSpan);
    }
    if (currentPairIds && (p.id === currentPairIds[0] || p.id === currentPairIds[1])) li.classList.add('comparing');
    listEl.appendChild(li);
  }
}

function queueSkip(pair, queue) {
  // Place current pair at end of queue (simple strategy)
  queue.push(pair[0], pair[1]);
}

function keyFor(a, b) { return `${a.id}|${b.id}`; }

// prefer: asks the user to choose A vs B and returns 1, 0, -1 (or null for skip)
function makePrefer() {
  return async function prefer(a, b) {
    // cached?
    const k = keyFor(a, b);
    if (state.sorter.cache[k] != null) return state.sorter.cache[k];

    return new Promise(resolve => {
      const leftEl = $('#card-left');
      const rightEl = $('#card-right');
      renderCard(leftEl, a); renderCard(rightEl, b);

      const finish = (val) => {
        if (val !== null && val !== 'BACK') {
          state.sorter.cache[k] = val;
          state.sorter.cache[`${b.id}|${a.id}`] = val === 1 ? -1 : val === -1 ? 1 : 0;
          if (val === 0) state.sorter.ties[k] = true, state.sorter.ties[`${b.id}|${a.id}`] = true;
        }
    document.removeEventListener('keydown', onKey);
    // remove click handlers to avoid stray handlers
    const btnLeft = $('#choose-left'); const btnTie = $('#choose-tie'); const btnRight = $('#choose-right'); const btnSkip = $('#choose-skip'); const btnBack = $('#choose-back');
    if (btnLeft) btnLeft.onclick = null;
    if (btnTie) btnTie.onclick = null;
    if (btnRight) btnRight.onclick = null;
    if (btnSkip) btnSkip.onclick = null;
    if (btnBack) btnBack.onclick = null;
        saveState();
        resolve(val);
      };

      const onKey = (e) => {
        if (e.key === 'ArrowLeft') finish(1);
        else if (e.key?.toLowerCase() === 't') finish(0);
        else if (e.key === 'ArrowRight') finish(-1);
      };
      document.addEventListener('keydown', onKey, { once: false });

  const btnLeft = $('#choose-left');
  const btnTie = $('#choose-tie');
  const btnRight = $('#choose-right');
  const btnSkip = $('#choose-skip');
  const btnBack = $('#choose-back');
  if (btnBack) btnBack.disabled = !(state.sorter.undo && state.sorter.undo.length >= 2);
  if (btnLeft) btnLeft.onclick = (e) => { e && e.preventDefault(); console.debug('choose-left clicked'); finish(1); };
  if (btnTie) btnTie.onclick = (e) => { e && e.preventDefault(); console.debug('choose-tie clicked'); finish(0); };
  if (btnRight) btnRight.onclick = (e) => { e && e.preventDefault(); console.debug('choose-right clicked'); finish(-1); };
  if (btnSkip) btnSkip.onclick = (e) => { e && e.preventDefault(); console.debug('choose-skip clicked'); finish(null); };
  if (btnBack) btnBack.onclick = (e) => { e && e.preventDefault(); console.debug('choose-back clicked'); finish('BACK'); };
  // Highlight current pair in the live ranking panel
  try { renderLiveRanking([a.id, b.id]); } catch (_) {}
    });
  };
}

// Async, resumable merge sort
function serializeFrame(frame) {
  // frame: { L, R, i, j, out }
  return {
    L: frame.L.map(x => x.id),
    R: frame.R.map(x => x.id),
    i: frame.i, j: frame.j,
    out: frame.out.map(x => x.id),
  };
}

function deserializeFrame(frame, idMap) {
  return {
    L: frame.L.map(id => idMap.get(id)),
    R: frame.R.map(id => idMap.get(id)),
    i: frame.i, j: frame.j,
    out: frame.out.map(id => idMap.get(id)),
  };
}

// Resumable iterative merge sort using serialized stack in state.sorter.stack
function idsOf(list) {
  if (!Array.isArray(list)) return [];
  const ids = list.map((x, idx) => {
    if (x == null) { 
        console.warn(`idsOf: null/undefined entry at index ${idx}. Entry value:`, x, 'Full list:', list); 
        return null; 
    }
    if (typeof x === 'string') return x;
    if (typeof x === 'object' && x.id != null) return x.id;
    console.warn('idsOf: unexpected entry at', idx, x);
    return null;
  }).filter(id => id != null);
  return ids;
}
function objsOf(ids, idMap) { return ids.map(id => idMap.get(id)).filter(Boolean); }

function initSort(items) {
  if (!Array.isArray(items) || items.length === 0) {
    console.error('initSort: invalid items', items);
    throw new Error('No items to sort');
  }
  state.sorter.active = true;
  state.sorter.result = null;
  state.sorter.stack = {
    width: 1,
    i: 0,
    arr: idsOf(items).filter(Boolean),
    L: [], R: [], out: [],
    li: 0, rj: 0,
  };
  // precompute total comparisons for display
  const n = state.sorter.stack.arr.length;
  state.sorter.totalComparisons = totalComparisonUpperBound(n);
  // reset undo and seed with initial snapshot
  state.sorter.undo = [];
  pushUndoSnapshot();
  saveState();
}

// --- ELO mode --------------------------------------------------------------
function initElo(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('No items to sort');
  state.sorter.mode = 'elo';
  state.sorter.active = true;
  state.sorter.result = null;
  state.sorter.stack = null;
  state.sorter.cache = {}; state.sorter.ties = {}; state.sorter.undo = [];
  const ids = idsOf(items);
  const basePairs = estimateEloPairTarget(ids.length);
  // adjust intensity
  const intensity = state.sorter.eloIntensity || 'balanced';
  let multiplier = 1.0; let kFactor = 32;
  if (intensity === 'fast') { multiplier = 0.6; kFactor = 40; }
  else if (intensity === 'balanced') { multiplier = 1.0; kFactor = 32; }
  else if (intensity === 'accurate') { multiplier = 1.5; kFactor = 24; }
  const extra = Math.max(0, Math.round((multiplier - 1) * basePairs));
  const elo = { ratings: {}, kFactor, pairsDone: 0, totalPairs: basePairs + extra, queue: [], history: {} };
  // init ratings
  ids.forEach(id => { elo.ratings[id] = 1000; });
  // init history
  ids.forEach(id => { elo.history[id] = [1000]; });
  // seed queue with a shuffled round-robin cycle to ensure broad coverage initially
  const cycles = Math.max(2, Math.ceil(Math.log2(Math.max(2, ids.length))));
  for (let c = 0; c < cycles; c++) {
    const shuffled = seededShuffle(state.data, state.seed + c).map(p => p.id).filter(id => elo.ratings[id] != null);
    for (let i = 0; i < shuffled.length - 1; i++) {
      elo.queue.push([shuffled[i], shuffled[i + 1]]);
    }
  }
  state.sorter.elo = elo;
  // expose for progress display
  state.sorter.totalComparisons = elo.totalPairs;
  pushUndoSnapshot();
  saveState();
}

function estimateEloPairTarget(n) {
  // Reasonable interaction budget; grows near O(n log n)
  if (n <= 1) return 0;
  const h = Math.ceil(Math.log2(n));
  return Math.max(n - 1, Math.round(1.5 * n * h));
}

function eloExpected(ra, rb) { return 1 / (1 + Math.pow(10, (rb - ra) / 400)); }

function eloUpdate(r, score, expected, k) { return r + k * (score - expected); }

async function continueElo() {
  const idMap = new Map(state.data.map(p => [p.id, p]));
  const elo = state.sorter.elo;
  const nextPair = () => {
    // Pull from queue; if empty, pick two with closest ratings to refine borders
    if (elo.queue.length > 0) return elo.queue.shift();
    const ids = Object.keys(elo.ratings);
    ids.sort((a,b) => elo.ratings[b] - elo.ratings[a]);
    let best = null; let bestDiff = Infinity;
    for (let i = 0; i < ids.length - 1; i++) {
      const diff = Math.abs(elo.ratings[ids[i]] - elo.ratings[ids[i+1]]);
      if (diff < bestDiff) { bestDiff = diff; best = [ids[i], ids[i+1]]; }
    }
    return best;
  };

  const prefer = makePrefer();
  const total = elo.totalPairs;
  const progressFromElo = () => {
    const done = elo.pairsDone;
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    updateProgress(pct);
  };

  while (elo.pairsDone < total) {
    const pairIds = nextPair();
    if (!pairIds) break;
    const a = idMap.get(pairIds[0]);
    const b = idMap.get(pairIds[1]);
    if (!a || !b || a.id === b.id) continue;
    // show and ask
    pushUndoSnapshot();
    const res = await prefer(a, b);
    if (res === 'BACK') { restoreFromUndo(); continue; }
    if (res === null) {
      // Treat skip as a draw; requeue later to revisit
      elo.queue.push([a.id, b.id]);
      saveState();
      continue;
    }
    const ra = elo.ratings[a.id];
    const rb = elo.ratings[b.id];
    const Ea = eloExpected(ra, rb);
    const Eb = 1 - Ea;
    const k = elo.kFactor;
    const isTie = res === 0;
    const Sa = isTie ? 0.5 : (res > 0 ? 1 : 0);
    const Sb = isTie ? 0.5 : (res < 0 ? 1 : 0);
    elo.ratings[a.id] = eloUpdate(ra, Sa, Ea, k);
    elo.ratings[b.id] = eloUpdate(rb, Sb, Eb, k);
  // record history (cap to 10)
  (elo.history[a.id] ||= []).push(Math.round(elo.ratings[a.id])); if (elo.history[a.id].length > 10) elo.history[a.id].shift();
  (elo.history[b.id] ||= []).push(Math.round(elo.ratings[b.id])); if (elo.history[b.id].length > 10) elo.history[b.id].shift();
    elo.pairsDone++;
    // Occasionally add comparisons across the spectrum
    if (elo.pairsDone % 7 === 0) {
      const ids = Object.keys(elo.ratings).sort((x,y) => elo.ratings[y] - elo.ratings[x]);
      const mid = Math.floor(ids.length / 2);
      const lo = ids[Math.max(0, mid - 1)];
      const hi = ids[Math.min(ids.length - 1, mid + 1)];
      if (lo && hi && lo !== hi) elo.queue.push([lo, hi]);
    }
    saveState();
    progressFromElo();
    try { renderLiveRanking([a.id, b.id]); } catch {}
  }

  // Finish: convert ratings to sorted list
  const ids = Object.keys(elo.ratings).sort((a,b) => elo.ratings[b] - elo.ratings[a]);
  const result = ids.map(id => idMap.get(id)).filter(Boolean);
  state.sorter.active = false;
  state.sorter.result = result;
  state.sorter.mode = 'elo';
  const btnBackEnd = document.getElementById('choose-back'); if (btnBackEnd) btnBackEnd.disabled = true;
  updateProgress(100);
  saveState();
  renderResults(result);
  showScreen('screen-results');
}

function pushUndoSnapshot() {
  try {
    const snap = {
      // core sorter fields
      mode: state.sorter.mode,
      active: !!state.sorter.active,
      totalComparisons: state.sorter.totalComparisons ?? 0,
      // merge-sort state
      stack: JSON.parse(JSON.stringify(state.sorter.stack)),
      cache: JSON.parse(JSON.stringify(state.sorter.cache)),
      ties: JSON.parse(JSON.stringify(state.sorter.ties)),
      // elo state
      elo: JSON.parse(JSON.stringify(state.sorter.elo || null)),
    };
    state.sorter.undo.push(snap);
    // cap memory
    const MAX_UNDO = 2000; // allow long backtracks
    if (state.sorter.undo.length > MAX_UNDO) state.sorter.undo.splice(0, state.sorter.undo.length - MAX_UNDO);
  } catch (e) { console.warn('pushUndoSnapshot failed', e); }
}

function restoreFromUndo() {
  const stack = state.sorter.undo || [];
  if (stack.length < 2) { toast('Nothing to undo'); return false; }
  // discard current snapshot and use previous
  stack.pop();
  const prev = stack[stack.length - 1];
  if (!prev) return false;
  state.sorter.mode = prev.mode || state.sorter.mode;
  state.sorter.active = !!prev.active;
  state.sorter.totalComparisons = prev.totalComparisons ?? state.sorter.totalComparisons;
  state.sorter.stack = prev.stack;
  state.sorter.cache = prev.cache;
  state.sorter.ties = prev.ties;
  state.sorter.elo = prev.elo || null;
  saveState();
  toast('Undid last choice', { ok: true });
  // Refresh UI bits (progress and live ranking) to reflect restored state
  try {
    if (state.sorter.mode === 'elo' && state.sorter.elo) {
      const done = state.sorter.elo.pairsDone || 0;
      const total = state.sorter.elo.totalPairs || state.sorter.totalComparisons || 0;
      const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
      updateProgress(pct);
    } else if (state.sorter.stack) {
      const n = Array.isArray(state.sorter.stack.arr) ? state.sorter.stack.arr.length : 0;
      const donePairs = countUniqueCachePairs(state.sorter.cache || {});
      updateProgress(estimateProgress(n, donePairs));
    } else {
      updateProgress(0);
    }
  } catch {}
  try { renderLiveRanking(); } catch {}
  return true;
}

async function continueSort() {
  const prefer = makePrefer();
  const idMap = new Map(state.data.map(p => [p.id, p]));
  const st = state.sorter.stack;
  if (!st) return;

  const N = st.arr.length;
  const estimate = () => updateProgress(estimateProgress(N, countUniqueCachePairs(state.sorter.cache)));

  while (st.width < N) {
    if (st.i >= st.arr.length) { st.width *= 2; st.i = 0; continue; }

    // Prepare L,R if empty
    if (st.L.length === 0 && st.R.length === 0) {
      const arrObjs = objsOf(st.arr, idMap);
  const L = arrObjs.slice(st.i, st.i + st.width).filter(Boolean);
  const R = arrObjs.slice(st.i + st.width, st.i + 2 * st.width).filter(Boolean);
  st.L = idsOf(L).filter(Boolean);
  st.R = idsOf(R).filter(Boolean);
      st.out = [];
      st.li = 0; st.rj = 0;
    }

    // If R is empty (odd tail), fast-forward this block
    if (st.R.length === 0) {
      const merged = st.L.slice();
      // splice back into arr
      const before = st.arr.slice(0, st.i);
      const after = st.arr.slice(st.i + st.L.length);
      st.arr = before.concat(merged, after);
      st.L = []; st.R = []; st.out = []; st.li = 0; st.rj = 0;
      st.i += 2 * st.width;
      saveState();
      estimate();
      continue;
    }

    // While both have elements, ask user
    while (st.li < st.L.length && st.rj < st.R.length) {
  let a = idMap.get(st.L[st.li]);
  let b = idMap.get(st.R[st.rj]);
  if (!a) { console.warn('continueSort: invalid L entry, skipping', st.L[st.li]); st.li++; continue; }
  if (!b) { console.warn('continueSort: invalid R entry, skipping', st.R[st.rj]); st.rj++; continue; }
      // Guard: if a and b are the same due to corrupted arrays, advance right index
      if (a && b && a.id === b.id) {
        console.warn('continueSort: detected self-match, advancing right index', a.id);
        st.rj++;
        if (st.rj >= st.R.length) break;
        b = idMap.get(st.R[st.rj]);
      }
      estimate();
  // Capture pre-decision snapshot so Back returns to this exact state
  pushUndoSnapshot();
  const btnBackNow = document.getElementById('choose-back');
  if (btnBackNow) btnBackNow.disabled = !(state.sorter.undo && state.sorter.undo.length >= 2);
  let res = await prefer(a, b);
    if (res === 'BACK') {
        // restore previous snapshot and restart inner loop to show prior pair
        const ok = restoreFromUndo();
        if (ok) {
          // refresh local reference to st after restoration
          // Note: state.sorter.stack object identity updated; rebind st
          Object.assign(st, state.sorter.stack);
          // Keep state.sorter.stack pointing to our working object
          state.sorter.stack = st;
      const btnBackAfter = document.getElementById('choose-back');
      if (btnBackAfter) btnBackAfter.disabled = !(state.sorter.undo && state.sorter.undo.length >= 2);
        }
        continue;
      }
      if (res === null) {
        // If both sides have exactly one candidate left, treat skip as a temporary tie to advance.
        const lRem = st.L.length - st.li;
        const rRem = st.R.length - st.rj;
        if (lRem === 1 && rRem === 1) {
          console.debug('continueSort: skip on 1v1 -> treating as tie to advance');
          st.out.push(st.L[st.li]); st.li++;
          saveState();
        } else {
          // Otherwise, rotate current elements to the end to show a new pair
          const liIdx = st.li; const rjIdx = st.rj;
          let lval = null, rval = null;
          if (liIdx >= 0 && liIdx < st.L.length) lval = st.L.splice(liIdx, 1)[0];
          if (rjIdx >= 0 && rjIdx < st.R.length) rval = st.R.splice(rjIdx, 1)[0];
          if (lval != null) st.L.push(lval);
          if (rval != null) st.R.push(rval);
          console.debug('continueSort: skip rotated, pushed', { lval: !!lval, rval: !!rval, liIdx, rjIdx });
          saveState();
        }
        // Force-render the next pair immediately so UI reflects the change
        try {
          const nextA = idMap.get(st.L[st.li]);
          const nextB = idMap.get(st.R[st.rj]);
          console.debug('continueSort: next pair after skip', { a: nextA && nextA.id, b: nextB && nextB.id });
          const leftEl = $('#card-left'); const rightEl = $('#card-right');
          if (leftEl && rightEl) {
            try {
              // Create replacement nodes to force a full DOM swap (stronger than innerHTML)
              const newLeft = document.createElement(leftEl.tagName.toLowerCase());
              newLeft.className = leftEl.className; newLeft.id = leftEl.id; newLeft.setAttribute('aria-live', leftEl.getAttribute('aria-live') || 'polite');
              const newRight = document.createElement(rightEl.tagName.toLowerCase());
              newRight.className = rightEl.className; newRight.id = rightEl.id; newRight.setAttribute('aria-live', rightEl.getAttribute('aria-live') || 'polite');
              if (nextA) renderCard(newLeft, nextA); else newLeft.innerHTML = '';
              if (nextB) renderCard(newRight, nextB); else newRight.innerHTML = '';
              leftEl.parentNode.replaceChild(newLeft, leftEl);
              rightEl.parentNode.replaceChild(newRight, rightEl);
              // log preview and flash
              console.debug('continueSort: replaced left/right nodes - previews', newLeft.innerHTML.slice(0,200), newRight.innerHTML.slice(0,200));
              // stronger visual nudge: brief scale + shadow, scroll and focus
              try {
                [newLeft, newRight].forEach(n => {
                  n.style.transition = 'transform .12s ease, box-shadow .25s ease, opacity .05s';
                  n.style.transform = 'scale(0.995)';
                });
                requestAnimationFrame(() => {
                  [newLeft, newRight].forEach(n => {
                    n.style.transform = 'scale(1)';
                    n.style.boxShadow = '0 0 0 6px rgba(78,161,255,0.18)';
                  });
                });
                setTimeout(() => { [newLeft, newRight].forEach(n => { n.style.boxShadow = ''; n.style.transition=''; n.style.transform=''; }); }, 380);
                try { newLeft.scrollIntoView({behavior: 'smooth', block: 'center'}); newLeft.focus && newLeft.focus(); } catch (e) {}
              } catch(e) { console.debug('continueSort: visual nudge failed', e); }
              toast('Skipped — pair rotated', {});
            } catch (e) { console.debug('continueSort: node-replace failed', e); }
          }
        } catch (e) { console.warn('continueSort: failed to force-render after skip', e); }
        continue; // re-render next pair
      }
      if (res >= 0) { st.out.push(st.L[st.li]); st.li++; }
      else { st.out.push(st.R[st.rj]); st.rj++; }
  saveState();
  // Refresh live ranking after each decision
  try { renderLiveRanking(); } catch (_) {}
    }

    // Append remaining
    while (st.li < st.L.length) { st.out.push(st.L[st.li++]); }
    while (st.rj < st.R.length) { st.out.push(st.R[st.rj++]); }

  // Splice merged run back; compute original segment length
  const segLen = st.out.length + (st.L.length - st.li) + (st.R.length - st.rj);
  const before = st.arr.slice(0, st.i);
  const after = st.arr.slice(st.i + segLen);
    st.arr = before.concat(st.out, after);
    st.L = []; st.R = []; st.out = []; st.li = 0; st.rj = 0;
    st.i += 2 * st.width;
    saveState();
  }

  // Done
  const result = objsOf(st.arr, idMap);
  state.sorter.active = false;
  state.sorter.result = result;
  state.sorter.stack = null;
  const btnBackEnd = document.getElementById('choose-back');
  if (btnBackEnd) btnBackEnd.disabled = true;
  updateProgress(100);
  saveState();
  renderResults(result);
  showScreen('screen-results');
}

function estimateProgress(n, uniquePairCount) {
  // Tighter upper bound for number of comparisons in merge sort:
  // total <= n*ceil(log2 n) - (2^ceil(log2 n) - 1)
  if (n <= 1) return 100;
  const total = totalComparisonUpperBound(n);
  const pct = Math.min(100, total > 0 ? (uniquePairCount / total) * 100 : 0);
  return pct;
}

function totalComparisonUpperBound(n) {
  if (n <= 1) return 0;
  const h = Math.ceil(Math.log2(Math.max(1, n)));
  return n * h - (Math.pow(2, h) - 1);
}

// --- Results UI -------------------------------------------------------------
function renderResults(list) {
  const ol = $('#results-list');
  ol.innerHTML = '';
  let rank = 1;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const li = document.createElement('li');
    if (i > 0) {
      const prev = list[i - 1];
      const tieKey = `${prev.id}|${p.id}`;
      const isTie = !!(state.sorter.ties[tieKey] || state.sorter.ties[`${p.id}|${prev.id}`]);
      if (!isTie) rank = i + 1;
    }
    const num = document.createElement('span'); num.className = 'rankno'; num.textContent = `${rank}.`;
    const name = document.createElement('span'); name.textContent = ' ' + p.name;
    li.append(num, name);
    if (state.sorter.mode === 'elo' && state.sorter.elo && state.sorter.elo.ratings) {
      const r = Math.round(state.sorter.elo.ratings[p.id] || 0);
      const rspan = document.createElement('span'); rspan.className = 'elo-final'; rspan.textContent = ` ${r}`;
      li.appendChild(rspan);
    }
    ol.appendChild(li);
  }
}

// Restart but keep loaded data: clears sorter and returns to welcome so user can choose mode again
function restartKeepData() {
  // preserve state.data and tiers but remove sorter progress
  const savedData = Array.isArray(state.data) ? state.data : [];
  state = defaultState();
  state.data = savedData;
  state.tiers = { SS: [], S: [], A: [], B: [], C: [], D: [], F: [], Unplaced: [] };
  saveState();
  showScreen('screen-welcome');
}

  // Restart button in results
  const btnRestart = $('#btn-restart');
  if (btnRestart) btnRestart.onclick = () => { if (confirm('Restart sorting with a fresh run?')) restartKeepData(); };

// --- Tier Board -------------------------------------------------------------
const TIER_ORDER = ['SS','S','A','B','C','D','F','Unplaced'];
function buildTierBoard() {
  const board = $('#tier-board');
  board.innerHTML = '';
  const lists = {};
  TIER_ORDER.forEach(tier => {
    const col = document.createElement('section'); col.className = 'tier-col'; col.dataset.tier = tier;
    const header = document.createElement('header'); header.innerHTML = `<span>${tier}</span><span aria-hidden="true"></span>`;
    const list = document.createElement('div'); list.className = 'list'; list.id = `tier-${tier}`;
    col.append(header, list);
    board.appendChild(col);
    lists[tier] = list;
  });

  // Fill items from state.tiers; for missing tiers, use Unplaced
  const idMap = new Map(state.data.map(p => [p.id, p]));
  const seen = new Set();
  TIER_ORDER.forEach(tier => {
    state.tiers[tier] = state.tiers[tier] || [];
    state.tiers[tier].forEach(id => {
      if (!idMap.has(id)) return;
      seen.add(id);
      lists[tier].appendChild(makeTierItem(idMap.get(id)));
    });
  });
  // Add all not-seen to Unplaced respecting ranking
  state.sorter.result.forEach(p => {
    if (!seen.has(p.id)) lists['Unplaced'].appendChild(makeTierItem(p));
  });

  // Init Sortable groups
  TIER_ORDER.forEach(tier => {
    new Sortable(lists[tier], {
      group: 'tiers', animation: 150, ghostClass: 'drag-ghost',
      onEnd: () => { captureTiersFromDOM(); saveState(); }
    });
  });

  // Filter
  $('#tier-filter').oninput = (e) => {
    const q = e.target.value.toLowerCase().trim();
    $$('.tier-item').forEach(el => {
      const name = (el.dataset.name || '').toLowerCase();
      el.style.display = name.includes(q) ? '' : 'none';
    });
  };
}

// --- Tier Cutoffs Wizard ---------------------------------------------------
const CUTOFF_TIERS = ['SS','S','A','B','C','D','F'];
let cutState = null; // { rankIds: string[], pos: 0.., chosen: {SS:number,...}, cursor: 0 }

function startCutoffs() {
  if (!state.sorter.result || !state.sorter.result.length) {
    toast('No ranking available', { error: true });
    return;
  }
  const rankIds = state.sorter.result.map(p => p.id);
  cutState = { rankIds, pos: 0, chosen: {}, cursor: 0 };
  showScreen('screen-cutoffs');
  renderCutoffs();
}

function renderCutoffs() {
  if (!cutState) return;
  const tier = CUTOFF_TIERS[cutState.pos];
  const remaining = cutState.rankIds.length - cutState.cursor;
  $('#cutoffs-tier-label').textContent = `Tier ${tier}: count`;
  $('#cutoffs-remaining').textContent = `of ${remaining} remaining`;
  const input = $('#cutoffs-count');
  input.min = 0; input.max = remaining; input.value = String(Math.max(0, Math.min(remaining, cutState.chosen[tier] ?? 0)));
  // preview list highlighting the next segment
  const ol = $('#cutoffs-list'); ol.innerHTML = '';
  const idMap = new Map(state.data.map(p => [p.id, p]));
  cutState.rankIds.forEach((id, idx) => {
    const li = document.createElement('li'); li.textContent = idMap.get(id)?.name || id;
    if (idx >= cutState.cursor && idx < cutState.cursor + Number(input.value)) li.style.fontWeight = '700';
    ol.appendChild(li);
  });
  // status
  const status = $('#cutoffs-status');
  status.textContent = `Setting ${tier}. Completed: ${CUTOFF_TIERS.slice(0, cutState.pos).map(t=>`${t}:${cutState.chosen[t]||0}`).join(', ') || 'none'}`;
  // buttons
  $('#btn-cutoffs-prev').disabled = cutState.pos === 0;
  $('#btn-cutoffs-next').hidden = cutState.pos >= CUTOFF_TIERS.length - 1;
  $('#btn-cutoffs-apply').hidden = !(cutState.pos >= CUTOFF_TIERS.length - 1);
}

function applyCut(value) {
  const tier = CUTOFF_TIERS[cutState.pos];
  const remaining = cutState.rankIds.length - cutState.cursor;
  const count = Math.max(0, Math.min(remaining, Number(value||0)|0));
  cutState.chosen[tier] = count;
}

function nextCut() {
  const input = $('#cutoffs-count');
  applyCut(input.value);
  const tier = CUTOFF_TIERS[cutState.pos];
  cutState.cursor += cutState.chosen[tier] || 0;
  if (cutState.pos < CUTOFF_TIERS.length - 1) cutState.pos++;
  renderCutoffs();
}

function prevCut() {
  if (cutState.pos === 0) return;
  // rewind one tier
  const prevTier = CUTOFF_TIERS[cutState.pos - 1];
  cutState.pos--;
  cutState.cursor -= cutState.chosen[prevTier] || 0;
  renderCutoffs();
}

function applyCutoffsToTiers() {
  // Build tiers from chosen counts; leftover go to Unplaced initially
  const idMap = new Map(state.data.map(p => [p.id, p]));
  const ids = cutState.rankIds.slice();
  const tiers = { SS: [], S: [], A: [], B: [], C: [], D: [], F: [], Unplaced: [] };
  let cursor = 0;
  CUTOFF_TIERS.forEach(t => {
    const n = Math.max(0, Math.min(ids.length - cursor, cutState.chosen[t] || 0));
    tiers[t] = ids.slice(cursor, cursor + n);
    cursor += n;
  });
  tiers.Unplaced = ids.slice(cursor);
  state.tiers = tiers;
  saveState();
  buildTierBoard();
  showScreen('screen-tier');
}

function makeTierItem(person) {
  const el = document.createElement('div'); el.className = 'tier-item'; el.dataset.id = person.id;
  const imgWrap = document.createElement('div'); imgWrap.className = 'tier-img-wrap';
  const candidates = person._resolved ? [person._resolved] : resolveImageSrc(person);
  (async () => {
    let loaded = false;
    for (const src of candidates) {
      console.debug('makeTierItem: trying', person.id, src);
      await new Promise(res => {
  const i = new Image(); i.alt = `Portrait of ${person.name}`; i.loading = 'eager'; i.decoding = 'async';
  i.onload = () => { if (!loaded) { i.className = 'tier-img'; try { imgWrap.innerHTML=''; } catch(e){} imgWrap.appendChild(i); try { person._resolved = src; } catch(_){} loaded = true; } res(true); };
  i.onerror = () => res(false);
  i.src = src;
      }).then(ok => { if (ok) console.debug('makeTierItem: loaded', person.id, src); else console.debug('makeTierItem: not loaded', person.id, src); });
      if (loaded) break;
    }
    if (!loaded) {
      const ph = document.createElement('div'); ph.className = 'placeholder';
      const initials = (person.name.match(/\b([A-Z])[A-Za-z]+/g) || []).map(s => s[0]).slice(0,2).join('');
      ph.textContent = initials || '\ud83d\udc64';
      imgWrap.innerHTML = ''; imgWrap.appendChild(ph);
    }
  })();
  // For a cleaner visual tier list, show only the image tile.
  // Keep name for accessibility and filtering, and show it on hover/focus via an overlay.
  el.dataset.name = person.name || '';
  el.title = person.name || '';
  el.setAttribute('aria-label', person.name || '');
  // make focusable for keyboard users so overlay can appear on focus
  el.tabIndex = 0;

  // caption element that will pop out below the image on hover
  let captionText = person.name || '';
//   if (person.number != null) {
//     if (person.id === 'cleveland') captionText += ' — #22 & #24';
//     else if (person.id === 'trump') captionText += ' — #45 & #47';
//     else captionText += ` — #${person.number}`;
//   }
  const caption = document.createElement('div');
  caption.className = 'tier-caption';
  caption.textContent = captionText;

  el.append(imgWrap, caption);
  return el;
}

function captureTiersFromDOM() {
  const obj = {}; TIER_ORDER.forEach(tier => {
    obj[tier] = $$('#tier-' + tier + ' .tier-item').map(el => el.dataset.id);
  });
  state.tiers = obj;
}

async function exportPNG() {
  const el = $('#tier-board');
  const scale = 2;
  const backgroundColor = $('#png-transparent').checked ? null : '#ffffff';
  // If Unplaced column exists but is empty, hide it for the export so it's not included in PNG.
  const unplacedCol = el.querySelector('.tier-col[data-tier="Unplaced"]');
  let prevDisplay = null;
  let hid = false;
  try {
    if (unplacedCol) {
      const list = unplacedCol.querySelector('.list');
      if (!list || list.children.length === 0) {
        prevDisplay = unplacedCol.style.display;
        unplacedCol.style.display = 'none';
        hid = true;
      }
    }
    const canvas = await html2canvas(el, { scale, backgroundColor, useCORS: true });
    canvas.toBlob(blob => {
      download('presidential_tiers.png', blob, 'image/png');
    });
  } finally {
    if (hid && unplacedCol) {
      unplacedCol.style.display = prevDisplay || '';
    }
  }
}

function exportJSON() {
  const payload = {
    ranking: state.sorter.result.map(p => p.id),
    tiers: state.tiers,
    dataVersion: state.dataVersion || 1,
    createdAt: new Date().toISOString(),
  };
  download('presidential_tiers.json', JSON.stringify(payload, null, 2));
}

async function importJSON(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !data.tiers) throw new Error('Invalid file');
    // Validate IDs exist
    const ids = new Set(state.data.map(p => p.id));
    Object.values(data.tiers).flat().forEach(id => { if (!ids.has(id)) throw new Error('Unknown id in file'); });

    state.tiers = { SS: [], S: [], A: [], B: [], C: [], D: [], F: [], Unplaced: [], ...data.tiers };
    if (Array.isArray(data.ranking)) {
      const idMap = new Map(state.data.map(p => [p.id, p]));
      state.sorter.result = data.ranking.map(id => idMap.get(id)).filter(Boolean);
    }
    saveState();
    buildTierBoard();
    toast('Imported', { ok: true });
  } catch (e) {
    console.error(e);
    toast('Import failed', { error: true });
  }
}

function copyShareLink() {
  const payload = {
    version: APP_VERSION,
    seed: state.seed,
    timestamp: Date.now(),
    choices: state.sorter.cache,
    ties: state.sorter.ties,
    ranking: state.sorter.result?.map(p => p.id) || null,
    tiers: state.tiers,
  };
  const hash = '#state=' + base64urlEncode(payload);
  const url = location.origin + location.pathname + location.search + hash;
  navigator.clipboard.writeText(url).then(() => toast('Link copied', { ok: true })).catch(() => toast('Copy failed', { error: true }));
}

function tryLoadShareFromHash() {
  if (!location.hash.startsWith('#state=')) return null;
  const decoded = base64urlDecode(location.hash.substring('#state='.length))
  return decoded;
}

// --- App lifecycle ----------------------------------------------------------
let state = loadState() || defaultState();

console.log('pps: app.js loaded');

// Global error handlers to surface runtime problems
window.addEventListener('error', (e) => {
  console.error('Unhandled error', e.error || e.message, e);
  toast('An unexpected error occurred (see console)', { error: true });
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled rejection', e.reason);
  toast('An unexpected promise error occurred (see console)', { error: true });
});

function applyStateOnLoad(loadedData) {
  console.log('pps: applyStateOnLoad - data loaded, items=', Array.isArray(loadedData) ? loadedData.length : 0);
  // sanitize any holes or odd numeric properties before storing
  state.data = cleanArrayLike(loadedData);
  const idMap = new Map(loadedData.map(p => [p.id, p]));
  // If we have a share state in hash
  const shared = tryLoadShareFromHash();
  if (shared) {
    if (shared.choices) state.sorter.cache = shared.choices;
    if (shared.ties) state.sorter.ties = shared.ties;
    if (shared.ranking) state.sorter.result = shared.ranking.map(id => idMap.get(id)).filter(Boolean);
    if (shared.tiers) state.tiers = { SS: [], S: [], A: [], B: [], C: [], D: [], F: [], Unplaced: [], ...shared.tiers };
    state.seed = shared.seed || state.seed;
    saveState();
  }

  // router buttons
  const btnStart = $('#btn-start');
  if (btnStart) {
    btnStart.disabled = false;
    btnStart.addEventListener('click', async (e) => {
      console.log('pps: Start button clicked');
      try { await startSorting(); }
      catch (err) { console.error(err); toast('Start failed', { error: true }); }
    });
  }
  const btnStartElo = $('#btn-start-elo');
  if (btnStartElo) {
    btnStartElo.disabled = false;
    btnStartElo.addEventListener('click', async () => {
      try { await startSortingElo(); }
      catch (err) { console.error(err); toast('Start (ELO) failed', { error: true }); }
    });
  }
  // ELO intensity selector wiring
  const eloSelect = $('#elo-intensity');
  if (eloSelect) {
    // set initial value from state
    eloSelect.value = state.sorter.eloIntensity || 'balanced';
    eloSelect.onchange = () => { state.sorter.eloIntensity = eloSelect.value; saveState(); };
  }
  // Repair button: run sanitizer and show before/after counts
  const btnRepair = $('#btn-repair');
  if (btnRepair) btnRepair.onclick = () => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      const before = raw ? JSON.parse(raw) : null;
      const beforeCount = before && before.data ? (Array.isArray(before.data) ? before.data.length : (before.data.length || 0)) : 0;
      const repaired = sanitizeState(before || defaultState());
      const aggressive = confirm('Repair state: OK = aggressive (wipe sorter progress), Cancel = soft repair (sanitize only).\n\nAggressive will keep candidate data but remove sorter progress, cache, ties, and undo history.');
      if (aggressive) {
        repaired.sorter = { active: false, pendingResolve: null, cache: {}, ties: {}, progress: 0, stack: null, result: null, undo: [] };
        repaired.tiers = { SS: [], S: [], A: [], B: [], C: [], D: [], F: [], Unplaced: [] };
      }
      localStorage.setItem(LS_KEY, JSON.stringify(repaired));
      toast(`Repaired state (data before: ${beforeCount}, after: ${repaired.data.length})`, { ok: true });
      // Log JSON snapshots (avoid DevTools live object evaluation confusion)
      try { console.log('Repair state: before (snapshot)', JSON.parse(JSON.stringify(before || {})), 'after (snapshot)', JSON.parse(JSON.stringify(repaired)), 'aggressive', aggressive); } catch (e) { console.log('Repair state: before/after', before, repaired, 'aggressive', aggressive); }
    } catch (e) { console.error('Repair failed', e); toast('Repair failed', { error: true }); }
  };
  $('#btn-resume').onclick = async () => {
    showScreen('screen-sorter');
    if (state.sorter.mode === 'elo') {
      if (!state.sorter.elo || !state.sorter.elo.queue?.length) initElo(seededShuffle(state.data, state.seed));
      await continueElo();
      return;
    }
    if (!state.sorter.stack) { initSort(seededShuffle(state.data, state.seed)); }
  const btnBack = document.getElementById('choose-back');
  if (btnBack) btnBack.disabled = !(state.sorter.undo && state.sorter.undo.length >= 2);
    await continueSort();
  };
  $('#btn-skip-to-tiers').onclick = () => {
    if (!state.sorter.result) state.sorter.result = seededShuffle(loadedData, state.seed);
    showTierBoard();
  };
  $('#btn-to-tiers').onclick = () => showTierBoard();
  const btnCutoffs = $('#btn-cutoffs');
  if (btnCutoffs) btnCutoffs.onclick = () => startCutoffs();
  $('#btn-cancel-sort').onclick = () => showScreen('screen-welcome');
  // Initial live ranking render
  try { renderLiveRanking(); } catch (_) {}

  $('#btn-export-png').onclick = exportPNG;
  $('#btn-export-json').onclick = exportJSON;
  $('#input-import-json').onchange = (e) => e.target.files?.[0] && importJSON(e.target.files[0]);
  $('#btn-share').onclick = copyShareLink;
  $('#btn-reset').onclick = () => {
    if (confirm('Reset all data?')) { localStorage.clear(); location.hash = ''; location.reload(); }
  };

  $('#btn-help').onclick = () => $('#modal-help').showModal();
  $('#btn-theme').onclick = () => document.documentElement.classList.toggle('light');

  // Cutoffs wizard wiring
  const inputCut = $('#cutoffs-count');
  if (inputCut) inputCut.oninput = () => renderCutoffs();
  const btnPrev = $('#btn-cutoffs-prev'); if (btnPrev) btnPrev.onclick = () => prevCut();
  const btnNext = $('#btn-cutoffs-next'); if (btnNext) btnNext.onclick = () => nextCut();
  const btnApply = $('#btn-cutoffs-apply'); if (btnApply) btnApply.onclick = () => { applyCut($('#cutoffs-count').value); applyCutoffsToTiers(); };
  const btnCancel = $('#btn-cutoffs-cancel'); if (btnCancel) btnCancel.onclick = () => { cutState = null; showScreen('screen-results'); };

  // Initialize welcome screen based on saved progress
  const hasProgress = state.sorter && (state.sorter.stack || Object.keys(state.sorter.cache).length > 0 || state.sorter.result);
  if (hasProgress) {
    $('#btn-resume').hidden = !!state.sorter.result ? true : false;
    $('#btn-skip-to-tiers').hidden = false;
  }

  // If share included ranking, go to results/tier accordingly
  if (state.sorter.result) {
    renderResults(state.sorter.result);
    showScreen('screen-results');
  } else {
    showScreen('screen-welcome');
  }
}

async function startSorting() {
  // Build the candidate list, shuffled by seed
  try {
  // Fresh run: clear persisted state and reset in-memory state to defaults
  clearState();
  state = defaultState();
  state.tiers = { SS: [], S: [], A: [], B: [], C: [], D: [], F: [], Unplaced: [] };
  // Load fresh data to avoid relying on possibly mutated state.data
  let fresh;
  try { fresh = await loadData(); } catch (e) { fresh = Array.isArray(state.data) ? state.data : []; }
  const source = Array.from(fresh || []).filter(p => p && p.id);
  // Use the fresh, preflighted objects as canonical state so _resolved is preserved
  state.data = source;
  // Defensive: remove any accidental holes or non-object entries and log
  const beforeLen = Array.isArray(fresh) ? fresh.length : 0;
  const afterLen = source.length;
  if (afterLen !== beforeLen) console.warn('startSorting: removed', beforeLen - afterLen, 'invalid entries from data source');
  saveState();
  if (source.length === 0) throw new Error('No valid candidates available');
  if (source.length !== (fresh || []).length) console.warn('startSorting: removed invalid entries from data source', (fresh || []).length - source.length);
  // Defensive snapshot: log a copy so DevTools shows exact snapshot at this moment
  console.log('seededShuffle: initial snapshot (copy)', source.slice());
  const items = seededShuffle(source, state.seed);
  console.log('seededShuffle: items snapshot (copy)', items.slice());
  console.log('startSorting: items sample', items.slice(0,6));
  initSort(items);
    showScreen('screen-sorter');
  updateProgress(estimateProgress(items.length, countUniqueCachePairs(state.sorter.cache)));
  const btnBack = document.getElementById('choose-back');
  if (btnBack) btnBack.disabled = !(state.sorter.undo && state.sorter.undo.length >= 2);
    await continueSort();
  } catch (err) {
    console.error('startSorting error', err);
    toast('An error occurred starting the sorter', { error: true });
    throw err;
  }
}

function showTierBoard() {
  if (!state.sorter.result) {
    const rawSource = Array.isArray(state.data) ? state.data : [];
    const source = rawSource.filter(p => p && p.id);
    state.sorter.result = seededShuffle(source, state.seed);
  }
  buildTierBoard();
  showScreen('screen-tier');
}

async function startSortingElo() {
  try {
    clearState();
    state = defaultState();
    state.tiers = { SS: [], S: [], A: [], B: [], C: [], D: [], F: [], Unplaced: [] };
    let fresh;
    try { fresh = await loadData(); } catch (e) { fresh = Array.isArray(state.data) ? state.data : []; }
    const source = Array.from(fresh || []).filter(p => p && p.id);
    state.data = source;
    saveState();
    if (source.length === 0) throw new Error('No valid candidates available');
    const items = seededShuffle(source, state.seed);
    initElo(items);
    showScreen('screen-sorter');
    updateProgress(0);
    const btnBack = document.getElementById('choose-back');
    if (btnBack) btnBack.disabled = !(state.sorter.undo && state.sorter.undo.length >= 2);
    await continueElo();
  } catch (err) {
    console.error('startSortingElo error', err);
    toast('An error occurred starting ELO mode', { error: true });
    throw err;
  }
}

// Initial load
loadData().then(applyStateOnLoad).catch(err => {
  console.error(err);
  toast('Failed to load data', { error: true });
});

// Listen for hash changes to offer state import
window.addEventListener('hashchange', () => {
  const shared = tryLoadShareFromHash();
  if (shared) {
    if (confirm('Load state from URL?')) {
      // wipe current and apply
      const newState = defaultState();
      state = Object.assign(newState, state, shared);
      location.reload();
    }
  }
});
