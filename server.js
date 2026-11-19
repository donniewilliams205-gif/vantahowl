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
const trivia = require('./lib/trivia');

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
/* Feature-pack migration: newer default channels appear on existing data too. */
(function ensureNewChannels() {
  const want = [
    { name: 'Pack Pets', emoji: '🐾', topic: 'Pet pics only. All good boys and girls welcome.', gate: null },
    { name: 'Stoner Lounge', emoji: '🌿', topic: '21+ chill corner. Adults only, keep it mellow.', gate: '21+' },
  ];
  let changed = false;
  for (const w of want) {
    if (!db.channels.some((c) => c.name === w.name)) {
      const ch = { id: uid('chan_'), name: w.name, emoji: w.emoji, topic: w.topic, hidden: false, order: db.channels.length, gate: w.gate };
      db.channels.push(ch);
      if (!db.messages[ch.id]) db.messages[ch.id] = [];
      changed = true;
    }
  }
  if (!db.howl || typeof db.howl !== 'object') { db.howl = { total: 0, daily: { date: '', count: 0 } }; changed = true; }
  if (changed) store.save();
})();
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
    banner: u.banner || '', nowPlaying: u.nowPlaying || '',
    kudosReceived: (u.stats && u.stats.kudosReceived) || 0,
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
    base.streak = u.streak ? u.streak.count : 0;
    base.streakBest = u.streak ? u.streak.best : 0;
    base.howls = u.howls ? { total: u.howls.total, streak: u.howls.streak } : { total: 0, streak: 0 };
    base.kudosLeft = game.kudosLeft(u);
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
  if (channel.gate === '21+') {
    // Hard server-side age gate: under-21 (and anonymous) users never see it.
    if (!user) return false;
    const age = ageFromDob(user.dob);
    if (age === null || age < 21) return false;
  }
  if (!channel.hidden) return true;
  return !!user && (user.role === 'founder' || user.role === 'moderator');
}

