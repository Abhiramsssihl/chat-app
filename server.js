const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory store (replace with DB in production) ─────────────────────────
const users = {};        // { socketId: { id, name, avatar, status, socketId } }
const usersByUserId = {}; // { userId: userData }
const friendRequests = {}; // { toUserId: [{from, time}] }
const friends = {};      // { userId: Set<userId> }
const messages = {};     // { roomId: [{id,from,to,text,time}] }

function getRoomId(a, b) {
  return [a, b].sort().join('__');
}

function getUserData(userId) {
  return usersByUserId[userId] || null;
}

function getPublicUser(u) {
  return { id: u.id, name: u.name, avatar: u.avatar, status: u.status, online: !!u.socketId };
}

// ─── REST: search users ───────────────────────────────────────────────────────
app.get('/api/users/search', (req, res) => {
  const q = (req.query.q || '').toLowerCase().replace(/^@/, '');
  if (!q) return res.json([]);
  const results = Object.values(usersByUserId)
    .filter(u => u.name.toLowerCase().includes(q) || u.id.toLowerCase().includes(q))
    .map(getPublicUser)
    .slice(0, 20);
  res.json(results);
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  // ── Register / Login ──────────────────────────────────────────────────────
  socket.on('register', ({ name, avatar, status }, cb) => {
    const userId = 'u_' + uuidv4().slice(0, 8);
    const userData = { id: userId, name: name || 'User', avatar: avatar || '', status: status || 'Hey there!', socketId: socket.id };
    users[socket.id] = userData;
    usersByUserId[userId] = userData;
    friends[userId] = new Set();
    friendRequests[userId] = [];
    socket.userId = userId;
    console.log(`Registered: ${name} (${userId})`);
    cb({ success: true, user: getPublicUser(userData) });
    io.emit('user_online', { userId, online: true });
  });

  socket.on('login', ({ userId }, cb) => {
    const userData = usersByUserId[userId];
    if (!userData) return cb({ success: false, error: 'User not found' });
    userData.socketId = socket.id;
    users[socket.id] = userData;
    socket.userId = userId;
    cb({ success: true, user: getPublicUser(userData) });
    io.emit('user_online', { userId, online: true });

    // Send pending requests
    const pending = (friendRequests[userId] || []).map(r => ({
      ...r,
      fromUser: getPublicUser(getUserData(r.from))
    }));
    if (pending.length) socket.emit('pending_requests', pending);
  });

  // ── Update profile ────────────────────────────────────────────────────────
  socket.on('update_profile', ({ name, avatar, status }, cb) => {
    const u = users[socket.id];
    if (!u) return cb && cb({ success: false });
    if (name) u.name = name;
    if (avatar) u.avatar = avatar;
    if (status !== undefined) u.status = status;
    cb && cb({ success: true, user: getPublicUser(u) });
    // Notify friends
    const myFriends = friends[u.id] || new Set();
    myFriends.forEach(fid => {
      const f = usersByUserId[fid];
      if (f && f.socketId) io.to(f.socketId).emit('contact_updated', getPublicUser(u));
    });
  });

  // ── Get friends list ──────────────────────────────────────────────────────
  socket.on('get_friends', (_, cb) => {
    const u = users[socket.id];
    if (!u) return cb([]);
    const list = [...(friends[u.id] || [])].map(id => getPublicUser(getUserData(id))).filter(Boolean);
    cb(list);
  });

  // ── Send friend request ───────────────────────────────────────────────────
  socket.on('send_request', ({ toUserId }, cb) => {
    const from = users[socket.id];
    if (!from) return cb({ success: false, error: 'Not registered' });
    if (from.id === toUserId) return cb({ success: false, error: 'Cannot add yourself' });
    if ((friends[from.id] || new Set()).has(toUserId)) return cb({ success: false, error: 'Already friends' });
    if (!usersByUserId[toUserId]) return cb({ success: false, error: 'User not found' });

    if (!friendRequests[toUserId]) friendRequests[toUserId] = [];
    const already = friendRequests[toUserId].find(r => r.from === from.id);
    if (already) return cb({ success: false, error: 'Request already sent' });

    const req = { from: from.id, time: new Date() };
    friendRequests[toUserId].push(req);

    // Notify recipient if online
    const toUser = usersByUserId[toUserId];
    if (toUser && toUser.socketId) {
      io.to(toUser.socketId).emit('friend_request', { ...req, fromUser: getPublicUser(from) });
    }
    cb({ success: true });
  });

  // ── Accept/decline request ────────────────────────────────────────────────
  socket.on('accept_request', ({ fromUserId }, cb) => {
    const me = users[socket.id];
    if (!me) return cb({ success: false });
    friendRequests[me.id] = (friendRequests[me.id] || []).filter(r => r.from !== fromUserId);

    if (!friends[me.id]) friends[me.id] = new Set();
    if (!friends[fromUserId]) friends[fromUserId] = new Set();
    friends[me.id].add(fromUserId);
    friends[fromUserId].add(me.id);

    // Notify sender
    const sender = usersByUserId[fromUserId];
    if (sender && sender.socketId) {
      io.to(sender.socketId).emit('request_accepted', { byUser: getPublicUser(me) });
    }
    cb({ success: true, user: sender ? getPublicUser(sender) : null });
  });

  socket.on('decline_request', ({ fromUserId }, cb) => {
    const me = users[socket.id];
    if (!me) return cb({ success: false });
    friendRequests[me.id] = (friendRequests[me.id] || []).filter(r => r.from !== fromUserId);
    cb({ success: true });
  });

  // ── Get chat history ──────────────────────────────────────────────────────
  socket.on('get_messages', ({ withUserId }, cb) => {
    const me = users[socket.id];
    if (!me) return cb([]);
    const roomId = getRoomId(me.id, withUserId);
    cb(messages[roomId] || []);
  });

  // ── Send message ──────────────────────────────────────────────────────────
  socket.on('send_message', ({ toUserId, text }, cb) => {
    const me = users[socket.id];
    if (!me || !text.trim()) return cb && cb({ success: false });

    const msg = { id: uuidv4(), from: me.id, to: toUserId, text: text.trim(), time: new Date(), read: false };
    const roomId = getRoomId(me.id, toUserId);
    if (!messages[roomId]) messages[roomId] = [];
    messages[roomId].push(msg);

    // Deliver to recipient
    const toUser = usersByUserId[toUserId];
    if (toUser && toUser.socketId) {
      io.to(toUser.socketId).emit('new_message', msg);
    }
    cb && cb({ success: true, message: msg });
  });

  // ── Typing indicator ──────────────────────────────────────────────────────
  socket.on('typing', ({ toUserId, isTyping }) => {
    const me = users[socket.id];
    if (!me) return;
    const toUser = usersByUserId[toUserId];
    if (toUser && toUser.socketId) {
      io.to(toUser.socketId).emit('typing', { fromUserId: me.id, isTyping });
    }
  });

  // ── Mark messages read ────────────────────────────────────────────────────
  socket.on('mark_read', ({ fromUserId }) => {
    const me = users[socket.id];
    if (!me) return;
    const roomId = getRoomId(me.id, fromUserId);
    if (messages[roomId]) {
      messages[roomId].forEach(m => { if (m.to === me.id) m.read = true; });
    }
    const sender = usersByUserId[fromUserId];
    if (sender && sender.socketId) {
      io.to(sender.socketId).emit('messages_read', { byUserId: me.id });
    }
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const u = users[socket.id];
    if (u) {
      u.socketId = null;
      delete users[socket.id];
      io.emit('user_online', { userId: u.id, online: false });
      console.log(`Disconnected: ${u.name} (${u.id})`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n🚀 ChatApp running at http://localhost:${PORT}\n`));
