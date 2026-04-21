const express  = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const path = require('path');
const fs   = require('fs');

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms    = new Map();
const ROOMS_FILE = path.join(__dirname, 'rooms.json');

/* ── Persistence ── */
function loadRooms() {
  try {
    const data  = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    const now   = Date.now();
    const limit = 30 * 24 * 60 * 60 * 1000; // 30 days
    for (const [id, r] of Object.entries(data)) {
      if (r.createdAt && now - r.createdAt > limit) continue;
      rooms.set(id, {
        users:     new Set(),
        videoId:   r.videoId   || null,
        videoType: r.videoType || null,
        state:     r.state     || { playing: false, time: 0 },
        queue:     r.queue     || [],
        notes:     r.notes     || '',
        subtitles: r.subtitles || [],
        history:   r.history   || [],
        createdAt: r.createdAt || now,
      });
    }
    console.log(`Loaded ${rooms.size} room(s) from disk`);
  } catch (_) {}
}

let saveTimer = null;
function roomSnapshot(room) {
  return {
    videoId:   room.videoId,
    videoType: room.videoType,
    state:     room.state,
    queue:     room.queue,
    notes:     room.notes,
    subtitles: room.subtitles,
    history:   room.history,
    createdAt: room.createdAt,
  };
}
function saveRooms() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const data = {};
    for (const [id, room] of rooms.entries()) data[id] = roomSnapshot(room);
    try { fs.writeFileSync(ROOMS_FILE, JSON.stringify(data, null, 2)); } catch (_) {}
  }, 2000);
}
function saveRoomsNow() {
  clearTimeout(saveTimer);
  const data = {};
  for (const [id, room] of rooms.entries()) data[id] = roomSnapshot(room);
  try { fs.writeFileSync(ROOMS_FILE, JSON.stringify(data, null, 2)); } catch (_) {}
}

loadRooms();

/* ── Graceful shutdown ── */
function shutdown(sig) {
  console.log(`\n${sig} received — saving rooms and exiting`);
  saveRoomsNow();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

/* ── Hourly room cleanup ── */
setInterval(() => {
  const now   = Date.now();
  const limit = 30 * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [id, room] of rooms.entries()) {
    const expired = room.createdAt && now - room.createdAt > limit;
    const stale   = room.users.size === 0 && !room.videoId && !room.queue.length && !room.notes;
    if (expired || stale) { rooms.delete(id); removed++; }
  }
  if (removed) { saveRooms(); console.log(`Cleaned up ${removed} stale room(s)`); }
}, 60 * 60 * 1000);

