/* ── YouTube IFrame API ── */
(function () {
  var tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(tag);
})();

/* ── Stars ── */
(function () {
  var canvas = document.getElementById('stars-canvas');
  var ctx    = canvas.getContext('2d');
  var stars  = [];
  function resize() {
    canvas.width = window.innerWidth; canvas.height = window.innerHeight; stars = [];
    for (var i = 0; i < 150; i++) stars.push({ x: Math.random()*canvas.width, y: Math.random()*canvas.height, r: Math.random()*1.2+0.2, a: Math.random(), s: Math.random()*0.004+0.001, p: Math.random()*6.28 });
  }
  function draw(t) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i], alpha = s.a * (0.4 + 0.6 * Math.abs(Math.sin(s.p + t * s.s)));
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.283);
      ctx.fillStyle = 'rgba(220,210,255,' + alpha.toFixed(3) + ')'; ctx.fill();
    }
    requestAnimationFrame(draw);
  }
  window.addEventListener('resize', resize); resize(); requestAnimationFrame(draw);
})();

/* ═══════════════════════════════════
   App state
═══════════════════════════════════ */
var socket      = io({ autoConnect: true });
var currentRoom = null;
var partnerUp   = false;
var isJoinMode  = false;

/* Players */
var ytPlayer    = null;
var vimeoPlayer = null;
var ytReady     = false;
var pendingLoad = null;         // { id, type, autoplay }
var currentType = null;         // 'youtube' | 'vimeo' | 'mp4'
var syncLock    = false;
var vimeoTime   = 0;            // last known Vimeo time (async API)

/* Panel */
var panelOpen   = false;
var unreadCount = 0;
var activeTab   = 'chat';

/* Queue / notes */
var queue      = [];
var notesTimer = null;

/* Subtitles */
var subtitles       = [];
var subtitlePollId  = null;

/* Drawing */
var drawActive  = false;
var drawColor   = '#f472b6';
var drawEraser  = false;
var drawCtx     = null;
var isDrawing   = false;
var lastDraw    = null;         // { x, y } in normalised coords

/* Display names */
var myName      = localStorage.getItem('together_name') || '';
var partnerName = 'Partner';

/* Typing indicator */
var isTyping    = false;
var typingTimer = null;

/* Watch timer */
var watchStart    = null;   // Date.now() when session started
var watchElapsed  = 0;      // accumulated ms from previous sessions
var watchInterval = null;

/* Sounds */
var soundMuted = false;
var audioCtx   = null;

/* WebRTC */
var peer        = null;
var localStream = null;
var micOn       = false;
var micMuted    = false;

/* Webcam PiP */
var camPeer   = null;
var camStream = null;
var camOn     = false;

/* Watch history */
var watchHistory = [];

/* Chat rate limit */
var chatTimes = [];

/* ═══════════════════════════════════
   Utilities
═══════════════════════════════════ */
function show(id) {
  document.querySelectorAll('.screen').forEach(function (s) { s.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
}

var toastTimer;
function toast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2800);
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function detectMedia(url) {
  if (!url) return null;
  var ytMatch = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  if (ytMatch) return { type: 'youtube', id: ytMatch[1] };
  var viMatch = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (viMatch) return { type: 'vimeo', id: viMatch[1] };
  if (/\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(url)) return { type: 'mp4', id: url };
  return null;
}

async function fetchTitle(type, id) {
  try {
    if (type === 'youtube') {
      var r = await fetch('https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=' + id + '&format=json');
      return (await r.json()).title || 'YouTube Video';
    }
    if (type === 'vimeo') {
      var r = await fetch('https://vimeo.com/api/oembed.json?url=https://vimeo.com/' + id);
      return (await r.json()).title || 'Vimeo Video';
    }
  } catch (_) {}
  if (type === 'mp4') return decodeURIComponent(id.split('/').pop().split('?')[0]) || 'Video';
  return 'Video';
}

/* ═══════════════════════════════════
   Notification sounds (Web Audio API)
═══════════════════════════════════ */
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playTone(freq, duration, delay, vol, shape) {
  try {
    var ctx  = getAudioCtx();
    var osc  = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = shape || 'sine';
    osc.frequency.setValueAtTime(freq, ctx.currentTime + delay);
    gain.gain.setValueAtTime(0, ctx.currentTime + delay);
    gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + delay + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + duration);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(ctx.currentTime + delay);
    osc.stop(ctx.currentTime + delay + duration);
  } catch (_) {}
}

function playSound(type) {
  if (soundMuted) return;
  if (type === 'join') {
    playTone(523, 0.25, 0,    0.12, 'sine');
    playTone(659, 0.25, 0.1,  0.12, 'sine');
    playTone(784, 0.4,  0.2,  0.12, 'sine');
  } else if (type === 'leave') {
    playTone(523, 0.25, 0,    0.09, 'sine');
    playTone(440, 0.25, 0.1,  0.09, 'sine');
    playTone(349, 0.4,  0.2,  0.09, 'sine');
  } else if (type === 'message') {
    playTone(880, 0.18, 0, 0.08, 'sine');
  } else if (type === 'reaction') {
    playTone(1047, 0.12, 0,    0.07, 'triangle');
    playTone(1319, 0.12, 0.09, 0.07, 'triangle');
  }
}

document.getElementById('sound-toggle-btn').addEventListener('click', function () {
  soundMuted = !soundMuted;
  this.classList.toggle('active', soundMuted);
  this.title = soundMuted ? 'Sounds off' : 'Sounds on';
  toast(soundMuted ? 'Sounds off' : 'Sounds on');
});

