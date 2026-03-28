require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { supabase } = require('./config/supabase');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

// ── Middleware ──
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── API routes FIRST ──
app.use('/api', require('./routes/index'));
app.get('/api/health', (_, res) => res.json({ status: 'ok', timestamp: new Date() }));

// ── Static files — media served from Cloudinary CDN, not local disk ──
// Only serve the frontend app itself
app.use(express.static(path.join(__dirname, '../frontend')));

// ── SPA fallback ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ── Helper: safe supabase update (no .catch chaining) ──
const safeUpdate = async (table, data, column, value) => {
  try {
    await supabase.from(table).update(data).eq(column, value);
  } catch (e) {
    // silently ignore — don't crash the server
  }
};

// ═══════════════ SOCKET.IO ═══════════════
const onlineUsers = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Auth required'));
  try {
    const d = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = d.userId;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', async (socket) => {
  const uid = socket.userId;
  onlineUsers.set(uid, socket.id);

  await safeUpdate('users', { is_online: true }, 'id', uid);
  io.emit('user:online', { userId: uid, online: true });
  socket.join('user:' + uid);

  socket.on('message:send', async ({ receiverId, content, message_type, media_url, font_style }) => {
    try {
      // Build insert — try with font_style first, fall back without it
      const insertData = {
        sender_id: uid,
        receiver_id: receiverId,
        content,
        message_type: message_type || 'text',
        media_url: media_url || null,
        font_style: font_style || 'default'
      };
      let msgResult = await supabase
        .from('messages')
        .insert(insertData)
        .select('*, sender:users!messages_sender_id_fkey(id,name,avatar_url)')
        .single();
      // If font_style column doesn't exist, retry without it
      if (msgResult.error && msgResult.error.message && msgResult.error.message.includes('font_style')) {
        delete insertData.font_style;
        msgResult = await supabase
          .from('messages')
          .insert(insertData)
          .select('*, sender:users!messages_sender_id_fkey(id,name,avatar_url)')
          .single();
      }
      if (msgResult.error) throw msgResult.error;
      const msg = { ...msgResult.data, font_style: font_style || 'default' };
      io.to('user:' + receiverId).emit('message:new', msg);
      socket.emit('message:new', msg);
      try {
        const { data: sender } = await supabase.from('users').select('name').eq('id', uid).single();
        io.to('user:' + receiverId).emit('notification:new', {
          type: 'message',
          from: sender?.name,
          content: (content || '').substring(0, 60)
        });
      } catch (_) {}
    } catch (err) {
      socket.emit('error', { message: 'Message failed' });
    }
  });

  socket.on('typing:start', ({ receiverId }) => {
    io.to('user:' + receiverId).emit('typing:start', { userId: uid });
  });
  socket.on('typing:stop', ({ receiverId }) => {
    io.to('user:' + receiverId).emit('typing:stop', { userId: uid });
  });

  socket.on('post:new',    (post) => io.emit('post:new', post));
  socket.on('comment:new', (data) => io.emit('comment:new', data));

  socket.on('group:join', (gid) => socket.join('group:' + gid));
  socket.on('group:message', ({ groupId, content }) => {
    io.to('group:' + groupId).emit('group:message', {
      groupId, senderId: uid, content, timestamp: new Date()
    });
  });

  socket.on('disconnect', async () => {
    onlineUsers.delete(uid);
    await safeUpdate('users', { is_online: false }, 'id', uid);
    io.emit('user:online', { userId: uid, online: false });
  });
});

// ── Error handler ──
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 100MB)' });
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal error' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n✦ Vibe Social running at http://localhost:' + PORT);
  console.log('   Supabase: ' + (process.env.SUPABASE_URL ? '✅ Connected' : '❌ Not configured'));
  console.log('   Socket.io: ✅ Ready\n');
});