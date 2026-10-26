/* ============================================================
   STANICA — serverless live departures for BG / NS / NI.
   Talks directly to the upstream BusLogic / NSmart endpoints
   (reverse-engineered in github.com/FmasterofU/NSmart-RE,
   same upstreams used by github.com/MikMik1011/bgpp).
   Belgrade's V2 API uses AES-256-CBC, done in-browser via
   WebCrypto — no backend needed.
   ============================================================ */
'use strict';

/* ---------- city / upstream configuration ---------- */

const CITIES = {
  bg: {
    name: 'Beograd',
    bullet: { text: 'BG', color: '#EE352E' },
    hint: 'GSP / BG Naplata · V2 encrypted API',
    base: 'https://announcement-bgnaplata.ticketing.rs',
    apiKey: '1688dc355af72ef09287',
    version: 2,
    encKey: '3+Lhz8XaOli6bHIoYPGuq9Y8SZxEjX6eN7AFPZuLCLs=',
    encIV: 'IvUScqUudyxBTBU9ZCyjow==',
    center: [44.81255, 20.46145],
  },
  ns: {
    name: 'Novi Sad',
    bullet: { text: 'NS', color: '#0039A6' },
    hint: 'JGSP Novi Sad · NSmart API',
    base: 'https://online.nsmart.rs',
    apiKey: '4670f468049bbee2260',
    version: 1,
    center: [45.267136, 19.833549],
  },
  ni: {
    name: 'Niš',
    bullet: { text: 'NI', color: '#FF6319' },
    hint: 'JGPNiš · NSmart API',
    base: 'https://online.jgpnis.rs',
    apiKey: 'cddfd29e495b4851965d',
    version: 1,
    center: [43.3209, 21.8958],
  },
};

/* MTA-ish palette, used to give every line a stable route-bullet color */
const LINE_PALETTE = [
  '#EE352E', '#00933C', '#0039A6', '#FF6319',
  '#B933AD', '#6CBE45', '#996633', '#FCCC0A',
];

const REFRESH_SECONDS = 20;
const STATIONS_CACHE_TTL = 24 * 60 * 60 * 1000; // 1 day

/* ---------- tiny DOM + storage helpers ---------- */

const $ = (sel) => document.querySelector(sel);
const app = $('#app');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function bullet(text, color) {
  const b = el('span', 'bullet', text);
  b.style.background = color;
  if (color.toUpperCase() === '#FCCC0A') b.classList.add('text-dark');
  b.title = 'Line ' + text;
  return b;
}

function lineColor(lineNumber) {
  let hash = 0;
  const s = String(lineNumber);
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return LINE_PALETTE[hash % LINE_PALETTE.length];
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('stanica:' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('stanica:' + key, JSON.stringify(value)); } catch {}
  },
};

const settings = Object.assign({ proxy: '' }, store.get('settings', {}));
const favorites = store.get('favorites', {}); // { cityId: [stationKey, ...] }
let geoPos = store.get('geopos', null); // { lat, lon }

/* ---------- networking ---------- */

async function apiFetch(path, options = {}) {
  const url = options.absolute ? path : path;
  const proxy = (settings.proxy || '').trim();
  const target = proxy ? proxy + encodeURIComponent(url) : url;
  const opts = Object.assign({}, options);
  delete opts.absolute;
  const res = await fetch(target, opts);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' from upstream');
  return res;
}

function buslogicHeaders(city) {
  return {
    'X-Api-Authentication': city.apiKey,
    // 'User-Agent: okhttp/4.10.0' is what the apps send; browsers forbid
    // setting it — upstreams accept the request without it.
  };
}

/* ---------- Belgrade V2 AES-256-CBC (WebCrypto) ---------- */

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function aesKey(city) {
  const raw = b64ToBytes(city.encKey);
  return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false,
    ['encrypt', 'decrypt']);
}

async function v2Encrypt(city, payloadObj) {
  const key = await aesKey(city);
  const iv = b64ToBytes(city.encIV);
  const data = new TextEncoder().encode(JSON.stringify(payloadObj));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, data);
  return bytesToB64(new Uint8Array(encrypted));
}

async function v2Decrypt(city, body) {
  let b64 = body;
  try { b64 = decodeURIComponent(body); } catch { /* already plain base64 */ }
  const key = await aesKey(city);
  const iv = b64ToBytes(city.encIV);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv }, key, b64ToBytes(b64));
  return JSON.parse(new TextDecoder().decode(plain));
}

/* ---------- upstream data ---------- */