/* ═══════════════════════════════════
   Watch timer
═══════════════════════════════════ */
function startWatchTimer() {
  if (watchStart) return;
  watchStart = Date.now();
  document.getElementById('watch-timer').classList.add('running');
  if (!watchInterval) {
    watchInterval = setInterval(function () {
      var total = watchElapsed + (watchStart ? Date.now() - watchStart : 0);
      var s = Math.floor(total / 1000);
      var m = Math.floor(s / 60);
      var h = Math.floor(m / 60);
      s %= 60; m %= 60;
      document.getElementById('watch-timer-text').textContent =
        h > 0 ? h + 'h ' + String(m).padStart(2,'0') + 'm'
               : String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    }, 1000);
  }
}

function pauseWatchTimer() {
  if (!watchStart) return;
  watchElapsed += Date.now() - watchStart;
  watchStart = null;
}

/* ═══════════════════════════════════
   Multi-player
═══════════════════════════════════ */
window.onYouTubeIframeAPIReady = function () {
  ytReady = true;
  ytPlayer = new YT.Player('yt-player', {
    height: '100%', width: '100%',
    playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: function () {
        if (pendingLoad && pendingLoad.type === 'youtube') {
          var pl = pendingLoad; pendingLoad = null; loadMedia(pl.id, 'youtube', pl.autoplay);
        }
      },
      onStateChange: function (e) {
        if (syncLock || !currentRoom) return;
        if (e.data === YT.PlayerState.PLAYING) socket.emit('play',  { time: ytPlayer.getCurrentTime() });
        if (e.data === YT.PlayerState.PAUSED)  socket.emit('pause', { time: ytPlayer.getCurrentTime() });
        if (e.data === YT.PlayerState.ENDED)   socket.emit('video-ended');
      }
    }
  });
};

function showPlayer(type) {
  document.getElementById('yt-player').style.display       = type === 'youtube' ? 'block' : 'none';
  document.getElementById('html5-video').style.display     = type === 'mp4'     ? 'block' : 'none';
  document.getElementById('vimeo-container').style.display = type === 'vimeo'   ? 'block' : 'none';
}

function loadMedia(id, type, autoplay) {
  currentType = type;
  document.getElementById('player-placeholder').classList.add('hidden');
  showPlayer(type);
  if (type === 'youtube') {
    if (!ytReady || !ytPlayer) { pendingLoad = { id: id, type: type, autoplay: autoplay }; return; }
    syncLock = true;
    ytPlayer.loadVideoById(id);
    setTimeout(function () { if (!autoplay) ytPlayer.pauseVideo(); syncLock = false; }, 1000);
  } else if (type === 'mp4') {
    setupHtml5(id, autoplay);
  } else if (type === 'vimeo') {
    setupVimeo(id, autoplay);
  }
}

function setupHtml5(url, autoplay) {
  var video = document.getElementById('html5-video');
  video.onplay = video.onpause = video.onseeked = video.onended = null;
  syncLock = true; video.src = url; video.load();
  video.onplay   = function () { if (!syncLock) socket.emit('play',  { time: video.currentTime }); };
  video.onpause  = function () { if (!syncLock && !video.ended) socket.emit('pause', { time: video.currentTime }); };
  video.onseeked = function () { if (!syncLock) socket.emit('seek',  { time: video.currentTime }); };
  video.onended  = function () { socket.emit('video-ended'); };
  video.addEventListener('canplay', function onCp() {
    video.removeEventListener('canplay', onCp); syncLock = false;
    if (autoplay) video.play().catch(function () {});
  });
}

function setupVimeo(videoId, autoplay) {
  var container = document.getElementById('vimeo-container');
  if (vimeoPlayer) {
    syncLock = true;
    vimeoPlayer.loadVideo(parseInt(videoId, 10))
      .then(function () { syncLock = false; if (autoplay) vimeoPlayer.play().catch(function () {}); })
      .catch(function () { syncLock = false; });
    return;
  }
  syncLock = true;
  vimeoPlayer = new Vimeo.Player(container, { id: parseInt(videoId, 10), responsive: true, autopause: false });
  vimeoPlayer.on('play',       function () { if (!syncLock && currentRoom) vimeoPlayer.getCurrentTime().then(function (t) { socket.emit('play',  { time: t }); }); });
  vimeoPlayer.on('pause',      function () { if (!syncLock && currentRoom) vimeoPlayer.getCurrentTime().then(function (t) { socket.emit('pause', { time: t }); }); });
  vimeoPlayer.on('seeked',     function (d) { if (!syncLock && currentRoom) socket.emit('seek', { time: d.seconds }); });
  vimeoPlayer.on('ended',      function () { socket.emit('video-ended'); });
  vimeoPlayer.on('timeupdate', function (d) { vimeoTime = d.seconds; });
  vimeoPlayer.on('loaded',     function () { syncLock = false; if (autoplay) vimeoPlayer.play().catch(function () {}); });
}

function getVideoTime() {
  if (currentType === 'youtube' && ytPlayer) { try { return ytPlayer.getCurrentTime() || 0; } catch (_) { return 0; } }
  if (currentType === 'mp4') return document.getElementById('html5-video').currentTime || 0;
  return vimeoTime;
}

function applyPlay(time) {
  syncLock = true;
  if (currentType === 'youtube' && ytPlayer)   { ytPlayer.seekTo(time, true); ytPlayer.playVideo(); }
  else if (currentType === 'mp4')              { var v = document.getElementById('html5-video'); v.currentTime = time; v.play().catch(function () {}); }
  else if (currentType === 'vimeo' && vimeoPlayer) vimeoPlayer.setCurrentTime(time).then(function () { return vimeoPlayer.play(); }).catch(function () {});
  setTimeout(function () { syncLock = false; }, 700);
}

function applyPause(time) {
  syncLock = true;
  if (currentType === 'youtube' && ytPlayer)   { ytPlayer.seekTo(time, true); ytPlayer.pauseVideo(); }
  else if (currentType === 'mp4')              { var v = document.getElementById('html5-video'); v.currentTime = time; v.pause(); }
  else if (currentType === 'vimeo' && vimeoPlayer) vimeoPlayer.setCurrentTime(time).then(function () { return vimeoPlayer.pause(); }).catch(function () {});
  setTimeout(function () { syncLock = false; }, 700);
}

