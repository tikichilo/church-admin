/**
 * server.js — Makeni Central SDA Church — ADMIN SERVER
 * Node.js + Express + MongoDB (Mongoose)
 *
 * This is the authenticated admin backend: login/signup, JWT auth,
 * audit logging, and superadmin controls, plus the write-side routes
 * for content the public site displays (announcements, lesson/theme,
 * events, recaps). Public GET routes are included so the admin
 * dashboard (and, if pointed here, the public site) can read data;
 * all write methods (POST/PUT/PATCH/DELETE) on admin-managed
 * collections require a valid, non-blocked admin/superadmin JWT.
 *
 * Story model and all kids-page-related content/routes have been
 * removed — kids.html no longer has a backend-driven "stories" feed.
 */

'use strict';

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const multer     = require('multer');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const cron       = require('node-cron');
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
   UPLOADS (event posters + recap gallery images)
   Stored under <root>/uploads/... so express.static above serves
   them directly at /uploads/events/<file> and /uploads/recaps/<file>.
   Non-image files and anything over 5MB are rejected before they
   touch disk.
═══════════════════════════════════════════════ */
const UPLOAD_ROOT      = path.join(__dirname, 'uploads');
const EVENT_UPLOAD_DIR = path.join(UPLOAD_ROOT, 'events');
const RECAP_UPLOAD_DIR = path.join(UPLOAD_ROOT, 'recaps');
[EVENT_UPLOAD_DIR, RECAP_UPLOAD_DIR].forEach(dir => fs.mkdirSync(dir, { recursive: true }));

const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const IMAGE_FILTER_ERROR = 'Only JPG, PNG, and WEBP images are allowed';

function makeStorage(dir) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
      cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
    },
  });
}

function imageFileFilter(req, file, cb) {
  if (!IMAGE_MIME_TYPES.includes(file.mimetype)) {
    return cb(new Error(IMAGE_FILTER_ERROR));
  }
  cb(null, true);
}

const uploadEventPoster = multer({
  storage: makeStorage(EVENT_UPLOAD_DIR),
  fileFilter: imageFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const uploadRecapImages = multer({
  storage: makeStorage(RECAP_UPLOAD_DIR),
  fileFilter: imageFileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 10 }, // 5MB each, 10 max
});

// Best-effort file deletion — never throws, just logs if it fails
function deleteUploadedFile(publicUrl) {
  if (!publicUrl) return;
  const filePath = path.join(__dirname, publicUrl);
  fs.unlink(filePath, err => {
    if (err && err.code !== 'ENOENT') {
      console.warn('Could not delete uploaded file:', filePath, err.message);
    }
  });
}


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

const passwordResetSchema = new mongoose.Schema({
  userId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  token:     { type: String, required: true },
  expiresAt: { type: Date,   required: true },
  used:      { type: Boolean, default: false },
});
const PasswordReset = mongoose.model('PasswordReset', passwordResetSchema);

// Nodemailer transporter (Gmail SMTP)
// Requires GMAIL_USER and GMAIL_PASS (16-char App Password) in .env
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

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

    User.findByIdAndUpdate(user._id, { lastSeen: new Date(), lastAction: 'LOGIN' }).catch(() => {});

    res.json({ token, name: user.name, email: user.email, role: user.role });
  } catch (err) {
    console.error('POST /api/auth/login:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role });
});

