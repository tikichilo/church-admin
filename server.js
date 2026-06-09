/**
 * server.js — Makeni Central SDA Church
 * Node.js + Express + MongoDB (Mongoose)
 */

'use strict';

const express   = require('express');
const mongoose  = require('mongoose');
const cors      = require('cors');
const path      = require('path');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const cron      = require('node-cron');
require('dotenv').config();

const JWT_SECRET  = process.env.JWT_SECRET  || 'change-this-secret-in-production';
const INVITE_CODE = (process.env.INVITE_CODE || 'MAKENI-2025').toUpperCase();

const app  = express();
const PORT = process.env.PORT || 3000;


/* ═══════════════════════════════════════════════
   MIDDLEWARE
═══════════════════════════════════════════════ */
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});


/* ═══════════════════════════════════════════════
   MONGODB CONNECTION
═══════════════════════════════════════════════ */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✦ MongoDB connected'))
  .catch(err => { console.error('MongoDB connection error:', err); process.exit(1); });


/* ═══════════════════════════════════════════════
   AUTH — User Model & Middleware
═══════════════════════════════════════════════ */

const userSchema = new mongoose.Schema({
  name:       { type: String, required: true, maxlength: 100 },
  email:      { type: String, required: true, unique: true, lowercase: true },
  password:   { type: String, required: true },
  role:       { type: String, default: 'admin', enum: ['admin', 'superadmin'] },
  blocked:    { type: Boolean, default: false },
  lastSeen:   { type: Date,   default: null },
  lastAction: { type: String, default: null },
  createdAt:  { type: Date,   default: Date.now },
});
const User = mongoose.model('User', userSchema);

// Middleware: verify JWT only (public-ish routes)
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized — please sign in' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired — please sign in again' });
  }
}


/* ═══════════════════════════════════════════════
   AUTH ROUTES
═══════════════════════════════════════════════ */