function applySeek(time) {
  syncLock = true;
  if (currentType === 'youtube' && ytPlayer)        ytPlayer.seekTo(time, true);
  else if (currentType === 'mp4')                   document.getElementById('html5-video').currentTime = time;
  else if (currentType === 'vimeo' && vimeoPlayer)  vimeoPlayer.setCurrentTime(time).catch(function () {});
  setTimeout(function () { syncLock = false; }, 500);
}

/* ═══════════════════════════════════
   Subtitles
═══════════════════════════════════ */
function parseSrt(text) {
  var entries = [];
  var blocks  = text.trim().replace(/\r\n/g, '\n').split(/\n\s*\n/);
  blocks.forEach(function (block) {
    var lines = block.trim().split('\n');
    if (lines.length < 3) return;
    var t = lines[1].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!t) return;
    var start = +t[1]*3600 + +t[2]*60 + +t[3] + +t[4]/1000;
    var end   = +t[5]*3600 + +t[6]*60 + +t[7] + +t[8]/1000;
    var text  = lines.slice(2).join('\n').replace(/<[^>]*>/g, '');
    entries.push({ start: start, end: end, text: text });
  });
  return entries;
}

function applySubtitles(parsed) {
  subtitles = parsed;
  clearInterval(subtitlePollId);
  if (!subtitles.length) { document.getElementById('subtitle-display').textContent = ''; return; }
  subtitlePollId = setInterval(function () {
    var t     = getVideoTime();
    var entry = null;
    for (var i = 0; i < subtitles.length; i++) {
      if (t >= subtitles[i].start && t <= subtitles[i].end) { entry = subtitles[i]; break; }
    }
    document.getElementById('subtitle-display').textContent = entry ? entry.text : '';
  }, 200);
}

function clearSubtitles() {
  subtitles = [];
  clearInterval(subtitlePollId);
  document.getElementById('subtitle-display').textContent = '';
  document.getElementById('subtitle-label').classList.remove('active');
  document.getElementById('subtitle-clear-btn').style.display = 'none';
  document.getElementById('subtitle-label').style.display     = 'inline-flex';
}

document.getElementById('subtitle-file').addEventListener('change', function () {
  var file = this.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function (e) {
    var parsed = parseSrt(e.target.result);
    if (!parsed.length) { toast('Could not read subtitle file'); return; }
    applySubtitles(parsed);
    socket.emit('subtitle-load', { subtitles: parsed });
    document.getElementById('subtitle-label').style.display     = 'none';
    document.getElementById('subtitle-clear-btn').style.display = 'inline-flex';
    toast('Subtitles loaded (' + parsed.length + ' entries)');
  };
  reader.readAsText(file);
  this.value = '';
});

document.getElementById('subtitle-clear-btn').addEventListener('click', function () {
  clearSubtitles();
  socket.emit('subtitle-clear');
});

socket.on('subtitle-load',  function (d) { applySubtitles(d.subtitles); document.getElementById('subtitle-label').style.display = 'none'; document.getElementById('subtitle-clear-btn').style.display = 'inline-flex'; toast('Partner loaded subtitles'); });
socket.on('subtitle-clear', function ()  { clearSubtitles(); toast('Partner removed subtitles'); });

/* ═══════════════════════════════════
   Drawing overlay
═══════════════════════════════════ */
function initDrawCanvas() {
  var canvas = document.getElementById('draw-canvas');
  var rect   = canvas.getBoundingClientRect();
  canvas.width  = rect.width  || canvas.offsetWidth;
  canvas.height = rect.height || canvas.offsetHeight;
  drawCtx = canvas.getContext('2d');
  drawCtx.lineCap  = 'round';
  drawCtx.lineJoin = 'round';
}

function setDrawStyle() {
  if (!drawCtx) return;
  if (drawEraser) {
    drawCtx.globalCompositeOperation = 'destination-out';
    drawCtx.strokeStyle = 'rgba(0,0,0,1)';
    drawCtx.lineWidth   = 22;
  } else {
    drawCtx.globalCompositeOperation = 'source-over';
    drawCtx.strokeStyle = drawColor;
    drawCtx.lineWidth   = 3;
  }
}

function normalise(e) {
  var canvas  = document.getElementById('draw-canvas');
  var rect    = canvas.getBoundingClientRect();
  var clientX = e.touches ? e.touches[0].clientX : e.clientX;
  var clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
}

function toPixels(nx, ny) {
  var canvas = document.getElementById('draw-canvas');
  return { x: nx * canvas.width, y: ny * canvas.height };
}

function openDraw() {
  drawActive = true;
  var canvas = document.getElementById('draw-canvas');
  canvas.classList.add('active');
  canvas.style.cursor = 'crosshair';
  document.getElementById('draw-toolbar').classList.add('active');
  document.getElementById('draw-toggle-btn').classList.add('active');
  initDrawCanvas();
  setDrawStyle();
}

function closeDraw() {
  drawActive = false;
  var canvas = document.getElementById('draw-canvas');
  canvas.classList.remove('active');
  document.getElementById('draw-toolbar').classList.remove('active');
  document.getElementById('draw-toggle-btn').classList.remove('active');
}

document.getElementById('draw-toggle-btn').addEventListener('click', function () {
  if (!currentRoom) { toast('Join a room first'); return; }
  drawActive ? closeDraw() : openDraw();
});
document.getElementById('draw-close-btn').addEventListener('click', closeDraw);

document.getElementById('draw-clear-btn').addEventListener('click', function () {
  if (drawCtx) drawCtx.clearRect(0, 0, document.getElementById('draw-canvas').width, document.getElementById('draw-canvas').height);
  socket.emit('draw-clear');
});

