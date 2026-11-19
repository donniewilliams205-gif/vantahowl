'use strict';
/*
 * Vantahowl — server-backed community site for Bludhound420 and the pack.
 * Node + Express 4 + Socket.IO 4, JSON datastore, bcryptjs, JWT cookie auth.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Server } = require('socket.io');

const { Store, uid } = require('./lib/store');
const { dayKey, weekKey, ageFromDob, youtubeId, sniffImage, maskProfanity, cleanText } = require('./lib/util');
const game = require('./lib/game');

/* ---------------- config ---------------- */
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const FOUNDER_USERNAME = (process.env.FOUNDER_USERNAME || 'bludhound420').toLowerCase();
const JWT_SECRET = process.env.JWT_SECRET || 'vantahowl-dev-secret-change-me';
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_COOKIE = 'vh_session';
const CSRF_COOKIE = 'vh_csrf';
const REACTIONS = ['🔥', '❤️', '🌿', '🎮', '👑', '🐺'];
const VIBES = ['Hyped', 'Chill', 'Locked in', 'Lifted', 'Tired', 'Low'];

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const store = new Store(DATA_DIR);
const db = store.data;

/* Seed the five default channels on first boot. */
if (!Array.isArray(db.channels) || db.channels.length === 0) {
  const seed = [
    { name: 'The Lobby', emoji: '🌕', topic: 'Where the pack gathers. Say hey, drop a howl.' },
    { name: 'Clips & Videos', emoji: '🎬', topic: 'Your best clips and full videos.' },
    { name: 'Pics', emoji: '📸', topic: 'Screenshots, setups, pets, fits — show the pack.' },
    { name: 'Music', emoji: '🎵', topic: 'Tracks, playlists and the Song of the Day.' },
    { name: 'Chill Chat', emoji: '☕', topic: 'Low-key talk. No pressure, just vibes.' },
  ];
  db.channels = seed.map((c, i) => ({ id: uid('chan_'), name: c.name, emoji: c.emoji, topic: c.topic, hidden: false, order: i }));
  for (const c of db.channels) db.messages[c.id] = [];
  store.save();
}
for (const u of db.users) game.ensureUserShape(u);

/* ---------------- helpers ---------------- */
function securityLog(event, detail) {
  db.securityLog.push({ at: new Date().toISOString(), event, detail: String(detail || '') });
  if (db.securityLog.length > 1000) db.securityLog.splice(0, db.securityLog.length - 1000);
  store.saveSoon();
}

function findUser(id) { return db.users.find((u) => u.id === id) || null; }
function findUserByName(name) {
  return db.users.find((u) => u.username.toLowerCase() === String(name || '').toLowerCase()) || null;
}
function findChannel(id) { return db.channels.find((c) => c.id === id) || null; }
function findPost(id) { return db.posts.find((p) => p.id === id) || null; }

function publicUser(u, viewer) {
  if (!u) return null;
  const rank = game.rankFor(u.points);
  const base = {
    id: u.id, username: u.username, displayName: u.displayName, role: u.role,
    rank, badges: u.badges, statusLine: u.statusLine || '', accent: u.accent || '#E1062C',
    createdAt: u.createdAt,
  };
  if (viewer && viewer.id === u.id) {
    base.coins = u.coins;
    base.points = u.points;
    base.weeklyPoints = u.weekly && u.weekly.key === weekKey() ? u.weekly.points : 0;
    base.vibe = u.vibe || null;
    base.lastSpinDate = u.lastSpinDate || null;
    base.sprintBest = u.sprintBest || null;
    base.stats = u.stats;
  }
  return base;
}

function blockedIds(user) {
  if (!user) return new Set();
  return new Set(db.blocks.filter((b) => b.userId === user.id).map((b) => b.blockedId));
}
function isHiddenAuthor(authorId, viewer) {
  const author = findUser(authorId);
  if (author && author.banned) return true;
  if (viewer && blockedIds(viewer).has(authorId)) return true;
  return false;
}
function canSeeChannel(channel, user) {
  if (!channel) return false;
  if (!channel.hidden) return true;
  return !!user && (user.role === 'founder' || user.role === 'moderator');
}

function serializePost(p, viewer) {
  const author = findUser(p.authorId);
  const comments = db.comments
    .filter((c) => c.postId === p.id && !isHiddenAuthor(c.authorId, viewer))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((c) => ({
      id: c.id, text: c.text, createdAt: c.createdAt,
      author: publicUser(findUser(c.authorId), viewer),
    }));
  const reactions = {};
  for (const [emoji, users] of Object.entries(p.reactions || {})) {
    if (users.length) reactions[emoji] = { count: users.length, mine: viewer ? users.includes(viewer.id) : false };
  }
  return {
    id: p.id, channelId: p.channelId, text: p.text, image: p.image || null,
    youtubeId: p.youtubeId || null, createdAt: p.createdAt,
    author: publicUser(author, viewer), comments, reactions,
    gifts: (p.gifts || []).map((g) => ({ ...g, from: publicUser(findUser(g.fromId), viewer) })),
    spotlight: db.settings.spotlightPostId === p.id,
  };
}