/* ── Routes ── */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ── Sockets ── */
io.on('connection', (socket) => {
  let currentRoom = null;
  let myName      = 'Partner';
  const chatTimes = [];   // timestamps of recent messages for rate-limiting

  socket.on('create-room', (options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }

    let roomId;
    if (options.customId) {
      roomId = options.customId.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      if (roomId.length < 3 || roomId.length > 30) return cb({ error: 'Name must be 3–30 characters' });
      if (rooms.has(roomId)) return cb({ error: 'That name is already taken' });
    } else {
      roomId = nanoid(8);
    }

    myName = options.name || 'Partner';
    rooms.set(roomId, {
      users:     new Set([socket.id]),
      videoId:   null,
      videoType: null,
      state:     { playing: false, time: 0 },
      queue:     [],
      notes:     '',
      subtitles: [],
      history:   [],
      hostName:  myName,
      createdAt: Date.now(),
    });
    socket.join(roomId);
    currentRoom = roomId;
    saveRooms();
    cb({ roomId });
  });

  socket.on('join-room', ({ roomId, name } = {}, cb) => {
    if (typeof roomId === 'string' && typeof name === 'function') {
      // legacy call: join-room(roomId, cb)
      cb = name; name = 'Partner'; // eslint-disable-line no-param-reassign
    }
    const room = rooms.get(roomId);
    if (!room) return cb({ error: 'Room not found' });
    myName = name || 'Partner';
    room.users.add(socket.id);
    socket.join(roomId);
    currentRoom = roomId;
    socket.to(roomId).emit('partner-joined', { name: myName });
    cb({
      success:       true,
      videoId:       room.videoId,
      videoType:     room.videoType,
      state:         room.state,
      partnerOnline: room.users.size > 1,
      queue:         room.queue,
      notes:         room.notes,
      subtitles:     room.subtitles,
      history:       room.history  || [],
      partnerName:   room.hostName || 'Partner',
    });
  });

  socket.on('set-name', (name) => { myName = String(name || 'Partner').trim().slice(0, 30); })

  /* ── Sync state on demand (used after reconnect) ── */
  socket.on('sync-state', (cb) => {
    if (typeof cb !== 'function') return;
    const room = rooms.get(currentRoom);
    if (!room) return cb(null);
    cb({ videoId: room.videoId, videoType: room.videoType, state: room.state });
  });;

  socket.on('video-load', ({ videoId, videoType, title }) => {
    const room = rooms.get(currentRoom);
    if (!room || !videoId) return;
    videoId = String(videoId).slice(0, 300);
    room.videoId   = videoId;
    room.videoType = videoType || 'youtube';
    room.state     = { playing: false, time: 0 };
    room.history   = room.history || [];
    room.history.push({ id: videoId, type: room.videoType, title: title || videoId, addedAt: Date.now() });
    if (room.history.length > 50) room.history.shift();
    io.to(currentRoom).emit('history-update', { history: room.history });
    socket.to(currentRoom).emit('video-load', { videoId, videoType: room.videoType });
    saveRooms();
  });

  socket.on('play', ({ time }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.state = { playing: true, time };
    socket.to(currentRoom).emit('play', { time });
  });

  socket.on('pause', ({ time }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.state = { playing: false, time };
    socket.to(currentRoom).emit('pause', { time });
    saveRooms();
  });

  socket.on('seek', ({ time }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.state.time = time;
    socket.to(currentRoom).emit('seek', { time });
  });

  socket.on('reaction', ({ emoji }) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('reaction', { emoji });
  });

  /* ── Queue ── */
  socket.on('queue-add', ({ item }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.queue.push(item);
    io.to(currentRoom).emit('queue-update', { queue: room.queue });
    saveRooms();
  });

  socket.on('queue-remove', ({ index }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.queue.splice(index, 1);
    io.to(currentRoom).emit('queue-update', { queue: room.queue });
    saveRooms();
  });

  socket.on('queue-play', ({ index }) => {
    const room = rooms.get(currentRoom);
    if (!room || !room.queue[index]) return;
    const item = room.queue[index];
    room.videoId   = item.id;
    room.videoType = item.type;
    room.state     = { playing: false, time: 0 };
    room.queue.forEach((q, i) => { q.current = i === index; });
    room.history   = room.history || [];
    room.history.push({ id: item.id, type: item.type, title: item.title || item.id, addedAt: Date.now() });
    if (room.history.length > 50) room.history.shift();
    io.to(currentRoom).emit('video-load', { videoId: item.id, videoType: item.type });
    io.to(currentRoom).emit('queue-update', { queue: room.queue });
    io.to(currentRoom).emit('history-update', { history: room.history });
    saveRooms();
  });

  socket.on('video-ended', () => {
    const room = rooms.get(currentRoom);
    if (!room || !room.queue.length) return;
    const idx  = room.queue.findIndex(q => q.current);
    const next = idx + 1;
    if (next < room.queue.length) {
      const item = room.queue[next];
      room.videoId   = item.id;
      room.videoType = item.type;
      room.state     = { playing: true, time: 0 };
      room.queue.forEach((q, i) => { q.current = i === next; });
      room.history   = room.history || [];
      room.history.push({ id: item.id, type: item.type, title: item.title || item.id, addedAt: Date.now() });
      if (room.history.length > 50) room.history.shift();
      io.to(currentRoom).emit('video-load', { videoId: item.id, videoType: item.type, autoplay: true });
      io.to(currentRoom).emit('queue-update', { queue: room.queue });
      io.to(currentRoom).emit('history-update', { history: room.history });
      saveRooms();
    }
  });

  /* ── Notes ── */
  socket.on('notes-update', ({ notes }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.notes = String(notes || '').slice(0, 10000);
    socket.to(currentRoom).emit('notes-update', { notes: room.notes });
    saveRooms();
  });

  /* ── Subtitles ── */
  socket.on('subtitle-load', ({ subtitles }) => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.subtitles = subtitles;
    socket.to(currentRoom).emit('subtitle-load', { subtitles });
    saveRooms();
  });

  socket.on('subtitle-clear', () => {
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.subtitles = [];
    socket.to(currentRoom).emit('subtitle-clear');
    saveRooms();
  });

  /* ── Drawing (relay only — not persisted) ── */
  socket.on('draw-start', (d) => socket.to(currentRoom).emit('draw-start', d));
  socket.on('draw-move',  (d) => socket.to(currentRoom).emit('draw-move',  d));
  socket.on('draw-end',   ()  => socket.to(currentRoom).emit('draw-end'));
  socket.on('draw-clear', ()  => socket.to(currentRoom).emit('draw-clear'));

  /* ── Chat ── */
  socket.on('chat', ({ text }) => {
    if (!currentRoom || !text) return;
    const msg = String(text).trim().slice(0, 500);
    if (!msg) return;
    // Rate limit: max 10 messages per 10 seconds
    const now    = Date.now();
    const recent = chatTimes.filter(t => now - t < 10000);
    if (recent.length >= 10) return;
    chatTimes.length = 0; chatTimes.push(...recent, now);
    socket.to(currentRoom).emit('chat', { text: msg, name: myName });
  });

  /* ── Typing ── */
  socket.on('typing-start', () => { if (currentRoom) socket.to(currentRoom).emit('typing-start', { name: myName }); });
  socket.on('typing-stop',  () => { if (currentRoom) socket.to(currentRoom).emit('typing-stop'); });

  /* ── Voice ── */
  socket.on('voice-start',  (d) => socket.to(currentRoom).emit('voice-start',  d));
  socket.on('voice-signal', (d) => socket.to(currentRoom).emit('voice-signal', d));
  socket.on('voice-stop',   ()  => socket.to(currentRoom).emit('voice-stop'));

  /* ── Webcam ── */
  socket.on('cam-start',  (d) => socket.to(currentRoom).emit('cam-start',  d));
  socket.on('cam-signal', (d) => socket.to(currentRoom).emit('cam-signal', d));
  socket.on('cam-stop',   ()  => socket.to(currentRoom).emit('cam-stop'));

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.users.delete(socket.id);
    if (room.users.size === 0) {
      // keep room on disk; only remove from memory if truly empty & no content
      if (!room.videoId && !room.queue.length && !room.notes) {
        rooms.delete(currentRoom);
        saveRooms();
      }
    } else {
      io.to(currentRoom).emit('partner-left');
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Together is running → http://localhost:${PORT}`);
});
