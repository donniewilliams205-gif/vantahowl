'use strict';
/*
 * Vantahowl JSON datastore.
 * - Single JSON file inside DATA_DIR (db.json).
 * - Writes are atomic: serialize to db.json.tmp, fsync, then rename over db.json.
 * - A rolling backup (db.json.bak) is refreshed on every successful write;
 *   on load, if db.json is missing/corrupt we fall back to the backup.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function uid(prefix) {
  return (prefix || '') + crypto.randomBytes(9).toString('hex');
}

function defaultData() {
  return {
    version: 1,
    settings: {
      siteName: 'Vantahowl',
      announcement: '',
      signupsOpen: true,
      profanityMask: true,
      gameNight: null, // { label, at } ISO instant
      songOfDay: null, // { title, youtubeId }
      spotlightPostId: null,
    },
    users: [], // {id, username, displayName, passwordHash, dob, role, banned, createdAt, coins, points, weekly:{key,points}, dailyEarn:{date,amount}, badges:[], statusLine, accent, vibe:{date,mood}, lastSpinDate, sprintBest, stats:{posts,comments,chats,giftsSent,giftsReceived,pollVotes,checkinDays:[]}, loginFails, lockedUntil}
    channels: [], // {id, name, emoji, topic, hidden, order}
    posts: [], // {id, channelId, authorId, text, image, youtubeId, createdAt, reactions:{emoji:[userId]}, gifts:[{id,fromId,emoji,name,price,at}]}
    comments: [], // {id, postId, authorId, text, createdAt}
    messages: {}, // channelId -> [{id, authorId, text, createdAt}] capped 1000
    polls: [], // {id, channelId, authorId, question, options:[{id,text}], votes:{userId:optionId}, createdAt, closed}
    ledger: [], // {id, userId, delta, reason, at}
    questProgress: [], // {userId, weekKey, questId, progress, claimed}
    lfg: [], // {id, authorId, game, text, createdAt, expiresAt, filled}
    reports: [], // {id, reporterId, targetType, targetId, reason, status, createdAt}
    blocks: [], // {userId, blockedId}
    securityLog: [], // {at, event, detail} append-only, capped 1000
  };
}

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.file = path.join(dataDir, 'db.json');
    this.tmp = path.join(dataDir, 'db.json.tmp');
    this.bak = path.join(dataDir, 'db.json.bak');
    fs.mkdirSync(dataDir, { recursive: true });
    this.data = this._load();
    this._saveTimer = null;
  }

  _load() {
    for (const f of [this.file, this.bak]) {
      try {
        if (fs.existsSync(f)) {
          const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.users)) {
            // shallow-merge with defaults so new fields appear on upgrade
            const d = defaultData();
            const merged = Object.assign(d, parsed);
            merged.settings = Object.assign(d.settings, parsed.settings || {});
            return merged;
          }
        }
      } catch (e) {
        // fall through to next candidate / defaults
      }
    }
    return defaultData();
  }

  save() {
    const json = JSON.stringify(this.data);
    const fd = fs.openSync(this.tmp, 'w');
    try {
      fs.writeSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // keep the previous good file as the rolling backup
    try {
      if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.bak);
    } catch (e) { /* backup is best-effort */ }
    fs.renameSync(this.tmp, this.file);
  }

  /** Debounced save for high-frequency events (chat, reactions). */
  saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try { this.save(); } catch (e) { console.error('store save failed', e); }
    }, 250);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }
}

module.exports = { Store, defaultData, uid };
