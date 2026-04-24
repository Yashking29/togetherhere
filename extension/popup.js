'use strict';

const SUPPORTED = [
  'netflix.com', 'primevideo.com', 'amazon.com',
  'disneyplus.com', 'hotstar.com', 'hulu.com'
];

let mode     = 'create'; // 'create' | 'join'
let activeTab = null;

/* ── Helpers ── */
function sendToContent(msg) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(activeTab.id, msg, res => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
}

function isSupportedSite(url) {
  try { return SUPPORTED.some(s => new URL(url).hostname.includes(s)); }
  catch(_) { return false; }
}

function extractRoomId(val) {
  val = val.trim();
  try {
    const u = new URL(val);
    const r = u.searchParams.get('room');
    if (r) return r;
  } catch(_) {}
  return val;
}

/* ── UI ── */
function showSetup() {
  document.getElementById('setup-view').style.display = 'flex';
  document.getElementById('room-view').style.display  = 'none';
}

function showRoom(roomId, partnerOnline, partnerName) {
  document.getElementById('setup-view').style.display = 'none';
  document.getElementById('room-view').style.display  = 'flex';
  document.getElementById('room-id-text').textContent = 'Room: ' + roomId;
  updatePartner(partnerOnline, partnerName);
}

function updatePartner(online, name) {
  const dot  = document.getElementById('partner-dot');
  const text = document.getElementById('partner-status');
  dot.className  = 'dot' + (online ? ' online' : '');
  text.textContent = online ? (name || 'Partner') + ' is here ♡' : 'Waiting for partner…';
}

/* ── Init ── */
chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  activeTab = tab;
  const supported = isSupportedSite(tab.url || '');

  document.getElementById('warn-site').style.display = supported ? 'none' : 'block';
  document.getElementById('setup-view').style.display = supported ? 'flex' : 'none';

  if (!supported) return;

  // Restore saved name
  chrome.storage.local.get(['tg_name', 'tg_room'], data => {
    if (data.tg_name) document.getElementById('name-input').value = data.tg_name;
    if (data.tg_room) {
      // Check if still active
      sendToContent({ action: 'status' }).then(res => {
        if (res && res.roomId) showRoom(res.roomId, false, null);
      });
    }
  });
});

/* ── Mode toggle ── */
document.getElementById('btn-create-mode').addEventListener('click', () => {
  mode = 'create';
  document.getElementById('btn-create-mode').classList.add('active');
  document.getElementById('btn-join-mode').classList.remove('active');
  document.getElementById('join-row').style.display = 'none';
  document.getElementById('start-btn').textContent = 'Start Party ♡';
});

document.getElementById('btn-join-mode').addEventListener('click', () => {
  mode = 'join';
  document.getElementById('btn-join-mode').classList.add('active');
  document.getElementById('btn-create-mode').classList.remove('active');
  document.getElementById('join-row').style.display = 'block';
  document.getElementById('start-btn').textContent = 'Join Party ♡';
});

/* ── Start ── */
document.getElementById('start-btn').addEventListener('click', async () => {
  const btn  = document.getElementById('start-btn');
  const name = document.getElementById('name-input').value.trim() || 'Partner';
  chrome.storage.local.set({ tg_name: name });

  btn.disabled    = true;
  btn.textContent = 'Connecting…';

  let res;
  if (mode === 'create') {
    res = await sendToContent({ action: 'create', name });
  } else {
    const raw    = document.getElementById('room-input').value;
    const roomId = extractRoomId(raw);
    if (!roomId) { btn.disabled = false; btn.textContent = 'Join Party ♡'; return; }
    res = await sendToContent({ action: 'join', name, roomId });
  }

  btn.disabled    = false;
  btn.textContent = mode === 'create' ? 'Start Party ♡' : 'Join Party ♡';

  if (res && res.ok) {
    // Poll for room ID
    let attempts = 0;
    const poll = setInterval(async () => {
      const s = await sendToContent({ action: 'status' });
      if (s && s.roomId) {
        clearInterval(poll);
        chrome.storage.local.set({ tg_room: s.roomId });
        showRoom(s.roomId, false, null);
      }
      if (++attempts > 15) clearInterval(poll);
    }, 500);
  }
});

/* ── Copy link ── */
document.getElementById('copy-btn').addEventListener('click', async () => {
  const s = await sendToContent({ action: 'status' });
  if (!s || !s.roomId) return;
  // Use current tab URL so partner lands on same video
  const base = activeTab.url.split('?')[0];
  const url  = base + '?together_room=' + s.roomId;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copy-btn');
    btn.textContent = '✓ Copied! ♡';
    setTimeout(() => { btn.textContent = '🔗 Copy Invite Link'; }, 2000);
  });
});

/* ── Leave ── */
document.getElementById('leave-btn').addEventListener('click', async () => {
  await sendToContent({ action: 'leave' });
  chrome.storage.local.remove(['tg_room']);
  showSetup();
});