/* Pseudo-author for system messages (Trivia Moon). */
const SYSTEM_AUTHOR = {
  id: 'system', username: 'trivia_moon', displayName: '🎲 Trivia Moon', role: 'system',
  rank: { id: 'alpha', name: 'Alpha', icon: '🌕', next: null }, badges: [],
  statusLine: '', accent: '#FFB020', banner: '', nowPlaying: '', createdAt: 0,
};
function authorFor(authorId, viewer) {
  if (authorId === 'system') return SYSTEM_AUTHOR;
  return publicUser(findUser(authorId), viewer);
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
    crowned: !!p.crowned,
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

/* ---------------- "HOUNDY IS LIVE" (Kick) ----------------
 * Honest by design: the banner shows when the Founder flips the manual
 * toggle, or when Kick's public channel API (no credentials) actually
 * reports a livestream. A failed check never fakes a live status. */
const KICK_CHANNEL = (process.env.KICK_CHANNEL || 'bludhound420').toLowerCase();
const kickCache = { isLive: false, ok: false, checkedAt: 0 };
async function checkKickLive() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(KICK_CHANNEL), {
      headers: { 'User-Agent': 'Vantahowl/1.1 (community site)', Accept: 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error('kick api status ' + res.status);
    const j = await res.json();
    kickCache.isLive = !!(j && j.livestream);
    kickCache.ok = true;
  } catch (e) {
    kickCache.ok = false; // unknown — never claim live from a failed check
  }
  kickCache.checkedAt = Date.now();
}
if (KICK_CHANNEL) {
  const t = setTimeout(checkKickLive, 3000); if (t.unref) t.unref();
  const iv = setInterval(checkKickLive, 60 * 1000); if (iv.unref) iv.unref();
}
function liveState() {
  const manual = !!db.settings.liveManual;
  const auto = kickCache.ok && kickCache.isLive;
  return {
    show: manual || auto,
    source: manual ? 'manual' : (auto ? 'auto' : null),
    autoOk: kickCache.ok,
    channel: KICK_CHANNEL,
    url: 'https://kick.com/' + KICK_CHANNEL,
    checkedAt: kickCache.checkedAt || null,
  };
}

/* ---------------- feature-pack serializers ---------------- */
function dmUnreadCount(user) {
  if (!user) return 0;
  return db.dms.filter((d) => d.toId === user.id && !d.read).length;
}
function dmBlockedEitherWay(aId, bId) {
  return db.blocks.some((b) =>
    (b.userId === aId && b.blockedId === bId) || (b.userId === bId && b.blockedId === aId));
}
function serializeEvent(e, viewer) {
  return {
    id: e.id, title: e.title, kind: e.kind, at: e.at, description: e.description,
    createdAt: e.createdAt, going: e.rsvps.length,
    mine: viewer ? e.rsvps.includes(viewer.id) : false,
    rsvps: e.rsvps.map((id) => publicUser(findUser(id), viewer)).filter(Boolean),
  };
}
function upcomingEvents(viewer, limit) {
  const now = Date.now() - 60 * 1000; // keep just-started events visible briefly
  return db.events
    .filter((e) => Date.parse(e.at) >= now)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(0, limit || 10)
    .map((e) => serializeEvent(e, viewer));
}
function packMvp(viewer) {
  const wk = weekKey();
  const top = db.users
    .filter((u) => !u.banned && u.role !== 'founder' && u.weekly && u.weekly.key === wk && u.weekly.points > 0)
    .sort((a, b) => b.weekly.points - a.weekly.points)[0];
  return top ? { user: publicUser(top, viewer), weeklyPoints: top.weekly.points, weekKey: wk } : null;
}
function serializeJukebox(viewer) {
  const items = db.jukebox
    .map((j) => ({
      id: j.id, youtubeId: j.youtubeId, title: j.title, createdAt: j.createdAt,
      votes: Object.keys(j.votes || {}).length,
      mine: viewer ? !!(j.votes && j.votes[viewer.id]) : false,
      addedBy: publicUser(findUser(j.addedById), viewer),
    }))
    .sort((a, b) => b.votes - a.votes || a.createdAt - b.createdAt);
  return { nowPlaying: items[0] || null, queue: items };
}
function serializeBattle(b, viewer) {
  const counts = {};
  for (const pid of Object.values(b.votes || {})) counts[pid] = (counts[pid] || 0) + 1;
  const side = (postId) => {
    const post = findPost(postId);
    return { post: post ? serializePost(post, viewer) : null, postId, votes: counts[postId] || 0 };
  };
  return {
    id: b.id, round: b.round, status: b.status, prize: b.prize,
    createdAt: b.createdAt, closedAt: b.closedAt || null,
    winnerPostId: b.winnerPostId || null,
    myVote: viewer ? (b.votes && b.votes[viewer.id]) || null : null,
    a: side(b.postAId), b: side(b.postBId),
  };
}
function serializeSuggestion(s, viewer) {
  return {
    id: s.id, text: s.text, status: s.status, createdAt: s.createdAt,
    votes: Object.keys(s.votes || {}).length,
    mine: viewer ? !!(s.votes && s.votes[viewer.id]) : false,
    author: publicUser(findUser(s.authorId), viewer),
  };
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
    emotes: db.emotes.filter((e) => e.status === 'approved').map((e) => ({ name: e.name, image: e.image })),
    live: liveState(),
    dmUnread: req.user && !req.user.banned ? dmUnreadCount(req.user) : 0,
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
  const streak = game.touchStreak(store, user);
  game.checkBadges(user);
  store.save();
  securityLog('signup', username + (isFounder ? ' (FOUNDER)' : ''));
  const csrf = issueSession(res, user);
  res.status(201).json({ user: publicUser(user, user), csrfToken: csrf, streak });
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
  const streak = game.touchStreak(store, user);
  store.save();
  securityLog('login', username);
  const csrf = issueSession(res, user);
  res.json({ user: publicUser(user, user), csrfToken: csrf, streak });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({
    user: publicUser(req.user, req.user),
    csrfToken: req.cookies[CSRF_COOKIE] || null,
    dmUnread: dmUnreadCount(req.user),
    live: liveState(),
  });
});

app.patch('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  if (typeof req.body.displayName === 'string') u.displayName = cleanText(req.body.displayName, 30) || u.displayName;
  if (typeof req.body.statusLine === 'string') u.statusLine = cleanText(req.body.statusLine, 80);
  if (typeof req.body.nowPlaying === 'string') u.nowPlaying = cleanText(req.body.nowPlaying, 60);
  if (typeof req.body.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(req.body.accent)) u.accent = req.body.accent;
  if ('banner' in req.body) {
    if (req.body.banner === '' || req.body.banner === null) u.banner = '';
    else if (typeof req.body.banner === 'string' && /^\/uploads\/[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(req.body.banner)) {
      u.banner = req.body.banner;
    } else return res.status(400).json({ error: 'Banner must be an uploaded image.' });
  }
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
  const jukebox = channel.name === 'Music' ? serializeJukebox(viewer) : null;
  const events = channel.name === 'The Lobby' ? upcomingEvents(viewer, 5) : null;
  const mvp = channel.name === 'The Lobby' ? packMvp(viewer) : null;
  res.json({ channel, posts, polls, spotlight, songOfDay, jukebox, events, mvp });
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
    .map((m) => ({ id: m.id, text: m.text, createdAt: m.createdAt, author: authorFor(m.authorId, viewer) }));
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
  const streak = game.touchStreak(store, req.user);
  const { badges } = reward(store, req.user, { coins: 3, points: 3, reason: 'vibe', metric: 'checkins' });
  store.save();
  res.json({ ok: true, vibe: req.user.vibe, coins: req.user.coins, newBadges: badges, streak });
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
  profile.stats = {
    posts: u.stats.posts, comments: u.stats.comments, chats: u.stats.chats, giftsSent: u.stats.giftsSent,
    kudosReceived: u.stats.kudosReceived || 0, kudosGiven: u.stats.kudosGiven || 0,
  };
  profile.badges = u.badges;
  profile.streak = u.streak ? u.streak.count : 0;
  profile.howls = u.howls ? u.howls.total : 0;
  res.json({ user: profile });
});