async function fetchStations(cityId) {
  const city = CITIES[cityId];
  const cacheKey = 'stations:' + cityId;
  const cached = store.get(cacheKey, null);
  if (cached && Date.now() - cached.time < STATIONS_CACHE_TTL) return cached.stations;

  const res = await apiFetch(city.base + '/publicapi/v1/networkextended.php', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, buslogicHeaders(city)),
    body: JSON.stringify({ action: 'get_cities_extended' }),
  });
  const json = await res.json();

  // Same shape as bgpp's ParserV1: upstream `id` = uid used by the arrivals
  // endpoint; `station_id` = public station id.
  const stations = (json.stations || []).map((s) => ({
    uid: String(s.id),
    id: String(s.station_id).toUpperCase(),
    name: s.name,
    lat: Number(s.coordinates && s.coordinates.latitude) || 0,
    lon: Number(s.coordinates && s.coordinates.longitude) || 0,
  }));
  store.set(cacheKey, { time: Date.now(), stations });
  return stations;
}

async function fetchArrivals(cityId, station) {
  const city = CITIES[cityId];
  let raw;
  if (city.version === 2) {
    const payload = { station_uid: station.uid, session_id: 'A' + Date.now() };
    const encrypted = await v2Encrypt(city, payload);
    const res = await apiFetch(city.base + '/publicapi/v2/api.php', {
      method: 'POST',
      headers: buslogicHeaders(city),
      body: new URLSearchParams({ action: 'data_bulletin', base: encrypted }),
    });
    const body = await res.text();
    const decrypted = await v2Decrypt(city, body);
    raw = decrypted && decrypted.data;
  } else {
    const res = await apiFetch(
      city.base + '/publicapi/v1/announcement/announcement.php' +
      '?ibfm=TM000001&action=get_announcement_data&station_uid=' + encodeURIComponent(station.uid),
      { headers: buslogicHeaders(city) });
    raw = await res.json();
  }

  if (!Array.isArray(raw) || raw.length === 0 || raw[0].just_coordinates === '1') return [];

  // Same grouping as bgpp's ParserV1 (iterate reversed so earliest comes first).
  const lines = new Map();
  for (let i = raw.length - 1; i >= 0; i--) {
    const v = raw[i];
    const veh = (v.vehicles && v.vehicles[0]) || {};
    const arrival = {
      etaSeconds: Number(v.seconds_left ?? 0),
      etaStations: Number(v.stations_between ?? 0),
      stationName: veh.station_name || 'Unknown',
      garageNo: veh.garageNo || 'Unknown',
      lat: Number(veh.lat ?? 0),
      lon: Number(veh.lng ?? 0),
    };
    if (lines.has(v.line_number)) {
      lines.get(v.line_number).arrivals.push(arrival);
    } else {
      lines.set(v.line_number, {
        lineNumber: String(v.line_number),
        lineName: v.line_title || '',
        arrivals: [arrival],
      });
    }
  }
  const out = Array.from(lines.values());
  out.forEach((l) => l.arrivals.sort((a, b) => a.etaSeconds - b.etaSeconds));
  out.sort((a, b) => a.arrivals[0].etaSeconds - b.arrivals[0].etaSeconds);
  return out;
}

/* ---------- misc helpers ---------- */

function normalize(s) {
  return String(s).toLowerCase()
    .replace(/[\u0106\u0107]/g, 'c').replace(/[\u010C\u010D]/g, 'c')
    .replace(/[\u0160\u0161]/g, 's').replace(/[\u017D\u017E]/g, 'z')
    .replace(/[\u0110\u0111]/g, 'dj');
}

function fmtEta(seconds) {
  if (seconds <= 0) return 'ARRIVING';
  if (seconds < 60) return '<1 MIN';
  const m = Math.floor(seconds / 60);
  return m + ' MIN';
}