function serializePoll(poll, viewer) {
  const total = Object.keys(poll.votes || {}).length;
  return {
    id: poll.id, channelId: poll.channelId, question: poll.question, createdAt: poll.createdAt,
    author: publicUser(findUser(poll.authorId), viewer),
    totalVotes: total,
    myVote: viewer ? poll.votes[viewer.id] || null : null,
    options: poll.options.map((o) => {
      const count = Object.values(poll.votes || {}).filter((v) => v === o.id).length;
      return { id: o.id, text: o.text, count, pct: total ? Math.round((count / total) * 100) : 0 };
    }),
  };
}

/** Activity reward bundle: coins (capped), points, quest progress, badges. */
function reward(storeRef, user, opts) {
  const { coins = 0, points = 0, reason, metric } = opts;
  let granted = 0;
  if (coins) granted = game.awardCoins(storeRef, user, coins, 'earn:' + reason);
  if (points) game.addPoints(user, points);
  if (metric) game.bumpQuest(storeRef, user, metric, 1);
  game.noteActivityHour(user);
  const badges = game.checkBadges(user);
  return { granted, badges };
}

/* ---------------- app ---------------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; media-src 'self' blob:; " +
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com; connect-src 'self' ws: wss:; " +
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', index: false }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

/* ---------------- auth ---------------- */
function issueSession(res, user) {
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: IS_PROD, path: '/', maxAge: 7 * 24 * 3600 * 1000,
  });
  const csrf = crypto.randomBytes(24).toString('hex');
  res.cookie(CSRF_COOKIE, csrf, {
    httpOnly: false, sameSite: 'lax', secure: IS_PROD, path: '/', maxAge: 7 * 24 * 3600 * 1000,
  });
  return csrf;
}

function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const u = findUser(payload.uid);
    return u || null;
  } catch (e) { return null; }
}

function optionalAuth(req, res, next) {
  req.user = userFromToken(req.cookies[SESSION_COOKIE]);
  next();
}
function requireAuth(req, res, next) {
  const u = userFromToken(req.cookies[SESSION_COOKIE]);
  if (!u) return res.status(401).json({ error: 'Sign in first.' });
  if (u.banned) return res.status(403).json({ error: 'This account is banned.' });
  req.user = u;
  next();
}
function requireFounder(req, res, next) {
  if (!req.user || req.user.role !== 'founder') return res.status(403).json({ error: 'Founder only.' });
  next();
}
function requireMod(req, res, next) {
  if (!req.user || (req.user.role !== 'founder' && req.user.role !== 'moderator')) {
    return res.status(403).json({ error: 'Moderators only.' });
  }
  next();
}

/* CSRF: state-changing API calls (except signup/login) need the double-submit token. */
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path === '/signup' || req.path === '/login') return next();
  const cookieToken = req.cookies[CSRF_COOKIE];
  const headerToken = req.get('x-csrf-token');
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Bad CSRF token.' });
  }
  next();
});

app.get('/api/health', (req, res) => res.json({ ok: true, name: db.settings.siteName }));

app.get('/api/bootstrap', optionalAuth, (req, res) => {
  const s = db.settings;
  res.json({
    settings: {
      siteName: s.siteName, announcement: s.announcement, gameNight: s.gameNight,
      songOfDay: s.songOfDay, signupsOpen: s.signupsOpen,
    },
    user: req.user && !req.user.banned ? publicUser(req.user, req.user) : null,
    csrfToken: req.cookies[CSRF_COOKIE] || null,
    channels: db.channels.filter((c) => canSeeChannel(c, req.user)).sort((a, b) => a.order - b.order),
    gifts: game.GIFTS, badges: game.BADGES.map(({ id, icon, name, desc }) => ({ id, icon, name, desc })),
    reactions: REACTIONS, vibes: VIBES,
  });
});

app.post('/api/signup', async (req, res) => {
  const username = cleanText(req.body.username, 20);
  const displayName = cleanText(req.body.displayName, 30) || username;
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const dob = typeof req.body.dob === 'string' ? req.body.dob : '';
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–20 letters, numbers or underscores.' });
  }
  if (password.length < 10) return res.status(400).json({ error: 'Password must be at least 10 characters.' });
  const age = ageFromDob(dob);
  if (age === null) return res.status(400).json({ error: 'Enter a valid date of birth.' });
  if (age < 13) return res.status(400).json({ error: 'You must be at least 13 to join Vantahowl.' });
  if (findUserByName(username)) return res.status(409).json({ error: 'That username is taken.' });
  const isFounder = username.toLowerCase() === FOUNDER_USERNAME;
  if (!db.settings.signupsOpen && !isFounder) {
    return res.status(403).json({ error: 'Signups are closed right now.' });
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const user = game.ensureUserShape({
    id: uid('user_'), username, displayName, passwordHash, dob,
    role: isFounder ? 'founder' : 'member', banned: false, createdAt: Date.now(),
    coins: 0, points: 0, badges: [], statusLine: '', accent: '#E1062C',
    vibe: null, lastSpinDate: null, sprintBest: null, loginFails: 0, lockedUntil: 0,
  });
  db.users.push(user);
  game.awardCoins(store, user, 25, 'welcome');
  game.checkBadges(user);
  store.save();
  securityLog('signup', username + (isFounder ? ' (FOUNDER)' : ''));
  const csrf = issueSession(res, user);
  res.status(201).json({ user: publicUser(user, user), csrfToken: csrf });
});