// POST /api/auth/forgot-password
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const user = await User.findOne({ email: email.toLowerCase().trim() });

    // Always respond 200 — don't reveal whether the email exists
    if (!user) return res.json({ success: true });

    // Invalidate any existing unused tokens for this user
    await PasswordReset.deleteMany({ userId: user._id });

    const rawToken    = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

    await PasswordReset.create({
      userId:    user._id,
      token:     hashedToken,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
    });

    const BASE_URL = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
    const resetUrl = `${BASE_URL}/reset-password.html?token=${rawToken}`;

    await mailer.sendMail({
      from:    `"Makeni Central SDA Admin" <${process.env.GMAIL_USER}>`,
      to:      user.email,
      subject: 'Reset your admin password',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px 24px;background:#fff;border-radius:12px;border:1px solid #e2e2e2">
          <div style="text-align:center;margin-bottom:24px">
            <div style="width:48px;height:48px;border-radius:50%;background:#041534;display:inline-flex;align-items:center;justify-content:center;font-family:Georgia,serif;font-size:20px;color:#e6c364;font-weight:700">M</div>
            <h2 style="margin:12px 0 4px;color:#041534;font-size:18px">Makeni Central SDA</h2>
            <p style="color:#777;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin:0">Admin Portal</p>
          </div>
          <p style="color:#1a1c1c;font-size:15px">Hi <strong>${user.name}</strong>,</p>
          <p style="color:#45464e;font-size:14px;line-height:1.6">
            We received a request to reset your password. Click the button below to choose a new one.
            This link will expire in <strong>1 hour</strong>.
          </p>
          <div style="text-align:center;margin:28px 0">
            <a href="${resetUrl}" style="background:#041534;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;display:inline-block">
              Reset Password
            </a>
          </div>
          <p style="color:#888;font-size:12px;line-height:1.6">
            If you didn't request this, you can safely ignore this email — your password will remain unchanged.
          </p>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
          <p style="color:#aaa;font-size:11px;text-align:center">Makeni Central SDA Church Admin Portal</p>
        </div>
      `,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/auth/forgot-password:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/reset-password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
    if (password.length < 8)  return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const resetRecord = await PasswordReset.findOne({
      token:     hashedToken,
      used:      false,
      expiresAt: { $gt: new Date() },
    });

    if (!resetRecord) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired' });
    }

    const hash = await bcrypt.hash(password, 12);
    await User.findByIdAndUpdate(resetRecord.userId, { password: hash });
    await PasswordReset.findByIdAndUpdate(resetRecord._id, { used: true });

    res.json({ success: true });
  } catch (err) {
    console.error('POST /api/auth/reset-password:', err);
    res.status(500).json({ error: 'Server error' });
  }
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

// ── Announcement — now matches the public site's fields ──
const ANNOUNCEMENT_REACTION_KEYS = ['amen', 'love', 'praise'];

const announcementSchema = new mongoose.Schema({
  text:      { type: String, required: true, maxlength: 200 },
  title:     { type: String, default: '',        maxlength: 100 },
  category:  { type: String, default: 'general', maxlength: 40, lowercase: true, trim: true },
  expiresAt: { type: Date,   default: null },
  reactions: {
    amen:   { type: Number, default: 0, min: 0 },
    love:   { type: Number, default: 0, min: 0 },
    praise: { type: Number, default: 0, min: 0 },
  },
  createdAt: { type: Date,   default: Date.now },
});
const Announcement = mongoose.model('Announcement', announcementSchema);

// ── Visit — "Plan Your Visit" modal submissions ──
const visitSchema = new mongoose.Schema({
  date:      { type: Date,   required: true },
  service:   { type: String, required: true, maxlength: 60  }, // e.g. "Divine Service"
  time:      { type: String, default: '',    maxlength: 60  }, // e.g. "11:00 AM"
  name:      { type: String, default: '',    maxlength: 100 },
  needs:     { type: [String], default: [] },                  // e.g. ["prayer","welcome"]
  createdAt: { type: Date,   default: Date.now },
});
const Visit = mongoose.model('Visit', visitSchema);

// Allowed values, kept in sync with the service buttons / checkboxes in index.html
const VISIT_SERVICES = ['Sabbath School', 'Divine Service', 'Bible Study', 'Full Day'];
const VISIT_NEEDS     = ['prayer', 'welcome', 'kids', 'transport'];

// ── Event — Upcoming Events + Featured Event on news.html ──
const eventSchema = new mongoose.Schema({
  title:     { type: String,  required: true, maxlength: 120 },
  posterUrl: { type: String,  default: '' },                  // /uploads/events/<file>
  date:      { type: Date,    required: true },
  time:      { type: String,  default: '',    maxlength: 60  }, // e.g. "09:00 AM – 04:00 PM"
  location:  { type: String,  default: '',    maxlength: 150 },
  info:      { type: String,  default: '',    maxlength: 1000 },
  featured:  { type: Boolean, default: false },                 // only one should be true at a time
  createdAt: { type: Date,    default: Date.now },
});
const Event = mongoose.model('Event', eventSchema);

// ── Recap — Event Recaps gallery on news.html ──
const recapSchema = new mongoose.Schema({
  title:       { type: String, required: true, maxlength: 120 },
  description: { type: String, default: '',    maxlength: 1000 },
  images: {
    type: [String],   // /uploads/recaps/<file>, up to 10
    default: [],
    validate: {
      validator: arr => arr.length > 0 && arr.length <= 10,
      message: 'A recap needs between 1 and 10 images',
    },
  },
  createdAt: { type: Date, default: Date.now },
});
const Recap = mongoose.model('Recap', recapSchema);


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

// POST /api/announcements/:id/react — public reaction toggle. No user
// accounts exist for visitors, so this trusts the client's `active`
// flag (the frontend tracks each visitor's own toggle in localStorage
// and just tells the server whether to add or remove one).
app.post('/api/announcements/:id/react', async (req, res) => {
  try {
    const { reaction, active } = req.body;
    if (!ANNOUNCEMENT_REACTION_KEYS.includes(reaction)) {
      return res.status(400).json({ error: 'Invalid reaction type' });
    }
    const delta = active ? 1 : -1;
    let ann = await Announcement.findByIdAndUpdate(
      req.params.id,
      { $inc: { [`reactions.${reaction}`]: delta } },
      { new: true }
    );
    if (!ann) return res.status(404).json({ error: 'Not found' });

    // Guard against the count dipping below 0 (e.g. a stale toggle from
    // a second tab).
    if (ann.reactions[reaction] < 0) {
      ann.reactions[reaction] = 0;
      await ann.save();
    }
    res.json({ success: true, reactions: ann.reactions });
  } catch (err) {
    console.error('POST /api/announcements/:id/react:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/visits — saves a "Plan Your Visit" submission. Public/unauthenticated:
// the people filling out this modal on the public site aren't logged in.
app.post('/api/visits', async (req, res) => {
  try {
    const { date, service, time, name, needs } = req.body;

    if (!date || !service) {
      return res.status(400).json({ error: 'Date and service are required' });
    }

    const parsedDate = new Date(date);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date' });
    }

    if (!VISIT_SERVICES.includes(service)) {
      return res.status(400).json({ error: 'Invalid service' });
    }

    // Drop any need values that aren't in our known list, just in case
    const cleanNeeds = Array.isArray(needs)
      ? needs.filter(n => VISIT_NEEDS.includes(n))
      : [];

    const visit = await Visit.create({
      date:    parsedDate,
      service,
      time:    (time || '').slice(0, 60),
      name:    (name || '').slice(0, 100),
      needs:   cleanNeeds,
    });

    res.status(201).json({ success: true, id: visit._id });
  } catch (err) {
    console.error('POST /api/visits:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/events — upcoming events only, soonest first
app.get('/api/events', async (req, res) => {
  try {
    const now = new Date();
    const events = await Event.find({ date: { $gte: now } }).sort({ date: 1 }).lean();
    res.json(events);
  } catch (err) {
    console.error('GET /api/events:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/events/featured — the single event currently marked featured
app.get('/api/events/featured', async (req, res) => {
  try {
    const event = await Event
      .findOne({ featured: true, date: { $gte: new Date() } })
      .sort({ date: 1 })
      .lean();
    res.json(event || null);
  } catch (err) {
    console.error('GET /api/events/featured:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/recaps — newest recap galleries first
app.get('/api/recaps', async (req, res) => {
  try {
    const recaps = await Recap.find().sort({ createdAt: -1 }).lean();
    res.json(recaps);
  } catch (err) {
    console.error('GET /api/recaps:', err);
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
    req.user = { ...decoded, role: user.role };
    const action = `${req.method} ${req.path}`;
    User.findByIdAndUpdate(decoded.id, { lastSeen: new Date(), lastAction: action }).catch(() => {});
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired — please sign in again' });
  }
}

// Apply strict auth to all admin write routes.
// GET requests on these paths pass through (public reads); anything
// that mutates data (POST/PUT/PATCH/DELETE) requires a valid,
// non-blocked admin/superadmin JWT.
app.use([
  '/api/audit',
  '/api/donations',
  '/api/fund/goal',
  '/api/lesson',
  '/api/theme',
  '/api/announcements',
  '/api/events',
  '/api/recaps',
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

// GET /api/visits — admin-only list of planned visits, soonest upcoming first.
// Optional ?upcoming=true filters out past dates.
app.get('/api/visits', requireAuth, async (req, res) => {
  try {
    const { upcoming } = req.query;
    const filter = upcoming === 'true'
      ? { date: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }
      : {};

    const visits = await Visit.find(filter).sort({ date: 1 }).lean();
    res.json(visits);
  } catch (err) {
    console.error('GET /api/visits:', err);
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
    const { text, title, category, expiresAt } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });
    const ann = await Announcement.create({
      text:      text.slice(0, 200),
      title:     (title || '').slice(0, 100),
      category:  (category || 'general').slice(0, 40).toLowerCase(),
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });
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

// POST /api/events — multipart/form-data: fields + a single `poster` file.
// Poster is optional; requireAuth is applied via the blanket app.use above.
app.post('/api/events', uploadEventPoster.single('poster'), async (req, res) => {
  try {
    const { title, date, time, location, info } = req.body;

    if (!title || !date) {
      if (req.file) deleteUploadedFile(`/uploads/events/${req.file.filename}`);
      return res.status(400).json({ error: 'Title and date are required' });
    }

    const parsedDate = new Date(date);
    if (isNaN(parsedDate.getTime())) {
      if (req.file) deleteUploadedFile(`/uploads/events/${req.file.filename}`);
      return res.status(400).json({ error: 'Invalid date' });
    }

    const event = await Event.create({
      title:     title.slice(0, 120),
      posterUrl: req.file ? `/uploads/events/${req.file.filename}` : '',
      date:      parsedDate,
      time:      (time || '').slice(0, 60),
      location:  (location || '').slice(0, 150),
      info:      (info || '').slice(0, 1000),
    });

    await audit(req, 'CREATE_EVENT', { eventId: event._id, title: event.title });
    res.status(201).json({ success: true, id: event._id });
  } catch (err) {
    console.error('POST /api/events:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/events/:id/feature — marks one event as featured, unmarking any other
app.patch('/api/events/:id/feature', async (req, res) => {
  try {
    const exists = await Event.exists({ _id: req.params.id });
    if (!exists) return res.status(404).json({ error: 'Not found' });

    await Event.updateMany({}, { $set: { featured: false } });
    await Event.findByIdAndUpdate(req.params.id, { $set: { featured: true } });

    await audit(req, 'FEATURE_EVENT', { eventId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH /api/events/:id/feature:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/events/:id', async (req, res) => {
  try {
    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) return res.status(404).json({ error: 'Not found' });

    deleteUploadedFile(event.posterUrl);
    await audit(req, 'DELETE_EVENT', { eventId: event._id, title: event.title });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/events/:id:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/recaps — multipart/form-data: fields + up to 10 files under `images`
app.post('/api/recaps', uploadRecapImages.array('images', 10), async (req, res) => {
  try {
    const { title, description } = req.body;

    if (!title) {
      (req.files || []).forEach(f => deleteUploadedFile(`/uploads/recaps/${f.filename}`));
      return res.status(400).json({ error: 'Title is required' });
    }

    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'At least one image is required' });
    }

    const images = req.files.map(f => `/uploads/recaps/${f.filename}`);

    const recap = await Recap.create({
      title:       title.slice(0, 120),
      description: (description || '').slice(0, 1000),
      images,
    });

    await audit(req, 'CREATE_RECAP', { recapId: recap._id, title: recap.title, images: images.length });
    res.status(201).json({ success: true, id: recap._id });
  } catch (err) {
    console.error('POST /api/recaps:', err);
    (req.files || []).forEach(f => deleteUploadedFile(`/uploads/recaps/${f.filename}`));
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/recaps/:id', async (req, res) => {
  try {
    const recap = await Recap.findByIdAndDelete(req.params.id);
    if (!recap) return res.status(404).json({ error: 'Not found' });

    (recap.images || []).forEach(deleteUploadedFile);
    await audit(req, 'DELETE_RECAP', { recapId: recap._id, title: recap.title });
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/recaps/:id:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


/* ═══════════════════════════════════════════════
   SUPER ADMIN MIDDLEWARE
═══════════════════════════════════════════════ */

async function requireSuperAdmin(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
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
    const [discussions, lessons, themes, announcements, donations, auditLogs, admins, visits, events, recaps] =
      await Promise.all([
        Discussion.countDocuments(), Lesson.countDocuments(), Theme.countDocuments(),
        Announcement.countDocuments(), Donation.countDocuments(),
        AuditLog.countDocuments(), User.countDocuments(), Visit.countDocuments(),
        Event.countDocuments(), Recap.countDocuments(),
      ]);
    res.json({ discussions, lessons, themes, announcements, donations, auditLogs, admins, visits, events, recaps });
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
  donations:     () => Donation.deleteMany({}),
  auditlogs:     () => AuditLog.deleteMany({}),
  visits:        () => Visit.deleteMany({}),
  events: async () => {
    const docs = await Event.find({}, 'posterUrl').lean();
    docs.forEach(d => deleteUploadedFile(d.posterUrl));
    return Event.deleteMany({});
  },
  recaps: async () => {
    const docs = await Recap.find({}, 'images').lean();
    docs.forEach(d => (d.images || []).forEach(deleteUploadedFile));
    return Recap.deleteMany({});
  },
};

app.delete('/api/superadmin/db/:collection', requireSuperAdmin, async (req, res) => {
  try {
    const key = req.params.collection.toLowerCase();
    if (!CLEARABLE[key]) {
      return res.status(400).json({ error: 'Unknown or protected collection' });
    }
    const olderThanDays = parseInt(req.query.olderThan) || 0;
    let result;
    if (olderThanDays > 0 && !['lessons', 'themes', 'events', 'recaps'].includes(key)) {
      const cutoff = new Date(Date.now() - olderThanDays * 86400000);
      const Model = { discussions: Discussion, announcements: Announcement, donations: Donation, auditlogs: AuditLog, visits: Visit }[key];
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
    const annResult    = await Announcement.deleteMany({ expiresAt: { $ne: null, $lte: now } });
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
   ERROR HANDLING — must be registered after all routes.
   Catches multer upload errors (bad file type, too large, too many
   files) and returns clean JSON instead of Express's default HTML
   stack trace.
═══════════════════════════════════════════════ */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE:       'Image is too large — max 5MB per file.',
      LIMIT_FILE_COUNT:      'Too many images — max 10 per recap.',
      LIMIT_UNEXPECTED_FILE: 'Too many images — max 10 per recap.',
    };
    return res.status(400).json({ error: messages[err.code] || err.message });
  }
  if (err && err.message === IMAGE_FILTER_ERROR) {
    return res.status(400).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Server error' });
});


/* ═══════════════════════════════════════════════
   START
═══════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`\x1b[33m✦ Makeni Central SDA — server running on port ${PORT}\x1b[0m`);
});