function distanceKm(a, b) {
  const R = 6371, dLat = (b[0] - a[0]) * Math.PI / 180,
    dLon = (b[1] - a[1]) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function fmtDist(km) {
  if (km < 1) return Math.round(km * 1000) + ' m';
  return km.toFixed(1) + ' km';
}

/* ============================================================
   VIEWS + ROUTER
   Routes:  #/                 home (pick a "line" / city)
            #/<city>          stations in city
            #/<city>/<id>     live departures board
   ============================================================ */

let refreshTimer = null;
let countdownTimer = null;

function clearTimers() {
  clearInterval(refreshTimer);
  clearInterval(countdownTimer);
  refreshTimer = countdownTimer = null;
}

function setView(node) {
  clearTimers();
  app.innerHTML = '';
  app.appendChild(node);
  window.scrollTo(0, 0);
}

function errorNotice(err) {
  const box = el('div', 'notice');
  const title = el('strong', null, 'SIGNAL PROBLEM');
  box.appendChild(title);
  box.appendChild(el('br'));
  const msg = el('span', null,
    'Could not reach the upstream API. ' +
    (settings.proxy
      ? 'Check your CORS proxy prefix in settings (⚙). '
      : 'The upstream may be down — or your browser blocked the cross-origin request. ' +
        'Open settings (⚙) and try a CORS proxy prefix such as https://corsproxy.io/?url= — ') +
    'Details: ' + (err && err.message ? err.message : err));
  box.appendChild(msg);
  return box;
}

/* ---------- home ---------- */

function viewHome() {
  const wrap = el('div');
  wrap.appendChild(el('h2', 'view-title', 'Select a line — izaberi grad'));

  const grid = el('div', 'city-grid');
  for (const [id, city] of Object.entries(CITIES)) {
    const tile = el('a', 'city-tile');
    tile.href = '#/' + id;
    tile.appendChild(bullet(city.bullet.text, city.bullet.color));
    const mid = el('div');
    mid.appendChild(el('div', 'city-name', city.name));
    mid.appendChild(el('div', 'city-hint', city.hint));
    tile.appendChild(mid);
    tile.appendChild(el('span', 'city-arrow', '→'));
    grid.appendChild(tile);
  }
  wrap.appendChild(grid);

  // favorite stops across cities
  const favEntries = Object.entries(favorites)
    .flatMap(([cityId, ids]) => (ids || []).map((sid) => ({ cityId, sid })));
  if (favEntries.length) {
    const strip = el('div', 'fav-strip');
    strip.appendChild(el('h2', 'view-title', '★ Favorite stops'));
    const list = el('ul', 'station-list');
    for (const f of favEntries) {
      if (!CITIES[f.cityId]) continue;
      const row = el('li', 'station-row');
      row.appendChild(bullet(CITIES[f.cityId].bullet.text, CITIES[f.cityId].bullet.color));
      const info = el('div');
      info.appendChild(el('div', 'station-name', f.sid));
      info.appendChild(el('div', 'station-meta', CITIES[f.cityId].name.toUpperCase() + ' · SAVED STOP'));
      row.appendChild(info);
      row.appendChild(el('span', 'station-go', '→'));
      row.addEventListener('click', () => { location.hash = '#/' + f.cityId + '/' + encodeURIComponent(f.sid); });
      list.appendChild(row);
    }
    strip.appendChild(list);
    wrap.appendChild(strip);
  }
  setView(wrap);
}

/* ---------- city / station picker ---------- */

async function viewCity(cityId) {
  const city = CITIES[cityId];
  if (!city) { location.hash = '#/'; return; }

  const wrap = el('div');
  wrap.appendChild(el('h2', 'view-title', city.name + ' — find your stop'));

  const plaque = el('div', 'plaque');
  plaque.appendChild(bullet(city.bullet.text, city.bullet.color));
  const h = el('h1', null, city.name);
  h.appendChild(el('span', 'plaque-sub', 'STATION SELECT · STANICA'));
  plaque.appendChild(h);
  wrap.appendChild(plaque);

  const loading = el('div', 'loading-sign', 'LOADING STATIONS…');
  wrap.appendChild(loading);
  setView(wrap);

  let stations;
  try {
    stations = await fetchStations(cityId);
  } catch (err) {
    loading.remove();
    const back = el('a', 'btn btn-secondary btn-block', '← BACK');
    back.href = '#/';
    wrap.appendChild(errorNotice(err));
    wrap.appendChild(back);
    return;
  }
  loading.remove();

  if (!stations.length) {
    wrap.appendChild(el('div', 'empty-note', 'NO STATIONS REPORTED BY THE UPSTREAM API'));
    return;
  }

  const searchWrap = el('div', 'search-wrap');
  const input = el('input', 'search-input');
  input.type = 'search';
  input.placeholder = 'Search station — npr. "železnička"…';
  input.setAttribute('aria-label', 'Search stations');
  searchWrap.appendChild(input);
  wrap.appendChild(searchWrap);

  const list = el('ul', 'station-list');
  wrap.appendChild(list);

  const favs = favorites[cityId] || [];

  function renderList() {
    const q = normalize(input.value.trim());
    let shown = stations.filter((s) => !q || normalize(s.name).includes(q));
    if (geoPos) {
      shown = shown.slice().sort((a, b) =>
        distanceKm(geoPos, [a.lat, a.lon]) - distanceKm(geoPos, [b.lat, b.lon]));
    } else {
      shown = shown.slice().sort((a, b) => a.name.localeCompare(b.name, 'sr'));
    }
    list.innerHTML = '';
    if (!shown.length) {
      list.appendChild(el('div', 'empty-note', 'NO MATCHING STATIONS'));
      return;
    }
    for (const s of shown.slice(0, 400)) {
      const row = el('li', 'station-row');
      row.appendChild(el('span', 'station-dot'));
      const info = el('div');
      info.appendChild(el('div', 'station-name', s.name));
      const metaBits = [];
      if (geoPos && s.lat) metaBits.push(fmtDist(distanceKm(geoPos, [s.lat, s.lon])) + ' AWAY');
      metaBits.push('STOP ' + s.id);
      info.appendChild(el('div', 'station-meta', metaBits.join(' · ')));
      row.appendChild(info);

      const favBtn = el('button', 'station-fav' + (favs.includes(s.id) ? ' on' : ''), '★');
      favBtn.title = 'Save as favorite';
      favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const i = favs.indexOf(s.id);
        if (i >= 0) { favs.splice(i, 1); toast('REMOVED FROM FAVORITES'); }
        else { favs.push(s.id); toast('SAVED TO FAVORITES'); }
        favorites[cityId] = favs;
        store.set('favorites', favorites);
        favBtn.classList.toggle('on', i < 0);
      });
      row.appendChild(favBtn);
      row.appendChild(el('span', 'station-go', '→'));
      row.addEventListener('click', () => {
        location.hash = '#/' + cityId + '/' + encodeURIComponent(s.id);
      });
      list.appendChild(row);
    }
  }
  input.addEventListener('input', renderList);
  renderList();
}