app.post('/api/login', async (req, res) => {
  const username = cleanText(req.body.username, 20);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = findUserByName(username);
  if (!user) {
    securityLog('login_fail', 'unknown user ' + username);
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  if (user.lockedUntil && user.lockedUntil > Date.now()) {
    return res.status(423).json({ error: 'Account locked after too many failed tries. Wait 15 minutes.' });
  }
  if (user.banned) return res.status(403).json({ error: 'This account is banned.' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    user.loginFails = (user.loginFails || 0) + 1;
    securityLog('login_fail', username + ' (' + user.loginFails + ')');
    if (user.loginFails >= 5) {
      user.lockedUntil = Date.now() + 15 * 60 * 1000;
      user.loginFails = 0;
      securityLog('lockout', username + ' locked for 15 minutes');
      store.save();
      return res.status(423).json({ error: 'Too many failed tries — account locked for 15 minutes.' });
    }
    store.save();
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  user.loginFails = 0;
  user.lockedUntil = 0;
  store.save();
  securityLog('login', username);
  const csrf = issueSession(res, user);
  res.json({ user: publicUser(user, user), csrfToken: csrf });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user, req.user), csrfToken: req.cookies[CSRF_COOKIE] || null });
});

app.patch('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  if (typeof req.body.displayName === 'string') u.displayName = cleanText(req.body.displayName, 30) || u.displayName;
  if (typeof req.body.statusLine === 'string') u.statusLine = cleanText(req.body.statusLine, 80);
  if (typeof req.body.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(req.body.accent)) u.accent = req.body.accent;
  store.save();
  res.json({ user: publicUser(u, u) });
});

/* ---------------- uploads ---------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

app.post('/api/upload', requireAuth, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be 5 MB or smaller.' : 'Upload failed.';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'No image file sent.' });
    const kind = sniffImage(req.file.buffer);
    if (!kind) return res.status(400).json({ error: 'That file is not a JPEG, PNG, GIF or WebP image.' });
    const name = crypto.randomBytes(16).toString('hex') + kind.ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), req.file.buffer);
    res.status(201).json({ url: '/uploads/' + name });
  });
});

/* ---------------- channels & posts ---------------- */
app.get('/api/channels', optionalAuth, (req, res) => {
  res.json({
    channels: db.channels.filter((c) => canSeeChannel(c, req.user)).sort((a, b) => a.order - b.order),
  });
});

app.get('/api/channels/:id/feed', optionalAuth, (req, res) => {
  const channel = findChannel(req.params.id);
  if (!channel || !canSeeChannel(channel, req.user)) return res.status(404).json({ error: 'Channel not found.' });
  const viewer = req.user && !req.user.banned ? req.user : null;
  let posts = db.posts
    .filter((p) => p.channelId === channel.id && !isHiddenAuthor(p.authorId, viewer))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 100)
    .map((p) => serializePost(p, viewer));
  // Founder Spotlight pins atop The Lobby.
  let spotlight = null;
  if (channel.name === 'The Lobby' && db.settings.spotlightPostId) {
    const sp = findPost(db.settings.spotlightPostId);
    if (sp && !isHiddenAuthor(sp.authorId, viewer)) {
      spotlight = serializePost(sp, viewer);
      posts = posts.filter((p) => p.id !== sp.id);
    }
  }
  const polls = db.polls
    .filter((p) => p.channelId === channel.id && !isHiddenAuthor(p.authorId, viewer))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((p) => serializePoll(p, viewer));
  const songOfDay = channel.name === 'Music' ? db.settings.songOfDay : null;
  res.json({ channel, posts, polls, spotlight, songOfDay });
});