// POST /api/auth/signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password, inviteCode } = req.body;
    if (!name || !email || !password || !inviteCode) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if ((inviteCode || '').toUpperCase() !== INVITE_CODE) {
      return res.status(403).json({ error: 'Invalid invite code' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) return res.status(409).json({ error: 'An account with this email already exists' });

    const hash = await bcrypt.hash(password, 12);
    const userCount = await User.countDocuments();
    const role = userCount === 0 ? 'superadmin' : 'admin';
    await User.create({ name: name.slice(0, 100), email, password: hash, role });
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('POST /api/auth/signup:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.blocked) return res.status(403).json({ error: 'Your account has been suspended' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    const token = jwt.sign(
      { id: user._id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    // Record last seen on login
    User.findByIdAndUpdate(user._id, { lastSeen: new Date(), lastAction: 'LOGIN' }).catch(() => {});

    res.json({ token, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    console.error('POST /api/auth/login:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me — verify token + return id so superadmin can identify itself
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role });
});


/* ═══════════════════════════════════════════════
   SCHEMAS & MODELS
═══════════════════════════════════════════════ */

const donationSchema = new mongoose.Schema({
  amount:    { type: Number, required: true, min: 1 },
  currency:  { type: String, default: 'ZMW' },
  createdAt: { type: Date,   default: Date.now },
});
const Donation = mongoose.model('Donation', donationSchema);

const fundSchema = new mongoose.Schema({
  raised:  { type: Number, default: 0 },
  goal:    { type: Number, default: 500000 },
  donors:  { type: Number, default: 0 },
});
const Fund = mongoose.model('Fund', fundSchema);

const discussionSchema = new mongoose.Schema({
  name:      { type: String, required: true, maxlength: 100 },
  category:  { type: String, required: true, maxlength: 60  },
  title:     { type: String, required: true, maxlength: 100 },
  body:      { type: String, required: true, maxlength: 1000 },
  likes:     { type: Number, default: 0 },
  comments:  { type: Number, default: 0 },
  createdAt: { type: Date,   default: Date.now },
});
const Discussion = mongoose.model('Discussion', discussionSchema);

const lessonSchema = new mongoose.Schema({
  title:     { type: String, required: true, maxlength: 100 },
  verse:     { type: String, default: '',    maxlength: 200 },
  body:      { type: String, required: true, maxlength: 1000 },
  url:       { type: String, default: '' },
  updatedAt: { type: Date,   default: Date.now },
});
const Lesson = mongoose.model('Lesson', lessonSchema);

const themeSchema = new mongoose.Schema({
  heading:   { type: String, required: true, maxlength: 60 },
  ref:       { type: String, default: '',    maxlength: 40 },
  body:      { type: String, default: '',    maxlength: 300 },
  updatedAt: { type: Date,   default: Date.now },
});
const Theme = mongoose.model('Theme', themeSchema);

const announcementSchema = new mongoose.Schema({
  text:      { type: String, required: true, maxlength: 200 },
  expiresAt: { type: Date,   default: null },
  createdAt: { type: Date,   default: Date.now },
});
const Announcement = mongoose.model('Announcement', announcementSchema);

const storySchema = new mongoose.Schema({
  title:     { type: String, required: true, maxlength: 100 },
  tag:       { type: String, default: '',    maxlength: 60 },
  ageGroup:  { type: String, default: 'All Ages' },
  preview:   { type: String, default: '',    maxlength: 200 },
  body:      { type: String, required: true, maxlength: 3000 },
  imageUrl:  { type: String, default: '' },
  featured:  { type: Boolean, default: false },
  createdAt: { type: Date,   default: Date.now },
});
const Story = mongoose.model('Story', storySchema);


/* ═══════════════════════════════════════════════
   ROUTES — PUBLIC
═══════════════════════════════════════════════ */

app.post('/api/donate', async (req, res) => {
  try {
    const { amount, currency } = req.body;
    if (!amount || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const donation = await Donation.create({ amount: Number(amount), currency: currency || 'ZMW' });
    await Fund.findOneAndUpdate({}, { $inc: { raised: Number(amount), donors: 1 } }, { upsert: true, new: true });
    res.status(201).json({ success: true, id: donation._id });
  } catch (err) {
    console.error('POST /api/donate:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/fund', async (req, res) => {
  try {
    let fund = await Fund.findOne();
    if (!fund) fund = await Fund.create({ raised: 0, goal: 500000, donors: 0 });
    res.json({ raised: fund.raised, goal: fund.goal, donors: fund.donors });
  } catch (err) {
    console.error('GET /api/fund:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/discussions', async (req, res) => {
  try {
    const { category } = req.query;
    const filter = category && category !== 'all' ? { category } : {};
    const discussions = await Discussion.find(filter).sort({ createdAt: -1 }).lean();
    res.json(discussions);
  } catch (err) {
    console.error('GET /api/discussions:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/discussions', async (req, res) => {
  try {
    const { name, category, title, body } = req.body;
    if (!name || !category || !title || !body) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    const discussion = await Discussion.create({
      name: name.slice(0, 100), category: category.slice(0, 60),
      title: title.slice(0, 100), body: body.slice(0, 1000),
    });
    res.status(201).json({ success: true, id: discussion._id });
  } catch (err) {
    console.error('POST /api/discussions:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/discussions/:id/like', async (req, res) => {
  try {
    const discussion = await Discussion.findByIdAndUpdate(req.params.id, { $inc: { likes: 1 } }, { new: true });
    if (!discussion) return res.status(404).json({ error: 'Not found' });
    res.json({ likes: discussion.likes });
  } catch (err) {
    console.error('POST /api/discussions/:id/like:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/lesson', async (req, res) => {
  try {
    const lesson = await Lesson.findOne().sort({ updatedAt: -1 }).lean();
    const theme  = await Theme.findOne().sort({ updatedAt: -1 }).lean();
    if (!lesson) return res.json(null);
    res.json({ ...lesson, theme: theme || null });
  } catch (err) {
    console.error('GET /api/lesson:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/theme', async (req, res) => {
  try {
    const theme = await Theme.findOne().sort({ updatedAt: -1 }).lean();
    res.json(theme || null);
  } catch (err) {
    console.error('GET /api/theme:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/announcements', async (req, res) => {
  try {
    const now = new Date();
    const announcements = await Announcement
      .find({ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] })
      .sort({ createdAt: -1 }).lean();
    res.json(announcements);
  } catch (err) {
    console.error('GET /api/announcements:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/stories', async (req, res) => {
  try {
    const stories = await Story.find().sort({ featured: -1, createdAt: -1 }).lean();
    res.json(stories);
  } catch (err) {
    console.error('GET /api/stories:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


/* ═══════════════════════════════════════════════
   AUDIT LOG — Schema & helper
═══════════════════════════════════════════════ */

const auditSchema = new mongoose.Schema({
  adminId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  adminName:  { type: String, required: true },
  adminEmail: { type: String, required: true },
  action:     { type: String, required: true, maxlength: 80 },
  details:    { type: mongoose.Schema.Types.Mixed, default: {} },
  ip:         { type: String, default: '' },
  createdAt:  { type: Date,   default: Date.now },
});
const AuditLog = mongoose.model('AuditLog', auditSchema);

async function audit(req, action, details = {}) {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || req.socket?.remoteAddress || 'unknown';
    await AuditLog.create({
      adminId:    req.user.id,
      adminName:  req.user.name,
      adminEmail: req.user.email,
      action, details, ip,
    });
  } catch (e) {
    console.warn('audit() failed:', e.message);
  }
}


/* ═══════════════════════════════════════════════
   STRICT AUTH MIDDLEWARE
   Checks DB for blocked status + records lastSeen
═══════════════════════════════════════════════ */

async function requireAuthStrict(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized — please sign in' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.id).select('blocked role name email').lean();
    if (!user)        return res.status(401).json({ error: 'Account not found' });
    if (user.blocked) return res.status(403).json({ error: 'Your account has been suspended' });
    req.user = { ...decoded, role: user.role }; // always use DB role, not stale JWT
    // Track last seen + last action (fire-and-forget)
    const action = `${req.method} ${req.path}`;
    User.findByIdAndUpdate(decoded.id, { lastSeen: new Date(), lastAction: action }).catch(() => {});
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired — please sign in again' });
  }
}

// Apply strict auth to all admin write routes
app.use([
  '/api/audit',
  '/api/donations',
  '/api/fund/goal',
  '/api/lesson',
  '/api/theme',
  '/api/announcements',
  '/api/stories',
], (req, res, next) => {
  if (['POST','PUT','PATCH','DELETE'].includes(req.method)) {
    return requireAuthStrict(req, res, next);
  }
  next();
});


/* ═══════════════════════════════════════════════
   ROUTES — ADMIN
═══════════════════════════════════════════════ */

app.post('/api/audit', requireAuth, async (req, res) => {
  try {
    const { action, details } = req.body;
    if (!action) return res.status(400).json({ error: 'action required' });
    await audit(req, action.toUpperCase().slice(0, 80), details || {});
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/audit:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/donations', requireAuth, async (req, res) => {
  try {
    const donations = await Donation.find().sort({ createdAt: -1 }).lean();
    res.json(donations);
  } catch (err) {
    console.error('GET /api/donations:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/discussions/:id', requireAuth, async (req, res) => {
  try {
    const discussion = await Discussion.findByIdAndDelete(req.params.id);
    if (!discussion) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/discussions/:id:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/fund/goal', requireAuth, async (req, res) => {
  try {
    const { goal } = req.body;
    if (!goal || isNaN(goal) || Number(goal) <= 0) {
      return res.status(400).json({ error: 'Invalid goal amount' });
    }
    const fund = await Fund.findOneAndUpdate({}, { $set: { goal: Number(goal) } }, { upsert: true, new: true });
    res.json({ success: true, goal: fund.goal });
  } catch (err) {
    console.error('POST /api/fund/goal:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/lesson', requireAuth, async (req, res) => {
  try {
    const { title, verse, body, url } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Title and body required' });
    await Lesson.deleteMany({});
    await Lesson.create({ title: title.slice(0,100), verse: (verse||'').slice(0,200), body: body.slice(0,1000), url: url||'' });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/lesson:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/theme', requireAuth, async (req, res) => {
  try {
    const { heading, ref, body } = req.body;
    if (!heading) return res.status(400).json({ error: 'Heading required' });
    await Theme.deleteMany({});
    await Theme.create({ heading: heading.slice(0,60), ref: (ref||'').slice(0,40), body: (body||'').slice(0,300) });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/theme:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/announcements', requireAuth, async (req, res) => {
  try {
    const { text, expiresAt } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });
    const ann = await Announcement.create({ text: text.slice(0,200), expiresAt: expiresAt ? new Date(expiresAt) : null });
    res.status(201).json({ success: true, id: ann._id });
  } catch (err) {
    console.error('POST /api/announcements:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/announcements/:id', requireAuth, async (req, res) => {
  try {
    const ann = await Announcement.findByIdAndDelete(req.params.id);
    if (!ann) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/announcements/:id:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/stories', requireAuth, async (req, res) => {
  try {
    const { title, tag, ageGroup, preview, body, imageUrl, featured } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'Title and body required' });
    if (featured) await Story.updateMany({ featured: true }, { featured: false });
    const story = await Story.create({
      title: title.slice(0,100), tag: (tag||'').slice(0,60), ageGroup: ageGroup||'All Ages',
      preview: (preview||'').slice(0,200), body: body.slice(0,3000), imageUrl: imageUrl||'', featured: !!featured,
    });
    res.status(201).json({ success: true, id: story._id });
  } catch (err) {
    console.error('POST /api/stories:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/stories/:id/feature', requireAuth, async (req, res) => {
  try {
    await Story.updateMany({ featured: true }, { featured: false });
    const story = await Story.findByIdAndUpdate(req.params.id, { featured: true }, { new: true });
    if (!story) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/stories/:id/feature:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/stories/:id', requireAuth, async (req, res) => {
  try {
    const story = await Story.findByIdAndDelete(req.params.id);
    if (!story) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/stories/:id:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


/* ═══════════════════════════════════════════════
   SUPER ADMIN MIDDLEWARE
   ✦ FIX: always checks DB for role + blocked status
     so stale JWTs can never bypass access control
═══════════════════════════════════════════════ */

async function requireSuperAdmin(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Always hit the DB — never trust the role baked into the JWT
    const user = await User.findById(decoded.id).select('role blocked name email').lean();
    if (!user)              return res.status(401).json({ error: 'Account not found' });
    if (user.blocked)       return res.status(403).json({ error: 'Your account has been suspended' });
    if (user.role !== 'superadmin') return res.status(403).json({ error: 'Super admin access required' });
    req.user = { ...decoded, role: user.role, name: user.name, email: user.email };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired' });
  }
}


/* ═══════════════════════════════════════════════
   ROUTES — SUPER ADMIN
═══════════════════════════════════════════════ */

app.get('/api/superadmin/admins', requireSuperAdmin, async (req, res) => {
  try {
    const admins = await User.find({}, '-password').sort({ createdAt: -1 }).lean();

    // Pull last activity from audit log
    const ids = admins.map(a => a._id);
    const auditActivity = await AuditLog.aggregate([
      { $match: { adminId: { $in: ids } } },
      { $sort:  { createdAt: -1 } },
      { $group: { _id: '$adminId', lastAction: { $first: '$action' }, lastSeen: { $first: '$createdAt' } } },
    ]);
    const seenMap = {};
    auditActivity.forEach(l => { seenMap[l._id.toString()] = l; });

    const result = admins.map(a => ({
      ...a,
      lastSeen:   seenMap[a._id.toString()]?.lastSeen   || a.lastSeen   || null,
      lastAction: seenMap[a._id.toString()]?.lastAction || a.lastAction || null,
    }));

    res.json(result);
  } catch (err) {
    console.error('GET /api/superadmin/admins:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/superadmin/admins/:id/block', requireSuperAdmin, async (req, res) => {
  try {
    const { blocked } = req.body;
    if (String(req.params.id) === String(req.user.id)) {
      return res.status(400).json({ error: "You can't block yourself" });
    }
    const user = await User.findByIdAndUpdate(
      req.params.id, { $set: { blocked: !!blocked } }, { new: true, select: '-password' }
    );
    if (!user) return res.status(404).json({ error: 'Admin not found' });
    await audit(req, blocked ? 'BLOCK_ADMIN' : 'UNBLOCK_ADMIN', {
      targetId: user._id, targetName: user.name, targetEmail: user.email,
    });
    res.json({ success: true, blocked: user.blocked });
  } catch (err) {
    console.error('POST /api/superadmin/admins/:id/block:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/superadmin/admins/:id', requireSuperAdmin, async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user.id)) {
      return res.status(400).json({ error: "You can't delete your own account" });
    }
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'Admin not found' });
    await audit(req, 'DELETE_ADMIN', { targetName: user.name, targetEmail: user.email });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/superadmin/admins/:id:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/superadmin/admins/:id/role', requireSuperAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['admin', 'superadmin'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    const user = await User.findByIdAndUpdate(
      req.params.id, { $set: { role } }, { new: true, select: '-password' }
    );
    if (!user) return res.status(404).json({ error: 'Admin not found' });
    await audit(req, 'CHANGE_ROLE', { targetName: user.name, newRole: role });
    res.json({ success: true, role: user.role });
  } catch (err) {
    console.error('POST /api/superadmin/admins/:id/role:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/superadmin/audit', requireSuperAdmin, async (req, res) => {
  try {
    const page    = Math.max(1, parseInt(req.query.page)  || 1);
    const limit   = Math.min(100, parseInt(req.query.limit) || 50);
    const adminId = req.query.adminId || null;
    const action  = req.query.action  || null;

    const filter = {};
    if (adminId) filter.adminId = adminId;
    if (action)  filter.action  = action;

    const [logs, total] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      AuditLog.countDocuments(filter),
    ]);
    res.json({ logs, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('GET /api/superadmin/audit:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/superadmin/db-stats', requireSuperAdmin, async (req, res) => {
  try {
    const [discussions, lessons, themes, announcements, stories, donations, auditLogs, admins] =
      await Promise.all([
        Discussion.countDocuments(), Lesson.countDocuments(), Theme.countDocuments(),
        Announcement.countDocuments(), Story.countDocuments(), Donation.countDocuments(),
        AuditLog.countDocuments(), User.countDocuments(),
      ]);
    res.json({ discussions, lessons, themes, announcements, stories, donations, auditLogs, admins });
  } catch (err) {
    console.error('GET /api/superadmin/db-stats:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

const CLEARABLE = {
  discussions:   () => Discussion.deleteMany({}),
  lessons:       () => Lesson.deleteMany({}),
  themes:        () => Theme.deleteMany({}),
  announcements: () => Announcement.deleteMany({}),
  stories:       () => Story.deleteMany({}),
  donations:     () => Donation.deleteMany({}),
  auditlogs:     () => AuditLog.deleteMany({}),
};

app.delete('/api/superadmin/db/:collection', requireSuperAdmin, async (req, res) => {
  try {
    const key = req.params.collection.toLowerCase();
    if (!CLEARABLE[key]) {
      return res.status(400).json({ error: 'Unknown or protected collection' });
    }
    const olderThanDays = parseInt(req.query.olderThan) || 0;
    let result;
    if (olderThanDays > 0 && key !== 'lessons' && key !== 'themes') {
      const cutoff = new Date(Date.now() - olderThanDays * 86400000);
      const Model = { discussions: Discussion, announcements: Announcement, stories: Story, donations: Donation, auditlogs: AuditLog }[key];
      result = Model ? await Model.deleteMany({ createdAt: { $lt: cutoff } }) : await CLEARABLE[key]();
    } else {
      result = await CLEARABLE[key]();
    }
    await audit(req, 'CLEAR_COLLECTION', { collection: key, deleted: result.deletedCount, olderThanDays: olderThanDays || 'all' });
    res.json({ success: true, deleted: result.deletedCount });
  } catch (err) {
    console.error('DELETE /api/superadmin/db/:collection:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


/* ═══════════════════════════════════════════════
   CRON JOBS
═══════════════════════════════════════════════ */

// Every Thursday at midnight (UTC) — clear expired announcements + reset lesson & theme
cron.schedule('0 0 * * 4', async () => {
  try {
    const now = new Date();

    const annResult = await Announcement.deleteMany({
      expiresAt: { $ne: null, $lte: now },
    });
    const lessonResult = await Lesson.deleteMany({});
    const themeResult  = await Theme.deleteMany({});

    console.log(`[CRON] Thursday cleanup — removed ${annResult.deletedCount} announcement(s), cleared ${lessonResult.deletedCount} lesson(s) and ${themeResult.deletedCount} theme(s)`);
  } catch (err) {
    console.error('[CRON] Thursday cleanup failed:', err);
  }
});

// Every 30 minutes — ping self to prevent Render free-tier spin-down
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
cron.schedule('*/30 * * * *', async () => {
  try {
    const res = await fetch(`${SELF_URL}/api/fund`);
    console.log(`[CRON] Keep-alive ping → ${res.status}`);
  } catch (err) {
    console.error('[CRON] Keep-alive ping failed:', err);
  }
});


/* ═══════════════════════════════════════════════
   START
═══════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`\x1b[33m✦ Makeni Central SDA — server running on port ${PORT}\x1b[0m`);
});