/* ---------- departures board ---------- */

function updateBoardClock(updatedAt) {
  const clock = $('#board-clock');
  if (!clock) return;
  const elapsed = Math.floor((Date.now() - updatedAt) / 1000);
  const left = Math.max(0, REFRESH_SECONDS - elapsed);
  const t = new Date(updatedAt);
  const pad = (n) => String(n).padStart(2, '0');
  clock.textContent = 'UPDATED ' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) +
    ' · NEXT IN ' + left + 's';
}

async function loadBoard(cityId, station, board, stationNameEl) {
  const head = board.querySelector('.board-body');
  let lines;
  try {
    lines = await fetchArrivals(cityId, station);
  } catch (err) {
    head.innerHTML = '';
    head.appendChild(errorNotice(err));
    return;
  }
  head.innerHTML = '';
  stationNameEl.textContent = station.name;

  if (!lines.length) {
    head.appendChild(el('div', 'board-empty',
      'NO DEPARTURES AT THIS TIME\nCHECK BACK SOON'));
    return;
  }
  for (const line of lines) {
    const row = el('div', 'dep-row');
    row.appendChild(bullet(line.lineNumber, lineColor(line.lineNumber)));
    const info = el('div', 'dep-info');
    info.appendChild(el('div', 'dep-line-name', line.lineName || ('LINE ' + line.lineNumber)));
    const next = line.arrivals[0];
    const bits = [];
    if (next.etaStations > 0) bits.push(next.etaStations + (next.etaStations === 1 ? ' STOP' : ' STOPS') + ' AWAY');
    if (next.stationName && next.stationName !== 'Unknown') bits.push('NEAR ' + next.stationName.toUpperCase());
    if (next.garageNo && next.garageNo !== 'Unknown') bits.push('UNIT ' + next.garageNo);
    if (bits.length) info.appendChild(el('div', 'dep-detail', bits.join(' · ')));
    row.appendChild(info);

    const etas = el('div', 'dep-etas');
    const main = el('span', 'dep-eta-main' + (next.etaSeconds <= 45 ? ' arriving' : ''), fmtEta(next.etaSeconds));
    etas.appendChild(main);
    if (line.arrivals.length > 1) {
      etas.appendChild(el('span', 'dep-eta-next',
        'then ' + line.arrivals.slice(1, 3).map((a) => fmtEta(a.etaSeconds)).join(' · ')));
    }
    row.appendChild(etas);
    head.appendChild(row);
  }
}

