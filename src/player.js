
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const root = $('root');
  const qs = new URLSearchParams(location.search);
  const PREVIEW = qs.get('preview');
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };

  /* ---------- Diagnostic : les erreurs sont remontées dans la console d'administration ---------- */
  let lastReport = 0, deviceIdForDiag = '';
  function report(msg) {
    try {
      if (PREVIEW || !deviceIdForDiag || Date.now() - lastReport < 60000) return;
      lastReport = Date.now();
      fetch('/api/diag', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceIdForDiag, msg: String(msg).slice(0, 500), ua: navigator.userAgent }) }).catch(function () {});
    } catch (e) {}
  }
  window.onerror = function (msg, src, line, col) { report(msg + ' (ligne ' + line + ':' + col + ')'); };
  function safe(fn, label) {
    return function () {
      try { return fn.apply(this, arguments); }
      catch (e) { report(label + ' : ' + (e && e.message ? e.message : e)); if (window.console) console.error(e); }
    };
  }

  /* ---------- Identifiant de l'appareil ---------- */
  let deviceId = store.get('sc_device');
  if (!deviceId) {
    deviceId = 'ecr-' + Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    store.set('sc_device', deviceId);
  }
  deviceIdForDiag = deviceId;

  /* ---------- Plein écran ---------- */
  if (!PREVIEW) document.body.classList.add('kiosk');
  function goFullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    try {
      const r = el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen ? el.webkitRequestFullscreen() : null;
      if (r && r.catch) r.catch(() => {});
    } catch (e) {}
  }
  document.addEventListener('click', goFullscreen);
  document.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ' || e.keyCode === 13 || e.keyCode === 32) goFullscreen(); });
  setTimeout(() => { $('hint').style.opacity = 0; }, 8000);

  /* ---------- Taille / orientation ---------- */
  let orientation = 0, margin = 0;
  function layout() {
    const k = margin / 100;
    const ox = Math.round(window.innerWidth * k), oy = Math.round(window.innerHeight * k);
    const W = window.innerWidth - 2 * ox, H = window.innerHeight - 2 * oy;
    let w = W, h = H, tf = '';
    if (orientation === 90) { w = H; h = W; tf = 'translate(' + W + 'px,0) rotate(90deg)'; }
    else if (orientation === 270) { w = H; h = W; tf = 'translate(0,' + H + 'px) rotate(-90deg)'; }
    else if (orientation === 180) { tf = 'translate(' + W + 'px,' + H + 'px) rotate(180deg)'; }
    tf = 'translate(' + ox + 'px,' + oy + 'px) ' + tf;
    root.style.width = w + 'px'; root.style.height = h + 'px';
    root.style.webkitTransform = tf; root.style.transform = tf;
    root.style.fontSize = (Math.min(w, h) / 100) + 'px';  // 1em = 1 % du plus petit côté
    setTicker(tickerText, true);
  }
  window.addEventListener('resize', safe(layout, 'mise en page'));

  /* ---------- Outils ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = n => String(n).padStart(2, '0');
  function youtubeEmbed(url) {
    const m = String(url).match(/(?:youtu\.be\/|v=|embed\/|shorts\/|live\/)([\w-]{11})/);
    if (!m) return url;
    const id = m[1];
    return `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&loop=1&playlist=${id}&controls=0&modestbranding=1&rel=0`;
  }

  /* ---------- Horloge (surcouche) ---------- */
  setInterval(() => {
    const d = new Date();
    $('clock').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
    document.querySelectorAll('[data-live-clock]').forEach(el => {
      el.querySelector('.t').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes());
      el.querySelector('.d').textContent = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    });
  }, 1000);

  /* ---------- Bandeau défilant ---------- */
  let tickerText = '';
  function setTicker(text, force) {
    if (text === tickerText && !force) return;
    tickerText = text || '';
    const t = $('ticker'), span = t.querySelector('span');
    if (!tickerText) { t.style.display = 'none'; return; }
    t.style.display = 'block';
    span.textContent = tickerText;
    span.style.animation = span.style.webkitAnimation = 'none';
    void span.offsetWidth;
    const width = root.offsetWidth, sw = span.offsetWidth;
    const pxPerSec = width / 9;
    const dur = Math.max(10, (width + sw) / pxPerSec);
    let st = document.getElementById('tickStyle');
    if (!st) { st = document.createElement('style'); st.id = 'tickStyle'; document.head.appendChild(st); }
    const from = 'translate(' + width + 'px,0)', to = 'translate(' + (-sw) + 'px,0)';
    st.textContent = '@-webkit-keyframes tick{from{-webkit-transform:' + from + '}to{-webkit-transform:' + to + '}}' +
      '@keyframes tick{from{-webkit-transform:' + from + ';transform:' + from + '}to{-webkit-transform:' + to + ';transform:' + to + '}}';
    span.style.webkitAnimation = 'tick ' + dur + 's linear infinite';
    span.style.animation = 'tick ' + dur + 's linear infinite';
  }

  /* ---------- Lecture ---------- */
  let config = null, items = [], idx = -1, timer = null, sig = '', front = 'A';

  function render(content) {
    const c = content;
    if (c.type === 'image') {
      const img = document.createElement('img');
      img.src = c.file; img.alt = ''; if (c.fit === 'cover') img.className = 'cover';
      img.onerror = () => { clearTimeout(timer); timer = setTimeout(next, 2000); };
      return img;
    }
    if (c.type === 'video') {
      const v = document.createElement('video');
      v.src = c.file; v.autoplay = true; v.playsInline = true; v.muted = c.muted !== false;
      v.setAttribute('playsinline', ''); if (v.muted) v.setAttribute('muted', '');
      if (c.fit === 'cover') v.className = 'cover';
      return v;
    }
    if (c.type === 'text') {
      const d = document.createElement('div');
      d.className = 'txt';
      d.style.background = c.bg || '#1d3557'; d.style.color = c.fg || '#fff';
      d.innerHTML = `<div class="bar" style="background:${esc(c.accent || '#f4a261')}"></div>` +
        (c.title ? `<h1>${esc(c.title)}</h1>` : '') + (c.body ? `<p>${esc(c.body)}</p>` : '');
      return d;
    }
    if (c.type === 'clock') {
      const d = document.createElement('div');
      d.className = 'clk'; d.setAttribute('data-live-clock', '');
      const now = new Date();
      d.innerHTML = `<div class="t">${pad(now.getHours())}:${pad(now.getMinutes())}</div>
        <div class="d">${now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
        <div class="s">${esc((config && config.settings && config.settings.schoolName) || '')}</div>`;
      return d;
    }
    if (c.type === 'web' || c.type === 'youtube') {
      const f = document.createElement('iframe');
      f.src = c.type === 'youtube' ? youtubeEmbed(c.url) : c.url;
      f.allow = 'autoplay; fullscreen; encrypted-media';
      f.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
      return f;
    }
    const d = document.createElement('div'); return d;
  }

  function showItem(item) {
    clearTimeout(timer);
    const back = front === 'A' ? 'B' : 'A';
    const layerIn = $(back), layerOut = $(front);
    layerIn.innerHTML = '';
    const el = render(item.content);
    layerIn.appendChild(el);
    layerIn.classList.add('on'); layerOut.classList.remove('on');
    front = back;
    root.classList.toggle('full-clock', item.content.type === 'clock');
    setTimeout(() => { if (front !== layerOut.id) layerOut.innerHTML = ''; }, 900);

    const dur = Number(item.duration) || 0;
    if (item.content.type === 'video') {
      el.play().catch(() => { el.muted = true; el.play().catch(() => {}); });
      if (dur > 0) timer = setTimeout(next, dur * 1000);
      else {
        el.onended = next;
        el.onerror = () => { timer = setTimeout(next, 2000); };
        timer = setTimeout(next, 3 * 3600 * 1000); // garde-fou
      }
    } else {
      timer = setTimeout(next, Math.max(3, dur || 10) * 1000);
    }
    // préchargement de l'image suivante
    const nxt = items[(idx + 1) % items.length];
    if (nxt && nxt.content.type === 'image') { const i = new Image(); i.src = nxt.content.file; }
  }

  function next() {
    clearTimeout(timer);
    if (!items.length) return;
    const prev = idx;
    idx = (idx + 1) % items.length;
    // un seul élément fixe : inutile de le recharger
    if (items.length === 1 && prev === idx && items[0].content.type !== 'video' && $(front).firstChild) {
      timer = setTimeout(next, Math.max(3, Number(items[0].duration) || 10) * 1000);
      return;
    }
    showItem(items[idx]);
  }

  function activePlaylistId(cfg) {
    const now = new Date();
    const day = now.getDay() === 0 ? 7 : now.getDay();
    const hm = pad(now.getHours()) + ':' + pad(now.getMinutes());
    for (const r of (cfg.screen.schedules || [])) {
      if (!cfg.playlists[r.playlistId] || !(r.days || []).includes(day)) continue;
      const inside = r.start <= r.end ? (hm >= r.start && hm < r.end) : (hm >= r.start || hm < r.end);
      if (inside) return r.playlistId;
    }
    return cfg.screen.playlistId;
  }

  function evaluate() {
    if (!config) return;
    const pid = activePlaylistId(config);
    const pl = pid && config.playlists[pid];
    const newSig = pl ? JSON.stringify(pl) : 'none';
    if (newSig === sig) return;
    sig = newSig;
    // un diaporama est déplié en une suite d'images (durée = durée par diapositive)
    items = [];
    (pl ? pl.items : []).forEach(it => {
      if (it.content.type === 'slides') (it.content.slides || []).forEach(f => items.push({ duration: it.duration, content: { type: 'image', file: f, fit: it.content.fit } }));
      else items.push(it);
    });
    idx = -1;
    clearTimeout(timer);
    if (!items.length) {
      $('A').innerHTML = ''; $('B').innerHTML = ''; $('A').classList.remove('on'); $('B').classList.remove('on');
      $('idle').querySelector('.n').textContent = config.screen.name || 'Écran';
      $('idle').style.display = 'flex';
    } else {
      $('idle').style.display = 'none';
      next();
    }
  }
  evaluate = safe(evaluate, 'programmation');
  next = safe(next, 'lecture');
  setInterval(evaluate, 15000);

  function applyConfig(cfg) {
    config = cfg;
    $('pair').style.display = 'none';
    if ((cfg.screen.orientation || 0) !== orientation || (cfg.screen.margin || 0) !== margin) {
      orientation = cfg.screen.orientation || 0; margin = cfg.screen.margin || 0; layout();
    }
    $('clock').style.display = cfg.screen.showClock ? 'block' : 'none';
    setTicker(cfg.screen.ticker);
    showAlert(cfg.alert);
    document.title = (cfg.screen.name || 'Écran') + ' – Affichage';
    evaluate();
  }

  function showAlert(a) {
    const el = $('alert');
    if (!a) { el.style.display = 'none'; return; }
    el.className = a.level === 'info' ? 'info' : 'urgence';
    el.querySelector('h1').textContent = a.title || '';
    el.querySelector('p').textContent = a.message || '';
    el.style.display = 'flex';
  }
  applyConfig = safe(applyConfig, 'configuration');

  /* ---------- Mode aperçu (depuis la console) ---------- */
  if (PREVIEW) {
    layout();
    fetch('/api/preview/' + encodeURIComponent(PREVIEW) + '?token=' + encodeURIComponent(qs.get('token') || ''))
      .then(r => r.json())
      .then(function (d) {
        if (!d.playlists) throw new Error(d.error || 'Aperçu impossible');
        applyConfig({ screen: { id: 'apercu', name: 'Aperçu', playlistId: PREVIEW, schedules: [], orientation: 0, ticker: '', showClock: false },
          playlists: d.playlists, settings: d.settings, alert: null });
      })
      .catch(e => { $('idle').style.display = 'flex'; $('idle').querySelector('.n').textContent = e.message; });
    return;
  }

  /* ---------- Connexion au serveur ---------- */
  layout();
  $('pair').querySelector('.url').textContent = location.host + '/admin';
  let lastCfgStr = '';
  try {
    lastCfgStr = store.get('sc_config') || '';
    const cached = JSON.parse(lastCfgStr || 'null');
    if (cached && cached.type === 'config') applyConfig(cached);   // reprise immédiate, même hors ligne
  } catch (e) {}

  let paired = !!config, lastHello = 0;

  function showPair(code) {
    config = null; sig = ''; items = []; clearTimeout(timer); lastCfgStr = ''; store.set('sc_config', '');
    $('A').innerHTML = ''; $('B').innerHTML = '';
    $('alert').style.display = 'none'; $('idle').style.display = 'none';
    $('pair').querySelector('.code').textContent = code || '····';
    $('pair').style.display = 'flex';
  }

  function runCmd(cmd) {
    const last = store.get('sc_cmd');
    if (last === null) { store.set('sc_cmd', cmd ? cmd.id : '-'); return; }   // premier démarrage : on n'exécute rien d'ancien
    if (!cmd || last === cmd.id) return;
    store.set('sc_cmd', cmd.id);
    if (Date.now() - cmd.at > 3 * 60 * 1000) return;                         // commande trop ancienne
    if (cmd.cmd === 'reload') location.reload();
    if (cmd.cmd === 'identify') {
      const id = $('ident'); id.querySelector('div').textContent = (config && config.screen.name) || 'Écran';
      id.style.display = 'flex'; setTimeout(() => { id.style.display = 'none'; }, 6000);
    }
  }

  function hello() {
    return fetch('/api/hello', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, ua: navigator.userAgent, res: screen.width + '×' + screen.height })
    }).then(r => {
      if (!r.ok) throw new Error('hello ' + r.status);
      lastHello = Date.now();
      return r.json();
    });
  }

  function pollConfig() {
    return fetch('/api/config/' + deviceId).then(r => {
      if (!r.ok) throw new Error('config ' + r.status);
      return r.text();
    }).then(text => {
      const m = JSON.parse(text);
      if (m.type === 'unpaired') { paired = false; return; }
      if (text !== lastCfgStr) { lastCfgStr = text; store.set('sc_config', text); applyConfig(m); }
      runCmd(m.screen.cmd);
    });
  }

  // Boucle principale : appairage toutes les 5 s, puis configuration toutes les 10 s
  // (servie par le cache du CDN) et signe de vie toutes les 5 min.
  function tick() {
    let wait = 10000;
    let p = Promise.resolve();
    if (!paired || Date.now() - lastHello > 5 * 60 * 1000) {
      p = p.then(hello).then(d => {
        if (!d.paired) {
          paired = false; wait = 5000;
          if ($('pair').style.display !== 'flex' || $('pair').querySelector('.code').textContent !== d.code) showPair(d.code);
        } else paired = true;
      });
    }
    p.then(() => { if (paired) return pollConfig(); })
      .then(() => { if (!paired) wait = 5000; $('net').style.display = 'none'; },
            e => { $('net').style.display = 'block'; wait = 15000; if (e && !/^(hello|config) /.test(e.message || '')) report('réseau : ' + (e.message || e)); })
      .then(() => { setTimeout(tick, wait); });
  }
  tick();

  // Rechargement de sécurité chaque nuit vers 4 h (libère la mémoire des navigateurs de TV)
  const bootedAt = Date.now();
  setInterval(() => {
    if (new Date().getHours() === 4 && Date.now() - bootedAt > 2 * 3600 * 1000) location.reload();
  }, 10 * 60 * 1000);
})();
