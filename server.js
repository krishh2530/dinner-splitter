const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ──────────────────────────────────────────────────────────
// DATA STORE  (simple JSON file — perfect for one dinner)
// ──────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) return freshDB();
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return freshDB(); }
}

function freshDB() {
  return {
    users: [],
    orders: [],
    participants: [],   // { orderId, userId, status: 'pending'|'accepted'|'declined' }
    notifications: [],  // { id, userId, orderId, type, isRead }
    billSettings: { cgst: 0, sgst: 0, serviceCharge: 0, discount: 0 },
    _seq: { users: 0, orders: 0, participants: 0, notifications: 0 }
  };
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function nextId(db, table) {
  db._seq[table] = (db._seq[table] || 0) + 1;
  return db._seq[table];
}

// ──────────────────────────────────────────────────────────
// SOCKET.IO — track online users
// ──────────────────────────────────────────────────────────
const onlineMap = new Map(); // userId -> socketId

io.on('connection', (socket) => {
  socket.on('auth', (userId) => {
    onlineMap.set(Number(userId), socket.id);
  });
  socket.on('disconnect', () => {
    for (const [uid, sid] of onlineMap.entries()) {
      if (sid === socket.id) { onlineMap.delete(uid); break; }
    }
  });
});

function emitTo(userId, event, data) {
  const sid = onlineMap.get(Number(userId));
  if (sid) io.to(sid).emit(event, data);
}

function getOwner(db) {
  return db.users.find(u => u.isOwner);
}

// ──────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────
function buildOrder(db, orderId) {
  const order = db.orders.find(o => o.id === orderId);
  if (!order) return null;
  const creator = db.users.find(u => u.id === order.createdBy);
  const parts = db.participants.filter(p => p.orderId === orderId).map(p => {
    const u = db.users.find(u => u.id === p.userId);
    return { userId: p.userId, name: u ? u.name : '?', status: p.status };
  });
  const acceptedCount = parts.filter(p => p.status === 'accepted').length;
  const share = acceptedCount > 0 ? order.price / acceptedCount : order.price;
  return {
    ...order,
    creatorName: creator ? creator.name : '?',
    participants: parts,
    acceptedCount,
    share
  };
}

// ──────────────────────────────────────────────────────────
// EXPRESS
// ──────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── LOGIN ──────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const db = loadDB();
  const clean = name.trim();
  let user = db.users.find(u => u.name.toLowerCase() === clean.toLowerCase());
  if (!user) {
    user = {
      id: nextId(db, 'users'),
      name: clean,
      isOwner: clean.toLowerCase() === 'krishna',
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
    saveDB(db);
  }
  res.json({ user });
});

// ── USERS ──────────────────────────────────────────────────
app.get('/api/users', (req, res) => {
  const db = loadDB();
  res.json(db.users.map(u => ({ id: u.id, name: u.name, isOwner: u.isOwner })));
});

app.delete('/api/users/:id', (req, res) => {
  const db = loadDB();
  const uid = Number(req.params.id);
  const user = db.users.find(u => u.id === uid);
  if (user?.isOwner) return res.status(403).json({ error: 'Cannot delete owner' });
  db.users = db.users.filter(u => u.id !== uid);
  db.notifications = db.notifications.filter(n => n.userId !== uid);
  db.participants = db.participants.filter(p => p.userId !== uid);
  saveDB(db);
  io.emit('user_deleted', { userId: uid });
  res.json({ success: true });
});

// ── ORDERS ────────────────────────────────────────────────
app.post('/api/orders', (req, res) => {
  const { dishName, price, orderType, createdBy, participantIds } = req.body;
  if (!dishName?.trim() || !price || !orderType || !createdBy) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const db = loadDB();
  const orderId = nextId(db, 'orders');
  const order = {
    id: orderId,
    dishName: dishName.trim(),
    price: parseFloat(price),
    orderType,
    createdBy,
    createdAt: new Date().toISOString()
  };
  db.orders.push(order);

  // Creator is always accepted
  db.participants.push({ orderId, userId: createdBy, status: 'accepted' });

  // Group: add others as pending
  if (orderType === 'group' && Array.isArray(participantIds)) {
    for (const uid of participantIds) {
      if (uid !== createdBy) {
        db.participants.push({ orderId, userId: uid, status: 'pending' });
        const notifId = nextId(db, 'notifications');
        db.notifications.push({ id: notifId, userId: uid, orderId, type: 'group_invitation', isRead: false, createdAt: new Date().toISOString() });
      }
    }
  }

  // Notify owner about new order
  const owner = getOwner(db);
  if (owner && owner.id !== createdBy) {
    const notifId = nextId(db, 'notifications');
    db.notifications.push({ id: notifId, userId: owner.id, orderId, type: 'new_order', isRead: false, createdAt: new Date().toISOString() });
  }

  saveDB(db);

  const full = buildOrder(db, orderId);

  // Real-time: notify invited participants
  if (orderType === 'group' && Array.isArray(participantIds)) {
    for (const uid of participantIds) {
      if (uid !== createdBy) emitTo(uid, 'group_invitation', full);
    }
  }
  // Notify owner
  if (owner) emitTo(owner.id, 'new_order', full);

  res.json({ order: full });
});