async function viewStation(cityId, stationId) {
  const city = CITIES[cityId];
  if (!city) { location.hash = '#/'; return; }

  const wrap = el('div');
  wrap.appendChild(el('h2', 'view-title', city.name + ' — live departures'));

  const plaque = el('div', 'plaque');
  plaque.appendChild(bullet(city.bullet.text, city.bullet.color));
  const h = el('h1');
  const nameSpan = el('span', null, '…');
  h.appendChild(nameSpan);
  h.appendChild(el('span', 'plaque-sub', 'STOP ' + stationId + ' · ' + city.name.toUpperCase()));
  plaque.appendChild(h);
  wrap.appendChild(plaque);

  const loading = el('div', 'loading-sign', 'FINDING STOP…');
  wrap.appendChild(loading);
  setView(wrap);

  let station = null;
  try {
    const stations = await fetchStations(cityId);
    station = stations.find((s) => s.id === stationId) ||
              stations.find((s) => s.id === stationId.toUpperCase());
  } catch (err) {
    loading.remove();
    wrap.appendChild(errorNotice(err));
    const back = el('a', 'btn btn-secondary btn-block', '← ALL STATIONS');
    back.href = '#/' + cityId;
    wrap.appendChild(back);
    return;
  }
  loading.remove();
  if (!station) {
    wrap.appendChild(el('div', 'empty-note', 'STOP NOT FOUND — IT MAY HAVE BEEN REMOVED FROM THE NETWORK'));
    const back = el('a', 'btn btn-secondary btn-block', '← ALL STATIONS');
    back.href = '#/' + cityId;
    wrap.appendChild(back);
    return;
  }

  const board = el('div', 'board');
  const head = el('div', 'board-head');
  head.appendChild(el('span', 'board-title', '◉ LIVE DEPARTURES'));
  const clock = el('span', 'board-clock');
  clock.id = 'board-clock';
  head.appendChild(clock);
  board.appendChild(head);
  board.appendChild(el('div', 'board-body'));
  wrap.appendChild(board);

  const actions = el('div', 'board-actions');
  const refreshBtn = el('button', 'btn', '↻ REFRESH');
  const backBtn = el('a', 'btn btn-secondary', '← ALL STATIONS');
  backBtn.href = '#/' + cityId;
  actions.appendChild(refreshBtn);
  actions.appendChild(backBtn);
  wrap.appendChild(actions);

  let updatedAt = 0;
  const run = async () => {
    await loadBoard(cityId, station, board, nameSpan);
    updatedAt = Date.now();
    updateBoardClock(updatedAt);
  };
  refreshBtn.addEventListener('click', run);
  await run();
  refreshTimer = setInterval(run, REFRESH_SECONDS * 1000);
  countdownTimer = setInterval(() => updateBoardClock(updatedAt), 1000);
}

/* ---------- router ---------- */

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean)
    .map(decodeURIComponent);
  if (!parts.length) return viewHome();
  if (parts.length === 1) return viewCity(parts[0].toLowerCase());
  return viewStation(parts[0].toLowerCase(), parts[1].toUpperCase());
}

/* ---------- settings modal ---------- */

const modal = $('#modal');
$('#btn-settings').addEventListener('click', () => {
  $('#proxy-input').value = settings.proxy || '';
  modal.classList.remove('hidden');
});
$('#btn-close-modal').addEventListener('click', () => {
  settings.proxy = $('#proxy-input').value.trim();
  store.set('settings', settings);
  modal.classList.add('hidden');
  toast(settings.proxy ? 'PROXY SAVED' : 'DIRECT CONNECTION — NO PROXY');
});
modal.addEventListener('click', (e) => {
  if (e.target === modal) $('#btn-close-modal').click();
});
$('#btn-clear-cache').addEventListener('click', () => {
  Object.keys(CITIES).forEach((id) => localStorage.removeItem('stanica:stations:' + id));
  toast('STATION CACHE CLEARED');
});

/* ---------- geolocation ---------- */

const geoBtn = $('#btn-geo');
function paintGeoBtn() { geoBtn.classList.toggle('active', !!geoPos); }
geoBtn.addEventListener('click', () => {
  if (!navigator.geolocation) { toast('GEOLOCATION NOT SUPPORTED'); return; }
  toast('LOCATING…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      geoPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      store.set('geopos', geoPos);
      paintGeoBtn();
      toast('LOCATION SAVED — STOPS SORTED BY DISTANCE');
      route();
    },
    () => toast('COULD NOT GET LOCATION'),
    { timeout: 8000 });
});
paintGeoBtn();

window.addEventListener('hashchange', route);
route();