document.getElementById('draw-eraser-btn').addEventListener('click', function () {
  drawEraser = !drawEraser;
  this.classList.toggle('active', drawEraser);
  setDrawStyle();
});

document.querySelectorAll('.draw-color-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    document.querySelectorAll('.draw-color-btn').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    drawColor  = btn.dataset.color;
    drawEraser = false;
    document.getElementById('draw-eraser-btn').classList.remove('active');
    setDrawStyle();
  });
});

/* Draw mouse/touch events */
var drawCanvas = document.getElementById('draw-canvas');

function onDrawStart(e) {
  if (!drawActive) return;
  e.preventDefault();
  isDrawing = true;
  var n = normalise(e);
  var p = toPixels(n.x, n.y);
  setDrawStyle();
  drawCtx.beginPath();
  drawCtx.moveTo(p.x, p.y);
  lastDraw = n;
  socket.emit('draw-start', { x: n.x, y: n.y, color: drawColor, eraser: drawEraser });
}

function onDrawMove(e) {
  if (!drawActive || !isDrawing) return;
  e.preventDefault();
  var n = normalise(e);
  var p = toPixels(n.x, n.y);
  drawCtx.lineTo(p.x, p.y);
  drawCtx.stroke();
  socket.emit('draw-move', { x: n.x, y: n.y });
}

function onDrawEnd(e) {
  if (!isDrawing) return;
  isDrawing = false; lastDraw = null;
  socket.emit('draw-end');
}

drawCanvas.addEventListener('mousedown',  onDrawStart);
drawCanvas.addEventListener('mousemove',  onDrawMove);
drawCanvas.addEventListener('mouseup',    onDrawEnd);
drawCanvas.addEventListener('mouseleave', onDrawEnd);
drawCanvas.addEventListener('touchstart', onDrawStart, { passive: false });
drawCanvas.addEventListener('touchmove',  onDrawMove,  { passive: false });
drawCanvas.addEventListener('touchend',   onDrawEnd);

/* Remote drawing */
var remotePath = null;

socket.on('draw-start', function (d) {
  if (!drawCtx) initDrawCanvas();
  var p = toPixels(d.x, d.y);
  if (d.eraser) {
    drawCtx.globalCompositeOperation = 'destination-out';
    drawCtx.strokeStyle = 'rgba(0,0,0,1)';
    drawCtx.lineWidth   = 22;
  } else {
    drawCtx.globalCompositeOperation = 'source-over';
    drawCtx.strokeStyle = d.color || '#f472b6';
    drawCtx.lineWidth   = 3;
  }
  drawCtx.lineCap  = 'round';
  drawCtx.lineJoin = 'round';
  drawCtx.beginPath();
  drawCtx.moveTo(p.x, p.y);
  remotePath = d;
  if (!drawActive) {
    document.getElementById('draw-canvas').classList.add('active');
    document.getElementById('draw-canvas').style.pointerEvents = 'none';
  }
});

socket.on('draw-move', function (d) {
  if (!drawCtx) return;
  var p = toPixels(d.x, d.y);
  drawCtx.lineTo(p.x, p.y);
  drawCtx.stroke();
});

socket.on('draw-end', function () { remotePath = null; });

socket.on('draw-clear', function () {
  if (drawCtx) drawCtx.clearRect(0, 0, document.getElementById('draw-canvas').width, document.getElementById('draw-canvas').height);
});

/* ═══════════════════════════════════
   Reactions
═══════════════════════════════════ */
function showReaction(emoji) {
  var overlay = document.getElementById('reaction-overlay');
  var el      = document.createElement('div');
  el.className  = 'reaction-float';
  el.textContent = emoji;
  el.style.left  = (10 + Math.random() * 80) + '%';
  overlay.appendChild(el);
  setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 2900);
}

document.querySelectorAll('.reaction-btn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    if (!currentRoom) { toast('Join a room first'); return; }
    var emoji = btn.dataset.emoji;
    socket.emit('reaction', { emoji: emoji });
    showReaction(emoji);
    playSound('reaction');
  });
});

socket.on('reaction', function (d) { showReaction(d.emoji); playSound('reaction'); });

