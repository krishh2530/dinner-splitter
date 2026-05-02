const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const crypto     = require('crypto');
const path       = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const PORT           = process.env.PORT || 3000;
const MONGO_URI      = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/dinnertab';
const OWNER_PASSWORD = 'FinalHangout';
const SUPER_OWNER    = 'krishna';

// ── DB CONNECTION ──────────────────────────────────────────
let dbReady = false;

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 30000,
  heartbeatFrequencyMS:     10000,
  maxPoolSize:              5,
})
.then(() => { dbReady = true; console.log('✅ MongoDB connected'); })
.catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

mongoose.connection.on('connected',   () => { dbReady = true;  console.log('✅ MongoDB ready'); });
mongoose.connection.on('disconnected',() => { dbReady = false; console.log('⚠️  MongoDB disconnected'); });
mongoose.connection.on('reconnected', () => { dbReady = true;  console.log('✅ MongoDB reconnected'); });

function requireDB(req, res, next) {
  if (!dbReady) return res.status(503).json({ error: 'Database connecting — wait a moment and try again.' });
  next();
}

// ── SCHEMAS ────────────────────────────────────────────────
const User = mongoose.model('User', new mongoose.Schema({
  name:         { type: String, required: true, unique: true },
  isOwner:      { type: Boolean, default: false },
  isSuperOwner: { type: Boolean, default: false },
  sessionToken: { type: String, default: null },
  createdAt:    { type: Date,   default: Date.now }
}));

const Order = mongoose.model('Order', new mongoose.Schema({
  dishName:  { type: String, required: true },
  price:     { type: Number, required: true },
  orderType: { type: String, enum: ['solo','group'], required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
}));

const Participant = mongoose.model('Participant', new mongoose.Schema({
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true },
  userId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User',  required: true },
  status:  { type: String, enum: ['pending','accepted','declined'], default: 'pending' }
}));

const Notification = mongoose.model('Notification', new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  orderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  type:      { type: String },
  isRead:    { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
}));

const BillSettings = mongoose.model('BillSettings', new mongoose.Schema({
  _id:           { type: String, default: 'singleton' },
  cgst:          { type: Number, default: 0 },
  sgst:          { type: Number, default: 0 },
  serviceCharge: { type: Number, default: 0 },
  discount:      { type: Number, default: 0 }
}));

// ── SOCKET.IO ──────────────────────────────────────────────
const onlineMap = new Map();
io.on('connection', socket => {
  socket.on('auth', uid => { if (uid) onlineMap.set(String(uid), socket.id); });
  socket.on('disconnect', () => {
    for (const [uid, sid] of onlineMap) {
      if (sid === socket.id) { onlineMap.delete(uid); break; }
    }
  });
});
function emitTo(userId, event, data) {
  const sid = onlineMap.get(String(userId));
  if (sid) io.to(sid).emit(event, data);
}

// ── HELPER ─────────────────────────────────────────────────
async function buildOrder(order) {
  if (!order) return null;
  const creator = await User.findById(order.createdBy).catch(() => null);
  const parts   = await Participant.find({ orderId: order._id });
  const users   = await User.find({ _id: { $in: parts.map(p => p.userId) } });
  const uMap    = Object.fromEntries(users.map(u => [String(u._id), u.name]));
  const list    = parts.map(p => ({ userId: String(p.userId), name: uMap[String(p.userId)] || '?', status: p.status }));
  const accepted = list.filter(p => p.status === 'accepted');
  return {
    id: String(order._id), dishName: order.dishName, price: order.price,
    orderType: order.orderType, createdBy: String(order.createdBy),
    createdAt: order.createdAt, creatorName: creator?.name || '?',
    participants: list, acceptedCount: accepted.length,
    share: accepted.length > 0 ? order.price / accepted.length : order.price
  };
}
const genToken = () => crypto.randomBytes(24).toString('hex');

// ── ROUTES ─────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true, db: dbReady }));

