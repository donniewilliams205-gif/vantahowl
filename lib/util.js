'use strict';

/** YYYY-MM-DD in UTC — the "day" used for daily caps, spins and check-ins. */
function dayKey(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toISOString().slice(0, 10);
}

/** ISO-8601 week key like 2026-W47 (weeks start Monday). */
function weekKey(ts) {
  const d = ts ? new Date(ts) : new Date();
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fdayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fdayNum + 3);
  const week = 1 + Math.round((date - firstThursday) / (7 * 24 * 3600 * 1000));
  return date.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

/** Age in whole years from a YYYY-MM-DD date of birth, or null if invalid. */
function ageFromDob(dob) {
  if (typeof dob !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (!m) return null;
  const birth = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const mm = now.getUTCMonth() - birth.getUTCMonth();
  if (mm < 0 || (mm === 0 && now.getUTCDate() < birth.getUTCDate())) age--;
  return age;
}

/** Extract an 11-char YouTube video id from a URL or bare id; null if none. */
function youtubeId(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  const patterns = [
    /youtube\.com\/watch\?[^#]*v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/live\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = p.exec(s);
    if (m) return m[1];
  }
  return null;
}

/*
 * Image type sniffing by magic bytes. Returns {ext, mime} or null.
 * Never trust the client-supplied filename or Content-Type.
 */
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return { ext: '.png', mime: 'image/png' };
  }
  // GIF: "GIF8"
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { ext: '.gif', mime: 'image/gif' };
  }
  // WebP: "RIFF" .... "WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

/* Small built-in profanity list; masked when the site setting is on. */
const PROFANITY = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'damn', 'cunt', 'dick',
  'pussy', 'whore', 'slut', 'nigger', 'nigga', 'faggot', 'retard',
];
const PROFANITY_RE = new RegExp('\\b(' + PROFANITY.join('|') + ')\\b', 'gi');

function maskProfanity(text) {
  if (typeof text !== 'string') return text;
  return text.replace(PROFANITY_RE, (w) => w[0] + '*'.repeat(Math.max(1, w.length - 1)));
}

/** Escape a string for safe interpolation into HTML (frontend also escapes). */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanText(s, max) {
  if (typeof s !== 'string') return '';
  return s.trim().slice(0, max);
}

module.exports = { dayKey, weekKey, ageFromDob, youtubeId, sniffImage, maskProfanity, escapeHtml, cleanText };