/* ═══════════════════════════════════
   Queue
═══════════════════════════════════ */
function renderQueue() {
  var list  = document.getElementById('queue-list');
  var empty = document.getElementById('queue-empty');
  list.innerHTML = '';
  if (!queue.length) { empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  queue.forEach(function (item, i) {
    var div    = document.createElement('div');
    div.className = 'queue-item' + (item.current ? ' current' : '');
    var badge  = document.createElement('span');
    badge.className  = 'queue-badge queue-badge-' + item.type;
    badge.textContent = item.type === 'youtube' ? 'YT' : item.type === 'vimeo' ? 'VI' : 'MP4';
    var title  = document.createElement('span');
    title.className  = 'queue-title';
    title.textContent = item.title || item.id;
    var playBtn   = document.createElement('button');
    playBtn.className   = 'queue-play'; playBtn.title = 'Play now'; playBtn.textContent = '▶';
    var removeBtn = document.createElement('button');
    removeBtn.className   = 'queue-remove'; removeBtn.title = 'Remove'; removeBtn.textContent = '✕';
    (function (idx) {
      playBtn.addEventListener('click',   function () { socket.emit('queue-play',   { index: idx }); });
      removeBtn.addEventListener('click', function () { socket.emit('queue-remove', { index: idx }); });
    })(i);
    div.appendChild(badge); div.appendChild(title); div.appendChild(playBtn); div.appendChild(removeBtn);
    list.appendChild(div);
  });
}

async function addToQueue(url) {
  var media = detectMedia(url);
  if (!media) { toast('Unsupported URL — try YouTube, Vimeo or a .mp4 link'); return; }
  toast('Fetching title…');
  var title = await fetchTitle(media.type, media.id);
  socket.emit('queue-add', { item: { type: media.type, id: media.id, title: title, current: false } });
  toast('Added to queue ♡');
}

socket.on('queue-update', function (d) { queue = d.queue; renderQueue(); });

/* ═══════════════════════════════════
   Notes
═══════════════════════════════════ */
document.getElementById('notes-input').addEventListener('input', function () {
  var val = this.value;
  clearTimeout(notesTimer);
  notesTimer = setTimeout(function () { if (currentRoom) socket.emit('notes-update', { notes: val }); }, 500);
});

socket.on('notes-update', function (d) {
  var el = document.getElementById('notes-input');
  if (document.activeElement !== el) el.value = d.notes;
});

/* ═══════════════════════════════════
   Partner status
═══════════════════════════════════ */
function setStatus(state) {
  var dot  = document.getElementById('status-dot');
  var text = document.getElementById('status-text');
  var wrap = document.getElementById('partner-status');
  dot.className = 'status-dot ' + state;
  if (state === 'online') {
    text.textContent = 'Your love is here ♡'; wrap.classList.add('online');
    document.getElementById('player-shell').classList.add('synced');
  } else if (state === 'offline') {
    text.textContent = 'Partner disconnected'; wrap.classList.remove('online');
    document.getElementById('player-shell').classList.remove('synced');
  } else {
    text.textContent = 'Waiting for your person…'; wrap.classList.remove('online');
    document.getElementById('player-shell').classList.remove('synced');
  }
}

/* ═══════════════════════════════════
   Panel & tabs
═══════════════════════════════════ */
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(function (btn) { btn.classList.toggle('active', btn.dataset.tab === tab); });
  document.querySelectorAll('.tab-content').forEach(function (el) { el.classList.toggle('active', el.id === 'tab-' + tab); });
  if (tab === 'chat') {
    unreadCount = 0; document.getElementById('unread-badge').classList.remove('visible');
    setTimeout(function () { var msgs = document.getElementById('messages'); msgs.scrollTop = msgs.scrollHeight; }, 50);
  }
}

document.querySelectorAll('.tab-btn').forEach(function (btn) {
  btn.addEventListener('click', function () { switchTab(btn.dataset.tab); });
});

document.getElementById('panel-toggle-btn').addEventListener('click', function () {
  panelOpen = !panelOpen;
  document.getElementById('side-panel').classList.toggle('open', panelOpen);
  if (panelOpen) switchTab(activeTab);
});

/* ═══════════════════════════════════
   Enter room
═══════════════════════════════════ */
function enterRoom(id, videoId, videoType, state, partnerOnline, initialQueue, initialNotes, initialSubs, incomingPartnerName, initialHistory) {
  currentRoom = id;
  partnerUp   = !!partnerOnline;
  if (incomingPartnerName) partnerName = incomingPartnerName;
  window.history.replaceState({}, '', '/?room=' + id);
  show('room');
  setStatus(partnerOnline ? 'online' : 'waiting');
  document.getElementById('panel-toggle-btn').classList.add('room-active');
  if (partnerOnline) startWatchTimer();

  if (initialQueue   && initialQueue.length)   { queue = initialQueue; renderQueue(); }
  if (initialHistory && initialHistory.length) { watchHistory = initialHistory; renderHistory(); }
  if (initialNotes) document.getElementById('notes-input').value = initialNotes;
  if (initialSubs  && initialSubs.length)  {
    applySubtitles(initialSubs);
    document.getElementById('subtitle-label').style.display     = 'none';
    document.getElementById('subtitle-clear-btn').style.display = 'inline-flex';
  }

  if (videoId) {
    loadMedia(videoId, videoType || 'youtube', false);
    if (state && state.time > 0) {
      setTimeout(function () {
        if (state.playing) applyPlay(state.time); else applyPause(state.time);
      }, 1600);
    }
  }
}

/* ═══════════════════════════════════
   Chat
═══════════════════════════════════ */
function addMessage(text, isSelf, senderName) {
  var msgs   = document.getElementById('messages');
  var div    = document.createElement('div');
  div.className = 'msg ' + (isSelf ? 'self' : 'them');
  if (senderName) {
    var nameEl = document.createElement('div');
    nameEl.className = 'msg-name'; nameEl.textContent = senderName;
    div.appendChild(nameEl);
  }
  var bubble = document.createElement('span');
  bubble.className  = 'msg-bubble'; bubble.textContent = text;
  div.appendChild(bubble); msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
  if ((!panelOpen || activeTab !== 'chat') && !isSelf) {
    unreadCount++;
    var badge = document.getElementById('unread-badge');
    badge.textContent = unreadCount > 9 ? '9+' : unreadCount;
    badge.classList.add('visible');
  }
}

function addSystemMsg(text) {
  var msgs = document.getElementById('messages');
  var div  = document.createElement('div');
  div.className = 'msg-system'; div.textContent = text;
  msgs.appendChild(div); msgs.scrollTop = msgs.scrollHeight;
}

function sendMessage() {
  var input = document.getElementById('msg-input');
  var text  = input.value.trim();
  if (!text || !currentRoom) return;
  var now = Date.now();
  chatTimes = chatTimes.filter(function (t) { return now - t < 3000; });
  if (chatTimes.length >= 5) { toast('Slow down ♡'); return; }
  chatTimes.push(now);
  if (isTyping) { isTyping = false; clearTimeout(typingTimer); socket.emit('typing-stop'); }
  socket.emit('chat', { text: text }); addMessage(text, true, myName || 'You'); input.value = '';
}