app.get('/api/orders/mine', (req, res) => {
  const uid = Number(req.query.userId);
  const db = loadDB();
  const myOrderIds = db.participants.filter(p => p.userId === uid).map(p => p.orderId);
  const unique = [...new Set(myOrderIds)];
  const orders = unique.map(id => buildOrder(db, id)).filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(orders);
});

app.get('/api/orders/all', (req, res) => {
  const db = loadDB();
  const orders = db.orders.map(o => buildOrder(db, o.id)).filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(orders);
});

app.post('/api/orders/:id/respond', (req, res) => {
  const orderId = Number(req.params.id);
  const { userId, response } = req.body;
  const db = loadDB();

  const part = db.participants.find(p => p.orderId === orderId && p.userId === userId);
  if (part) part.status = response;

  // Mark the notification read
  db.notifications.forEach(n => {
    if (n.orderId === orderId && n.userId === userId) n.isRead = true;
  });

  saveDB(db);

  const full = buildOrder(db, orderId);
  const user = db.users.find(u => u.id === userId);

  // Notify order creator
  if (full) {
    emitTo(full.createdBy, 'invitation_response', { orderId, userName: user?.name, response, order: full });
    const owner = getOwner(db);
    if (owner && owner.id !== full.createdBy) emitTo(owner.id, 'order_updated', full);
    else if (owner) emitTo(owner.id, 'order_updated', full);
  }

  res.json({ success: true, order: full });
});

app.delete('/api/orders/:id', (req, res) => {
  const orderId = Number(req.params.id);
  const db = loadDB();
  db.orders = db.orders.filter(o => o.id !== orderId);
  db.participants = db.participants.filter(p => p.orderId !== orderId);
  db.notifications = db.notifications.filter(n => n.orderId !== orderId);
  saveDB(db);
  io.emit('order_deleted', { orderId });
  res.json({ success: true });
});

// ── NOTIFICATIONS ─────────────────────────────────────────
app.get('/api/notifications', (req, res) => {
  const uid = Number(req.query.userId);
  const db = loadDB();
  const notifs = db.notifications
    .filter(n => n.userId === uid && !n.isRead)
    .map(n => {
      const order = buildOrder(db, n.orderId);
      return { ...n, order };
    })
    .filter(n => n.order)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(notifs);
});

app.get('/api/notifications/count', (req, res) => {
  const uid = Number(req.query.userId);
  const db = loadDB();
  const count = db.notifications.filter(n => n.userId === uid && !n.isRead).length;
  res.json({ count });
});

app.post('/api/notifications/read-all', (req, res) => {
  const uid = Number(req.body.userId);
  const db = loadDB();
  db.notifications.filter(n => n.userId === uid).forEach(n => n.isRead = true);
  saveDB(db);
  res.json({ success: true });
});

// ── BILL ──────────────────────────────────────────────────
app.get('/api/bill', (req, res) => {
  const db = loadDB();
  const s = db.billSettings;

  const userBreakdowns = db.users.map(user => {
    const myParts = db.participants.filter(p => p.userId === user.id && p.status === 'accepted');
    const orderLines = myParts.map(p => {
      const order = buildOrder(db, p.orderId);
      return order ? {
        orderId: order.id,
        dishName: order.dishName,
        totalPrice: order.price,
        orderType: order.orderType,
        participants: order.acceptedCount,
        share: order.share
      } : null;
    }).filter(Boolean);
    const base = orderLines.reduce((s, o) => s + o.share, 0);
    return { id: user.id, name: user.name, base, orders: orderLines };
  }).filter(u => u.orders.length > 0);

  const grandBase = userBreakdowns.reduce((s, u) => s + u.base, 0);

  const cgstAmt     = grandBase * s.cgst / 100;
  const sgstAmt     = grandBase * s.sgst / 100;
  const serviceAmt  = grandBase * s.serviceCharge / 100;
  const preTax      = grandBase + cgstAmt + sgstAmt + serviceAmt;
  const discountAmt = preTax * s.discount / 100;
  const finalTotal  = preTax - discountAmt;

  const users = userBreakdowns.map(u => ({
    ...u,
    finalShare: grandBase > 0 ? (u.base / grandBase) * finalTotal : 0
  }));

  res.json({ settings: s, grandBase, cgstAmt, sgstAmt, serviceAmt, preTax, discountAmt, finalTotal, users });
});

app.put('/api/bill/settings', (req, res) => {
  const db = loadDB();
  db.billSettings = {
    cgst:          parseFloat(req.body.cgst)          || 0,
    sgst:          parseFloat(req.body.sgst)          || 0,
    serviceCharge: parseFloat(req.body.serviceCharge) || 0,
    discount:      parseFloat(req.body.discount)      || 0
  };
  saveDB(db);
  res.json({ success: true });
});

// ── RESET ─────────────────────────────────────────────────
app.post('/api/reset', (req, res) => {
  fs.writeFileSync(DB_PATH, JSON.stringify(freshDB(), null, 2));
  io.emit('reset');
  res.json({ success: true });
});

// ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🍽️  DinnerTab is live → http://localhost:${PORT}`);
  console.log('   Owner login name: krishna\n');
});