app.post('/api/channels/:id/posts', requireAuth, (req, res) => {
  const channel = findChannel(req.params.id);
  if (!channel || !canSeeChannel(channel, req.user)) return res.status(404).json({ error: 'Channel not found.' });
  let text = cleanText(req.body.text, 2000);
  if (db.settings.profanityMask) text = maskProfanity(text);
  const yt = youtubeId(req.body.youtube || '');
  let image = null;
  if (typeof req.body.image === 'string' && /^\/uploads\/[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(req.body.image)) {
    image = req.body.image;
  }
  if (!text && !yt && !image) return res.status(400).json({ error: 'Write something, or attach a pic or video.' });
  const post = {
    id: uid('post_'), channelId: channel.id, authorId: req.user.id,
    text, image, youtubeId: yt, createdAt: Date.now(), reactions: {}, gifts: [],
  };
  db.posts.push(post);
  req.user.stats.posts += 1;
  if (image) req.user.stats.imagePosts += 1;
  const { badges } = reward(store, req.user, { coins: 5, points: 10, reason: 'post', metric: 'posts' });
  store.save();
  const out = serializePost(post, req.user);
  out.newBadges = badges;
  res.status(201).json({ post: out });
});

app.delete('/api/posts/:id', requireAuth, (req, res) => {
  const post = findPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const mine = post.authorId === req.user.id;
  if (!mine && req.user.role !== 'founder' && req.user.role !== 'moderator') {
    return res.status(403).json({ error: 'Not your post.' });
  }
  db.posts = db.posts.filter((p) => p.id !== post.id);
  db.comments = db.comments.filter((c) => c.postId !== post.id);
  if (db.settings.spotlightPostId === post.id) db.settings.spotlightPostId = null;
  store.save();
  res.json({ ok: true });
});

app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const post = findPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  let text = cleanText(req.body.text, 600);
  if (!text) return res.status(400).json({ error: 'Comment is empty.' });
  if (db.settings.profanityMask) text = maskProfanity(text);
  const comment = { id: uid('com_'), postId: post.id, authorId: req.user.id, text, createdAt: Date.now() };
  db.comments.push(comment);
  req.user.stats.comments += 1;
  const { badges } = reward(store, req.user, { coins: 2, points: 4, reason: 'comment', metric: 'comments' });
  store.save();
  res.status(201).json({
    comment: { id: comment.id, text: comment.text, createdAt: comment.createdAt, author: publicUser(req.user, req.user) },
    newBadges: badges,
  });
});

app.delete('/api/comments/:id', requireAuth, (req, res) => {
  const comment = db.comments.find((c) => c.id === req.params.id);
  if (!comment) return res.status(404).json({ error: 'Comment not found.' });
  if (comment.authorId !== req.user.id && req.user.role !== 'founder' && req.user.role !== 'moderator') {
    return res.status(403).json({ error: 'Not your comment.' });
  }
  db.comments = db.comments.filter((c) => c.id !== comment.id);
  store.save();
  res.json({ ok: true });
});

app.post('/api/posts/:id/react', requireAuth, (req, res) => {
  const post = findPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  const emoji = req.body.emoji;
  if (!REACTIONS.includes(emoji)) return res.status(400).json({ error: 'Unknown reaction.' });
  if (!post.reactions[emoji]) post.reactions[emoji] = [];
  const list = post.reactions[emoji];
  const idx = list.indexOf(req.user.id);
  if (idx >= 0) list.splice(idx, 1); else list.push(req.user.id);
  store.saveSoon();
  res.json({ reactions: serializePost(post, req.user).reactions });
});

/* ---------------- polls ---------------- */
app.post('/api/channels/:id/polls', requireAuth, (req, res) => {
  const channel = findChannel(req.params.id);
  if (!channel || !canSeeChannel(channel, req.user)) return res.status(404).json({ error: 'Channel not found.' });
  let question = cleanText(req.body.question, 200);
  if (db.settings.profanityMask) question = maskProfanity(question);
  const options = Array.isArray(req.body.options)
    ? req.body.options.map((o) => cleanText(o, 60)).filter(Boolean).slice(0, 4)
    : [];
  if (!question) return res.status(400).json({ error: 'Ask a question.' });
  if (options.length < 2) return res.status(400).json({ error: 'Give at least 2 options.' });
  const poll = {
    id: uid('poll_'), channelId: channel.id, authorId: req.user.id, question,
    options: options.map((t) => ({ id: uid('opt_'), text: t })),
    votes: {}, createdAt: Date.now(), closed: false,
  };
  db.polls.push(poll);
  reward(store, req.user, { coins: 3, points: 5, reason: 'poll' });
  store.save();
  res.status(201).json({ poll: serializePoll(poll, req.user) });
});

app.post('/api/polls/:id/vote', requireAuth, (req, res) => {
  const poll = db.polls.find((p) => p.id === req.params.id);
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });
  const option = poll.options.find((o) => o.id === req.body.optionId);
  if (!option) return res.status(400).json({ error: 'Unknown option.' });
  const firstVote = !req.user.stats.pollsVoted.includes(poll.id);
  poll.votes[req.user.id] = option.id;
  if (firstVote) {
    req.user.stats.pollsVoted.push(poll.id);
    reward(store, req.user, { coins: 2, points: 3, reason: 'vote', metric: 'pollVotes' });
  }
  store.save();
  res.json({ poll: serializePoll(poll, req.user) });
});

/* ---------------- chat history (REST) ---------------- */
app.get('/api/channels/:id/messages', optionalAuth, (req, res) => {
  const channel = findChannel(req.params.id);
  if (!channel || !canSeeChannel(channel, req.user)) return res.status(404).json({ error: 'Channel not found.' });
  const viewer = req.user && !req.user.banned ? req.user : null;
  const list = (db.messages[channel.id] || [])
    .filter((m) => !isHiddenAuthor(m.authorId, viewer))
    .slice(-100)
    .map((m) => ({ id: m.id, text: m.text, createdAt: m.createdAt, author: publicUser(findUser(m.authorId), viewer) }));
  res.json({ messages: list });
});