document.getElementById('msg-send-btn').addEventListener('click', sendMessage);
document.getElementById('msg-input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
document.getElementById('msg-input').addEventListener('input', function () {
  if (!currentRoom) return;
  if (!isTyping) { isTyping = true; socket.emit('typing-start'); }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(function () { isTyping = false; socket.emit('typing-stop'); }, 2000);
});

socket.on('typing-start', function (d) {
  document.getElementById('typing-name').textContent = (d && d.name) || partnerName;
  document.getElementById('typing-indicator').classList.add('visible');
});
socket.on('typing-stop', function () {
  document.getElementById('typing-indicator').classList.remove('visible');
});

socket.on('chat', function (d) {
  document.getElementById('typing-indicator').classList.remove('visible');
  addMessage(d.text, false, d.name || partnerName); playSound('message');
  if (!panelOpen || activeTab !== 'chat') toast('♡ ' + d.text.slice(0, 40));
});

/* ═══════════════════════════════════
   Voice
═══════════════════════════════════ */
function updateMicUI() {
  var btn   = document.getElementById('mic-btn');
  var state = document.getElementById('voice-state');
  var hint  = document.getElementById('voice-hint');
  btn.classList.toggle('active', micOn && !micMuted);
  btn.classList.toggle('muted',  micOn &&  micMuted);
  if (!micOn)       { state.textContent = 'Tap mic to talk';    hint.textContent = 'Peer-to-peer · private'; }
  else if (micMuted){ state.textContent = 'Muted';              hint.textContent = 'Tap to unmute'; }
  else              { state.textContent = 'You’re speaking'; hint.textContent = 'Tap to mute · hold to stop'; }
}

function showPartnerVoice(active) {
  var row  = document.getElementById('partner-voice');
  var dot  = document.getElementById('partner-voice-dot');
  var text = document.getElementById('partner-voice-text');
  row.style.display = active ? 'flex' : 'none';
  dot.className = 'partner-voice-dot' + (active ? ' speaking' : '');
  text.textContent = active ? 'Partner’s mic is on' : '';
}

function buildPeer(initiator) {
  if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }
  peer = new SimplePeer({
    initiator: initiator, stream: localStream || undefined, trickle: true,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] }
  });
  peer.on('signal', function (d) { socket.emit('voice-signal', d); });
  peer.on('stream', function (s) {
    var audio = document.getElementById('remote-audio');
    audio.srcObject = s; audio.play().catch(function () {});
    showPartnerVoice(true); toast('Voice connected ♡');
    document.getElementById('voice-hint').textContent = 'Connected';
  });
  peer.on('connect', function () { document.getElementById('voice-hint').textContent = 'Connected'; });
  peer.on('error',   function () { toast('Voice error — try again'); stopVoice(); });
  peer.on('close',   function () { showPartnerVoice(false); peer = null; if (micOn) updateMicUI(); });
}

async function startVoice() {
  try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
  catch (_) { toast('Microphone access denied'); return; }
  micOn = true; micMuted = false; updateMicUI();
  if (partnerUp) { socket.emit('voice-start'); setTimeout(function () { buildPeer(true); }, 400); }
}

function stopVoice() {
  if (peer)        { try { peer.destroy(); } catch (_) {} peer = null; }
  if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
  document.getElementById('remote-audio').srcObject = null;
  micOn = false; micMuted = false; updateMicUI(); showPartnerVoice(false); socket.emit('voice-stop');
}

function toggleMic() {
  if (!micOn) { startVoice(); return; }
  micMuted = !micMuted;
  if (localStream) localStream.getAudioTracks().forEach(function (t) { t.enabled = !micMuted; });
  updateMicUI();
}

var micPressTimer;
document.getElementById('mic-btn').addEventListener('mousedown',  function () { micPressTimer = setTimeout(stopVoice, 700); });
document.getElementById('mic-btn').addEventListener('touchstart', function () { micPressTimer = setTimeout(stopVoice, 700); }, { passive: true });
document.getElementById('mic-btn').addEventListener('mouseup',    function () { clearTimeout(micPressTimer); });
document.getElementById('mic-btn').addEventListener('touchend',   function () { clearTimeout(micPressTimer); });
document.getElementById('mic-btn').addEventListener('click',      toggleMic);

socket.on('voice-start', async function () {
  if (!localStream) {
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); micOn = true; micMuted = false; updateMicUI(); }
    catch (_) { toast('Microphone access denied'); }
  }
  buildPeer(false);
});

socket.on('voice-signal', async function (d) {
  if (peer) { peer.signal(d); return; }
  if (!localStream) {
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); micOn = true; micMuted = false; updateMicUI(); }
    catch (_) { toast('Microphone access denied'); }
  }
  buildPeer(false); peer.signal(d);
});

socket.on('voice-stop', function () {
  if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }
  document.getElementById('remote-audio').srcObject = null;
  showPartnerVoice(false); toast('Partner ended voice');
});

/* ═══════════════════════════════════
   Socket — room events
═══════════════════════════════════ */
socket.on('partner-joined', function (d) {
  partnerUp   = true;
  partnerName = (d && d.name) || 'Partner';
  setStatus('online');
  playSound('join');
  toast(partnerName + ' joined ♡');
  addSystemMsg(partnerName + ' joined ♡');
  startWatchTimer();
  if (micOn && localStream) { socket.emit('voice-start'); setTimeout(function () { buildPeer(true); }, 400); }
});

socket.on('partner-left', function () {
  partnerUp = false; setStatus('offline');
  playSound('leave'); toast(partnerName + ' disconnected'); addSystemMsg(partnerName + ' left the room');
  pauseWatchTimer();
  document.getElementById('typing-indicator').classList.remove('visible');
  if (peer) { try { peer.destroy(); } catch (_) {} peer = null; }
  showPartnerVoice(false);
});

socket.on('video-load', function (d) { loadMedia(d.videoId, d.videoType || 'youtube', d.autoplay || false); });
socket.on('play',  function (d) { if (currentType) applyPlay(d.time); });
socket.on('pause', function (d) { if (currentType) applyPause(d.time); });
socket.on('seek',  function (d) { if (currentType) applySeek(d.time); });

