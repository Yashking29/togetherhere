(function () {
  'use strict';
  if (window.__togetherActive) return;
  window.__togetherActive = true;

  const SERVER = 'https://togetherhere.online';

  let socket    = null;
  let roomId    = null;
  let myName    = 'Partner';
  let syncLock  = false;
  let video     = null;
  let hud       = null;

  /* ════════════════════════════
     Video detection
  ════════════════════════════ */
  function findVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    return videos.find(v => v.readyState >= 1 && v.duration > 0) || videos[0] || null;
  }

  function waitForVideo(cb) {
    const v = findVideo();
    if (v) { cb(v); return; }
    const obs = new MutationObserver(() => {
      const v2 = findVideo();
      if (v2) { obs.disconnect(); cb(v2); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 60000);
  }

  /* ════════════════════════════
     Floating HUD
  ════════════════════════════ */
  function buildHud() {
    if (hud) return;

    const style = document.createElement('style');
    style.textContent = `
      #__tg_hud {
        position:fixed;top:20px;right:20px;z-index:2147483647;
        width:230px;background:rgba(9,9,20,.96);
        border:1px solid rgba(244,114,182,.35);border-radius:14px;
        font-family:'Inter',system-ui,sans-serif;color:#f0eeff;font-size:13px;
        box-shadow:0 8px 32px rgba(0,0,0,.7),0 0 0 1px rgba(244,114,182,.08);
        backdrop-filter:blur(20px);user-select:none;
      }
      #__tg_hud .th { display:flex;align-items:center;justify-content:space-between;
        padding:10px 14px 9px;border-bottom:1px solid rgba(255,255,255,.07);cursor:grab; }
      #__tg_hud .th-logo { font-weight:600;color:#f472b6;font-size:13px;
        filter:drop-shadow(0 0 6px rgba(244,114,182,.5)); }
      #__tg_hud .th-close { background:none;border:none;color:rgba(255,255,255,.35);
        cursor:pointer;font-size:13px;padding:2px 4px;border-radius:4px;line-height:1; }
      #__tg_hud .th-close:hover { color:#f87171; }
      #__tg_hud .tb { padding:12px 14px;display:flex;flex-direction:column;gap:9px; }
      #__tg_hud .ts { font-size:12px;color:rgba(240,238,255,.65);line-height:1.45; }
      #__tg_hud .ts.on { color:#f472b6; }
      #__tg_hud .tr { font-size:11px;color:rgba(255,255,255,.28); }
      #__tg_hud .tc {
        background:rgba(244,114,182,.14);border:1px solid rgba(244,114,182,.28);
        color:#f472b6;border-radius:8px;padding:6px 10px;font-size:12px;
        cursor:pointer;font-family:inherit;transition:background .15s;text-align:center;
      }
      #__tg_hud .tc:hover { background:rgba(244,114,182,.26); }
    `;
    document.head.appendChild(style);

    hud = document.createElement('div');
    hud.id = '__tg_hud';
    hud.innerHTML = `
      <div class="th">
        <span class="th-logo">&#9671; Together</span>
        <button class="th-close" id="__tg_x">&#10005;</button>
      </div>
      <div class="tb">
        <div class="ts" id="__tg_status">Waiting for partner&hellip;</div>
        <div class="tr" id="__tg_room"></div>
        <button class="tc" id="__tg_copy">Copy Invite Link</button>
      </div>
    `;
    document.body.appendChild(hud);

    // Draggable
    const header = hud.querySelector('.th');
    let ox=0, oy=0, drag=false;
    header.addEventListener('mousedown', e => {
      if (e.target.closest('.th-close')) return;
      drag=true;
      ox = e.clientX - hud.getBoundingClientRect().left;
      oy = e.clientY - hud.getBoundingClientRect().top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      hud.style.left   = Math.max(0, e.clientX - ox) + 'px';
      hud.style.top    = Math.max(0, e.clientY - oy) + 'px';
      hud.style.right  = 'auto';
    });
    document.addEventListener('mouseup', () => { drag = false; });

    hud.querySelector('#__tg_x').addEventListener('click', removeHud);
    hud.querySelector('#__tg_copy').addEventListener('click', () => {
      const url = 'https://togetherhere.online/?room=' + roomId;
      navigator.clipboard.writeText(url).catch(() => {});
      const btn = hud.querySelector('#__tg_copy');
      const prev = btn.textContent;
      btn.textContent = 'Copied! ♡';
      setTimeout(() => { btn.textContent = prev; }, 2000);
    });
  }

  function updateHud(msg, online) {
    if (!hud) return;
    const el = hud.querySelector('#__tg_status');
    if (el) { el.textContent = msg; el.className = 'ts' + (online ? ' on' : ''); }
    const re = hud.querySelector('#__tg_room');
    if (re && roomId) re.textContent = 'Room: ' + roomId;
  }

  function removeHud() {
    if (hud) { hud.remove(); hud = null; }
  }

  /* ════════════════════════════
     Toast
  ════════════════════════════ */
  function toast(msg) {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);' +
      'background:rgba(30,24,50,.97);border:1px solid rgba(244,114,182,.4);color:#f0eeff;' +
      'font-size:13px;padding:10px 22px;border-radius:100px;z-index:2147483647;' +
      'pointer-events:none;font-family:Inter,system-ui,sans-serif;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.5);white-space:nowrap;';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.remove(); }, 3000);
  }

  /* ════════════════════════════
     Video listeners
  ════════════════════════════ */
  function attachVideo(v) {
    video = v;
    v.addEventListener('play',   () => { if (!syncLock && socket) socket.emit('play',  { time: v.currentTime }); });
    v.addEventListener('pause',  () => { if (!syncLock && socket && !v.ended) socket.emit('pause', { time: v.currentTime }); });
    v.addEventListener('seeked', () => { if (!syncLock && socket) socket.emit('seek',  { time: v.currentTime }); });
  }

  function applyPlay(time)  { if (!video) return; syncLock=true; video.currentTime=time; video.play().catch(()=>{}); setTimeout(()=>syncLock=false,700); }
  function applyPause(time) { if (!video) return; syncLock=true; video.currentTime=time; video.pause(); setTimeout(()=>syncLock=false,700); }
  function applySeek(time)  { if (!video) return; syncLock=true; video.currentTime=time; setTimeout(()=>syncLock=false,500); }

  /* ════════════════════════════
     Socket
  ════════════════════════════ */
  function setupSocketEvents() {
    socket.on('partner-joined', d => {
      const name = (d && d.name) || 'Partner';
      updateHud(name + ' joined ♡', true);
      toast(name + ' is here ♡');
    });
    socket.on('partner-left', () => {
      updateHud('Partner disconnected', false);
      toast('Partner left the room');
    });
    socket.on('play',  d => applyPlay(d.time));
    socket.on('pause', d => applyPause(d.time));
    socket.on('seek',  d => applySeek(d.time));
    socket.on('disconnect', () => updateHud('Reconnecting…', false));
    socket.io.on('reconnect', () => {
      if (roomId) {
        socket.emit('join-room', { roomId, name: myName }, res => {
          if (res && !res.error) updateHud(res.partnerOnline ? 'Back in sync ♡' : 'Waiting…', res.partnerOnline);
        });
      }
    });
  }

  function connect(name, rid, customId) {
    myName = name || 'Partner';
    if (socket) { try { socket.disconnect(); } catch(_) {} }

    socket = io(SERVER, { transports: ['websocket', 'polling'] });
    setupSocketEvents();

    socket.on('connect', () => {
      if (rid) {
        socket.emit('join-room', { roomId: rid, name: myName }, res => {
          if (!res || res.error) { toast((res && res.error) || 'Room not found'); return; }
          roomId = rid;
          buildHud();
          updateHud(res.partnerOnline ? (res.partnerName || 'Partner') + ' is here ♡' : 'Waiting for partner…', res.partnerOnline);
          chrome.storage.local.set({ tg_room: roomId, tg_name: myName });
          if (res.state && res.state.time > 2) setTimeout(() => applySeek(res.state.time), 1000);
          waitForVideo(v => attachVideo(v));
        });
      } else {
        const opts = { name: myName };
        if (customId) opts.customId = customId;
        socket.emit('create-room', opts, res => {
          if (!res || res.error) { toast((res && res.error) || 'Could not create room'); return; }
          roomId = res.roomId;
          buildHud();
          updateHud('Waiting for partner…', false);
          chrome.storage.local.set({ tg_room: roomId, tg_name: myName });
          waitForVideo(v => attachVideo(v));
        });
      }
    });
  }

  /* ════════════════════════════
     Message bridge (popup ↔ content)
  ════════════════════════════ */
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.action === 'status') {
      respond({ roomId, connected: !!(socket && socket.connected), hasVideo: !!video });
      return true;
    }
    if (msg.action === 'create') {
      connect(msg.name, null, msg.customId || null);
      respond({ ok: true }); return true;
    }
    if (msg.action === 'join') {
      connect(msg.name, msg.roomId);
      respond({ ok: true }); return true;
    }
    if (msg.action === 'leave') {
      if (socket) { try { socket.disconnect(); } catch(_) {} socket = null; }
      removeHud(); roomId = null; video = null;
      chrome.storage.local.remove(['tg_room', 'tg_name']);
      respond({ ok: true }); return true;
    }
  });

})();