/* ---------------- gifts ---------------- */
app.post('/api/gifts', requireAuth, (req, res) => {
  const gift = game.GIFTS.find((g) => g.emoji === req.body.gift);
  if (!gift) return res.status(400).json({ error: 'Unknown gift.' });
  const sender = req.user;
  let recipient = null;
  let post = null;
  if (req.body.postId) {
    post = findPost(req.body.postId);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    recipient = findUser(post.authorId);
  } else if (req.body.toUserId) {
    recipient = findUser(req.body.toUserId);
  }
  if (!recipient) return res.status(400).json({ error: 'Pick a post or a member to gift.' });
  if (recipient.id === sender.id) return res.status(400).json({ error: 'You cannot gift yourself.' });
  if (recipient.banned) return res.status(400).json({ error: 'That member is unavailable.' });
  if (sender.coins < gift.price) return res.status(400).json({ error: 'Not enough Howl Coins.' });
  game.awardCoins(store, sender, -gift.price, 'gift:send:' + gift.name);
  game.awardCoins(store, recipient, gift.price, 'gift:receive:' + gift.name);
  sender.stats.giftsSent += 1;
  recipient.stats.giftsReceived += 1;
  const record = { id: uid('gift_'), fromId: sender.id, emoji: gift.emoji, name: gift.name, price: gift.price, at: Date.now() };
  if (post) post.gifts.push(record);
  game.addPoints(sender, 5);
  game.bumpQuest(store, sender, 'giftsSent', 1);
  const badges = game.checkBadges(sender);
  game.checkBadges(recipient);
  store.save();
  res.status(201).json({
    ok: true, gift: record, myCoins: sender.coins, newBadges: badges,
    post: post ? serializePost(post, sender) : null,
  });
});

/* ---------------- vibe check-in ---------------- */
app.post('/api/vibe', requireAuth, (req, res) => {
  const mood = req.body.mood;
  if (!VIBES.includes(mood)) return res.status(400).json({ error: 'Pick a vibe.' });
  const today = dayKey();
  if (req.user.vibe && req.user.vibe.date === today) {
    return res.status(400).json({ error: 'Already checked in today.' });
  }
  req.user.vibe = { date: today, mood };
  if (!req.user.stats.checkinDays.includes(today)) req.user.stats.checkinDays.push(today);
  const { badges } = reward(store, req.user, { coins: 3, points: 3, reason: 'vibe', metric: 'checkins' });
  store.save();
  res.json({ ok: true, vibe: req.user.vibe, coins: req.user.coins, newBadges: badges });
});

/* ---------------- quests ---------------- */
app.get('/api/quests', requireAuth, (req, res) => {
  const quests = game.activeQuests().map((q) => {
    const rec = game.questRecord(store, req.user, q.id);
    return { ...q, progress: rec.progress, claimed: rec.claimed, complete: rec.progress >= q.target };
  });
  store.saveSoon();
  res.json({ weekKey: weekKey(), quests });
});

app.post('/api/quests/claim', requireAuth, (req, res) => {
  const quest = game.activeQuests().find((q) => q.id === req.body.questId);
  if (!quest) return res.status(400).json({ error: 'That quest is not active this week.' });
  const rec = game.questRecord(store, req.user, quest.id);
  if (rec.claimed) return res.status(400).json({ error: 'Already claimed.' });
  if (rec.progress < quest.target) return res.status(400).json({ error: 'Quest not finished yet.' });
  rec.claimed = true;
  game.awardCoins(store, req.user, quest.reward, 'quest:' + quest.id);
  game.addPoints(req.user, 5);
  store.save();
  res.json({ ok: true, reward: quest.reward, coins: req.user.coins });
});

/* ---------------- arcade ---------------- */
app.post('/api/arcade/spin', requireAuth, (req, res) => {
  const today = dayKey();
  if (req.user.lastSpinDate === today) return res.status(400).json({ error: 'Already spun today — come back tomorrow.' });
  req.user.lastSpinDate = today;
  const amount = game.drawSpin();
  if (amount > 0) game.awardCoins(store, req.user, amount, 'arcade:spin');
  game.addPoints(req.user, 1);
  store.save();
  res.json({ ok: true, amount, coins: req.user.coins });
});

app.post('/api/arcade/sprint', requireAuth, (req, res) => {
  const ms = req.body.ms;
  if (!Number.isInteger(ms) || ms < 120 || ms > 120000) {
    return res.status(400).json({ error: 'Implausible sprint time.' });
  }
  let best = false;
  if (!req.user.sprintBest || ms < req.user.sprintBest) {
    req.user.sprintBest = ms;
    best = true;
  }
  game.addPoints(req.user, 1);
  store.save();
  res.json({ ok: true, ms, personalBest: req.user.sprintBest, isBest: best });
});

app.get('/api/arcade/leaderboard', optionalAuth, (req, res) => {
  const fastest = db.users
    .filter((u) => !u.banned && u.sprintBest)
    .sort((a, b) => a.sprintBest - b.sprintBest)
    .slice(0, 10)
    .map((u) => ({ user: publicUser(u, req.user), ms: u.sprintBest }));
  res.json({ fastest });
});