/* ── Reconnect handling ── */
socket.on('disconnect', function () {
  if (!currentRoom) return;
  setStatus('waiting');
  addSystemMsg('Connection lost — reconnecting…');
  pauseWatchTimer();
});

socket.on('connect', function () {
  if (!currentRoom) return; // initial connect, not a reconnect
  addSystemMsg('Reconnected — syncing…');
  socket.emit('join-room', { roomId: currentRoom, name: myName }, function (res) {
    if (!res || res.error) {
      currentRoom = null; partnerUp = false;
      addSystemMsg('Room no longer exists.');
      setStatus('waiting');
      return;
    }
    partnerUp = !!res.partnerOnline;
    setStatus(res.partnerOnline ? 'online' : 'waiting');
    if (res.partnerOnline) startWatchTimer();
    // Sync video to server's current position
    if (res.state && res.state.time > 0) {
      setTimeout(function () { applySeek(res.state.time); }, 600);
    }
    addSystemMsg('Back in sync ♡');
  });
});

/* ── Pause watch timer when tab hidden ── */
document.addEventListener('visibilitychange', function () {
  if (document.hidden) { pauseWatchTimer(); }
  else if (partnerUp && currentRoom) { startWatchTimer(); }
});

/* ── Cleanup WebRTC on page close ── */
window.addEventListener('beforeunload', function () {
  if (peer)        { try { peer.destroy(); }    catch (_) {} }
  if (camPeer)     { try { camPeer.destroy(); } catch (_) {} }
  if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
  if (camStream)   camStream.getTracks().forEach(function (t) { t.stop(); });
});

/* ═══════════════════════════════════
   Buttons
═══════════════════════════════════ */
document.getElementById('display-name-input').addEventListener('input', function () {
  myName = this.value.trim();
  localStorage.setItem('together_name', myName);
  if (currentRoom) socket.emit('set-name', myName);
});
/* pre-fill from localStorage */
document.getElementById('display-name-input').value = myName;

document.getElementById('create-btn').addEventListener('click', function () {
  if (isJoinMode) return;
  var btn      = document.getElementById('create-btn');
  var customId = document.getElementById('room-name-input').value.trim();
  var errEl    = document.getElementById('room-name-error');
  myName = document.getElementById('display-name-input').value.trim() || 'Partner';
  localStorage.setItem('together_name', myName);
  errEl.textContent = '';
  btn.disabled = true; btn.textContent = 'Creating…';

  function go() {
    var opts = { name: myName };
    if (customId) opts.customId = customId;
    socket.emit('create-room', opts, function (res) {
      if (res && res.roomId) {
        enterRoom(res.roomId, null, null, null, false, [], '', []);
      } else {
        btn.disabled = false; btn.textContent = 'Create a Room';
        errEl.textContent = (res && res.error) || 'Could not create room — try again';
      }
    });
  }
  if (socket.connected) go(); else socket.once('connect', go);
});

document.getElementById('new-room-btn').addEventListener('click', function () {
  socket.emit('create-room', { name: myName }, function (res) {
    if (res && res.roomId) enterRoom(res.roomId, null, null, null, false, [], '', []);
  });
});

document.getElementById('copy-btn').addEventListener('click', function () {
  if (!currentRoom) return;
  var url = window.location.origin + '/?room=' + currentRoom;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(function () { toast('Link copied — share it ♡'); }).catch(function () { prompt('Copy this link:', url); });
  } else { prompt('Copy this link:', url); }
});

async function handleLoad() {
  var url   = document.getElementById('url-input').value.trim();
  var media = detectMedia(url);
  if (!media) { toast('Unsupported URL — try YouTube, Vimeo or a .mp4 link'); return; }
  var title = await fetchTitle(media.type, media.id);
  socket.emit('video-load', { videoId: media.id, videoType: media.type, title: title });
  loadMedia(media.id, media.type, false);
  document.getElementById('url-input').value = '';
}

document.getElementById('load-btn').addEventListener('click', handleLoad);
document.getElementById('url-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') handleLoad(); });
document.getElementById('add-queue-btn').addEventListener('click', function () {
  var url = document.getElementById('url-input').value.trim();
  if (!url) return; addToQueue(url); document.getElementById('url-input').value = '';
});

/* ═══════════════════════════════════
   Watch history
═══════════════════════════════════ */
function renderHistory() {
  var list  = document.getElementById('history-list');
  var empty = document.getElementById('history-empty');
  list.innerHTML = '';
  if (!watchHistory.length) { empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  var reversed = watchHistory.slice().reverse();
  reversed.forEach(function (item) {
    var div = document.createElement('div');
    div.className = 'history-item';
    var badge = document.createElement('span');
    badge.className = 'history-badge queue-badge-' + item.type;
    badge.textContent = item.type === 'youtube' ? 'YT' : item.type === 'vimeo' ? 'VI' : 'MP4';
    var info = document.createElement('div');
    info.className = 'history-info';
    var titleEl = document.createElement('span');
    titleEl.className = 'history-title';
    titleEl.textContent = item.title || item.id;
    var timeEl = document.createElement('span');
    timeEl.className = 'history-time';
    timeEl.textContent = item.addedAt ? new Date(item.addedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    info.appendChild(titleEl); info.appendChild(timeEl);
    var playBtn = document.createElement('button');
    playBtn.className = 'history-play'; playBtn.title = 'Play again'; playBtn.textContent = '▶';
    (function (it) {
      playBtn.addEventListener('click', function () {
        socket.emit('video-load', { videoId: it.id, videoType: it.type, title: it.title });
        loadMedia(it.id, it.type, false);
      });
    })(item);
    div.appendChild(badge); div.appendChild(info); div.appendChild(playBtn);
    list.appendChild(div);
  });
}

socket.on('history-update', function (d) { watchHistory = d.history; renderHistory(); });

/* ═══════════════════════════════════
   Webcam PiP
═══════════════════════════════════ */
function buildCamPeer(initiator) {
  if (camPeer) { try { camPeer.destroy(); } catch (_) {} camPeer = null; }
  camPeer = new SimplePeer({
    initiator: initiator, stream: camStream || undefined, trickle: true,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] }
  });
  camPeer.on('signal', function (d) { socket.emit('cam-signal', d); });
  camPeer.on('stream', function (s) {
    var vid = document.getElementById('remote-cam');
    vid.srcObject = s; vid.play().catch(function () {});
    toast('Partner\'s camera connected ♡');
  });
  camPeer.on('error',  function () { stopCam(); });
  camPeer.on('close',  function () { camPeer = null; document.getElementById('remote-cam').srcObject = null; });
}

