(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const root = document.documentElement;
  const app = $('#app');
  const el = Engine.el;
  const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;

  const SETTINGS_KEY = 'nm.settings';
  const SEEDED_KEY = 'nm.seeded';

  const PRESETS = [
    { id: 'flat', name: 'ปกติ', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    { id: 'bass', name: 'เบสหนัก', gains: [7, 6, 4.5, 2.5, 0.5, 0, 0, 0, 0.5, 1] },
    { id: 'pop', name: 'ป๊อป', gains: [-1.5, -0.5, 1, 3, 4, 3.5, 1.5, 0, -0.5, -1] },
    { id: 'rock', name: 'ร็อก', gains: [5, 4, 2.5, 0.5, -1.5, -1, 1, 3, 4, 4.5] },
    { id: 'vocal', name: 'เสียงร้อง', gains: [-2, -2.5, -1.5, 1, 3.5, 4.5, 4, 2, 0, -1] },
    { id: 'jazz', name: 'แจ๊ส', gains: [3.5, 2.5, 1, 2, -1.5, -1.5, 0, 1.5, 3, 3.5] },
    { id: 'classic', name: 'คลาสสิก', gains: [4.5, 3.5, 2.5, 1, -1, -1, 0, 2, 3, 4] },
    { id: 'electronic', name: 'อิเล็กทรอนิกส์', gains: [6, 5, 1.5, 0, -2, 1.5, 0.5, 1.5, 4.5, 5.5] },
    { id: 'acoustic', name: 'อะคูสติก', gains: [4, 3.5, 2.5, 1, 1.5, 1.5, 3, 3.5, 3, 2] },
  ];
  const FREQ_LABELS = ['32', '64', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
  const VIZ_NAMES = { bars: 'แท่ง', mirror: 'สะท้อน', wave: 'คลื่น' };
  const REPEAT_NAMES = { off: 'ไม่เล่นซ้ำ', all: 'เล่นซ้ำทั้งหมด', one: 'เล่นซ้ำเพลงเดียว' };

  const DEFAULTS = {
    theme: 'light', accent: 'sunny', viz: 'bars', sensitivity: 1, smoothing: 0.6,
    volume: 0.85, shuffle: false, repeat: 'all', filter: 'all',
    eqOn: true, preset: 'flat', gains: PRESETS[0].gains.slice(),
    lastId: null, lastTime: 0,
  };

  /* ---------- settings ---------- */
  const settings = (() => {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (e) { /* ignore */ }
    const s = { ...DEFAULTS, ...saved };
    if (!Array.isArray(s.gains) || s.gains.length !== 10) s.gains = DEFAULTS.gains.slice();
    return s;
  })();

  let saveTimer = 0;
  function saveNow() {
    clearTimeout(saveTimer);
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }

  /* ---------- state ---------- */
  let tracks = [];
  let order = [];
  let current = null;
  let audioUrl = null;
  let screen = 'player';
  let query = '';
  const coverUrls = new Map();

  /* ---------- elements ---------- */
  const orb = $('#orb');
  const dial = $('#dial');
  const ring = $('#ring-progress');
  const knob = $('#dial-knob');
  const tracksEl = $('#tracks');
  const miniRange = $('#mini-range');
  const volRange = $('#vol');
  const fileInput = $('#file-input');
  const folderInput = $('#folder-input');
  const vizCanvas = $('#viz-canvas');
  const radialCanvas = $('#radial-canvas');
  const eqCanvas = $('#eq-canvas');
  const toastEl = $('#toast');

  /* ---------- helpers ---------- */
  const pad2 = (n) => String(n).padStart(2, '0');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  }
  function fmtTotal(sec) {
    if (sec < 60) return `${Math.round(sec)} วินาที`;
    const m = Math.round(sec / 60);
    return m < 60 ? `${m} นาที` : `${Math.floor(m / 60)} ชม. ${m % 60} นาที`;
  }
  function fmtBytes(b) {
    if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`;
    if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    return `${(b / 1024 ** 3).toFixed(2)} GB`;
  }
  function setFill(input) {
    const p = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--p', p + '%');
  }

  let toastTimer = 0;
  function toast(msg, ms = 2600) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  function coverUrl(t) {
    if (!t || !t.cover) return null;
    let url = coverUrls.get(t.id);
    if (!url) {
      url = URL.createObjectURL(t.cover);
      coverUrls.set(t.id, url);
    }
    return url;
  }

  /* ---------- theme ---------- */
  let colors = {};
  const darkMq = matchMedia('(prefers-color-scheme: dark)');

  function readColors() {
    const cs = getComputedStyle(root);
    const v = (n) => cs.getPropertyValue(n).trim();
    colors = {
      a1: v('--a1'), a2: v('--a2'), glow: v('--glow'), slot: v('--slot'),
      line: v('--line'), muted: v('--muted'), knob: v('--bg-hi'),
      font: 'Prompt, system-ui, sans-serif',
    };
  }

  function applyTheme() {
    const resolved = settings.theme === 'auto' ? (darkMq.matches ? 'dark' : 'light') : settings.theme;
    root.dataset.theme = resolved;
    root.dataset.accent = settings.accent;
    $('meta[name="theme-color"]').content = resolved === 'dark' ? '#2A2C30' : '#EEEDEA';
    $$('#theme-seg button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings.theme));
    $$('#accent-swatches .swatch').forEach((b) => b.classList.toggle('active', b.dataset.accent === settings.accent));
    readColors();
    requestDraw(true);
  }
  darkMq.addEventListener('change', () => { if (settings.theme === 'auto') applyTheme(); });

  /* ---------- navigation ---------- */
  function show(name) {
    screen = name;
    $$('.screen').forEach((s) => s.classList.toggle('active', s.dataset.screen === name));
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.goto === name));
    updateMini();
    if (name === 'settings') updateStorageInfo();
    requestDraw(true);
  }

  function updateMini() {
    $('#mini').hidden = screen === 'player' || !current;
  }

  /* ---------- now playing ---------- */
  function renderNow() {
    const t = current;
    $('#np-title').textContent = t ? t.title : 'ยังไม่มีเพลง';
    $('#np-artist').textContent = t ? (t.artist || 'ไม่ทราบศิลปิน') : 'เพิ่มเพลงจากเครื่องได้ที่คลังเพลง';
    const idx = t ? order.indexOf(t.id) : -1;
    $('#np-count').textContent = t ? `เพลงที่ ${idx + 1} จาก ${order.length}` : 'ยังไม่ได้เลือกเพลง';
    $('#btn-fav').setAttribute('aria-pressed', String(!!(t && t.fav)));

    const cover = coverUrl(t);
    orb.style.backgroundImage = cover ? `url("${cover}")` : '';
    orb.classList.toggle('has-cover', !!cover);
    $('#mini-art').style.backgroundImage = cover ? `url("${cover}")` : '';
    $('#mini-art').classList.toggle('has-cover', !!cover);
    $('#mini-title').textContent = t ? t.title : '';
    $('#mini-artist').textContent = t ? (t.artist || 'ไม่ทราบศิลปิน') : '';
    document.title = t ? `${t.title} · Neumorph Music` : 'Neumorph Music';
    updateMini();
    updateProgress(true);
  }

  let seekPreview = null;
  let miniDragging = false;
  let lastProgress = { sec: -1, frac: -1 };

  function updateProgress(force = false) {
    const dur = isFinite(el.duration) ? el.duration : (current ? current.duration : 0);
    const cur = seekPreview != null ? seekPreview * dur : (el.currentTime || 0);
    const frac = dur ? clamp(cur / dur, 0, 1) : 0;
    const sec = Math.floor(cur);
    if (!force && Math.abs(frac - lastProgress.frac) < 0.0004 && sec === lastProgress.sec) return;
    lastProgress = { sec, frac };

    ring.style.strokeDasharray = `${(frac * 100).toFixed(3)} 100`;
    ring.style.opacity = frac > 0.003 ? 1 : 0;
    const a = -Math.PI / 2 + frac * Math.PI * 2;
    knob.style.left = (50 + 37.5 * Math.cos(a)) + '%';
    knob.style.top = (50 + 37.5 * Math.sin(a)) + '%';
    $('#t-cur').textContent = fmt(cur);
    $('#t-dur').textContent = fmt(dur);
    dial.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    dial.setAttribute('aria-valuetext', `${fmt(cur)} จาก ${fmt(dur)}`);
    if (!miniDragging) {
      $('#mini-cur').textContent = fmt(cur);
      $('#mini-dur').textContent = fmt(dur);
      miniRange.value = Math.round(frac * 1000);
      setFill(miniRange);
    }
  }

  function syncPlaying() {
    const playing = !el.paused;
    app.classList.toggle('is-playing', playing);
    for (const b of [$('#btn-play'), $('#mini-play')]) b.setAttribute('aria-label', playing ? 'หยุดชั่วคราว' : 'เล่น');
    if (ms) ms.playbackState = playing ? 'playing' : 'paused';
    requestDraw();
  }

  function syncToggles() {
    const sh = $('#btn-shuffle');
    sh.setAttribute('aria-pressed', String(settings.shuffle));
    const rp = $('#btn-repeat');
    rp.dataset.mode = settings.repeat;
    rp.classList.toggle('on', settings.repeat !== 'off');
    rp.setAttribute('aria-label', REPEAT_NAMES[settings.repeat]);
    $$('#lib-filter .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === settings.filter));
    $$('#viz-opts button').forEach((b) => b.classList.toggle('active', b.dataset.value === settings.viz));
    const sens = $('#sens'), smooth = $('#smooth');
    sens.value = Math.round(settings.sensitivity * 100);
    smooth.value = Math.round(settings.smoothing * 100);
    $('#sens-val').textContent = sens.value + '%';
    $('#smooth-val').textContent = smooth.value + '%';
    volRange.value = Math.round(settings.volume * 100);
    [sens, smooth, volRange].forEach(setFill);
  }

  /* ---------- playback ---------- */
  function rebuildOrder() {
    const ids = tracks.map((t) => t.id);
    if (settings.shuffle) {
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
      }
      if (current) {
        const k = ids.indexOf(current.id);
        if (k > 0) { ids.splice(k, 1); ids.unshift(current.id); }
      }
    }
    order = ids;
  }

  let loadToken = 0;
  async function loadTrack(id, { autoplay = false, at = 0 } = {}) {
    const t = tracks.find((x) => x.id === id);
    if (!t) return;
    const token = ++loadToken;
    if (autoplay) Engine.init(); // create the AudioContext while we still hold the user gesture
    let blob = null;
    try { blob = await Store.file(id); } catch (err) { console.error(err); }
    if (token !== loadToken) return;
    if (!blob) { toast('ไม่พบไฟล์ของเพลงนี้'); return; }

    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(blob);
    current = t;
    settings.lastId = id;
    settings.lastTime = at;
    saveSoon();

    Engine.load(audioUrl);
    if (at > 0) el.addEventListener('loadedmetadata', () => { if (token === loadToken) Engine.seek(at); }, { once: true });
    renderNow();
    markActive();
    updateMediaSession();
    if (autoplay) startPlayback();
  }

  function startPlayback() {
    const p = Engine.play();
    if (p && p.catch) {
      p.catch((err) => {
        if (err.name === 'NotAllowedError') toast('แตะปุ่มเล่นอีกครั้งเพื่อเริ่มฟัง');
        else if (err.name !== 'AbortError') console.warn(err);
      });
    }
  }

  function togglePlay() {
    if (!current) {
      if (tracks.length) loadTrack(order[0], { autoplay: true });
      else { show('library'); toast('เพิ่มเพลงจากเครื่องก่อนนะ'); }
      return;
    }
    if (el.paused) startPlayback();
    else Engine.pause();
  }

  function step(dir, auto = false) {
    if (!order.length) return;
    const wasPlaying = auto || !el.paused;
    const i = current ? order.indexOf(current.id) : -1;
    let j = i + dir;
    if (j >= order.length) {
      if (auto && settings.repeat === 'off') { Engine.seek(0); return; }
      if (settings.shuffle && order.length > 1) {
        const last = current && current.id;
        rebuildOrder();
        if (order[0] === last) [order[0], order[1]] = [order[1], order[0]];
      }
      j = 0;
    }
    if (j < 0) j = order.length - 1;
    loadTrack(order[j], { autoplay: wasPlaying });
  }

  function prev() {
    if (el.currentTime > 3) { Engine.seek(0); return; }
    step(-1);
  }

  function seekBy(sec) {
    if (current) Engine.seek((el.currentTime || 0) + sec);
  }

  function changeVolume(delta) {
    settings.volume = clamp(settings.volume + delta, 0, 1);
    Engine.setVolume(settings.volume);
    volRange.value = Math.round(settings.volume * 100);
    setFill(volRange);
    saveSoon();
    toast(`ระดับเสียง ${Math.round(settings.volume * 100)}%`, 900);
  }

  function savePosition() {
    if (!current) return;
    settings.lastTime = el.currentTime || 0;
    saveNow();
  }

  el.addEventListener('play', syncPlaying);
  el.addEventListener('pause', syncPlaying);
  el.addEventListener('seeked', () => requestDraw());
  el.addEventListener('ended', () => {
    if (settings.repeat === 'one') { Engine.seek(0); startPlayback(); }
    else step(1, true);
  });
  el.addEventListener('error', () => {
    if (el.getAttribute('src')) toast('เล่นไฟล์นี้ไม่ได้ เบราว์เซอร์อาจไม่รองรับรูปแบบไฟล์');
  });
  el.addEventListener('loadedmetadata', () => {
    if (current && isFinite(el.duration) && Math.abs((current.duration || 0) - el.duration) > 0.5) {
      current.duration = el.duration;
      Store.update(current).catch(() => {});
      renderLibrary();
    }
    updateProgress(true);
    updatePositionState();
  });

  let lastPosSave = 0;
  el.addEventListener('timeupdate', () => {
    const now = Date.now();
    if (now - lastPosSave > 5000) { lastPosSave = now; savePosition(); }
    updatePositionState();
    if (el.paused) requestDraw();
  });

  /* ---------- media session (lock screen / headset controls) ---------- */
  if (ms) {
    const handlers = {
      play: () => startPlayback(),
      pause: () => Engine.pause(),
      previoustrack: prev,
      nexttrack: () => step(1),
      seekbackward: (d) => seekBy(-(d.seekOffset || 10)),
      seekforward: (d) => seekBy(d.seekOffset || 10),
      seekto: (d) => Engine.seek(d.seekTime),
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { ms.setActionHandler(action, fn); } catch (e) { /* unsupported action */ }
    }
  }

  function updateMediaSession() {
    if (!ms || !current || typeof MediaMetadata === 'undefined') return;
    const cover = coverUrl(current);
    const artwork = cover ? [{ src: cover, sizes: '320x320', type: 'image/jpeg' }]
      : /^https?:$/.test(location.protocol)
        ? [{ src: new URL('icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' }]
        : [];
    try {
      ms.metadata = new MediaMetadata({
        title: current.title,
        artist: current.artist || '',
        album: current.album || '',
        artwork,
      });
    } catch (e) { /* ignore */ }
  }

  function updatePositionState() {
    if (!ms || !ms.setPositionState || !isFinite(el.duration) || !el.duration) return;
    try {
      ms.setPositionState({
        duration: el.duration,
        position: Math.min(el.currentTime, el.duration),
        playbackRate: el.playbackRate || 1,
      });
    } catch (e) { /* ignore */ }
  }

  /* ---------- library ---------- */
  function visibleTracks() {
    const q = query.trim().toLowerCase();
    let list = tracks;
    if (settings.filter === 'fav') list = list.filter((t) => t.fav);
    if (q) list = list.filter((t) => `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q));
    return list;
  }

  function rowHtml(t) {
    const cover = coverUrl(t);
    const art = cover ? `<img src="${cover}" alt="" loading="lazy">` : '<svg><use href="#i-note"/></svg>';
    const active = current && t.id === current.id ? ' active' : '';
    return `<li class="track${active}" data-id="${t.id}">
      <button class="track-main" data-act="play">
        <span class="track-art">${art}<span class="eq-mini"><i></i><i></i><i></i></span></span>
        <span class="track-text">
          <span class="track-title">${escapeHtml(t.title)}</span>
          <span class="track-sub">${escapeHtml(t.artist || 'ไม่ทราบศิลปิน')} · ${fmt(t.duration)}</span>
        </span>
      </button>
      <button class="icon-btn${t.fav ? ' on' : ''}" data-act="fav" aria-label="ชื่นชอบ" aria-pressed="${!!t.fav}"><svg><use href="#i-heart"/></svg></button>
      <button class="icon-btn" data-act="del" aria-label="ลบออกจากคลัง"><svg><use href="#i-trash"/></svg></button>
    </li>`;
  }

  function renderLibrary() {
    const list = visibleTracks();
    const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
    $('#lib-summary').textContent = tracks.length ? `${tracks.length} เพลง · ${fmtTotal(total)}` : 'ยังไม่มีเพลง';
    $('#lib-empty').hidden = tracks.length > 0;
    const noResult = $('#lib-noresult');
    noResult.hidden = !tracks.length || list.length > 0;
    noResult.textContent = settings.filter === 'fav' && !query.trim() ? 'ยังไม่มีเพลงที่ชื่นชอบ แตะ ♡ ที่เพลงเพื่อเพิ่ม' : 'ไม่พบเพลงที่ค้นหา';
    tracksEl.innerHTML = list.map(rowHtml).join('');
  }

  function markActive() {
    $$('#tracks .track').forEach((li) => li.classList.toggle('active', !!current && li.dataset.id === current.id));
  }

  function toggleFav(id) {
    const t = tracks.find((x) => x.id === id);
    if (!t) return;
    t.fav = !t.fav;
    Store.update(t).catch(() => {});
    renderLibrary();
    if (current && current.id === id) $('#btn-fav').setAttribute('aria-pressed', String(t.fav));
    toast(t.fav ? 'เพิ่มในเพลงที่ชื่นชอบแล้ว' : 'นำออกจากเพลงที่ชื่นชอบแล้ว', 1400);
  }

  /* two-tap confirmation for destructive buttons */
  function armed(btn, label) {
    if (btn.classList.contains('confirm')) {
      clearTimeout(btn._disarm);
      btn.classList.remove('confirm');
      return true;
    }
    $$('.confirm').forEach((b) => b.classList.remove('confirm'));
    btn.classList.add('confirm');
    clearTimeout(btn._disarm);
    btn._disarm = setTimeout(() => btn.classList.remove('confirm'), 2800);
    toast(label, 1800);
    return false;
  }

  async function deleteTrack(id) {
    const t = tracks.find((x) => x.id === id);
    if (!t) return;
    const wasCurrent = !!current && current.id === id;
    const wasPlaying = wasCurrent && !el.paused;
    let nextId = null;
    if (wasCurrent && order.length > 1) {
      const i = order.indexOf(id);
      nextId = order[i + 1] || order[i - 1];
    }
    try { await Store.remove(id); } catch (err) { console.error(err); toast('ลบไม่สำเร็จ'); return; }

    tracks = tracks.filter((x) => x.id !== id);
    if (coverUrls.has(id)) { URL.revokeObjectURL(coverUrls.get(id)); coverUrls.delete(id); }
    order = order.filter((x) => x !== id);

    if (wasCurrent) {
      Engine.unload();
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = null;
      current = null;
      settings.lastId = null;
      saveSoon();
      if (nextId) await loadTrack(nextId, { autoplay: wasPlaying });
    }
    renderLibrary();
    renderNow();
    toast(`ลบ “${t.title}” แล้ว`);
  }

  async function clearLibrary() {
    try { await Store.clear(); } catch (err) { console.error(err); toast('ล้างคลังเพลงไม่สำเร็จ'); return; }
    Engine.unload();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = null;
    coverUrls.forEach((u) => URL.revokeObjectURL(u));
    coverUrls.clear();
    tracks = [];
    order = [];
    current = null;
    settings.lastId = null;
    saveNow();
    renderLibrary();
    renderNow();
    updateStorageInfo();
    toast('ล้างคลังเพลงแล้ว');
  }

  /* ---------- importing ---------- */
  const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|wav|wave|ogg|oga|opus|flac|webm|weba|mp4|aiff?|caf)$/i;
  const isAudio = (f) => (f.type && f.type.startsWith('audio/')) || AUDIO_EXT.test(f.name);

  /* duration in seconds, NaN when unknown, null when the browser can't decode the file */
  function probe(blob) {
    return new Promise((resolve) => {
      const a = document.createElement('audio');
      const url = URL.createObjectURL(blob);
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        a.removeAttribute('src');
        a.load();
        URL.revokeObjectURL(url);
        resolve(v);
      };
      const timer = setTimeout(() => done(NaN), 6000);
      a.preload = 'metadata';
      a.onloadedmetadata = () => done(a.duration);
      a.onerror = () => done(null);
      a.src = url;
    });
  }

  function guessFromName(name) {
    const base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    const stripped = base.replace(/^\d{1,3}[\s.\-]+(?=\S)/, '') || base;
    const m = stripped.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: stripped };
  }

  async function makeCover(pic) {
    if (!pic || !pic.data || pic.data.length < 64) return null;
    const blob = new Blob([pic.data], { type: pic.mime || 'image/jpeg' });
    try {
      const bmp = await createImageBitmap(blob);
      const size = 320;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const k = Math.max(size / bmp.width, size / bmp.height);
      const w = bmp.width * k, h = bmp.height * k;
      c.getContext('2d').drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h);
      if (bmp.close) bmp.close();
      return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.86));
    } catch (e) {
      return blob.size < 300000 ? blob : null;
    }
  }

  let importing = false;
  async function importFiles(fileList) {
    const files = [...fileList].filter(isAudio);
    if (!files.length) { toast('ไม่พบไฟล์เสียงที่รองรับ'); return; }
    if (importing) { toast('กำลังเพิ่มเพลงอยู่ รอสักครู่นะ'); return; }
    importing = true;
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    files.sort((a, b) => a.name.localeCompare(b.name, 'th', { numeric: true }));

    let added = 0, skipped = 0, failed = 0, full = false, firstId = null;
    const base = Date.now();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      toast(files.length > 1 ? `กำลังเพิ่มเพลง ${i + 1}/${files.length}` : 'กำลังเพิ่มเพลง…', 0);
      if (tracks.some((t) => t.name === f.name && t.size === f.size)) { skipped++; continue; }
      try {
        const [tags, duration] = await Promise.all([Tags.read(f), probe(f)]);
        if (duration === null) { failed++; continue; }
        const guess = guessFromName(f.name);
        const meta = {
          id: uid(),
          name: f.name,
          size: f.size,
          type: f.type,
          title: tags.title || guess.title,
          artist: tags.artist || guess.artist,
          album: tags.album || '',
          duration: isFinite(duration) ? duration : 0,
          cover: await makeCover(tags.picture),
          fav: false,
          addedAt: base + i,
        };
        await Store.add(meta, f);
        tracks.push(meta);
        if (!firstId) firstId = meta.id;
        added++;
      } catch (err) {
        console.error('Import failed:', f.name, err);
        if (err && err.name === 'QuotaExceededError') { full = true; break; }
        failed++;
      }
    }
    importing = false;

    rebuildOrder();
    renderLibrary();
    if (!current && firstId) await loadTrack(firstId);
    else renderNow();

    const parts = [];
    if (added) parts.push(`เพิ่ม ${added} เพลงแล้ว`);
    if (skipped) parts.push(`มีอยู่แล้ว ${skipped}`);
    if (failed) parts.push(`เปิดไม่ได้ ${failed} ไฟล์`);
    if (full) parts.push('พื้นที่จัดเก็บเต็ม');
    toast(parts.join(' · ') || 'ไม่มีเพลงใหม่', 3200);
    if (added && !Store.persistent) setTimeout(() => toast('เบราว์เซอร์นี้จะไม่จำเพลงหลังปิดหน้าเว็บ', 3200), 3300);
  }

  /* folders dropped from the desktop arrive as entries; walk them */
  async function filesFromDrop(dt) {
    const entries = [...(dt.items || [])]
      .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
      .filter(Boolean);
    if (!entries.length) return [...dt.files];
    const out = [];
    const walk = async (entry) => {
      if (entry.isFile) {
        out.push(await new Promise((res, rej) => entry.file(res, rej)));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const e of batch) await walk(e);
        } while (batch.length);
      }
    };
    for (const e of entries) {
      try { await walk(e); } catch (err) { console.warn(err); }
    }
    return out;
  }

  let demoBusy = false;
  async function addDemo({ quiet = false } = {}) {
    if (demoBusy) return;
    demoBusy = true;
    try {
      if (!quiet) toast('กำลังสร้างเพลงตัวอย่าง…', 0);
      const blob = await Demo.render();
      const file = new File([blob], 'sunny-afternoon-demo.wav', { type: 'audio/wav' });
      const duration = await probe(file);
      const meta = {
        id: uid(),
        name: file.name,
        size: file.size,
        type: file.type,
        ...Demo.meta,
        duration: isFinite(duration) ? duration : 0,
        cover: null,
        fav: false,
        addedAt: Date.now(),
      };
      await Store.add(meta, file);
      tracks.push(meta);
      rebuildOrder();
      renderLibrary();
      if (!current) await loadTrack(meta.id);
      else renderNow();
      if (!quiet) toast('เพิ่มเพลงตัวอย่างแล้ว ลองกดเล่นได้เลย');
    } catch (err) {
      console.error(err);
      if (!quiet) toast('สร้างเพลงตัวอย่างไม่สำเร็จ');
    }
    demoBusy = false;
  }

  async function updateStorageInfo() {
    let text = `${tracks.length} เพลง`;
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      if (est && est.usage != null) text += ` · ใช้พื้นที่ ${fmtBytes(est.usage)}`;
    } catch (e) { /* ignore */ }
    if (!Store.persistent) text += ' · ไม่บันทึกถาวร';
    $('#storage-info').textContent = text;
  }

  /* ---------- equalizer UI ---------- */
  const CURVE_FREQS = Float32Array.from({ length: 160 }, (_, i) => 20 * Math.pow(1000, i / 159));
  const BAND_FREQS = Float32Array.from(Engine.BANDS);
  let eqCurve = new Float32Array(CURVE_FREQS.length);
  let eqDots = [];

  function buildEq() {
    $('#eq-bands').innerHTML = Engine.BANDS.map((f, i) => `
      <div class="band" data-i="${i}">
        <span class="band-val"></span>
        <div class="band-track" role="slider" tabindex="0" aria-label="${FREQ_LABELS[i]} Hz"
             aria-valuemin="-12" aria-valuemax="12">
          <span class="band-zero"></span><span class="band-fill"></span><span class="band-knob"></span>
        </div>
        <span class="band-freq">${FREQ_LABELS[i]}</span>
      </div>`).join('');
    $('#eq-presets').innerHTML = PRESETS.map((p) => `<button class="chip" data-preset="${p.id}">${p.name}</button>`).join('')
      + '<button class="chip" data-preset="custom" hidden>กำหนดเอง</button>';
  }

  function renderEq() {
    $$('.band').forEach((band, i) => {
      const v = settings.gains[i];
      const pos = (1 - (v + 12) / 24) * 100;
      band.querySelector('.band-val').textContent = v === 0 ? '0' : (v > 0 ? '+' : '') + v;
      band.querySelector('.band-knob').style.top = pos + '%';
      const fill = band.querySelector('.band-fill');
      fill.style.top = (v >= 0 ? pos : 50) + '%';
      fill.style.bottom = (v >= 0 ? 50 : 100 - pos) + '%';
      const track = band.querySelector('.band-track');
      track.setAttribute('aria-valuenow', String(v));
      track.setAttribute('aria-valuetext', `${v} dB`);
    });
    $$('#eq-presets .chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.preset === settings.preset);
      if (c.dataset.preset === 'custom') c.hidden = settings.preset !== 'custom';
    });
    $('#eq-switch').setAttribute('aria-checked', String(settings.eqOn));
    app.classList.toggle('eq-off', !settings.eqOn);
    eqCurve = Engine.response(CURVE_FREQS, settings.gains);
    const dots = Engine.response(BAND_FREQS, settings.gains);
    eqDots = Engine.BANDS.map((f, i) => [f, dots[i]]);
    requestDraw(true);
  }

  function matchPreset(gains) {
    const p = PRESETS.find((x) => x.gains.every((g, i) => g === gains[i]));
    return p ? p.id : 'custom';
  }

  function setBand(i, v) {
    v = clamp(Math.round(v * 2) / 2, -12, 12);
    if (settings.gains[i] === v && settings.eqOn) return;
    settings.gains[i] = v;
    if (!settings.eqOn) { settings.eqOn = true; Engine.setEqEnabled(true); }
    settings.preset = matchPreset(settings.gains);
    Engine.setBand(i, v);
    renderEq();
    saveSoon();
  }

  function applyPreset(id) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    settings.preset = id;
    settings.gains = p.gains.slice();
    settings.eqOn = true;
    Engine.setGains(settings.gains);
    Engine.setEqEnabled(true);
    renderEq();
    saveSoon();
  }

  let lastBandTap = { i: -1, t: 0 };
  $('#eq-bands').addEventListener('pointerdown', (e) => {
    const track = e.target.closest('.band-track');
    if (!track) return;
    const i = Number(track.parentElement.dataset.i);
    e.preventDefault();
    track.focus({ preventScroll: true });
    const now = performance.now();
    if (lastBandTap.i === i && now - lastBandTap.t < 320) {
      lastBandTap = { i: -1, t: 0 };
      setBand(i, 0);
      return;
    }
    lastBandTap = { i, t: now };
    const set = (ev) => {
      const r = track.getBoundingClientRect();
      const frac = 1 - (ev.clientY - r.top) / r.height;
      setBand(i, frac * 24 - 12);
    };
    track.setPointerCapture(e.pointerId);
    set(e);
    const end = () => {
      track.removeEventListener('pointermove', set);
      track.removeEventListener('pointerup', end);
      track.removeEventListener('pointercancel', end);
    };
    track.addEventListener('pointermove', set);
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
  });

  $('#eq-bands').addEventListener('keydown', (e) => {
    const track = e.target.closest('.band-track');
    if (!track) return;
    const i = Number(track.parentElement.dataset.i);
    const delta = { ArrowUp: 0.5, ArrowRight: 0.5, ArrowDown: -0.5, ArrowLeft: -0.5, PageUp: 3, PageDown: -3 }[e.key];
    if (delta) { e.preventDefault(); setBand(i, settings.gains[i] + delta); }
    else if (e.key === 'Home' || e.key === '0') { e.preventDefault(); setBand(i, 0); }
  });

  $('#eq-presets').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-preset]');
    if (chip && chip.dataset.preset !== 'custom') applyPreset(chip.dataset.preset);
  });

  $('#eq-switch').addEventListener('click', () => {
    settings.eqOn = !settings.eqOn;
    Engine.setEqEnabled(settings.eqOn);
    renderEq();
    saveSoon();
  });

  $('#eq-reset').addEventListener('click', () => applyPreset('flat'));

  /* ---------- animation loop ---------- */
  const panelBands = new Viz.Bands(30, 38, 16000);
  const radialBands = new Viz.Bands(24, 40, 12000);
  const eqBands = new Viz.Bands(56, 22, 20000);
  const dbVal = $('#db-val');
  let rafId = 0, lastFrame = 0, level = -Infinity, levelText = '', pulse = 0, pulseText = '';
  let forceDraw = true;

  function requestDraw(force = false) {
    if (force) forceDraw = true;
    if (!rafId) {
      lastFrame = performance.now();
      rafId = requestAnimationFrame(frame);
    }
  }

  function frame(now) {
    rafId = 0;
    const dt = Math.min(0.1, Math.max(0.001, (now - lastFrame) / 1000));
    lastFrame = now;
    const playing = !el.paused;

    const freq = Engine.ready ? Engine.frequencyData() : null;
    const shift = (settings.sensitivity - 1) * 18;
    const opts = { floor: -80 - shift, ceil: -24 - shift, smoothing: settings.smoothing };
    for (const b of [panelBands, radialBands, eqBands]) {
      b.build(Engine.binCount, Engine.sampleRate);
      b.update(freq, dt, opts);
    }

    if (Engine.ready) {
      const db = Engine.levelDb();
      level = isFinite(level) ? level + (db - level) * Math.min(1, dt * 8) : db;
    }
    const text = !isFinite(level) || level < -90 ? '-∞' : level.toFixed(1);
    if (text !== levelText) { dbVal.textContent = text; levelText = text; }

    const bass = radialBands.energy(0, 5);
    pulse += (bass ** 1.3 - pulse) * Math.min(1, dt * 14);
    const pt = (1 + pulse * 0.16).toFixed(3);
    if (pt !== pulseText) { orb.style.setProperty('--pulse', pt); pulseText = pt; }

    const animating = playing || !panelBands.idle || !radialBands.idle || !eqBands.idle || pulse > 0.002;
    if (animating || forceDraw) {
      if (screen === 'player') {
        Viz.drawPanel(vizCanvas, panelBands, colors, settings.viz);
        Viz.drawRadial(radialCanvas, radialBands, colors, pulse);
      } else if (screen === 'eq') {
        Viz.drawEq(eqCanvas, { freqs: CURVE_FREQS, curve: eqCurve, dots: eqDots, bands: eqBands, enabled: settings.eqOn }, colors);
      }
      forceDraw = false;
    }
    updateProgress();

    if (animating || seekPreview != null) rafId = requestAnimationFrame(frame);
  }

  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(() => requestDraw(true));
    [vizCanvas, radialCanvas, eqCanvas].forEach((c) => ro.observe(c));
  } else {
    window.addEventListener('resize', () => requestDraw(true));
  }

  /* ---------- dial seeking ---------- */
  function dialPoint(e) {
    const r = dial.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    let a = Math.atan2(dy, dx) + Math.PI / 2;
    if (a < 0) a += Math.PI * 2;
    return { dist: Math.hypot(dx, dy) / (r.width / 2), frac: a / (Math.PI * 2) };
  }

  dial.addEventListener('pointerdown', (e) => {
    const p = dialPoint(e);
    if (p.dist < 0.62 || p.dist > 1.06 || !current || !isFinite(el.duration)) return;
    e.preventDefault();
    dial.setPointerCapture(e.pointerId);
    seekPreview = p.frac;
    requestDraw();
  });
  dial.addEventListener('pointermove', (e) => {
    if (seekPreview == null) return;
    let f = dialPoint(e).frac;
    if (seekPreview > 0.8 && f < 0.2) f = 1; // don't wrap across 12 o'clock
    else if (seekPreview < 0.2 && f > 0.8) f = 0;
    seekPreview = f;
    requestDraw();
  });
  const endDialDrag = () => {
    if (seekPreview == null) return;
    Engine.seek(seekPreview * el.duration);
    seekPreview = null;
    requestDraw();
  };
  dial.addEventListener('pointerup', endDialDrag);
  dial.addEventListener('pointercancel', endDialDrag);
  dial.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); seekBy(5); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); seekBy(-5); }
  });
  $('#dial-core').addEventListener('click', togglePlay);

  /* ---------- controls ---------- */
  $('#btn-play').addEventListener('click', togglePlay);
  $('#mini-play').addEventListener('click', togglePlay);
  $('#btn-next').addEventListener('click', () => step(1));
  $('#mini-next').addEventListener('click', () => step(1));
  $('#btn-prev').addEventListener('click', prev);
  $('#mini-prev').addEventListener('click', prev);
  $('#mini-open').addEventListener('click', () => show('player'));

  $('#btn-shuffle').addEventListener('click', () => {
    settings.shuffle = !settings.shuffle;
    rebuildOrder();
    syncToggles();
    renderNow();
    saveSoon();
    toast(settings.shuffle ? 'สุ่มเพลง: เปิด' : 'สุ่มเพลง: ปิด', 1400);
  });

  $('#btn-repeat').addEventListener('click', () => {
    settings.repeat = { all: 'one', one: 'off', off: 'all' }[settings.repeat] || 'all';
    syncToggles();
    saveSoon();
    toast(REPEAT_NAMES[settings.repeat], 1400);
  });

  $('#btn-fav').addEventListener('click', () => { if (current) toggleFav(current.id); });

  $('#viz-panel').addEventListener('click', () => {
    const modes = Object.keys(VIZ_NAMES);
    settings.viz = modes[(modes.indexOf(settings.viz) + 1) % modes.length];
    syncToggles();
    saveSoon();
    requestDraw(true);
    toast(`แอนิเมชัน: ${VIZ_NAMES[settings.viz]}`, 1200);
  });

  volRange.addEventListener('input', () => {
    settings.volume = volRange.value / 100;
    Engine.setVolume(settings.volume);
    setFill(volRange);
    saveSoon();
  });

  miniRange.addEventListener('input', () => {
    miniDragging = true;
    setFill(miniRange);
    const dur = isFinite(el.duration) ? el.duration : 0;
    $('#mini-cur').textContent = fmt((miniRange.value / 1000) * dur);
  });
  miniRange.addEventListener('change', () => {
    if (isFinite(el.duration)) Engine.seek((miniRange.value / 1000) * el.duration);
    miniDragging = false;
    requestDraw();
  });

  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-goto]');
    if (go) show(go.dataset.goto);
  });

  /* ---------- library events ---------- */
  $('#btn-add').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) importFiles(fileInput.files);
    fileInput.value = '';
  });
  if ('webkitdirectory' in folderInput) {
    $('#btn-folder').classList.add('supported');
    $('#btn-folder').addEventListener('click', () => folderInput.click());
    folderInput.addEventListener('change', () => {
      if (folderInput.files.length) importFiles(folderInput.files);
      folderInput.value = '';
    });
  }

  $('#search').addEventListener('input', (e) => {
    query = e.target.value;
    renderLibrary();
  });

  $('#lib-filter').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    settings.filter = chip.dataset.filter;
    syncToggles();
    renderLibrary();
    saveSoon();
  });

  tracksEl.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.track').dataset.id;
    switch (btn.dataset.act) {
      case 'play':
        if (current && current.id === id) togglePlay();
        else loadTrack(id, { autoplay: true });
        break;
      case 'fav':
        toggleFav(id);
        break;
      case 'del':
        if (armed(btn, 'แตะถังขยะอีกครั้งเพื่อลบ')) deleteTrack(id);
        break;
    }
  });

  $('#lib-empty').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'pick') fileInput.click();
    if (btn.dataset.act === 'demo') addDemo();
  });

  /* ---------- settings events ---------- */
  $('#theme-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]');
    if (!b) return;
    settings.theme = b.dataset.value;
    applyTheme();
    saveSoon();
  });

  $('#accent-swatches').addEventListener('click', (e) => {
    const b = e.target.closest('[data-accent]');
    if (!b) return;
    settings.accent = b.dataset.accent;
    applyTheme();
    saveSoon();
  });

  $('#viz-opts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]');
    if (!b) return;
    settings.viz = b.dataset.value;
    syncToggles();
    saveSoon();
  });

  $('#sens').addEventListener('input', (e) => {
    settings.sensitivity = e.target.value / 100;
    syncToggles();
    saveSoon();
  });

  $('#smooth').addEventListener('input', (e) => {
    settings.smoothing = e.target.value / 100;
    syncToggles();
    saveSoon();
  });

  $('#btn-clear').addEventListener('click', (e) => {
    if (!tracks.length) { toast('คลังเพลงว่างอยู่แล้ว'); return; }
    if (armed(e.currentTarget, 'แตะอีกครั้งเพื่อลบเพลงทั้งหมด')) clearLibrary();
  });

  /* ---------- keyboard ---------- */
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.closest && t.closest('input[type="search"], input[type="text"], textarea')) return;
    const onSlider = t.matches && t.matches('input[type="range"], [role="slider"]');
    switch (e.key) {
      case ' ':
        if (t.closest && t.closest('button')) return;
        e.preventDefault();
        togglePlay();
        break;
      case 'k': case 'K': togglePlay(); break;
      case 'ArrowRight': if (!onSlider) { e.preventDefault(); seekBy(5); } break;
      case 'ArrowLeft': if (!onSlider) { e.preventDefault(); seekBy(-5); } break;
      case 'ArrowUp': if (!onSlider) { e.preventDefault(); changeVolume(0.05); } break;
      case 'ArrowDown': if (!onSlider) { e.preventDefault(); changeVolume(-0.05); } break;
      case 'n': case 'N': step(1); break;
      case 'p': case 'P': prev(); break;
    }
  });

  /* ---------- drag & drop ---------- */
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    app.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) app.classList.remove('dragging');
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    app.classList.remove('dragging');
    const files = await filesFromDrop(e.dataTransfer);
    show('library');
    importFiles(files);
  });

  /* ---------- lifecycle ---------- */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) savePosition();
    else { Engine.resumeIfNeeded(); requestDraw(true); }
  });
  window.addEventListener('pagehide', savePosition);

  async function init() {
    applyTheme();
    syncToggles();
    buildEq();
    Engine.setGains(settings.gains);
    Engine.setEqEnabled(settings.eqOn);
    Engine.setVolume(settings.volume);
    renderEq();
    syncPlaying();

    await Store.open();
    try {
      tracks = (await Store.all()).sort((a, b) => a.addedAt - b.addedAt);
    } catch (err) {
      console.error(err);
      tracks = [];
    }
    rebuildOrder();
    renderLibrary();

    const last = tracks.find((t) => t.id === settings.lastId);
    if (last) await loadTrack(last.id, { at: settings.lastTime || 0 });
    else if (tracks.length) await loadTrack(tracks[0].id);
    else renderNow();

    let seeded = false;
    try { seeded = !!localStorage.getItem(SEEDED_KEY); } catch (e) { /* ignore */ }
    if (!tracks.length && !seeded) {
      try { localStorage.setItem(SEEDED_KEY, '1'); } catch (e) { /* ignore */ }
      addDemo({ quiet: true });
    }

    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => requestDraw(true));
    requestDraw(true);

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  init();
})();