/* ---------------- pack leaderboard & members ---------------- */
app.get('/api/leaderboard', optionalAuth, (req, res) => {
  const wk = weekKey();
  const top = db.users
    .filter((u) => !u.banned)
    .map((u) => ({ user: publicUser(u, req.user), weeklyPoints: u.weekly && u.weekly.key === wk ? u.weekly.points : 0, points: u.points }))
    .sort((a, b) => b.weeklyPoints - a.weeklyPoints || b.points - a.points)
    .slice(0, 20);
  res.json({ weekKey: wk, top });
});

app.get('/api/members', optionalAuth, (req, res) => {
  const members = db.users
    .filter((u) => !u.banned)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((u) => publicUser(u, req.user));
  res.json({ members });
});

app.get('/api/users/:id', optionalAuth, (req, res) => {
  const u = findUser(req.params.id);
  if (!u || u.banned) return res.status(404).json({ error: 'Member not found.' });
  const profile = publicUser(u, req.user);
  profile.stats = { posts: u.stats.posts, comments: u.stats.comments, chats: u.stats.chats, giftsSent: u.stats.giftsSent };
  profile.badges = u.badges;
  res.json({ user: profile });
});

/* ---------------- Looking for Squad ---------------- */
app.get('/api/lfg', optionalAuth, (req, res) => {
  const now = Date.now();
  const viewer = req.user && !req.user.banned ? req.user : null;
  const list = db.lfg
    .filter((l) => l.expiresAt > now && !isHiddenAuthor(l.authorId, viewer))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((l) => ({ ...l, author: publicUser(findUser(l.authorId), viewer) }));
  res.json({ lfg: list });
});

app.post('/api/lfg', requireAuth, (req, res) => {
  const gameName = cleanText(req.body.game, 60);
  let text = cleanText(req.body.text, 300);
  if (!gameName || !text) return res.status(400).json({ error: 'Name the game and what you need.' });
  if (db.settings.profanityMask) text = maskProfanity(text);
  const now = Date.now();
  const entry = {
    id: uid('lfg_'), authorId: req.user.id, game: gameName, text,
    createdAt: now, expiresAt: now + 24 * 3600 * 1000, filled: false,
  };
  db.lfg.push(entry);
  req.user.stats.lfgPosts += 1;
  const { badges } = reward(store, req.user, { coins: 3, points: 5, reason: 'lfg' });
  store.save();
  res.status(201).json({ lfg: { ...entry, author: publicUser(req.user, req.user) }, newBadges: badges });
});

app.post('/api/lfg/:id/filled', requireAuth, (req, res) => {
  const entry = db.lfg.find((l) => l.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Post not found.' });
  if (entry.authorId !== req.user.id && req.user.role !== 'founder') {
    return res.status(403).json({ error: 'Not your squad post.' });
  }
  entry.filled = true;
  store.save();
  res.json({ ok: true });
});

/* ---------------- reports & blocks ---------------- */
app.post('/api/reports', requireAuth, (req, res) => {
  const targetType = req.body.targetType;
  if (!['post', 'comment', 'user', 'message'].includes(targetType)) {
    return res.status(400).json({ error: 'Unknown report target.' });
  }
  const report = {
    id: uid('rep_'), reporterId: req.user.id, targetType,
    targetId: cleanText(req.body.targetId, 60), reason: cleanText(req.body.reason, 300),
    status: 'open', createdAt: Date.now(),
  };
  if (!report.targetId) return res.status(400).json({ error: 'Missing target.' });
  db.reports.push(report);
  store.save();
  securityLog('report', req.user.username + ' reported ' + targetType + ' ' + report.targetId);
  res.status(201).json({ ok: true, report });
});

app.get('/api/blocks', requireAuth, (req, res) => {
  const list = db.blocks.filter((b) => b.userId === req.user.id)
    .map((b) => ({ user: publicUser(findUser(b.blockedId), req.user) }));
  res.json({ blocks: list });
});

app.post('/api/blocks', requireAuth, (req, res) => {
  const target = findUser(req.body.userId);
  if (!target) return res.status(404).json({ error: 'Member not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot block yourself.' });
  if (!db.blocks.some((b) => b.userId === req.user.id && b.blockedId === target.id)) {
    db.blocks.push({ userId: req.user.id, blockedId: target.id });
    store.save();
  }
  res.json({ ok: true });
});

app.delete('/api/blocks/:userId', requireAuth, (req, res) => {
  db.blocks = db.blocks.filter((b) => !(b.userId === req.user.id && b.blockedId === req.params.userId));
  store.save();
  res.json({ ok: true });
});

/* ---------------- admin (Founder console) ---------------- */
app.get('/api/admin/settings', requireAuth, requireFounder, (req, res) => {
  res.json({ settings: db.settings });
});

app.patch('/api/admin/settings', requireAuth, requireFounder, (req, res) => {
  const s = db.settings;
  const b = req.body;
  if (typeof b.siteName === 'string' && cleanText(b.siteName, 40)) s.siteName = cleanText(b.siteName, 40);
  if (typeof b.announcement === 'string') s.announcement = cleanText(b.announcement, 300);
  if (typeof b.signupsOpen === 'boolean') s.signupsOpen = b.signupsOpen;
  if (typeof b.profanityMask === 'boolean') s.profanityMask = b.profanityMask;
  if ('gameNight' in b) {
    if (b.gameNight === null) s.gameNight = null;
    else if (b.gameNight && !Number.isNaN(Date.parse(b.gameNight.at))) {
      s.gameNight = { label: cleanText(b.gameNight.label, 80) || 'Game Night', at: new Date(b.gameNight.at).toISOString() };
    } else return res.status(400).json({ error: 'Game Night needs a valid date/time.' });
  }
  if ('songOfDay' in b) {
    if (b.songOfDay === null) s.songOfDay = null;
    else {
      const yt = youtubeId((b.songOfDay && b.songOfDay.youtube) || '');
      if (!yt) return res.status(400).json({ error: 'Song of the Day needs a YouTube link.' });
      s.songOfDay = { title: cleanText(b.songOfDay.title, 120) || 'Song of the Day', youtubeId: yt };
    }
  }
  store.save();
  securityLog('settings', req.user.username + ' updated site settings');
  res.json({ settings: s });
});

app.post('/api/admin/channels', requireAuth, requireFounder, (req, res) => {
  const name = cleanText(req.body.name, 40);
  if (!name) return res.status(400).json({ error: 'Name the channel.' });
  const channel = {
    id: uid('chan_'), name, emoji: cleanText(req.body.emoji, 4) || '💬',
    topic: cleanText(req.body.topic, 160), hidden: false,
    order: db.channels.length,
  };
  db.channels.push(channel);
  db.messages[channel.id] = [];
  store.save();
  securityLog('channel_create', name);
  res.status(201).json({ channel });
});

app.patch('/api/admin/channels/:id', requireAuth, requireFounder, (req, res) => {
  const channel = findChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });
  const b = req.body;
  if (typeof b.name === 'string' && cleanText(b.name, 40)) channel.name = cleanText(b.name, 40);
  if (typeof b.emoji === 'string') channel.emoji = cleanText(b.emoji, 4) || channel.emoji;
  if (typeof b.topic === 'string') channel.topic = cleanText(b.topic, 160);
  if (typeof b.hidden === 'boolean') channel.hidden = b.hidden;
  if (Number.isInteger(b.order)) channel.order = b.order;
  store.save();
  res.json({ channel });
});