/* ---------------- kudos ---------------- */
app.post('/api/users/:id/kudos', requireAuth, (req, res) => {
  const target = findUser(req.params.id);
  if (!target || target.banned) return res.status(404).json({ error: 'Member not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot give yourself kudos.' });
  if (dmBlockedEitherWay(req.user.id, target.id)) {
    return res.status(403).json({ error: 'Kudos are blocked between you two.' });
  }
  const wk = weekKey();
  if (req.user.kudosWeek.key !== wk) req.user.kudosWeek = { key: wk, count: 0 };
  if (req.user.kudosWeek.count >= game.KUDOS_WEEKLY_LIMIT) {
    return res.status(400).json({ error: 'You are out of kudos this week (3 per week).' });
  }
  req.user.kudosWeek.count += 1;
  req.user.stats.kudosGiven += 1;
  target.stats.kudosReceived += 1;
  const myBadges = game.checkBadges(req.user);
  const theirBadges = game.checkBadges(target);
  store.save();
  res.status(201).json({
    ok: true, targetKudos: target.stats.kudosReceived,
    kudosLeft: game.kudosLeft(req.user), newBadges: myBadges, targetNewBadges: theirBadges,
  });
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

/* ---------------- direct messages ---------------- */
app.get('/api/dms', requireAuth, (req, res) => {
  const me = req.user;
  const byPartner = new Map();
  for (const d of db.dms) {
    if (d.fromId !== me.id && d.toId !== me.id) continue;
    const partnerId = d.fromId === me.id ? d.toId : d.fromId;
    if (!byPartner.has(partnerId)) byPartner.set(partnerId, { last: null, unread: 0 });
    const entry = byPartner.get(partnerId);
    if (!entry.last || d.createdAt > entry.last.createdAt) entry.last = d;
    if (d.toId === me.id && !d.read) entry.unread += 1;
  }
  const conversations = [...byPartner.entries()]
    .map(([partnerId, e]) => ({
      user: publicUser(findUser(partnerId), me),
      last: e.last ? { text: e.last.text, createdAt: e.last.createdAt, mine: e.last.fromId === me.id } : null,
      unread: e.unread,
    }))
    .filter((c) => c.user)
    .sort((a, b) => (b.last ? b.last.createdAt : 0) - (a.last ? a.last.createdAt : 0));
  res.json({ conversations, unread: dmUnreadCount(me) });
});

app.get('/api/dms/:userId', requireAuth, (req, res) => {
  const partner = findUser(req.params.userId);
  if (!partner || partner.banned) return res.status(404).json({ error: 'Member not found.' });
  let changed = false;
  const messages = db.dms
    .filter((d) => (d.fromId === req.user.id && d.toId === partner.id) || (d.fromId === partner.id && d.toId === req.user.id))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((d) => {
      if (d.toId === req.user.id && !d.read) { d.read = true; changed = true; }
      return { id: d.id, text: d.text, createdAt: d.createdAt, mine: d.fromId === req.user.id };
    });
  if (changed) store.save();
  res.json({ user: publicUser(partner, req.user), messages });
});

app.post('/api/dms/:userId', requireAuth, (req, res) => {
  const partner = findUser(req.params.userId);
  if (!partner || partner.banned) return res.status(404).json({ error: 'Member not found.' });
  if (partner.id === req.user.id) return res.status(400).json({ error: 'You cannot DM yourself.' });
  if (dmBlockedEitherWay(req.user.id, partner.id)) {
    return res.status(403).json({ error: 'Messaging is blocked between you two.' });
  }
  let text = cleanText(req.body.text, 1000);
  if (!text) return res.status(400).json({ error: 'Message is empty.' });
  if (db.settings.profanityMask) text = maskProfanity(text);
  const dm = { id: uid('dm_'), fromId: req.user.id, toId: partner.id, text, createdAt: Date.now(), read: false };
  db.dms.push(dm);
  if (db.dms.length > 10000) db.dms.splice(0, db.dms.length - 10000);
  store.save();
  io.to('user:' + partner.id).emit('dm:new', {
    from: publicUser(req.user, partner),
    message: { id: dm.id, text: dm.text, createdAt: dm.createdAt, mine: false },
  });
  res.status(201).json({ message: { id: dm.id, text: dm.text, createdAt: dm.createdAt, mine: true } });
});

/* ---------------- the Pack Howl ---------------- */
app.get('/api/howl', optionalAuth, (req, res) => {
  const today = dayKey();
  res.json({
    total: db.howl.total,
    today: db.howl.daily.date === today ? db.howl.daily.count : 0,
    mine: req.user && !req.user.banned
      ? { total: req.user.howls.total, streak: req.user.howls.streak }
      : null,
  });
});

/* ---------------- clip battles ---------------- */
app.get('/api/battles', optionalAuth, (req, res) => {
  const viewer = req.user && !req.user.banned ? req.user : null;
  const battles = db.battles.slice().sort((a, b) => b.createdAt - a.createdAt).map((b) => serializeBattle(b, viewer));
  res.json({ battles });
});

app.post('/api/battles', requireAuth, requireFounder, (req, res) => {
  const a = findPost(req.body.postAId);
  const b = findPost(req.body.postBId);
  if (!a || !b) return res.status(404).json({ error: 'Both clips must exist.' });
  if (a.id === b.id) return res.status(400).json({ error: 'A clip cannot battle itself.' });
  const clipsChannel = db.channels.find((c) => c.name === 'Clips & Videos');
  if (!clipsChannel || a.channelId !== clipsChannel.id || b.channelId !== clipsChannel.id) {
    return res.status(400).json({ error: 'Battles use clips from Clips & Videos.' });
  }
  if (db.battles.some((x) => x.status === 'open')) {
    return res.status(400).json({ error: 'A battle is already open — close it first.' });
  }
  let prize = Number.isInteger(req.body.prize) ? req.body.prize : 25;
  prize = Math.max(0, Math.min(500, prize));
  const battle = {
    id: uid('btl_'), round: db.battles.length + 1, postAId: a.id, postBId: b.id,
    votes: {}, status: 'open', winnerPostId: null, prize,
    createdBy: req.user.id, createdAt: Date.now(), closedAt: null,
  };
  db.battles.push(battle);
  store.save();
  securityLog('battle_create', 'round ' + battle.round);
  res.status(201).json({ battle: serializeBattle(battle, req.user) });
});

app.post('/api/battles/:id/vote', requireAuth, (req, res) => {
  const battle = db.battles.find((x) => x.id === req.params.id);
  if (!battle) return res.status(404).json({ error: 'Battle not found.' });
  if (battle.status !== 'open') return res.status(400).json({ error: 'This battle is closed.' });
  const pick = req.body.postId;
  if (pick !== battle.postAId && pick !== battle.postBId) {
    return res.status(400).json({ error: 'Vote for one of the two clips.' });
  }
  battle.votes[req.user.id] = pick;
  store.save();
  res.json({ battle: serializeBattle(battle, req.user) });
});

app.post('/api/battles/:id/close', requireAuth, requireFounder, (req, res) => {
  const battle = db.battles.find((x) => x.id === req.params.id);
  if (!battle) return res.status(404).json({ error: 'Battle not found.' });
  if (battle.status !== 'open') return res.status(400).json({ error: 'Already closed.' });
  const counts = { [battle.postAId]: 0, [battle.postBId]: 0 };
  for (const pid of Object.values(battle.votes)) counts[pid] = (counts[pid] || 0) + 1;
  let winner = null;
  if (req.body.winnerPostId) {
    if (req.body.winnerPostId !== battle.postAId && req.body.winnerPostId !== battle.postBId) {
      return res.status(400).json({ error: 'Winner must be one of the two clips.' });
    }
    winner = req.body.winnerPostId;
  } else if (counts[battle.postAId] > counts[battle.postBId]) winner = battle.postAId;
  else if (counts[battle.postBId] > counts[battle.postAId]) winner = battle.postBId;
  else return res.status(400).json({ error: 'It is a tie — pick the winner yourself.' });
  battle.status = 'closed';
  battle.winnerPostId = winner;
  battle.closedAt = Date.now();
  const winPost = findPost(winner);
  if (winPost) {
    winPost.crowned = true;
    const author = findUser(winPost.authorId);
    if (author && battle.prize > 0) game.awardCoins(store, author, battle.prize, 'battle:prize');
  }
  store.save();
  securityLog('battle_close', 'round ' + battle.round + ' winner ' + winner);
  res.json({ battle: serializeBattle(battle, req.user) });
});

/* ---------------- trivia nights ---------------- */
const TRIVIA_Q_MS = Math.max(500, parseInt(process.env.TRIVIA_QUESTION_MS || '20000', 10) || 20000);
const TRIVIA_GAP_MS = Math.max(100, parseInt(process.env.TRIVIA_GAP_MS || '4000', 10) || 4000);
const TRIVIA_PER_SESSION = 5;
const TRIVIA_REWARD = 10;
const triviaSessions = new Map(); // channelId -> session

function postSystemMessage(channelId, text) {
  const msg = { id: uid('msg_'), authorId: 'system', text, createdAt: Date.now(), system: true };
  if (!db.messages[channelId]) db.messages[channelId] = [];
  db.messages[channelId].push(msg);
  if (db.messages[channelId].length > 1000) db.messages[channelId].splice(0, db.messages[channelId].length - 1000);
  store.saveSoon();
  io.to('chan:' + channelId).emit('chat:message', {
    channelId,
    message: { id: msg.id, text: msg.text, createdAt: msg.createdAt, author: SYSTEM_AUTHOR },
  });
  return msg;
}

function triviaIsLive(session) { return triviaSessions.get(session.channelId) === session; }

function triviaAsk(session) {
  if (!triviaIsLive(session)) return;
  const q = session.questions[session.index];
  session.current = { q, answered: false };
  postSystemMessage(session.channelId,
    '❓ Trivia Q' + (session.index + 1) + '/' + session.questions.length + ': ' + q.q +
    ' (first correct answer wins ' + TRIVIA_REWARD + ' 🪙)');
  session.timer = setTimeout(() => {
    if (!triviaIsLive(session) || !session.current || session.current.answered) return;
    session.current.answered = true;
    postSystemMessage(session.channelId, "⏰ Time's up! The answer was: " + session.current.q.answers[0]);
    triviaNext(session);
  }, TRIVIA_Q_MS);
  if (session.timer.unref) session.timer.unref();
}

function triviaNext(session) {
  if (!triviaIsLive(session)) return;
  if (session.timer) { clearTimeout(session.timer); session.timer = null; }
  session.index += 1;
  if (session.index >= session.questions.length) return triviaEnd(session);
  session.timer = setTimeout(() => triviaAsk(session), TRIVIA_GAP_MS);
  if (session.timer.unref) session.timer.unref();
}

function triviaEnd(session) {
  if (session.timer) { clearTimeout(session.timer); session.timer = null; }
  triviaSessions.delete(session.channelId);
  const scores = [...session.scores.entries()]
    .map(([userId, pts]) => ({ user: findUser(userId), pts }))
    .filter((s) => s.user)
    .sort((a, b) => b.pts - a.pts);
  const line = scores.length
    ? scores.map((s, i) => (i + 1) + '. ' + s.user.displayName + ' — ' + s.pts).join('  ·  ')
    : 'No correct answers — the moon keeps her coins. 🌑';
  postSystemMessage(session.channelId, '🏆 Trivia final scores: ' + line);
}

function triviaCheckAnswer(channelId, user, text) {
  const session = triviaSessions.get(channelId);
  if (!session || !session.current || session.current.answered) return;
  if (!trivia.isCorrect(session.current.q, text)) return;
  session.current.answered = true;
  const granted = game.awardCoins(store, user, TRIVIA_REWARD, 'earn:trivia');
  game.addPoints(user, 5);
  session.scores.set(user.id, (session.scores.get(user.id) || 0) + 1);
  postSystemMessage(channelId,
    '🎉 ' + user.displayName + ' nailed it: "' + session.current.q.answers[0] + '" (+' + granted + ' 🪙)');
  store.saveSoon();
  triviaNext(session);
}

app.get('/api/trivia', optionalAuth, (req, res) => {
  res.json({
    sessions: [...triviaSessions.values()].map((s) => ({
      channelId: s.channelId, index: s.index, total: s.questions.length,
    })),
  });
});

app.post('/api/trivia/start', requireAuth, requireMod, (req, res) => {
  const channel = findChannel(req.body.channelId);
  if (!channel || !canSeeChannel(channel, req.user)) return res.status(404).json({ error: 'Channel not found.' });
  if (triviaSessions.has(channel.id)) return res.status(400).json({ error: 'Trivia is already running in that channel.' });
  const session = {
    channelId: channel.id, startedBy: req.user.id,
    questions: trivia.pickQuestions(TRIVIA_PER_SESSION),
    index: 0, current: null, scores: new Map(), timer: null,
  };
  triviaSessions.set(channel.id, session);
  postSystemMessage(channel.id, '🎲 TRIVIA NIGHT in ' + channel.name + '! ' + session.questions.length +
    ' questions, first correct answer in chat wins ' + TRIVIA_REWARD + ' 🪙 each. Get ready…');
  // First question lands after a beat so everyone's chat is watching.
  session.timer = setTimeout(() => triviaAsk(session), TRIVIA_GAP_MS);
  if (session.timer.unref) session.timer.unref();
  res.status(201).json({ ok: true, channelId: channel.id, questions: session.questions.length });
});

app.post('/api/trivia/stop', requireAuth, requireMod, (req, res) => {
  const session = triviaSessions.get(req.body.channelId);
  if (!session) return res.status(400).json({ error: 'No trivia running in that channel.' });
  postSystemMessage(session.channelId, '🎲 Trivia stopped by the host.');
  triviaEnd(session);
  res.json({ ok: true });
});

/* ---------------- pack jukebox (Music channel) ---------------- */
app.get('/api/jukebox', optionalAuth, (req, res) => {
  const viewer = req.user && !req.user.banned ? req.user : null;
  res.json(serializeJukebox(viewer));
});

app.post('/api/jukebox', requireAuth, (req, res) => {
  const music = db.channels.find((c) => c.name === 'Music');
  if (!music || !canSeeChannel(music, req.user)) return res.status(404).json({ error: 'Music channel not found.' });
  const yt = youtubeId(req.body.youtube || '');
  if (!yt) return res.status(400).json({ error: 'Give a YouTube link.' });
  if (db.jukebox.some((j) => j.youtubeId === yt)) return res.status(400).json({ error: 'That song is already in the queue.' });
  const entry = {
    id: uid('jb_'), addedById: req.user.id, youtubeId: yt,
    title: cleanText(req.body.title, 120) || 'Untitled track',
    votes: {}, createdAt: Date.now(),
  };
  db.jukebox.push(entry);
  game.addPoints(req.user, 3);
  store.save();
  res.status(201).json(serializeJukebox(req.user));
});

app.post('/api/jukebox/:id/vote', requireAuth, (req, res) => {
  const entry = db.jukebox.find((j) => j.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Song not in the queue.' });
  if (entry.votes[req.user.id]) delete entry.votes[req.user.id];
  else entry.votes[req.user.id] = true;
  store.save();
  res.json(serializeJukebox(req.user));
});

app.delete('/api/jukebox/:id', requireAuth, (req, res) => {
  const entry = db.jukebox.find((j) => j.id === req.params.id);
  if (!entry) return res.status(404).json({ error: 'Song not in the queue.' });
  if (entry.addedById !== req.user.id && req.user.role !== 'founder' && req.user.role !== 'moderator') {
    return res.status(403).json({ error: 'Not your song to remove.' });
  }
  db.jukebox = db.jukebox.filter((j) => j.id !== entry.id);
  store.save();
  res.json(serializeJukebox(req.user));
});

app.post('/api/jukebox/next', requireAuth, (req, res) => {
  const state = serializeJukebox(req.user);
  if (!state.nowPlaying) return res.status(400).json({ error: 'The queue is empty.' });
  const top = db.jukebox.find((j) => j.id === state.nowPlaying.id);
  const isStaff = req.user.role === 'founder' || req.user.role === 'moderator';
  if (!isStaff && top.addedById !== req.user.id) {
    return res.status(403).json({ error: 'Only the DJ who queued it, a mod, or the Founder can skip.' });
  }
  db.jukebox = db.jukebox.filter((j) => j.id !== top.id);
  store.save();
  res.json(serializeJukebox(req.user));
});

/* ---------------- events calendar ---------------- */
app.get('/api/events', optionalAuth, (req, res) => {
  const viewer = req.user && !req.user.banned ? req.user : null;
  res.json({ events: upcomingEvents(viewer, 25) });
});

app.post('/api/events', requireAuth, requireFounder, (req, res) => {
  const title = cleanText(req.body.title, 100);
  if (!title) return res.status(400).json({ error: 'Name the event.' });
  const at = Date.parse(req.body.at || '');
  if (Number.isNaN(at)) return res.status(400).json({ error: 'Event needs a valid date/time.' });
  const kind = ['Game Night', 'Movie Night', 'Trivia', 'Stream', 'Other'].includes(req.body.kind) ? req.body.kind : 'Other';
  const event = {
    id: uid('evt_'), title, kind, at: new Date(at).toISOString(),
    description: cleanText(req.body.description, 400),
    createdBy: req.user.id, rsvps: [], createdAt: Date.now(),
  };
  db.events.push(event);
  store.save();
  securityLog('event_create', title);
  res.status(201).json({ event: serializeEvent(event, req.user) });
});

app.post('/api/events/:id/rsvp', requireAuth, (req, res) => {
  const event = db.events.find((e) => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const i = event.rsvps.indexOf(req.user.id);
  if (i >= 0) event.rsvps.splice(i, 1); else event.rsvps.push(req.user.id);
  store.save();
  res.json({ event: serializeEvent(event, req.user) });
});

app.delete('/api/events/:id', requireAuth, requireFounder, (req, res) => {
  const event = db.events.find((e) => e.id === req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  db.events = db.events.filter((e) => e.id !== event.id);
  store.save();
  res.json({ ok: true });
});

/* ---------------- custom pack emotes ---------------- */
const EMOTE_NAME_RE = /^[a-z0-9_]{2,24}$/;
app.get('/api/emotes', optionalAuth, (req, res) => {
  const viewer = req.user && !req.user.banned ? req.user : null;
  res.json({
    approved: db.emotes.filter((e) => e.status === 'approved')
      .map((e) => ({ id: e.id, name: e.name, image: e.image })),
    mine: viewer ? db.emotes.filter((e) => e.submittedBy === viewer.id)
      .map((e) => ({ id: e.id, name: e.name, image: e.image, status: e.status })) : [],
  });
});

app.post('/api/emotes', requireAuth, (req, res) => {
  const name = cleanText(req.body.name, 24).toLowerCase().replace(/^:|:$/g, '');
  if (!EMOTE_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Emote name must be 2–24 lowercase letters, numbers or underscores.' });
  }
  if (db.emotes.some((e) => e.name === name)) return res.status(409).json({ error: 'That emote name is taken.' });
  if (typeof req.body.image !== 'string' || !/^\/uploads\/[a-f0-9]{32}\.(jpg|png|gif|webp)$/.test(req.body.image)) {
    return res.status(400).json({ error: 'Emote needs an uploaded image.' });
  }
  const emote = {
    id: uid('emo_'), name, image: req.body.image,
    submittedBy: req.user.id, status: 'pending', createdAt: Date.now(),
  };
  db.emotes.push(emote);
  store.save();
  res.status(201).json({ emote });
});

app.delete('/api/emotes/:id', requireAuth, (req, res) => {
  const emote = db.emotes.find((e) => e.id === req.params.id);
  if (!emote) return res.status(404).json({ error: 'Emote not found.' });
  if (emote.submittedBy !== req.user.id && req.user.role !== 'founder' && req.user.role !== 'moderator') {
    return res.status(403).json({ error: 'Not your emote.' });
  }
  db.emotes = db.emotes.filter((e) => e.id !== emote.id);
  store.save();
  res.json({ ok: true });
});

/* ---------------- suggestion box ---------------- */
app.get('/api/suggestions', optionalAuth, (req, res) => {
  const viewer = req.user && !req.user.banned ? req.user : null;
  const list = db.suggestions.slice()
    .sort((a, b) => Object.keys(b.votes || {}).length - Object.keys(a.votes || {}).length || b.createdAt - a.createdAt)
    .map((s) => serializeSuggestion(s, viewer));
  res.json({ suggestions: list });
});

app.post('/api/suggestions', requireAuth, (req, res) => {
  let text = cleanText(req.body.text, 300);
  if (!text) return res.status(400).json({ error: 'Write your suggestion.' });
  if (db.settings.profanityMask) text = maskProfanity(text);
  const s = {
    id: uid('sug_'), authorId: req.user.id, text, votes: {}, status: 'open', createdAt: Date.now(),
  };
  db.suggestions.push(s);
  store.save();
  res.status(201).json({ suggestion: serializeSuggestion(s, req.user) });
});

app.post('/api/suggestions/:id/vote', requireAuth, (req, res) => {
  const s = db.suggestions.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Suggestion not found.' });
  if (s.votes[req.user.id]) delete s.votes[req.user.id];
  else s.votes[req.user.id] = true;
  store.save();
  res.json({ suggestion: serializeSuggestion(s, req.user) });
});

app.delete('/api/suggestions/:id', requireAuth, (req, res) => {
  const s = db.suggestions.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Suggestion not found.' });
  if (s.authorId !== req.user.id && req.user.role !== 'founder') {
    return res.status(403).json({ error: 'Not your suggestion.' });
  }
  db.suggestions = db.suggestions.filter((x) => x.id !== s.id);
  store.save();
  res.json({ ok: true });
});

/* ---------------- watch party (state; sockets below) ---------------- */
function partyStateFor() {
  const p = db.partyState;
  if (!p) return null;
  let position = p.position;
  if (p.playing) position += (Date.now() - p.updatedAt) / 1000;
  const host = findUser(p.hostId);
  return {
    videoId: p.videoId, title: p.title, hostId: p.hostId,
    hostName: host ? host.displayName : 'a departed wolf',
    playing: p.playing, position: Math.floor(position), updatedAt: p.updatedAt,
  };
}
function canHostParty(user) {
  if (!user) return false;
  if (user.role === 'founder' || user.role === 'moderator') return true;
  return !!db.partyState && db.partyState.hostId === user.id;
}
app.get('/api/party', optionalAuth, (req, res) => {
  const viewer = req.user && !req.user.banned ? req.user : null;
  res.json({ state: partyStateFor(), canHost: canHostParty(viewer) });
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
  if (typeof b.liveManual === 'boolean') {
    s.liveManual = b.liveManual;
    securityLog('live_toggle', req.user.username + ' set manual live banner ' + (b.liveManual ? 'ON' : 'OFF'));
  }
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
    gate: req.body.gate === '21+' ? '21+' : null,
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
  if ('gate' in b) channel.gate = b.gate === '21+' ? '21+' : null;
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

/* Emote moderation queue (Founder + Mods). */
app.get('/api/admin/emotes', requireAuth, requireMod, (req, res) => {
  const list = db.emotes.slice().sort((a, b) => b.createdAt - a.createdAt).map((e) => ({
    ...e, submitter: publicUser(findUser(e.submittedBy), req.user),
  }));
  res.json({ emotes: list });
});

app.post('/api/admin/emotes/:id/approve', requireAuth, requireMod, (req, res) => {
  const emote = db.emotes.find((e) => e.id === req.params.id);
  if (!emote) return res.status(404).json({ error: 'Emote not found.' });
  emote.status = 'approved';
  store.save();
  securityLog('emote_approve', emote.name + ' by ' + req.user.username);
  res.json({ ok: true, emote });
});

/* Suggestion triage (Founder). */
app.patch('/api/admin/suggestions/:id', requireAuth, requireFounder, (req, res) => {
  const s = db.suggestions.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Suggestion not found.' });
  if (!['open', 'planned', 'done', 'dismissed'].includes(req.body.status)) {
    return res.status(400).json({ error: 'Status must be open, planned, done or dismissed.' });
  }
  s.status = req.body.status;
  store.save();
  res.json({ suggestion: serializeSuggestion(s, req.user) });
});

/* Force a fresh Kick live check (Founder). */
app.post('/api/admin/live-check', requireAuth, requireFounder, async (req, res) => {
  await checkKickLive();
  res.json({ live: liveState() });
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

const partyChat = []; // in-memory Watch Party side-chat (last 50, not persisted)

io.on('connection', (socket) => {
  const user = socket.user;
  socket.join('user:' + user.id); // personal room for DM notifications

  socket.on('chat:join', (channelId) => {
    const channel = findChannel(channelId);
    if (!channel || !canSeeChannel(channel, user)) return;
    socket.join('chan:' + channel.id);
    const history = (db.messages[channel.id] || [])
      .filter((m) => !isHiddenAuthor(m.authorId, user))
      .slice(-50)
      .map((m) => ({ id: m.id, text: m.text, createdAt: m.createdAt, author: authorFor(m.authorId, user) }));
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
    triviaCheckAnswer(channel.id, user, text);
  });

  /* --- The Pack Howl --- */
  let lastHowlAt = 0;
  socket.on('howl:press', () => {
    const now = Date.now();
    if (now - lastHowlAt < 300) return; // gentle anti-spam
    lastHowlAt = now;
    const today = dayKey();
    const h = user.howls;
    if (h.lastDate !== today) {
      const yesterday = dayKey(now - 24 * 3600 * 1000);
      h.streak = h.lastDate === yesterday ? h.streak + 1 : 1;
      h.lastDate = today;
    }
    h.total += 1;
    if (db.howl.daily.date !== today) db.howl.daily = { date: today, count: 0 };
    db.howl.daily.count += 1;
    db.howl.total += 1;
    const badges = game.checkBadges(user);
    store.saveSoon();
    io.emit('howl:update', { total: db.howl.total, today: db.howl.daily.count });
    socket.emit('howl:mine', { total: h.total, streak: h.streak, newBadges: badges });
  });

  /* --- Watch Party: synced YouTube room --- */
  socket.on('party:join', () => {
    socket.join('party');
    socket.emit('party:state', {
      state: partyStateFor(), canHost: canHostParty(user), chat: partyChat.slice(-50),
    });
  });

  socket.on('party:set', (payload) => {
    const yt = youtubeId(payload && payload.youtube || '');
    if (!yt) return;
    // With a video already set, only the host / Founder / Mods may change it.
    if (db.partyState && !canHostParty(user)) return;
    db.partyState = {
      videoId: yt, title: cleanText(payload && payload.title, 120) || 'Watch Party',
      hostId: user.id, playing: true, position: 0, updatedAt: Date.now(),
    };
    store.saveSoon();
    io.to('party').emit('party:state', { state: partyStateFor() });
  });

  socket.on('party:control', (payload) => {
    if (!db.partyState || !canHostParty(user) || !payload) return;
    const p = db.partyState;
    const now = Date.now();
    let pos = p.playing ? p.position + (now - p.updatedAt) / 1000 : p.position;
    if (payload.action === 'play') {
      p.playing = true;
      if (Number.isFinite(payload.position)) pos = payload.position;
    } else if (payload.action === 'pause') {
      p.playing = false;
      if (Number.isFinite(payload.position)) pos = payload.position;
    } else if (payload.action === 'seek') {
      if (!Number.isFinite(payload.position)) return;
      pos = payload.position;
    } else return;
    p.position = Math.max(0, pos);
    p.updatedAt = now;
    store.saveSoon();
    io.to('party').emit('party:state', { state: partyStateFor() });
  });

  socket.on('party:chat', (payload) => {
    let text = cleanText(payload && payload.text, 300);
    if (!text) return;
    if (db.settings.profanityMask) text = maskProfanity(text);
    const m = { id: uid('pmsg_'), text, createdAt: Date.now(), author: publicUser(user, user) };
    partyChat.push(m);
    if (partyChat.length > 50) partyChat.splice(0, partyChat.length - 50);
    io.to('party').emit('party:chat', { message: m });
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