async function startCam() {
  if (!currentRoom) { toast('Join a room first'); return; }
  try { camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
  catch (_) { toast('Camera access denied'); return; }
  var lv = document.getElementById('local-cam');
  lv.srcObject = camStream; lv.play().catch(function () {});
  camOn = true;
  document.getElementById('cam-btn').classList.add('active');
  document.getElementById('webcam-pip').classList.add('active');
  if (partnerUp) { socket.emit('cam-start'); setTimeout(function () { buildCamPeer(true); }, 400); }
}

function stopCam() {
  if (camPeer)   { try { camPeer.destroy(); }  catch (_) {} camPeer = null; }
  if (camStream) { camStream.getTracks().forEach(function (t) { t.stop(); }); camStream = null; }
  document.getElementById('remote-cam').srcObject = null;
  document.getElementById('local-cam').srcObject  = null;
  camOn = false;
  document.getElementById('cam-btn').classList.remove('active');
  document.getElementById('webcam-pip').classList.remove('active');
  socket.emit('cam-stop');
}

document.getElementById('cam-btn').addEventListener('click', function () {
  camOn ? stopCam() : startCam();
});
document.getElementById('cam-close-btn').addEventListener('click', stopCam);

socket.on('cam-start', async function () {
  if (!camStream) {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      camOn = true;
      document.getElementById('cam-btn').classList.add('active');
      var lv = document.getElementById('local-cam'); lv.srcObject = camStream; lv.play().catch(function () {});
      document.getElementById('webcam-pip').classList.add('active');
    } catch (_) { toast('Camera access denied'); }
  }
  buildCamPeer(false);
});

socket.on('cam-signal', async function (d) {
  if (camPeer) { camPeer.signal(d); return; }
  if (!camStream) {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      camOn = true;
      document.getElementById('cam-btn').classList.add('active');
      var lv = document.getElementById('local-cam'); lv.srcObject = camStream; lv.play().catch(function () {});
      document.getElementById('webcam-pip').classList.add('active');
    } catch (_) { toast('Camera access denied'); return; }
  }
  buildCamPeer(false); camPeer.signal(d);
});

socket.on('cam-stop', function () {
  if (camPeer) { try { camPeer.destroy(); } catch (_) {} camPeer = null; }
  document.getElementById('remote-cam').srcObject = null;
  toast('Partner stopped their camera');
});

/* Draggable webcam pip */
(function () {
  var pip     = document.getElementById('webcam-pip');
  var handle  = document.getElementById('cam-drag-handle');
  var ox = 0, oy = 0, dragging = false;

  handle.addEventListener('mousedown', function (e) {
    if (e.target.closest('.cam-close-btn')) return;
    dragging = true; pip.classList.add('dragging');
    ox = e.clientX - pip.getBoundingClientRect().left;
    oy = e.clientY - pip.getBoundingClientRect().top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    pip.style.left = (e.clientX - ox) + 'px'; pip.style.top = (e.clientY - oy) + 'px';
    pip.style.right = 'auto'; pip.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', function () { dragging = false; pip.classList.remove('dragging'); });
})();

/* ── Join from ?room= ── */
var roomToJoin = new URLSearchParams(window.location.search).get('room');
if (roomToJoin) {
  isJoinMode = true;
  document.querySelector('.landing-symbol').textContent = '◇';
  document.querySelector('.landing-title').textContent  = 'You\'re invited';
  document.querySelector('.landing-sub').textContent    = 'Enter your name and join the room.';
  document.querySelector('.landing-hint').textContent   = '';
  document.querySelector('.landing-divider').style.display = 'none';
  document.getElementById('room-name-input').style.display = 'none';
  var joinBtn = document.getElementById('create-btn');
  joinBtn.innerHTML = 'Join Room <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  joinBtn.disabled = false;
  show('landing');

  function tryJoin() {
    socket.off('connect', tryJoin); // prevent double-fire if button clicked while connecting
    if (currentRoom) return;        // already joined
    myName = document.getElementById('display-name-input').value.trim() || myName || 'Partner';
    localStorage.setItem('together_name', myName);
    joinBtn.disabled = true;
    joinBtn.innerHTML = 'Joining…';

    function doJoin() {
      socket.emit('join-room', { roomId: roomToJoin, name: myName }, function (res) {
        joinBtn.disabled = false;
        joinBtn.innerHTML = 'Join Room <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        if (!res || res.error) {
          document.getElementById('room-name-error').style.display = 'block';
          document.getElementById('room-name-error').textContent = (res && res.error) || 'Room not found — the link may have expired.';
          return;
        }
        enterRoom(roomToJoin, res.videoId, res.videoType, res.state, res.partnerOnline, res.queue || [], res.notes || '', res.subtitles || [], res.partnerName, res.history || []);
      });
    }
    if (socket.connected) doJoin(); else { socket.once('connect', doJoin); socket.connect(); }
  }

  joinBtn.addEventListener('click', tryJoin);

  /* Auto-join for returning users who already have a name saved */
  if (myName) {
    if (socket.connected) tryJoin(); else socket.once('connect', tryJoin);
  }
}