app.delete('/api/admin/channels/:id', requireAuth, requireFounder, (req, res) => {
  const channel = findChannel(req.params.id);
  if (!channel) return res.status(404).json({ error: 'Channel not found.' });
  db.channels = db.channels.filter((c) => c.id !== channel.id);
  db.posts = db.posts.filter((p) => p.channelId !== channel.id);
  db.polls = db.polls.filter((p) => p.channelId !== channel.id);
  delete db.messages[channel.id];
  store.save();
  securityLog('channel_delete', channel.name);
  res.json({ ok: true });
});

app.get('/api/admin/users', requireAuth, requireFounder, (req, res) => {
  res.json({
    users: db.users.map((u) => ({
      ...publicUser(u, req.user), banned: u.banned, coins: u.coins, points: u.points, createdAt: u.createdAt,
    })),
  });
});

app.patch('/api/admin/users/:id/role', requireAuth, requireFounder, (req, res) => {
  const target = findUser(req.params.id);
  if (!target) return res.status(404).json({ error: 'Member not found.' });
  if (target.role === 'founder') return res.status(400).json({ error: 'The Founder can never be demoted.' });
  if (!['member', 'moderator'].includes(req.body.role)) return res.status(400).json({ error: 'Role must be member or moderator.' });
  target.role = req.body.role;
  store.save();
  securityLog('role', target.username + ' -> ' + target.role);
  res.json({ user: publicUser(target, req.user) });
});

app.patch('/api/admin/users/:id/ban', requireAuth, requireFounder, (req, res) => {
  const target = findUser(req.params.id);
  if (!target) return res.status(404).json({ error: 'Member not found.' });
  if (target.role === 'founder') return res.status(400).json({ error: 'The Founder can never be banned.' });
  target.banned = !!req.body.banned;
  store.save();
  securityLog(target.banned ? 'ban' : 'unban', target.username);
  res.json({ user: publicUser(target, req.user), banned: target.banned });
});