// LOGIN
app.post('/api/login', requireDB, async (req, res) => {
  try {
    const { name, password, sessionToken } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
    const cleanName   = name.trim();
    const isKrishna   = cleanName.toLowerCase() === SUPER_OWNER;
    const ownerAccess = password === OWNER_PASSWORD || isKrishna;

    let user = await User.findOne({ name: new RegExp('^' + cleanName + '$', 'i') });

    if (user) {
      if (ownerAccess) {
        user.isOwner = true; user.isSuperOwner = isKrishna;
        user.sessionToken = genToken();
        await user.save();
      } else {
        if (user.sessionToken && user.sessionToken !== sessionToken) {
          return res.status(403).json({ error: '"' + cleanName + '" is already taken. Pick a different name!' });
        }
      }
    } else {
      user = await User.create({ name: cleanName, isOwner: ownerAccess, isSuperOwner: isKrishna, sessionToken: genToken() });
    }

    res.json({
      user: { id: String(user._id), name: user.name, isOwner: user.isOwner, isSuperOwner: user.isSuperOwner },
      sessionToken: user.sessionToken
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// USERS
app.get('/api/users', requireDB, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: 1 });
    res.json(users.map(u => ({ id: String(u._id), name: u.name, isOwner: u.isOwner, isSuperOwner: u.isSuperOwner })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', requireDB, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.isSuperOwner) return res.status(403).json({ error: 'Cannot delete super owner' });
    await Notification.deleteMany({ userId: user._id });
    await Participant.deleteMany({ userId: user._id });
    await User.deleteOne({ _id: user._id });
    io.emit('user_deleted', { userId: String(user._id) });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ORDERS
app.post('/api/orders', requireDB, async (req, res) => {
  try {
    const { dishName, price, orderType, createdBy, participantIds } = req.body;
    if (!dishName?.trim() || !price || !orderType || !createdBy)
      return res.status(400).json({ error: 'Missing fields' });
    const order = await Order.create({ dishName: dishName.trim(), price: parseFloat(price), orderType, createdBy });
    await Participant.create({ orderId: order._id, userId: createdBy, status: 'accepted' });
    if (orderType === 'group' && Array.isArray(participantIds)) {
      for (const uid of participantIds) {
        if (String(uid) !== String(createdBy)) {
          await Participant.create({ orderId: order._id, userId: uid, status: 'pending' });
          await Notification.create({ userId: uid, orderId: order._id, type: 'group_invitation' });
        }
      }
    }
    const owners = await User.find({ isOwner: true });
    for (const o of owners) {
      if (String(o._id) !== String(createdBy))
        await Notification.create({ userId: o._id, orderId: order._id, type: 'new_order' });
    }
    const full = await buildOrder(order);
    if (orderType === 'group' && Array.isArray(participantIds))
      for (const uid of participantIds)
        if (String(uid) !== String(createdBy)) emitTo(uid, 'group_invitation', full);
    for (const o of owners)
      if (String(o._id) !== String(createdBy)) emitTo(o._id, 'new_order', full);
    res.json({ order: full });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/mine', requireDB, async (req, res) => {
  try {
    const parts  = await Participant.find({ userId: req.query.userId });
    const ids    = [...new Set(parts.map(p => String(p.orderId)))];
    const orders = await Order.find({ _id: { $in: ids } }).sort({ createdAt: -1 });
    res.json((await Promise.all(orders.map(buildOrder))).filter(Boolean));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orders/all', requireDB, async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 });
    res.json((await Promise.all(orders.map(buildOrder))).filter(Boolean));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/orders/:id/respond', requireDB, async (req, res) => {
  try {
    const { userId, response } = req.body;
    await Participant.updateOne({ orderId: req.params.id, userId }, { status: response });
    await Notification.updateMany({ orderId: req.params.id, userId }, { isRead: true });
    const order = await Order.findById(req.params.id);
    const full  = await buildOrder(order);
    const user  = await User.findById(userId);
    if (full) {
      emitTo(full.createdBy, 'invitation_response', { orderId: full.id, userName: user?.name, response, order: full });
      const owners = await User.find({ isOwner: true });
      for (const o of owners) emitTo(o._id, 'order_updated', full);
    }
    res.json({ success: true, order: full });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/orders/:id', requireDB, async (req, res) => {
  try {
    await Order.deleteOne({ _id: req.params.id });
    await Participant.deleteMany({ orderId: req.params.id });
    await Notification.deleteMany({ orderId: req.params.id });
    io.emit('order_deleted', { orderId: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// NOTIFICATIONS
app.get('/api/notifications', requireDB, async (req, res) => {
  try {
    const notifs = await Notification.find({ userId: req.query.userId, isRead: false }).sort({ createdAt: -1 });
    const result = (await Promise.all(notifs.map(async n => {
      const full = await buildOrder(await Order.findById(n.orderId));
      return { id: String(n._id), type: n.type, createdAt: n.createdAt, order: full };
    }))).filter(n => n.order);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/notifications/count', requireDB, async (req, res) => {
  try {
    res.json({ count: await Notification.countDocuments({ userId: req.query.userId, isRead: false }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/notifications/read-all', requireDB, async (req, res) => {
  try {
    await Notification.updateMany({ userId: req.body.userId }, { isRead: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// BILL
app.get('/api/bill', requireDB, async (req, res) => {
  try {
    let s = await BillSettings.findById('singleton') || { cgst:0, sgst:0, serviceCharge:0, discount:0 };
    const users = await User.find();
    const breakdown = await Promise.all(users.map(async user => {
      const parts = await Participant.find({ userId: user._id, status: 'accepted' });
      const lines = (await Promise.all(parts.map(async p => {
        const o = await Order.findById(p.orderId);
        if (!o) return null;
        const acc = await Participant.countDocuments({ orderId: o._id, status: 'accepted' });
        return { orderId: String(o._id), dishName: o.dishName, totalPrice: o.price, orderType: o.orderType, participants: acc, share: acc > 0 ? o.price/acc : o.price };
      }))).filter(Boolean);
      return { id: String(user._id), name: user.name, base: lines.reduce((s,o)=>s+o.share,0), orders: lines };
    }));
    const active      = breakdown.filter(u => u.orders.length > 0);
    const grandBase   = active.reduce((s,u)=>s+u.base,0);
    const cgstAmt     = grandBase * s.cgst / 100;
    const sgstAmt     = grandBase * s.sgst / 100;
    const serviceAmt  = grandBase * s.serviceCharge / 100;
    const preTax      = grandBase + cgstAmt + sgstAmt + serviceAmt;
    const discountAmt = preTax * s.discount / 100;
    const finalTotal  = preTax - discountAmt;
    res.json({
      settings: { cgst: s.cgst, sgst: s.sgst, serviceCharge: s.serviceCharge, discount: s.discount },
      grandBase, cgstAmt, sgstAmt, serviceAmt, preTax, discountAmt, finalTotal,
      users: active.map(u => ({ ...u, finalShare: grandBase > 0 ? (u.base/grandBase)*finalTotal : 0 }))
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/bill/settings', requireDB, async (req, res) => {
  try {
    await BillSettings.findByIdAndUpdate('singleton',
      { cgst:+req.body.cgst||0, sgst:+req.body.sgst||0, serviceCharge:+req.body.serviceCharge||0, discount:+req.body.discount||0 },
      { upsert: true });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// RESET
app.post('/api/reset', requireDB, async (req, res) => {
  try {
    await Promise.all([User.deleteMany({}), Order.deleteMany({}), Participant.deleteMany({}), Notification.deleteMany({}), BillSettings.deleteMany({})]);
    io.emit('reset');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// START
server.listen(PORT, () => console.log(`\n🍽️  DinnerTab → http://localhost:${PORT}\n`));
