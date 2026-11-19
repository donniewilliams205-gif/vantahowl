'use strict';
/*
 * Vantahowl togetherness economy: Howl Coins, gifts, pack ranks,
 * weekly quests, achievement badges, arcade.
 * All coin movement goes through awardCoins() so the ledger always balances.
 */
const crypto = require('crypto');
const { uid } = require('./store');
const { dayKey, weekKey } = require('./util');

const DAILY_EARN_CAP = 50;

const GIFTS = [
  { emoji: '🎁', name: 'Gift Box', price: 10 },
  { emoji: '🌹', name: 'Rose', price: 5 },
  { emoji: '🍕', name: 'Pizza', price: 15 },
  { emoji: '🌿', name: 'Herb', price: 20 },
  { emoji: '🐺', name: 'Wolf Spirit', price: 25 },
  { emoji: '👑', name: 'Crown', price: 50 },
];

const QUEST_POOL = [
  { id: 'howler', icon: '🐺', label: 'Howl it out — make 3 posts', metric: 'posts', target: 3, reward: 20 },
  { id: 'chatter', icon: '💬', label: 'Chatterbox — send 15 chat messages', metric: 'chats', target: 15, reward: 15 },
  { id: 'social', icon: '🤝', label: 'Pack social — leave 5 comments', metric: 'comments', target: 5, reward: 15 },
  { id: 'giver', icon: '🎁', label: 'Generous heart — send 2 gifts', metric: 'giftsSent', target: 2, reward: 20 },
  { id: 'voice', icon: '🗳️', label: 'Have your say — vote in 2 polls', metric: 'pollVotes', target: 2, reward: 10 },
  { id: 'vibes', icon: '🌙', label: 'Vibe keeper — check in on 2 days', metric: 'checkins', target: 2, reward: 15 },
];

/** The 3 quests active for a given week — deterministic rotation. */
function activeQuests(ts) {
  const key = weekKey(ts);
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const start = h % QUEST_POOL.length;
  const out = [];
  for (let i = 0; i < 3; i++) out.push(QUEST_POOL[(start + i) % QUEST_POOL.length]);
  return out;
}

const BADGES = [
  { id: 'first-howl', icon: '🐾', name: 'First Howl', desc: 'Make your first post', test: (u) => u.stats.posts >= 1 },
  { id: 'night-owl', icon: '🦉', name: 'Night Owl', desc: 'Be active between midnight and 6 AM', test: (u) => !!u.stats.nightOwl },
  { id: 'social-wolf', icon: '🐺', name: 'Social Wolf', desc: 'Leave 10 comments', test: (u) => u.stats.comments >= 10 },
  { id: 'sharpshooter', icon: '📸', name: 'Sharpshooter', desc: 'Share 5 photos', test: (u) => u.stats.imagePosts >= 5 },
  { id: 'pack-loyal', icon: '🌕', name: 'Pack Loyal', desc: 'Vibe check-in on 3 different days', test: (u) => (u.stats.checkinDays || []).length >= 3 },
  { id: 'generous-wolf', icon: '💛', name: 'Generous Wolf', desc: 'Send 3 gifts', test: (u) => u.stats.giftsSent >= 3 },
  { id: 'chatterbox', icon: '💬', name: 'Chatterbox', desc: 'Send 50 chat messages', test: (u) => u.stats.chats >= 50 },
  { id: 'pollster', icon: '🗳️', name: 'Pollster', desc: 'Vote in 3 polls', test: (u) => (u.stats.pollsVoted || []).length >= 3 },
  { id: 'coin-baron', icon: '🪙', name: 'Coin Baron', desc: 'Hold 250 Howl Coins at once', test: (u) => u.coins >= 250 },
  { id: 'squad-up', icon: '🎮', name: 'Squad Up', desc: 'Post on the Looking for Squad board', test: (u) => u.stats.lfgPosts >= 1 },
];

function rankFor(points) {
  if (points >= 400) return { id: 'alpha', name: 'Alpha', icon: '👑', next: null };
  if (points >= 100) return { id: 'wolf', name: 'Wolf', icon: '🐺', next: 400 };
  return { id: 'pup', name: 'Pup', icon: '🐾', next: 100 };
}