app.post('/api/admin/posts/:id/spotlight', requireAuth, requireFounder, (req, res) => {
  const post = findPost(req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found.' });
  db.settings.spotlightPostId = post.id;
  store.save();
  res.json({ ok: true });
});

app.delete('/api/admin/spotlight', requireAuth, requireFounder, (req, res) => {
  db.settings.spotlightPostId = null;
  store.save();
  res.json({ ok: true });
});

app.get('/api/admin/reports', requireAuth, requireMod, (req, res) => {
  const list = db.reports.slice().sort((a, b) => b.createdAt - a.createdAt).map((r) => ({
    ...r, reporter: publicUser(findUser(r.reporterId), req.user),
  }));
  res.json({ reports: list });
});

app.post('/api/admin/reports/:id/dismiss', requireAuth, requireMod, (req, res) => {
  const report = db.reports.find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  report.status = 'dismissed';
  store.save();
  res.json({ ok: true });
});

app.post('/api/admin/reports/:id/delete-content', requireAuth, requireMod, (req, res) => {
  const report = db.reports.find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found.' });
  if (report.targetType === 'post') {
    db.posts = db.posts.filter((p) => p.id !== report.targetId);
    db.comments = db.comments.filter((c) => c.postId !== report.targetId);
  } else if (report.targetType === 'comment') {
    db.comments = db.comments.filter((c) => c.id !== report.targetId);
  } else if (report.targetType === 'message') {
    for (const cid of Object.keys(db.messages)) {
      db.messages[cid] = db.messages[cid].filter((m) => m.id !== report.targetId);
    }
  }
  report.status = 'actioned';
  store.save();
  securityLog('report_action', report.targetType + ' ' + report.targetId + ' deleted by ' + req.user.username);
  res.json({ ok: true });
});

app.get('/api/admin/security-log', requireAuth, requireFounder, (req, res) => {
  res.json({ log: db.securityLog.slice(-200).reverse() });
});

/* ---------------- Socket.IO: live chat + lounge signaling ---------------- */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

io.use((socket, next) => {
  const cookies = parseCookies(socket.handshake.headers.cookie);
  const user = userFromToken(cookies[SESSION_COOKIE]);
  if (!user) return next(new Error('unauthorized'));
  if (user.banned) return next(new Error('banned'));
  socket.user = user;
  next();
});

const loungePeers = new Map(); // socketId -> {userId, username, displayName}

io.on('connection', (socket) => {
  const user = socket.user;

  socket.on('chat:join', (channelId) => {
    const channel = findChannel(channelId);
    if (!channel || !canSeeChannel(channel, user)) return;
    socket.join('chan:' + channel.id);
    const history = (db.messages[channel.id] || [])
      .filter((m) => !isHiddenAuthor(m.authorId, user))
      .slice(-50)
      .map((m) => ({ id: m.id, text: m.text, createdAt: m.createdAt, author: publicUser(findUser(m.authorId), user) }));
    socket.emit('chat:history', { channelId: channel.id, messages: history });
  });

  let lastChatAt = 0;
  socket.on('chat:send', (payload) => {
    const now = Date.now();
    if (now - lastChatAt < 250) return; // gentle anti-flood
    lastChatAt = now;
    const channel = findChannel(payload && payload.channelId);
    if (!channel || !canSeeChannel(channel, user)) return;
    let text = cleanText(payload && payload.text, 500);
    if (!text) return;
    if (db.settings.profanityMask) text = maskProfanity(text);
    const msg = { id: uid('msg_'), authorId: user.id, text, createdAt: now };
    if (!db.messages[channel.id]) db.messages[channel.id] = [];
    db.messages[channel.id].push(msg);
    if (db.messages[channel.id].length > 1000) {
      db.messages[channel.id].splice(0, db.messages[channel.id].length - 1000);
    }
    user.stats.chats += 1;
    reward(store, user, { coins: 1, points: 1, reason: 'chat', metric: 'chats' });
    store.saveSoon();
    const out = { id: msg.id, text: msg.text, createdAt: msg.createdAt, author: publicUser(user, user) };
    io.to('chan:' + channel.id).emit('chat:message', { channelId: channel.id, message: out });
  });

  socket.on('chat:delete', (payload) => {
    if (user.role !== 'founder' && user.role !== 'moderator') return;
    const channel = findChannel(payload && payload.channelId);
    if (!channel || !db.messages[channel.id]) return;
    db.messages[channel.id] = db.messages[channel.id].filter((m) => m.id !== payload.messageId);
    store.saveSoon();
    io.to('chan:' + channel.id).emit('chat:deleted', { channelId: channel.id, messageId: payload.messageId });
  });

  /* --- Voice & Video Lounge (BETA): WebRTC signaling relay --- */
  socket.on('lounge:join', () => {
    loungePeers.set(socket.id, { userId: user.id, username: user.username, displayName: user.displayName });
    socket.join('lounge');
    const others = [...loungePeers.entries()]
      .filter(([id]) => id !== socket.id)
      .map(([id, p]) => ({ socketId: id, ...p }));
    socket.emit('lounge:peers', { peers: others });
    socket.to('lounge').emit('lounge:peer-joined', {
      socketId: socket.id, userId: user.id, username: user.username, displayName: user.displayName,
    });
  });

  const relay = (event) => (payload) => {
    if (!payload || !payload.to) return;
    io.to(payload.to).emit(event, { from: socket.id, userId: user.id, username: user.username, sdp: payload.sdp, candidate: payload.candidate });
  };
  socket.on('rtc:offer', relay('rtc:offer'));
  socket.on('rtc:answer', relay('rtc:answer'));
  socket.on('rtc:ice', relay('rtc:ice'));

  const leaveLounge = () => {
    if (loungePeers.delete(socket.id)) {
      socket.to('lounge').emit('lounge:peer-left', { socketId: socket.id });
    }
  };
  socket.on('lounge:leave', leaveLounge);
  socket.on('disconnect', leaveLounge);
});

/* ---------------- SPA fallback & start ---------------- */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/') || req.path.startsWith('/uploads/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log('Vantahowl is howling on port ' + PORT + ' (data: ' + DATA_DIR + ')');
});