function ensureUserShape(u) {
  if (typeof u.coins !== 'number') u.coins = 0;
  if (typeof u.points !== 'number') u.points = 0;
  if (!u.weekly || typeof u.weekly !== 'object') u.weekly = { key: weekKey(), points: 0 };
  if (!u.dailyEarn || typeof u.dailyEarn !== 'object') u.dailyEarn = { date: dayKey(), amount: 0 };
  if (!Array.isArray(u.badges)) u.badges = [];
  if (!u.stats || typeof u.stats !== 'object') u.stats = {};
  const s = u.stats;
  for (const k of ['posts', 'comments', 'chats', 'giftsSent', 'giftsReceived', 'imagePosts', 'lfgPosts']) {
    if (typeof s[k] !== 'number') s[k] = 0;
  }
  if (!Array.isArray(s.checkinDays)) s.checkinDays = [];
  if (!Array.isArray(s.pollsVoted)) s.pollsVoted = [];
  return u;
}

/**
 * Move coins. Positive deltas with reason starting "earn:" are activity
 * earnings and respect the daily cap (returns the amount actually granted).
 * All movements are written to the ledger. Returns amount applied.
 */
function awardCoins(store, user, delta, reason) {
  ensureUserShape(user);
  let applied = delta;
  if (delta > 0 && reason.startsWith('earn:')) {
    const today = dayKey();
    if (user.dailyEarn.date !== today) user.dailyEarn = { date: today, amount: 0 };
    const room = Math.max(0, DAILY_EARN_CAP - user.dailyEarn.amount);
    applied = Math.min(delta, room);
    user.dailyEarn.amount += applied;
  }
  if (applied === 0) return 0;
  user.coins += applied;
  if (user.coins < 0) user.coins = 0;
  store.data.ledger.push({ id: uid('led_'), userId: user.id, delta: applied, reason, at: Date.now() });
  if (store.data.ledger.length > 5000) store.data.ledger.splice(0, store.data.ledger.length - 5000);
  return applied;
}

function addPoints(user, n) {
  ensureUserShape(user);
  user.points += n;
  const wk = weekKey();
  if (user.weekly.key !== wk) user.weekly = { key: wk, points: 0 };
  user.weekly.points += n;
}

function questRecord(store, user, questId) {
  const wk = weekKey();
  let rec = store.data.questProgress.find((q) => q.userId === user.id && q.weekKey === wk && q.questId === questId);
  if (!rec) {
    rec = { userId: user.id, weekKey: wk, questId, progress: 0, claimed: false };
    store.data.questProgress.push(rec);
  }
  return rec;
}

/** Increment any active quest matching this metric. */
function bumpQuest(store, user, metric, n) {
  for (const q of activeQuests()) {
    if (q.metric !== metric) continue;
    const rec = questRecord(store, user, q.id);
    rec.progress = Math.min(q.target, rec.progress + (n || 1));
  }
}

/** Award any newly-earned badges; returns the badge defs newly granted. */
function checkBadges(user) {
  ensureUserShape(user);
  const fresh = [];
  for (const b of BADGES) {
    if (!user.badges.includes(b.id) && b.test(user)) {
      user.badges.push(b.id);
      fresh.push(b);
    }
  }
  return fresh;
}

/** Note activity for stats that depend on the clock (Night Owl). */
function noteActivityHour(user) {
  const h = new Date().getHours();
  if (h >= 0 && h < 6) user.stats.nightOwl = true;
}

const SPIN_TABLE = [
  { amount: 0, weight: 20 }, { amount: 5, weight: 25 }, { amount: 10, weight: 20 },
  { amount: 15, weight: 12 }, { amount: 20, weight: 10 }, { amount: 25, weight: 6 },
  { amount: 30, weight: 4 }, { amount: 40, weight: 3 },
];

function drawSpin() {
  const total = SPIN_TABLE.reduce((a, s) => a + s.weight, 0);
  let r = crypto.randomInt(total);
  for (const s of SPIN_TABLE) {
    if (r < s.weight) return s.amount;
    r -= s.weight;
  }
  return 0;
}

module.exports = {
  GIFTS, QUEST_POOL, BADGES, DAILY_EARN_CAP,
  activeQuests, rankFor, ensureUserShape, awardCoins, addPoints,
  questRecord, bumpQuest, checkBadges, noteActivityHour, drawSpin,
};
