'use strict';
/* Vantahowl frontend — vanilla JS SPA. All user content is escaped before render. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  me: null, csrf: null, settings: null, channels: [], gifts: [], badgesMeta: [],
  reactions: [], vibes: [], currentChannel: null, socket: null,
  gnTimer: null, uploadUrl: null,
  emotes: [], live: null, dmUnread: 0, dmPartner: null,
  party: { state: null, canHost: false },
  emoteUploadUrl: null, bannerUrl: undefined,
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtTime(ts) { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }

/* Escape first, then swap :emote: tokens for approved pack emote images. */
function richText(s) {
  let out = esc(s);
  if (state.emotes.length) {
    out = out.replace(/:([a-z0-9_]{2,24}):/g, (m, name) => {
      const e = state.emotes.find((x) => x.name === name);
      return e ? '<img class="emote-img" src="' + esc(e.image) + '" alt=":' + esc(name) + ':" title=":' + esc(name) + ':">' : m;
    });
  }
  return out;
}

function setDmUnread(n) {
  state.dmUnread = Math.max(0, n || 0);
  const badge = $('#dmBadge');
  badge.hidden = state.dmUnread === 0;
  badge.textContent = state.dmUnread;
}

function applyLive() {
  const live = state.live;
  const banner = $('#liveBanner');
  if (!live) { banner.hidden = true; return; }
  banner.hidden = !live.show;
  if (live.url) banner.href = live.url;
}

async function api(path, opts) {
  opts = opts || {};
  const headers = { 'Content-Type': 'application/json' };
  if (state.csrf && opts.method && opts.method !== 'GET') headers['x-csrf-token'] = state.csrf;
  const res = await fetch(path, {
    method: opts.method || 'GET', headers, credentials: 'same-origin',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) throw new Error(data.error || ('Request failed: ' + res.status));
  return data;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}
function badgeToasts(badges) {
  (badges || []).forEach((b) => toast('🏅 Badge unlocked: ' + b.icon + ' ' + b.name));
}
function setCoins(n) {
  if (typeof n === 'number') { $('#coinCount').textContent = n; if (state.me) state.me.coins = n; }
}

function authorHtml(a) {
  if (!a) return '<span class="author">a departed wolf</span>';
  const crown = a.role === 'founder' ? ' <span class="founder-badge">👑 Founder</span>' : a.role === 'moderator' ? ' <span class="mod-badge">🛡️ Mod</span>' : '';
  const playing = a.nowPlaying ? ' <span class="now-playing">🎮 ' + esc(a.nowPlaying) + '</span>' : '';
  return '<span class="author" style="color:' + esc(a.accent || '#f2f0ea') + '">' + esc(a.displayName) +
    '</span> <span class="rank">' + esc(a.rank.icon) + ' ' + esc(a.rank.name) + '</span>' + crown + playing;
}

/* ---------------- starfield ---------------- */
(function stars() {
  const cv = $('#stars'), ctx = cv.getContext('2d');
  let pts = [];
  function size() {
    cv.width = innerWidth; cv.height = innerHeight;
    pts = Array.from({ length: 140 }, () => ({ x: Math.random() * cv.width, y: Math.random() * cv.height, r: Math.random() * 1.4 + .3, p: Math.random() * Math.PI * 2 }));
  }
  size(); addEventListener('resize', size);
  (function draw(t) {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const s of pts) {
      ctx.globalAlpha = .35 + .35 * Math.sin(t / 900 + s.p);
      ctx.fillStyle = '#ffe9b0';
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(draw);
  })(0);
})();

/* ---------------- bootstrap ---------------- */
async function boot() {
  const data = await api('/api/bootstrap');
  state.settings = data.settings;
  state.me = data.user;
  state.csrf = data.csrfToken;
  state.channels = data.channels;
  state.gifts = data.gifts;
  state.badgesMeta = data.badges;
  state.reactions = data.reactions;
  state.vibes = data.vibes;
  state.emotes = data.emotes || [];
  state.live = data.live || null;
  applyLive();
  setDmUnread(data.dmUnread || 0);
  renderEmoteBar();
  renderHeader();
  renderChannels();
  applySettings();
  loadHowl();
  const lobby = state.channels.find((c) => c.name === 'The Lobby') || state.channels[0];
  if (lobby) selectChannel(lobby.id);
  if (state.me) connectSocket();
  renderVibes();
}

function applySettings() {
  const s = state.settings;
  document.title = s.siteName + ' — One Pack. One Howl.';
  $('#brandName').textContent = s.siteName.toUpperCase();
  $('#heroTitle').textContent = s.siteName.toUpperCase();
  $('#announcement').textContent = s.announcement || '';
  clearInterval(state.gnTimer);
  if (s.gameNight && s.gameNight.at) {
    $('#gameNightCard').hidden = false;
    $('#gnLabel').textContent = '🎮 ' + s.gameNight.label;
    const target = new Date(s.gameNight.at).getTime();
    const tick = () => {
      const diff = target - Date.now();
      if (diff <= 0) { $('#gnCount').textContent = 'Happening now — howl loud! 🐺'; return; }
      const d = Math.floor(diff / 864e5), h = Math.floor(diff / 36e5) % 24, m = Math.floor(diff / 6e4) % 60, sec = Math.floor(diff / 1e3) % 60;
      $('#gnCount').textContent = (d ? d + 'd ' : '') + h + 'h ' + m + 'm ' + sec + 's';
    };
    tick(); state.gnTimer = setInterval(tick, 1000);
  } else {
    $('#gameNightCard').hidden = true;
  }
}

function renderHeader() {
  const me = state.me;
  $('#navAuthBtn').hidden = !!me;
  $('#userChip').hidden = !me;
  $('#coinPill').hidden = !me;
  $('#composer').hidden = !me;
  $('#signinHint').hidden = !!me;
  $('#lfgFormCard').hidden = !me;
  $('#chatHint').hidden = !!me;
  $('#consoleNav').hidden = !(me && (me.role === 'founder' || me.role === 'moderator'));
  if (me) {
    $('#userChipName').textContent = me.displayName;
    $('#userChipBadge').innerHTML = me.role === 'founder' ? '<span class="founder-badge">👑 Founder</span>' : me.role === 'moderator' ? '<span class="mod-badge">🛡️ Mod</span>' : '';
    setCoins(me.coins);
  }
}

function renderChannels() {
  const box = $('#channelList');
  box.innerHTML = '';
  for (const c of state.channels) {
    const b = document.createElement('button');
    b.className = state.currentChannel === c.id ? 'active' : '';
    b.innerHTML = esc(c.emoji) + ' ' + esc(c.name) + (c.topic ? '<span class="channel-topic">' + esc(c.topic) + '</span>' : '');
    b.onclick = () => selectChannel(c.id);
    box.appendChild(b);
  }
}

function selectChannel(id) {
  state.currentChannel = id;
  renderChannels();
  const ch = state.channels.find((c) => c.id === id);
  $('#chatChannelName').textContent = ch ? ch.name : '';
  loadFeed();
  if (state.socket) state.socket.emit('chat:join', id);
  else loadChatHistory(id);
}

/* ---------------- feed ---------------- */
async function loadFeed() {
  const id = state.currentChannel;
  if (!id) return;
  const data = await api('/api/channels/' + id + '/feed');
  const list = $('#feedList');
  list.innerHTML = '';
  renderLobbySlot(data);
  renderJukebox(data.jukebox);
  $('#spotlightSlot').innerHTML = data.spotlight ? postHtml(data.spotlight, true) : '';
  $('#songSlot').innerHTML = data.songOfDay
    ? '<div class="card post spotlight"><div class="spotlight-tag">🎵 SONG OF THE DAY</div><h3>' + esc(data.songOfDay.title) + '</h3>' +
      '<iframe class="yt-frame" src="https://www.youtube-nocookie.com/embed/' + esc(data.songOfDay.youtubeId) + '" allowfullscreen title="Song of the Day"></iframe></div>'
    : '';
  for (const poll of data.polls) list.appendChild(pollEl(poll));
  for (const post of data.posts) list.appendChild(postEl(post));
  if (!data.polls.length && !data.posts.length) {
    list.innerHTML = '<div class="card"><p class="muted">Nothing here yet — be the first to howl. 🐺</p></div>';
  }
  bindPostEvents(list);
  bindPostEvents($('#spotlightSlot'));
}

/* Lobby extras: Pack MVP spotlight + upcoming events with RSVP. */
function renderLobbySlot(data) {
  const slot = $('#lobbySlot');
  let html = '';
  if (data.mvp) {
    html += '<div class="card post spotlight"><div class="spotlight-tag">⭐ PACK MVP OF THE WEEK</div>' +
      '<div class="post-head"><div>' + authorHtml(data.mvp.user) + '</div><span class="post-time">' + data.mvp.weeklyPoints + ' pts this week</span></div>' +
      '<p class="muted">The most active wolf in the pack right now. Howl loud for them! 🐺</p></div>';
  }
  if (data.events && data.events.length) {
    html += '<div class="card"><h3>📅 Coming Up</h3>' + data.events.map((e) =>
      '<div class="event-row"><div><b>' + esc(e.title) + '</b> <span class="muted">· ' + esc(e.kind) + ' · ' +
      new Date(e.at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</span>' +
      (e.description ? '<br><span class="muted">' + esc(e.description) + '</span>' : '') +
      '<br><span class="tiny muted">' + e.going + ' going</span></div>' +
      (state.me ? '<button class="btn ' + (e.mine ? 'gold' : 'ghost') + ' small" data-rsvp="' + e.id + '">' + (e.mine ? '✓ Going' : 'RSVP') + '</button>' : '') +
      '</div>').join('') + '</div>';
  }
  slot.innerHTML = html;
  slot.querySelectorAll('[data-rsvp]').forEach((b) => b.onclick = async () => {
    try { await api('/api/events/' + b.dataset.rsvp + '/rsvp', { method: 'POST' }); loadFeed(); } catch (e) { toast(e.message); }
  });
}

/* Music channel jukebox panel. */
function renderJukebox(jb) {
  const slot = $('#jukeboxSlot');
  if (!jb) { slot.innerHTML = ''; return; }
  const np = jb.nowPlaying;
  let html = '<div class="card"><h3>🎧 Pack Jukebox</h3>';
  html += np
    ? '<div class="spotlight-tag">▶ NOW PLAYING</div><iframe class="yt-frame" src="https://www.youtube-nocookie.com/embed/' + esc(np.youtubeId) + '" allowfullscreen title="Now playing"></iframe>' +
      '<p><b>' + esc(np.title) + '</b> <span class="muted">queued by ' + esc(np.addedBy ? np.addedBy.displayName : '?') + ' · ' + np.votes + ' votes</span></p>'
    : '<p class="muted">The queue is silent. Drop the first track.</p>';
  html += jb.queue.map((j) =>
    '<div class="lb-row"><span>' + esc(j.title) + ' <span class="muted tiny">by ' + esc(j.addedBy ? j.addedBy.displayName : '?') + '</span></span>' +
    '<span><button class="btn ' + (j.mine ? 'gold' : 'ghost') + ' small" data-jb-vote="' + j.id + '">▲ ' + j.votes + '</button> ' +
    '<button class="btn ghost small" data-jb-del="' + j.id + '">✕</button></span></div>').join('');
  if (state.me) {
    html += '<div class="composer-row"><input type="text" id="jbUrl" placeholder="YouTube link"><input type="text" id="jbTitle" maxlength="120" placeholder="Title"><button class="btn primary small" id="jbAdd">Queue it</button>' +
      (np ? '<button class="btn ghost small" id="jbNext">⏭ Skip (DJ / mod)</button>' : '') + '</div>';
  }
  html += '</div>';
  slot.innerHTML = html;
  slot.querySelectorAll('[data-jb-vote]').forEach((b) => b.onclick = async () => {
    if (!state.me) return toast('Sign in to vote.');
    try { const d = await api('/api/jukebox/' + b.dataset.jbVote + '/vote', { method: 'POST' }); renderJukebox(d); } catch (e) { toast(e.message); }
  });
  slot.querySelectorAll('[data-jb-del]').forEach((b) => b.onclick = async () => {
    try { const d = await api('/api/jukebox/' + b.dataset.jbDel, { method: 'DELETE' }); renderJukebox(d); } catch (e) { toast(e.message); }
  });
  const add = $('#jbAdd');
  if (add) add.onclick = async () => {
    try {
      const d = await api('/api/jukebox', { method: 'POST', body: { youtube: $('#jbUrl').value, title: $('#jbTitle').value } });
      renderJukebox(d);
      toast('Queued! 🎧');
    } catch (e) { toast(e.message); }
  };
  const next = $('#jbNext');
  if (next) next.onclick = async () => {
    try { const d = await api('/api/jukebox/next', { method: 'POST' }); renderJukebox(d); } catch (e) { toast(e.message); }
  };
}

function reactionsHtml(p) {
  return state.reactions.map((e) => {
    const r = p.reactions[e];
    const count = r ? r.count : 0;
    return '<button class="react-btn' + (r && r.mine ? ' mine' : '') + '" data-react="' + e + '" data-post="' + p.id + '">' + e + (count ? ' ' + count : '') + '</button>';
  }).join('');
}

function postHtml(p, isSpotlight) {
  const mine = state.me && p.author && state.me.id === p.author.id;
  const staff = state.me && (state.me.role === 'founder' || state.me.role === 'moderator');
  const gifts = (p.gifts || []).length
    ? '<div class="gifts-line">🎁 ' + p.gifts.map((g) => esc(g.emoji) + ' from ' + esc(g.from ? g.from.displayName : 'someone')).join(' · ') + '</div>' : '';
  return '<article class="card post' + (isSpotlight || p.spotlight ? ' spotlight' : '') + '" id="post-' + p.id + '">' +
    (isSpotlight || p.spotlight ? '<div class="spotlight-tag">👑 FOUNDER SPOTLIGHT</div>' : '') +
    (p.crowned ? '<div class="spotlight-tag">👑 CLIP BATTLE CHAMPION</div>' : '') +
    '<div class="post-head"><div>' + authorHtml(p.author) + '</div><span class="post-time">' + fmtTime(p.createdAt) + '</span></div>' +
    (p.text ? '<div class="post-text">' + richText(p.text) + '</div>' : '') +
    (p.image ? '<img class="post-img" src="' + esc(p.image) + '" alt="post image">' : '') +
    (p.youtubeId ? '<iframe class="yt-frame" src="https://www.youtube-nocookie.com/embed/' + esc(p.youtubeId) + '" allowfullscreen title="video"></iframe>' : '') +
    gifts +
    '<div class="reactions">' + reactionsHtml(p) + '</div>' +
    '<div class="post-actions">' +
      '<button class="btn ghost small" data-act="gift" data-post="' + p.id + '">🎁 Gift</button>' +
      (state.me && state.me.role === 'founder' && !p.spotlight ? '<button class="btn ghost small" data-act="spotlight" data-post="' + p.id + '">👑 Spotlight</button>' : '') +
      (mine || staff ? '<button class="btn ghost small" data-act="delete" data-post="' + p.id + '">🗑️ Delete</button>' : '') +
      (state.me && p.author && !mine ? '<button class="btn ghost small" data-act="report" data-post="' + p.id + '">🚩 Report</button>' : '') +
    '</div>' +
    '<div class="gift-picker" id="gifts-' + p.id + '" hidden>' +
      state.gifts.map((g) => '<button class="gift-btn" data-gift="' + g.emoji + '" data-post="' + p.id + '">' + g.emoji + ' ' + esc(g.name) + ' · ' + g.price + '🪙</button>').join('') +
    '</div>' +
    '<div class="comments">' +
      p.comments.map((c) => '<div class="comment">' + authorHtml(c.author) + ' — ' + richText(c.text) + '</div>').join('') +
      (state.me ? '<form class="comment-form" data-post="' + p.id + '"><input type="text" maxlength="600" placeholder="Add a comment…"><button class="btn primary small" type="submit">Reply</button></form>' : '') +
    '</div></article>';
}

function postEl(p) {
  const wrap = document.createElement('div');
  wrap.innerHTML = postHtml(p, false);
  return wrap.firstElementChild;
}

function pollEl(poll) {
  const el = document.createElement('div');
  el.className = 'card post';
  el.innerHTML = '<div class="post-head"><div>' + authorHtml(poll.author) + '</div><span class="post-time">' + fmtTime(poll.createdAt) + '</span></div>' +
    '<div class="post-text">📊 ' + esc(poll.question) + '</div>' +
    poll.options.map((o) =>
      '<button class="btn ghost poll-opt-btn" data-vote="' + poll.id + '" data-opt="' + o.id + '">' +
      (poll.myVote === o.id ? '✓ ' : '') + esc(o.text) + ' — ' + o.pct + '% (' + o.count + ')</button>' +
      '<div class="poll-bar"><div class="poll-fill" style="width:' + o.pct + '%"></div></div>').join('') +
    '<p class="muted tiny">' + poll.totalVotes + ' votes · tap to vote or change your vote</p>';
  el.querySelectorAll('[data-vote]').forEach((b) => b.onclick = async () => {
    if (!state.me) return toast('Sign in to vote.');
    try {
      const data = await api('/api/polls/' + b.dataset.vote + '/vote', { method: 'POST', body: { optionId: b.dataset.opt } });
      const fresh = pollEl(data.poll);
      el.replaceWith(fresh);
    } catch (e) { toast(e.message); }
  });
  return el;
}

function bindPostEvents(root) {
  root.querySelectorAll('[data-react]').forEach((b) => b.onclick = async () => {
    if (!state.me) return toast('Sign in to react.');
    try {
      const data = await api('/api/posts/' + b.dataset.post + '/react', { method: 'POST', body: { emoji: b.dataset.react } });
      const article = $('#post-' + b.dataset.post);
      if (article) article.querySelector('.reactions').innerHTML = state.reactions.map((e) => {
        const r = data.reactions[e]; const count = r ? r.count : 0;
        return '<button class="react-btn' + (r && r.mine ? ' mine' : '') + '" data-react="' + e + '" data-post="' + b.dataset.post + '">' + e + (count ? ' ' + count : '') + '</button>';
      }).join(''), bindPostEvents(article);
    } catch (e) { toast(e.message); }
  });
  root.querySelectorAll('[data-act="gift"]').forEach((b) => b.onclick = () => {
    if (!state.me) return toast('Sign in to gift.');
    const picker = $('#gifts-' + b.dataset.post);
    if (picker) picker.hidden = !picker.hidden;
  });
  root.querySelectorAll('[data-gift]').forEach((b) => b.onclick = async () => {
    try {
      const data = await api('/api/gifts', { method: 'POST', body: { gift: b.dataset.gift, postId: b.dataset.post } });
      setCoins(data.myCoins);
      badgeToasts(data.newBadges);
      toast('Gift sent! 🎁');
      loadFeed();
    } catch (e) { toast(e.message); }
  });
  root.querySelectorAll('[data-act="delete"]').forEach((b) => b.onclick = async () => {
    if (!confirm('Delete this post?')) return;
    try { await api('/api/posts/' + b.dataset.post, { method: 'DELETE' }); loadFeed(); } catch (e) { toast(e.message); }
  });
  root.querySelectorAll('[data-act="spotlight"]').forEach((b) => b.onclick = async () => {
    try { await api('/api/admin/posts/' + b.dataset.post + '/spotlight', { method: 'POST' }); toast('Pinned as Founder Spotlight 👑'); loadFeed(); } catch (e) { toast(e.message); }
  });
  root.querySelectorAll('[data-act="report"]').forEach((b) => b.onclick = async () => {
    const reason = prompt('Why are you reporting this post?');
    if (!reason) return;
    try { await api('/api/reports', { method: 'POST', body: { targetType: 'post', targetId: b.dataset.post, reason } }); toast('Reported — the mods have it. 🛡️'); } catch (e) { toast(e.message); }
  });
  root.querySelectorAll('.comment-form').forEach((f) => f.onsubmit = async (ev) => {
    ev.preventDefault();
    const input = f.querySelector('input');
    if (!input.value.trim()) return;
    try {
      const data = await api('/api/posts/' + f.dataset.post + '/comments', { method: 'POST', body: { text: input.value } });
      badgeToasts(data.newBadges);
      loadFeed();
    } catch (e) { toast(e.message); }
  });
}

/* composer */
$('#postImage').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  $('#postImageName').textContent = 'Uploading ' + file.name + '…';
  const fd = new FormData();
  fd.append('image', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': state.csrf }, body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    state.uploadUrl = data.url;
    $('#postImageName').textContent = '✓ ' + file.name;
  } catch (e) {
    $('#postImageName').textContent = '';
    toast(e.message);
  }
});

$('#postBtn').addEventListener('click', async () => {
  const body = { text: $('#postText').value, youtube: $('#postYoutube').value, image: state.uploadUrl };
  try {
    const data = await api('/api/channels/' + state.currentChannel + '/posts', { method: 'POST', body });
    $('#postText').value = ''; $('#postYoutube').value = ''; $('#postImage').value = '';
    $('#postImageName').textContent = ''; state.uploadUrl = null;
    badgeToasts(data.post.newBadges);
    loadFeed();
  } catch (e) { toast(e.message); }
});

$('#pollToggle').addEventListener('click', () => { $('#pollForm').hidden = !$('#pollForm').hidden; });
$('#pollBtn').addEventListener('click', async () => {
  const options = $$('.poll-opt').map((i) => i.value).filter(Boolean);
  try {
    await api('/api/channels/' + state.currentChannel + '/polls', { method: 'POST', body: { question: $('#pollQuestion').value, options } });
    $('#pollQuestion').value = ''; $$('.poll-opt').forEach((i) => i.value = '');
    $('#pollForm').hidden = true;
    loadFeed();
  } catch (e) { toast(e.message); }
});

/* ---------------- chat ---------------- */
async function loadChatHistory(channelId) {
  try {
    const data = await api('/api/channels/' + channelId + '/messages');
    renderChat(data.messages);
  } catch (e) { /* anonymous or missing channel */ }
}
function renderChat(messages) {
  const box = $('#chatMessages');
  box.innerHTML = messages.map(chatMsgHtml).join('');
  box.scrollTop = box.scrollHeight;
}
function chatMsgHtml(m) {
  return '<div class="chat-msg" id="msg-' + m.id + '">' + authorHtml(m.author) +
    '<span class="post-time">' + fmtTime(m.createdAt) + '</span><br>' + richText(m.text) + '</div>';
}
function connectSocket() {
  if (state.socket) { state.socket.disconnect(); }
  const socket = io({ withCredentials: true });
  state.socket = socket;
  socket.on('connect', () => { if (state.currentChannel) socket.emit('chat:join', state.currentChannel); });
  socket.on('chat:history', (data) => { if (data.channelId === state.currentChannel) renderChat(data.messages); });
  socket.on('chat:message', (data) => {
    if (data.channelId !== state.currentChannel) return;
    const box = $('#chatMessages');
    box.insertAdjacentHTML('beforeend', chatMsgHtml(data.message));
    box.scrollTop = box.scrollHeight;
  });
  socket.on('chat:deleted', (data) => {
    const el = $('#msg-' + data.messageId);
    if (el) el.remove();
  });
  socket.on('dm:new', (data) => {
    if (state.dmPartner === data.from.id && !$('#view-messages').hidden) {
      const box = $('#dmMessages');
      box.insertAdjacentHTML('beforeend', dmMsgHtml({ ...data.message, mine: false }));
      box.scrollTop = box.scrollHeight;
      api('/api/dms/' + data.from.id).catch(() => {}); // mark read
    } else {
      setDmUnread(state.dmUnread + 1);
      toast('✉️ ' + data.from.displayName + ': ' + data.message.text.slice(0, 60));
    }
    if (!$('#view-messages').hidden && state.dmPartner !== data.from.id) loadDmList();
  });
  socket.on('howl:update', (data) => {
    $('#howlTotal').textContent = data.total;
    $('#howlToday').textContent = data.today;
  });
  socket.on('howl:mine', (data) => {
    $('#howlMine').textContent = data.total;
    $('#howlStreak').textContent = data.streak;
    badgeToasts(data.newBadges);
  });
  initLoungeSocket(socket);
  initPartySocket(socket);
}
$('#chatForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = $('#chatInput');
  if (!state.me) return toast('Sign in to chat.');
  if (!state.socket) return toast('Chat is connecting…');
  const text = input.value.trim();
  if (!text) return;
  state.socket.emit('chat:send', { channelId: state.currentChannel, text });
  input.value = '';
});

/* ---------------- navigation ---------------- */
$$('.side-nav button').forEach((b) => b.addEventListener('click', () => {
  $$('.side-nav button').forEach((x) => x.classList.toggle('active', x === b));
  $$('.view').forEach((v) => v.hidden = true);
  $('#view-' + b.dataset.nav).hidden = false;
  if (b.dataset.nav === 'pack') loadPack();
  if (b.dataset.nav === 'arcade') loadArcade();
  if (b.dataset.nav === 'lfg') loadLfg();
  if (b.dataset.nav === 'members') loadMembers();
  if (b.dataset.nav === 'console') loadConsole();
  if (b.dataset.nav === 'messages') loadDmList();
  if (b.dataset.nav === 'watchparty') openParty();
  if (b.dataset.nav === 'battles') loadBattles();
  if (b.dataset.nav === 'ideas') loadIdeas();
}));

/* ---------------- pack view ---------------- */
function renderVibes() {
  const row = $('#vibeRow');
  row.innerHTML = '';
  for (const v of state.vibes) {
    const b = document.createElement('button');
    b.className = 'btn ghost';
    b.textContent = v;
    b.onclick = async () => {
      if (!state.me) return toast('Sign in to check in.');
      try {
        const data = await api('/api/vibe', { method: 'POST', body: { mood: v } });
        setCoins(data.coins);
        state.me.vibe = data.vibe;
        badgeToasts(data.newBadges);
        $('#vibeStatus').textContent = 'Today: ' + v + ' 🌙 (+3 Howl Coins)';
        toast('Vibe checked in: ' + v);
        if (data.streak) {
          state.me.streak = data.streak.streak;
          state.me.streakBest = data.streak.best;
          if (data.streak.bonus > 0) toast('🔥 ' + data.streak.milestone + '-day streak milestone: +' + data.streak.bonus + ' 🪙!');
        }
      } catch (e) { toast(e.message); }
    };
    row.appendChild(b);
  }
  if (state.me && state.me.vibe && state.me.vibe.date === new Date().toISOString().slice(0, 10)) {
    $('#vibeStatus').textContent = 'Today: ' + state.me.vibe.mood + ' 🌙';
  }
}

async function loadPack() {
  try {
    const lb = await api('/api/leaderboard');
    $('#leaderboard').innerHTML = lb.top.length
      ? lb.top.map((r, i) => '<div class="lb-row"><span>' + (i + 1) + '. ' + authorHtml(r.user) + '</span><b>' + r.weeklyPoints + ' pts</b></div>').join('')
      : '<p class="muted">No points yet this week — the moon is waiting.</p>';
  } catch (e) { /* ignore */ }
  if (!state.me) {
    $('#questList').innerHTML = '<p class="muted">Sign in to take on weekly quests.</p>';
    $('#myRank').innerHTML = '<p class="muted">Sign in to see your pack card.</p>';
    $('#badgeCase').innerHTML = '';
    return;
  }
  try {
    const q = await api('/api/quests');
    $('#questList').innerHTML = '';
    for (const quest of q.quests) {
      const row = document.createElement('div');
      row.className = 'quest';
      row.innerHTML = '<div><div>' + quest.icon + ' ' + esc(quest.label) + '</div>' +
        '<div class="quest-bar"><div class="quest-fill" style="width:' + Math.round(quest.progress / quest.target * 100) + '%"></div></div>' +
        '<span class="muted tiny">' + quest.progress + '/' + quest.target + ' · reward ' + quest.reward + '🪙</span></div>';
      if (quest.claimed) row.innerHTML += '<span class="founder-badge">✓ Claimed</span>';
      else if (quest.complete) {
        const btn = document.createElement('button');
        btn.className = 'btn gold small';
        btn.textContent = 'Claim ' + quest.reward + '🪙';
        btn.onclick = async () => {
          try {
            const data = await api('/api/quests/claim', { method: 'POST', body: { questId: quest.id } });
            setCoins(data.coins);
            toast('Quest reward claimed: +' + data.reward + ' Howl Coins 🪙');
            loadPack();
          } catch (e) { toast(e.message); }
        };
        row.appendChild(btn);
      }
      $('#questList').appendChild(row);
    }
  } catch (e) { toast(e.message); }
  const me = state.me;
  $('#myRank').innerHTML = '<div class="rank-big">' + esc(me.rank.icon) + ' ' + esc(me.rank.name) + '</div>' +
    '<p class="muted">' + me.points + ' lifetime points · ' + (me.weeklyPoints || 0) + ' this week · 🪙 ' + me.coins + ' Howl Coins' +
    (me.rank.next ? ' · next rank at ' + me.rank.next + ' points' : ' · top rank — lead the pack 👑') + '<br>' +
    '🔥 Login streak: <b>' + (me.streak || 0) + ' days</b> (best ' + (me.streakBest || 0) + ') · 🐺 ' + (me.howls ? me.howls.total : 0) + ' howls · 🌟 ' + (me.kudosReceived || 0) + ' kudos received</p>';
  $('#badgeCase').innerHTML = state.badgesMeta.map((b) => {
    const owned = me.badges.includes(b.id);
    return '<div class="badge-item' + (owned ? '' : ' locked') + '"><span class="b-icon">' + b.icon + '</span>' + esc(b.name) + '<br><span>' + esc(b.desc) + '</span></div>';
  }).join('');
  initProfileEdit();
  loadMyEmotes();
  renderEmoteBar();
  loadHowl();
}

/* ---------------- arcade ---------------- */
let sprintState = 'idle', sprintTimer = null, sprintStart = 0;
$('#sprintBox').addEventListener('click', async () => {
  const box = $('#sprintBox');
  if (!state.me) return toast('Sign in to sprint.');
  if (sprintState === 'idle') {
    sprintState = 'armed';
    box.className = 'sprint-box armed';
    box.textContent = 'Wait for gold…';
    $('#sprintStatus').textContent = '';
    sprintTimer = setTimeout(() => {
      sprintState = 'go';
      sprintStart = performance.now();
      box.className = 'sprint-box go';
      box.textContent = 'HOWL! CLICK!';
    }, 1200 + Math.random() * 3000);
  } else if (sprintState === 'armed') {
    clearTimeout(sprintTimer);
    sprintState = 'idle';
    box.className = 'sprint-box';
    box.textContent = 'Too soon! Click to try again';
  } else if (sprintState === 'go') {
    const ms = Math.round(performance.now() - sprintStart);
    sprintState = 'idle';
    box.className = 'sprint-box';
    box.textContent = ms + ' ms — click to run it again';
    try {
      const data = await api('/api/arcade/sprint', { method: 'POST', body: { ms } });
      $('#sprintStatus').textContent = data.isBest ? 'New personal best: ' + data.personalBest + ' ms ⚡' : 'Best: ' + data.personalBest + ' ms';
      loadArcadeBoard();
    } catch (e) { toast(e.message); }
  }
});
async function loadArcadeBoard() {
  const data = await api('/api/arcade/leaderboard');
  $('#sprintBoard').innerHTML = data.fastest.length
    ? data.fastest.map((r, i) => '<div class="lb-row"><span>' + (i + 1) + '. ' + authorHtml(r.user) + '</span><b>' + r.ms + ' ms</b></div>').join('')
    : '<p class="muted">No sprints yet. Set the pace.</p>';
}
function loadArcade() {
  loadArcadeBoard();
  const today = new Date().toISOString().slice(0, 10);
  const spun = state.me && state.me.lastSpinDate === today;
  $('#spinBtn').disabled = !!spun;
  $('#spinBtn').textContent = spun ? 'Already spun today 🌙' : 'Spin the moon';
}
$('#spinBtn').addEventListener('click', async () => {
  if (!state.me) return toast('Sign in to spin.');
  try {
    const data = await api('/api/arcade/spin', { method: 'POST' });
    state.me.lastSpinDate = new Date().toISOString().slice(0, 10);
    setCoins(data.coins);
    $('#spinResult').textContent = data.amount > 0 ? '+' + data.amount + ' 🪙' : '🌑 No coins — the moon keeps her secrets';
    $('#spinBtn').disabled = true;
    $('#spinBtn').textContent = 'Already spun today 🌙';
    toast(data.amount > 0 ? 'The moon grants ' + data.amount + ' Howl Coins!' : 'No coins this time — tomorrow is another moon.');
  } catch (e) { toast(e.message); }
});

/* ---------------- LFG ---------------- */
async function loadLfg() {
  const data = await api('/api/lfg');
  const list = $('#lfgList');
  list.innerHTML = data.lfg.length ? '' : '<div class="card"><p class="muted">The board is quiet. Post a squad call and rally the pack.</p></div>';
  for (const l of data.lfg) {
    const el = document.createElement('div');
    el.className = 'card lfg-card' + (l.filled ? ' filled' : '');
    const hours = Math.max(0, Math.round((l.expiresAt - Date.now()) / 36e5));
    el.innerHTML = '<div class="post-head"><div>' + authorHtml(l.author) + '</div><span class="post-time">' + hours + 'h left</span></div>' +
      '<div class="post-text">🎮 <b>' + esc(l.game) + '</b> — ' + esc(l.text) + '</div>' +
      (l.filled ? '<span class="founder-badge">✓ Squad filled</span>' : '');
    if (!l.filled && state.me && l.author && state.me.id === l.author.id) {
      const btn = document.createElement('button');
      btn.className = 'btn gold small';
      btn.textContent = 'Mark filled';
      btn.onclick = async () => { try { await api('/api/lfg/' + l.id + '/filled', { method: 'POST' }); loadLfg(); } catch (e) { toast(e.message); } };
      el.appendChild(btn);
    }
    list.appendChild(el);
  }
}
$('#lfgBtn').addEventListener('click', async () => {
  try {
    const data = await api('/api/lfg', { method: 'POST', body: { game: $('#lfgGame').value, text: $('#lfgText').value } });
    $('#lfgGame').value = ''; $('#lfgText').value = '';
    badgeToasts(data.newBadges);
    loadLfg();
  } catch (e) { toast(e.message); }
});

/* ---------------- the Pack Howl ---------------- */
async function loadHowl() {
  try {
    const data = await api('/api/howl');
    $('#howlTotal').textContent = data.total;
    $('#howlToday').textContent = data.today;
    if (data.mine) {
      $('#howlMine').textContent = data.mine.total;
      $('#howlStreak').textContent = data.mine.streak;
    }
  } catch (e) { /* howl is decorative until signed in */ }
}
$('#howlBtn').addEventListener('click', () => {
  if (!state.me) return toast('Sign in to howl with the pack.');
  if (!state.socket) return toast('Connecting… try again in a second.');
  state.socket.emit('howl:press');
  const btn = $('#howlBtn');
  btn.classList.remove('howled'); void btn.offsetWidth; btn.classList.add('howled');
});

/* ---------------- direct messages ---------------- */
function dmMsgHtml(m) {
  return '<div class="dm-msg' + (m.mine ? ' mine' : '') + '">' + richText(m.text) +
    '<span class="post-time">' + fmtTime(m.createdAt) + '</span></div>';
}
async function loadDmList() {
  const box = $('#dmList');
  if (!state.me) { box.innerHTML = '<p class="muted">Sign in to message the pack.</p>'; return; }
  try {
    const data = await api('/api/dms');
    setDmUnread(data.unread);
    box.innerHTML = data.conversations.length ? '' : '<p class="muted">No conversations yet — open a member profile and hit Message.</p>';
    for (const c of data.conversations) {
      const row = document.createElement('div');
      row.className = 'member-row';
      row.innerHTML = '<span>' + authorHtml(c.user) + (c.last ? '<br><span class="muted">' + (c.last.mine ? 'You: ' : '') + esc(c.last.text.slice(0, 60)) + '</span>' : '') + '</span>' +
        (c.unread ? '<span class="nav-badge">' + c.unread + '</span>' : '');
      const btn = document.createElement('button');
      btn.className = 'btn ghost small';
      btn.textContent = 'Open';
      btn.onclick = () => openDmThread(c.user.id);
      row.appendChild(btn);
      box.appendChild(row);
    }
  } catch (e) { toast(e.message); }
}
async function openDmThread(userId) {
  try {
    const data = await api('/api/dms/' + userId);
    state.dmPartner = userId;
    $('#dmThreadCard').hidden = false;
    $('#dmThreadTitle').innerHTML = '✉️ ' + authorHtml(data.user);
    const box = $('#dmMessages');
    box.innerHTML = data.messages.map(dmMsgHtml).join('') || '<p class="muted">No messages yet — say hey 🐺</p>';
    box.scrollTop = box.scrollHeight;
    const me = await api('/api/me');
    setDmUnread(me.dmUnread);
  } catch (e) { toast(e.message); }
}
$('#dmForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const input = $('#dmInput');
  if (!state.dmPartner || !input.value.trim()) return;
  try {
    const data = await api('/api/dms/' + state.dmPartner, { method: 'POST', body: { text: input.value } });
    input.value = '';
    const box = $('#dmMessages');
    box.insertAdjacentHTML('beforeend', dmMsgHtml(data.message));
    box.scrollTop = box.scrollHeight;
    loadDmList();
  } catch (e) { toast(e.message); }
});

/* ---------------- watch party ---------------- */
const wp = { localTime: 0, localStamp: 0, listening: false };
function wpCommand(func, args) {
  const frame = $('#wpFrame');
  if (!frame || !frame.contentWindow) return;
  frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: args || [] }), '*');
}
function wpLocalPosition() {
  const s = state.party.state;
  if (!s) return 0;
  return wp.localTime + (s.playing ? (Date.now() - wp.localStamp) / 1000 : 0);
}
function wpApplyState() {
  const s = state.party.state;
  const wrap = $('#wpPlayerWrap');
  if (!s) {
    $('#wpNow').textContent = 'Nothing is playing yet.';
    wrap.hidden = true;
    $('#wpControls').hidden = true;
    return;
  }
  $('#wpNow').innerHTML = '🎬 <b>' + esc(s.title) + '</b> · hosted by ' + esc(s.hostName) +
    (s.playing ? ' · ▶ playing' : ' · ⏸ paused');
  $('#wpHostNote').textContent = state.party.canHost ? 'You have the remote 🎛️' : 'The host has the remote — sit back and enjoy 🍿';
  $('#wpControls').hidden = !state.party.canHost;
  const frame = $('#wpFrame');
  const wantSrc = 'https://www.youtube-nocookie.com/embed/' + s.videoId + '?enablejsapi=1&rel=0';
  if (!frame.src || !frame.src.includes(s.videoId)) {
    wrap.hidden = false;
    frame.src = wantSrc;
    wp.localTime = s.position; wp.localStamp = Date.now();
    setTimeout(() => {
      frame.contentWindow && frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'wp' }), '*');
      if (s.playing) wpCommand('playVideo'); else wpCommand('pauseVideo');
      wpCommand('seekTo', [s.position, true]);
    }, 900);
    return;
  }
  // Same video: correct drift and play state.
  const drift = s.position - wpLocalPosition();
  if (Math.abs(drift) > 2.5) wpCommand('seekTo', [s.position, true]);
  wpCommand(s.playing ? 'playVideo' : 'pauseVideo');
}
function openParty() {
  if (!state.me) { toast('Sign in to join the Watch Party.'); return; }
  if (state.socket) state.socket.emit('party:join');
  api('/api/party').then((d) => {
    state.party.state = d.state;
    state.party.canHost = d.canHost;
    wpApplyState();
  }).catch(() => {});
}
function initPartySocket(socket) {
  socket.on('party:state', (data) => {
    if (data.state !== undefined) state.party.state = data.state;
    if (typeof data.canHost === 'boolean') state.party.canHost = data.canHost;
    if (Array.isArray(data.chat)) {
      $('#wpChat').innerHTML = data.chat.map((m) => '<div class="chat-msg">' + authorHtml(m.author) + '<br>' + richText(m.text) + '</div>').join('');
    }
    wpApplyState();
  });
  socket.on('party:chat', (data) => {
    const box = $('#wpChat');
    box.insertAdjacentHTML('beforeend', '<div class="chat-msg">' + authorHtml(data.message.author) + '<br>' + richText(data.message.text) + '</div>');
    box.scrollTop = box.scrollHeight;
  });
}
window.addEventListener('message', (e) => {
  if (!/youtube(-nocookie)?\.com$/.test(new URL(e.origin || 'http://x').hostname)) return;
  let data = null;
  try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (err) { return; }
  if (!data) return;
  if (data.event === 'infoDelivery' && data.info) {
    if (typeof data.info.currentTime === 'number') { wp.localTime = data.info.currentTime; wp.localStamp = Date.now(); }
    if (typeof data.info.playerState === 'number' && state.party.canHost && state.party.state) {
      // Host drove the player directly — relay it so the pack follows.
      if (data.info.playerState === 1 && !state.party.state.playing) {
        state.socket && state.socket.emit('party:control', { action: 'play', position: Math.round(wp.localTime) });
      } else if (data.info.playerState === 2 && state.party.state.playing) {
        state.socket && state.socket.emit('party:control', { action: 'pause', position: Math.round(wp.localTime) });
      }
    }
  }
});
$('#wpSet').addEventListener('click', () => {
  if (!state.me) return toast('Sign in first.');
  if (!state.socket) return toast('Connecting…');
  state.socket.emit('party:set', { youtube: $('#wpUrl').value, title: $('#wpTitle').value });
  $('#wpUrl').value = ''; $('#wpTitle').value = '';
  toast('Setting the party video… if a host already picked one, theirs stays. 🎬');
});
$('#wpPlay').addEventListener('click', () => state.socket && state.socket.emit('party:control', { action: 'play', position: Math.round(wpLocalPosition()) }));
$('#wpPause').addEventListener('click', () => state.socket && state.socket.emit('party:control', { action: 'pause', position: Math.round(wpLocalPosition()) }));
$('#wpBack').addEventListener('click', () => state.socket && state.socket.emit('party:control', { action: 'seek', position: Math.max(0, Math.round(wpLocalPosition()) - 10) }));
$('#wpFwd').addEventListener('click', () => state.socket && state.socket.emit('party:control', { action: 'seek', position: Math.round(wpLocalPosition()) + 10 }));
$('#wpChatForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = $('#wpChatInput');
  if (!state.socket || !input.value.trim()) return;
  state.socket.emit('party:chat', { text: input.value });
  input.value = '';
});

/* ---------------- clip battles ---------------- */
async function loadBattles() {
  const list = $('#battleList');
  try {
    const data = await api('/api/battles');
    list.innerHTML = data.battles.length ? '' : '<div class="card"><p class="muted">No battles yet. When two clips enter, one clip leaves with the crown 👑</p></div>';
    for (const b of data.battles) list.appendChild(battleEl(b));
    const createCard = $('#battleCreateCard');
    if (state.me && state.me.role === 'founder') {
      createCard.hidden = false;
      const clips = state.channels.find((c) => c.name === 'Clips & Videos');
      if (clips) {
        const feed = await api('/api/channels/' + clips.id + '/feed');
        const clipPosts = feed.posts.filter((p) => p.youtubeId);
        const opts = clipPosts.map((p) => '<option value="' + p.id + '">' + esc((p.author ? p.author.displayName : '?') + ' — ' + (p.text || 'clip').slice(0, 40)) + '</option>').join('');
        $('#battleA').innerHTML = opts;
        $('#battleB').innerHTML = opts;
      }
    } else {
      createCard.hidden = true;
    }
  } catch (e) { toast(e.message); }
}
function battleEl(b) {
  const el = document.createElement('div');
  el.className = 'card';
  const side = (s, label) => {
    const p = s.post;
    const isWinner = b.status === 'closed' && b.winnerPostId === s.postId;
    return '<div class="battle-side' + (isWinner ? ' winner' : '') + '">' +
      '<div class="spotlight-tag">' + label + (isWinner ? ' · 👑 WINNER' : '') + '</div>' +
      (p && p.youtubeId ? '<iframe class="yt-frame" src="https://www.youtube-nocookie.com/embed/' + esc(p.youtubeId) + '" allowfullscreen title="battle clip"></iframe>' : '') +
      '<p>' + (p ? authorHtml(p.author) + ' — ' + richText(p.text || '') : 'Clip removed') + '</p>' +
      '<p><b>' + s.votes + ' votes</b></p>' +
      (b.status === 'open' && state.me ? '<button class="btn ' + (b.myVote === s.postId ? 'gold' : 'primary') + ' small" data-battle-vote="' + b.id + '" data-post="' + s.postId + '">' + (b.myVote === s.postId ? '✓ Your pick' : 'Vote') + '</button>' : '') +
      '</div>';
  };
  el.innerHTML = '<h3>⚔️ Round ' + b.round + ' — ' + (b.status === 'open' ? 'VOTING OPEN' : 'CLOSED') + ' · prize ' + b.prize + ' 🪙</h3>' +
    '<div class="battle-grid">' + side(b.a, 'CLIP A') + side(b.b, 'CLIP B') + '</div>' +
    (b.status === 'open' && state.me && state.me.role === 'founder'
      ? '<button class="btn gold small" data-battle-close="' + b.id + '">Close &amp; crown the winner</button>' : '');
  el.querySelectorAll('[data-battle-vote]').forEach((btn) => btn.onclick = async () => {
    try { await api('/api/battles/' + btn.dataset.battleVote + '/vote', { method: 'POST', body: { postId: btn.dataset.post } }); loadBattles(); } catch (e) { toast(e.message); }
  });
  el.querySelectorAll('[data-battle-close]').forEach((btn) => btn.onclick = async () => {
    try {
      const d = await api('/api/battles/' + btn.dataset.battleClose + '/close', { method: 'POST', body: {} });
      toast('👑 Winner crowned! Prize paid: ' + d.battle.prize + ' 🪙');
      loadBattles();
    } catch (e) { toast(e.message + ' (Tip: on a tie, the Founder picks — try again and it will still need a pick.)'); }
  });
  return el;
}
$('#battleCreate').addEventListener('click', async () => {
  try {
    await api('/api/battles', {
      method: 'POST',
      body: { postAId: $('#battleA').value, postBId: $('#battleB').value, prize: parseInt($('#battlePrize').value, 10) || 25 },
    });
    toast('Battle started! ⚔️');
    loadBattles();
  } catch (e) { toast(e.message); }
});

/* ---------------- suggestion box ---------------- */
async function loadIdeas() {
  $('#ideaFormCard').hidden = !state.me;
  const list = $('#ideaList');
  try {
    const data = await api('/api/suggestions');
    list.innerHTML = data.suggestions.length ? '' : '<div class="card"><p class="muted">The box is empty. Be the first to shape Vantahowl. 💡</p></div>';
    for (const s of data.suggestions) {
      const el = document.createElement('div');
      el.className = 'card idea-row';
      const chip = { open: '🆕 Open', planned: '🛠️ Planned', done: '✅ Done', dismissed: '🗄️ Dismissed' }[s.status] || s.status;
      el.innerHTML = '<div class="post-head"><div>' + authorHtml(s.author) + '</div><span class="idea-chip">' + chip + '</span></div>' +
        '<div class="post-text">' + richText(s.text) + '</div>';
      const actions = document.createElement('div');
      actions.className = 'post-actions';
      if (state.me) {
        const vote = document.createElement('button');
        vote.className = 'btn ' + (s.mine ? 'gold' : 'ghost') + ' small';
        vote.textContent = '▲ ' + s.votes;
        vote.onclick = async () => { try { await api('/api/suggestions/' + s.id + '/vote', { method: 'POST' }); loadIdeas(); } catch (e) { toast(e.message); } };
        actions.appendChild(vote);
      } else {
        actions.innerHTML = '<span class="muted">▲ ' + s.votes + '</span>';
      }
      if (state.me && state.me.role === 'founder') {
        for (const st of ['planned', 'done', 'dismissed', 'open']) {
          if (st === s.status) continue;
          const b = document.createElement('button');
          b.className = 'btn ghost small';
          b.textContent = 'Mark ' + st;
          b.onclick = async () => { try { await api('/api/admin/suggestions/' + s.id, { method: 'PATCH', body: { status: st } }); loadIdeas(); } catch (e) { toast(e.message); } };
          actions.appendChild(b);
        }
      }
      el.appendChild(actions);
      list.appendChild(el);
    }
  } catch (e) { toast(e.message); }
}
$('#ideaBtn').addEventListener('click', async () => {
  try {
    await api('/api/suggestions', { method: 'POST', body: { text: $('#ideaText').value } });
    $('#ideaText').value = '';
    toast('Idea dropped in the box 💡');
    loadIdeas();
  } catch (e) { toast(e.message); }
});

/* ---------------- emotes ---------------- */
function renderEmoteBar() {
  const bar = $('#emoteBar');
  bar.innerHTML = state.emotes.map((e) =>
    '<button class="emote-btn" data-emote=":' + esc(e.name) + ':" title=":' + esc(e.name) + ':"><img class="emote-img" src="' + esc(e.image) + '" alt=":' + esc(e.name) + ':"></button>').join('');
  bar.querySelectorAll('[data-emote]').forEach((b) => b.onclick = () => {
    const input = $('#chatInput');
    input.value = (input.value + ' ' + b.dataset.emote + ' ').slice(0, 500);
    input.focus();
  });
  const gallery = $('#emoteGallery');
  if (gallery) {
    gallery.innerHTML = state.emotes.map((e) =>
      '<span class="emote-chip"><img class="emote-img" src="' + esc(e.image) + '" alt=""> :' + esc(e.name) + ':</span>').join('') ||
      '<span class="muted">No approved emotes yet.</span>';
  }
}
async function uploadImageFile(file) {
  const fd = new FormData();
  fd.append('image', file);
  const res = await fetch('/api/upload', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': state.csrf }, body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data.url;
}
$('#emoteFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    state.emoteUploadUrl = await uploadImageFile(file);
    $('#emoteFileName').textContent = '✓ ' + file.name;
  } catch (e) { toast(e.message); }
});
$('#emoteSubmit').addEventListener('click', async () => {
  if (!state.emoteUploadUrl) return toast('Pick an image first.');
  try {
    await api('/api/emotes', { method: 'POST', body: { name: $('#emoteName').value, image: state.emoteUploadUrl } });
    $('#emoteName').value = ''; $('#emoteFileName').textContent = ''; state.emoteUploadUrl = null;
    toast('Emote submitted — a mod will review it 😀');
    loadPack();
  } catch (e) { toast(e.message); }
});
async function loadMyEmotes() {
  if (!state.me) return;
  try {
    const data = await api('/api/emotes');
    $('#emoteMine').innerHTML = data.mine.length
      ? '<h4>Your submissions</h4>' + data.mine.map((e) =>
          '<span class="emote-chip"><img class="emote-img" src="' + esc(e.image) + '" alt=""> :' + esc(e.name) + ': · ' + esc(e.status) + '</span>').join('')
      : '';
  } catch (e) { /* optional */ }
}

/* ---------------- profile glow-up editing ---------------- */
function initProfileEdit() {
  const card = $('#profileEditCard');
  if (!state.me) { card.hidden = true; $('#emoteCard').hidden = true; return; }
  card.hidden = false;
  $('#emoteCard').hidden = false;
  $('#peDisplay').value = state.me.displayName;
  $('#peStatus').value = state.me.statusLine || '';
  $('#pePlaying').value = state.me.nowPlaying || '';
  $('#peAccent').value = state.me.accent || '#E1062C';
  state.bannerUrl = state.me.banner || '';
  $('#peBannerName').textContent = state.me.banner ? 'Banner set ✓' : '';
}
$('#peBannerFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    state.bannerUrl = await uploadImageFile(file);
    $('#peBannerName').textContent = '✓ ' + file.name;
  } catch (e) { toast(e.message); }
});
$('#peBannerClear').addEventListener('click', () => {
  state.bannerUrl = '';
  $('#peBannerName').textContent = 'Banner will be cleared on save';
});
$('#peSave').addEventListener('click', async () => {
  try {
    const data = await api('/api/me', {
      method: 'PATCH',
      body: {
        displayName: $('#peDisplay').value, statusLine: $('#peStatus').value,
        nowPlaying: $('#pePlaying').value, accent: $('#peAccent').value,
        banner: state.bannerUrl,
      },
    });
    state.me = data.user;
    renderHeader();
    toast('Profile glowing ✨');
    loadPack();
  } catch (e) { toast(e.message); }
});

/* ---------------- lounge (WebRTC mesh, BETA) ---------------- */
const lounge = { joined: false, stream: null, pcs: new Map() };
function initLoungeSocket(socket) {
  socket.on('lounge:peers', async (data) => {
    $('#loungeStatus').textContent = data.peers.length ? 'In the lounge: ' + data.peers.map((p) => p.displayName).join(', ') : 'You are the first one here — the pack will follow.';
  });
  socket.on('lounge:peer-joined', async (peer) => {
    if (!lounge.joined) return;
    $('#loungeStatus').textContent = peer.displayName + ' padded in 🐾';
    const pc = makePeer(peer.socketId, peer.displayName);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    state.socket.emit('rtc:offer', { to: peer.socketId, sdp: offer });
  });
  socket.on('rtc:offer', async (data) => {
    if (!lounge.joined) return;
    const pc = makePeer(data.from, data.username || 'Packmate');
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    state.socket.emit('rtc:answer', { to: data.from, sdp: answer });
  });
  socket.on('rtc:answer', async (data) => {
    const pc = lounge.pcs.get(data.from);
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  });
  socket.on('rtc:ice', async (data) => {
    const pc = lounge.pcs.get(data.from);
    if (pc && data.candidate) { try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) { /* late candidate */ } }
  });
  socket.on('lounge:peer-left', (data) => closePeer(data.socketId));
}
function makePeer(socketId, name) {
  closePeer(socketId);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  lounge.pcs.set(socketId, pc);
  if (lounge.stream) lounge.stream.getTracks().forEach((t) => pc.addTrack(t, lounge.stream));
  pc.onicecandidate = (ev) => { if (ev.candidate) state.socket.emit('rtc:ice', { to: socketId, candidate: ev.candidate }); };
  pc.ontrack = (ev) => {
    let tile = $('#tile-' + socketId);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.id = 'tile-' + socketId;
      tile.innerHTML = '<video autoplay playsinline></video><span class="video-name">' + esc(name) + '</span>';
      $('#videoGrid').appendChild(tile);
    }
    tile.querySelector('video').srcObject = ev.streams[0];
  };
  pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) closePeer(socketId); };
  return pc;
}
function closePeer(socketId) {
  const pc = lounge.pcs.get(socketId);
  if (pc) { try { pc.close(); } catch (e) { /* already closed */ } lounge.pcs.delete(socketId); }
  const tile = $('#tile-' + socketId);
  if (tile) tile.remove();
}
$('#loungeJoin').addEventListener('click', async () => {
  if (!state.me) return toast('Sign in to join the lounge.');
  if (!state.socket) return toast('Connecting… try again in a second.');
  try {
    lounge.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (e) {
    return toast('Camera/mic permission is needed for the lounge.');
  }
  $('#localVideo').srcObject = lounge.stream;
  $('#localTile').hidden = false;
  lounge.joined = true;
  $('#loungeJoin').hidden = true;
  $('#loungeLeave').hidden = false;
  state.socket.emit('lounge:join');
  $('#loungeStatus').textContent = 'You are in the lounge 🎤';
});
$('#loungeLeave').addEventListener('click', () => {
  lounge.joined = false;
  if (state.socket) state.socket.emit('lounge:leave');
  for (const id of [...lounge.pcs.keys()]) closePeer(id);
  if (lounge.stream) lounge.stream.getTracks().forEach((t) => t.stop());
  lounge.stream = null;
  $('#localTile').hidden = true;
  $('#loungeJoin').hidden = false;
  $('#loungeLeave').hidden = true;
  $('#loungeStatus').textContent = '';
});

/* ---------------- members ---------------- */
async function loadMembers() {
  const data = await api('/api/members');
  const list = $('#memberList');
  list.innerHTML = '';
  for (const m of data.members) {
    const row = document.createElement('div');
    row.className = 'member-row';
    row.innerHTML = '<span>' + authorHtml(m) + (m.statusLine ? ' <span class="muted">— ' + esc(m.statusLine) + '</span>' : '') + '</span>';
    const btn = document.createElement('button');
    btn.className = 'btn ghost small';
    btn.textContent = 'Profile';
    btn.onclick = () => showProfile(m.id);
    row.appendChild(btn);
    list.appendChild(row);
  }
}
async function showProfile(userId) {
  try {
    const data = await api('/api/users/' + userId);
    const u = data.user;
    $('#profileCard').hidden = false;
    $('#profileName').innerHTML = authorHtml(u);
    const s = u.stats || {};
    $('#profileBody').innerHTML =
      (u.banner ? '<img class="profile-banner" src="' + esc(u.banner) + '" alt="">' : '') +
      '<p class="muted">' + esc(u.statusLine || '') + '</p>' +
      (u.nowPlaying ? '<p class="now-playing-big">🎮 Now playing: ' + esc(u.nowPlaying) + '</p>' : '') +
      '<p>Posts: ' + (s.posts || 0) + ' · Comments: ' + (s.comments || 0) + ' · Chat: ' + (s.chats || 0) + ' · Gifts sent: ' + (s.giftsSent || 0) + '</p>' +
      '<p>🌟 Kudos received: <b>' + (u.kudosReceived || 0) + '</b> · Kudos given: ' + (s.kudosGiven || 0) + '</p>' +
      '<div class="badge-case">' + state.badgesMeta.filter((b) => u.badges.includes(b.id)).map((b) => '<div class="badge-item"><span class="b-icon">' + b.icon + '</span>' + esc(b.name) + '</div>').join('') + '</div>' +
      (state.me && state.me.id !== u.id ? '<div class="post-actions">' +
        '<button class="btn primary small" id="dmBtn">✉️ Message</button>' +
        '<button class="btn gold small" id="kudosBtn">🌟 Kudos (' + (state.me.kudosLeft != null ? state.me.kudosLeft : 3) + ' left)</button>' +
        state.gifts.map((g) => '<button class="gift-btn" data-direct-gift="' + g.emoji + '" data-user="' + u.id + '">' + g.emoji + ' ' + g.price + '🪙</button>').join('') +
        '<button class="btn ghost small" id="blockBtn">🚫 Block</button></div>' : '');
    $$('#profileBody [data-direct-gift]').forEach((b) => b.onclick = async () => {
      try {
        const d = await api('/api/gifts', { method: 'POST', body: { gift: b.dataset.directGift, toUserId: b.dataset.user } });
        setCoins(d.myCoins);
        badgeToasts(d.newBadges);
        toast('Gift sent! 🎁');
      } catch (e) { toast(e.message); }
    });
    const dmBtn = $('#dmBtn');
    if (dmBtn) dmBtn.onclick = () => {
      $('#profileCard').hidden = true;
      document.querySelector('[data-nav="messages"]').click();
      openDmThread(u.id);
    };
    const kudosBtn = $('#kudosBtn');
    if (kudosBtn) kudosBtn.onclick = async () => {
      try {
        const d = await api('/api/users/' + u.id + '/kudos', { method: 'POST' });
        if (state.me) state.me.kudosLeft = d.kudosLeft;
        badgeToasts(d.newBadges);
        toast('🌟 Kudos sent! ' + u.displayName + ' now has ' + d.kudosReceived + '.');
        showProfile(u.id);
      } catch (e) { toast(e.message); }
    };
    const blockBtn = $('#blockBtn');
    if (blockBtn) blockBtn.onclick = async () => {
      try { await api('/api/blocks', { method: 'POST', body: { userId: u.id } }); toast('Blocked — their posts and chat are hidden for you.'); loadFeed(); } catch (e) { toast(e.message); }
    };
  } catch (e) { toast(e.message); }
}

/* ---------------- console ---------------- */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
async function loadConsole() {
  if (!state.me) return;
  const isFounder = state.me.role === 'founder';
  $('#settingsCard').hidden = !isFounder;
  $('#channelAdminCard').hidden = !isFounder;
  $('#secLogCard').hidden = !isFounder;
  if (isFounder) {
    try {
      const data = await api('/api/admin/settings');
      const s = data.settings;
      $('#setSiteName').value = s.siteName;
      $('#setAnnouncement').value = s.announcement || '';
      $('#setSignupsOpen').checked = !!s.signupsOpen;
      $('#setProfanity').checked = !!s.profanityMask;
      $('#setLiveManual').checked = !!s.liveManual;
      renderEventAdmin();
      loadEmoteAdmin();
      $('#setGnLabel').value = s.gameNight ? s.gameNight.label : '';
      $('#setGnAt').value = s.gameNight ? toLocalInput(s.gameNight.at) : '';
      $('#setSodTitle').value = s.songOfDay ? s.songOfDay.title : '';
      $('#setSodUrl').value = s.songOfDay ? 'https://www.youtube.com/watch?v=' + s.songOfDay.youtubeId : '';
    } catch (e) { toast(e.message); }
    renderChannelAdmin();
    try {
      const users = await api('/api/admin/users');
      const box = $('#adminUserList');
      box.innerHTML = '';
      for (const u of users.users) {
        const row = document.createElement('div');
        row.className = 'admin-row';
        row.innerHTML = '<span>' + authorHtml(u) + (u.banned ? ' <b style="color:#ff5f7a">BANNED</b>' : '') + ' <span class="muted">🪙' + u.coins + ' · ' + u.points + ' pts</span></span>';
        if (u.role !== 'founder') {
          const roleBtn = document.createElement('button');
          roleBtn.className = 'btn ghost small';
          roleBtn.textContent = u.role === 'moderator' ? 'Demote to member' : 'Make moderator';
          roleBtn.onclick = async () => {
            try { await api('/api/admin/users/' + u.id + '/role', { method: 'PATCH', body: { role: u.role === 'moderator' ? 'member' : 'moderator' } }); loadConsole(); } catch (e) { toast(e.message); }
          };
          const banBtn = document.createElement('button');
          banBtn.className = 'btn ghost small';
          banBtn.textContent = u.banned ? 'Unban' : 'Ban';
          banBtn.onclick = async () => {
            try { await api('/api/admin/users/' + u.id + '/ban', { method: 'PATCH', body: { banned: !u.banned } }); loadConsole(); } catch (e) { toast(e.message); }
          };
          const wrap = document.createElement('span');
          wrap.append(roleBtn, banBtn);
          row.appendChild(wrap);
        }
        box.appendChild(row);
      }
    } catch (e) { toast(e.message); }
    try {
      const log = await api('/api/admin/security-log');
      $('#secLog').innerHTML = log.log.map((e) => '<div class="tiny muted">' + esc(e.at) + ' — <b>' + esc(e.event) + '</b> ' + esc(e.detail) + '</div>').join('') || '<p class="muted">No events yet.</p>';
    } catch (e) { /* founder only */ }
  }
  try {
    const data = await api('/api/admin/reports');
    const box = $('#reportList');
    box.innerHTML = data.reports.length ? '' : '<p class="muted">No reports. The pack is behaving. 🐺</p>';
    for (const r of data.reports) {
      const row = document.createElement('div');
      row.className = 'report-row';
      row.innerHTML = '<span>🚩 <b>' + esc(r.targetType) + '</b> · ' + esc(r.reason || '(no reason)') + ' <span class="muted">by ' + esc(r.reporter ? r.reporter.displayName : '?') + ' · ' + esc(r.status) + '</span></span>';
      if (r.status === 'open') {
        const wrap = document.createElement('span');
        const del = document.createElement('button');
        del.className = 'btn ghost small'; del.textContent = 'Delete content';
        del.onclick = async () => { try { await api('/api/admin/reports/' + r.id + '/delete-content', { method: 'POST' }); loadConsole(); loadFeed(); } catch (e) { toast(e.message); } };
        const dis = document.createElement('button');
        dis.className = 'btn ghost small'; dis.textContent = 'Dismiss';
        dis.onclick = async () => { try { await api('/api/admin/reports/' + r.id + '/dismiss', { method: 'POST' }); loadConsole(); } catch (e) { toast(e.message); } };
        wrap.append(del, dis);
        row.appendChild(wrap);
      }
      box.appendChild(row);
    }
  } catch (e) { /* mods+ only */ }
}
function renderChannelAdmin() {
  const box = $('#channelAdminList');
  box.innerHTML = '';
  // Re-bootstrap: the founder sees every channel here, including hidden ones.
  fetch('/api/bootstrap', { credentials: 'same-origin' }).then((r) => r.json()).then((data) => {
    for (const c of data.channels) {
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = '<span>' + esc(c.emoji) + ' <b>' + esc(c.name) + '</b>' + (c.hidden ? ' <span class="muted">(hidden)</span>' : '') + (c.gate === '21+' ? ' <span class="muted">(21+)</span>' : '') + '</span>';
      const wrap = document.createElement('span');
      const gate = document.createElement('button');
      gate.className = 'btn ghost small'; gate.textContent = c.gate === '21+' ? 'Remove 21+ gate' : 'Make 21+';
      gate.onclick = async () => {
        try { await api('/api/admin/channels/' + c.id, { method: 'PATCH', body: { gate: c.gate === '21+' ? null : '21+' } }); refreshChannels(); renderChannelAdmin(); } catch (e) { toast(e.message); }
      };
      wrap.appendChild(gate);
      const rename = document.createElement('button');
      rename.className = 'btn ghost small'; rename.textContent = 'Rename';
      rename.onclick = async () => {
        const name = prompt('New name for this channel:', c.name);
        if (!name) return;
        try { await api('/api/admin/channels/' + c.id, { method: 'PATCH', body: { name } }); refreshChannels(); renderChannelAdmin(); } catch (e) { toast(e.message); }
      };
      const hide = document.createElement('button');
      hide.className = 'btn ghost small'; hide.textContent = c.hidden ? 'Unhide' : 'Hide';
      hide.onclick = async () => {
        try { await api('/api/admin/channels/' + c.id, { method: 'PATCH', body: { hidden: !c.hidden } }); refreshChannels(); renderChannelAdmin(); } catch (e) { toast(e.message); }
      };
      const del = document.createElement('button');
      del.className = 'btn ghost small'; del.textContent = 'Delete';
      del.onclick = async () => {
        if (!confirm('Delete channel "' + c.name + '" and all its posts?')) return;
        try { await api('/api/admin/channels/' + c.id, { method: 'DELETE' }); refreshChannels(); renderChannelAdmin(); } catch (e) { toast(e.message); }
      };
      wrap.append(rename, hide, del);
      row.appendChild(wrap);
      box.appendChild(row);
    }
  });
}
async function refreshChannels() {
  const data = await api('/api/bootstrap');
  state.channels = data.channels;
  if (!state.channels.some((c) => c.id === state.currentChannel)) {
    state.currentChannel = state.channels.length ? state.channels[0].id : null;
  }
  renderChannels();
  if (state.currentChannel) loadFeed();
}
$('#chanCreate').addEventListener('click', async () => {
  try {
    await api('/api/admin/channels', { method: 'POST', body: { name: $('#newChanName').value, emoji: $('#newChanEmoji').value, topic: $('#newChanTopic').value } });
    $('#newChanName').value = ''; $('#newChanEmoji').value = ''; $('#newChanTopic').value = '';
    refreshChannels(); renderChannelAdmin();
    toast('Channel created 📺');
  } catch (e) { toast(e.message); }
});
$('#settingsSave').addEventListener('click', async () => {
  const gnAt = $('#setGnAt').value;
  const sodUrl = $('#setSodUrl').value.trim();
  const body = {
    siteName: $('#setSiteName').value,
    announcement: $('#setAnnouncement').value,
    signupsOpen: $('#setSignupsOpen').checked,
    profanityMask: $('#setProfanity').checked,
    liveManual: $('#setLiveManual').checked,
    gameNight: gnAt ? { label: $('#setGnLabel').value, at: new Date(gnAt).toISOString() } : null,
    songOfDay: sodUrl ? { title: $('#setSodTitle').value, youtube: sodUrl } : null,
  };
  try {
    const data = await api('/api/admin/settings', { method: 'PATCH', body });
    state.settings = { ...state.settings, ...data.settings };
    applySettings();
    const bootData = await api('/api/bootstrap');
    state.live = bootData.live;
    applyLive();
    toast('Settings saved 👑');
  } catch (e) { toast(e.message); }
});
$('#liveCheckBtn').addEventListener('click', async () => {
  try {
    const data = await api('/api/admin/live-check', { method: 'POST' });
    state.live = data.live;
    applyLive();
    $('#liveStatus').textContent = data.live.checkedAt
      ? 'Last check: ' + new Date(data.live.checkedAt).toLocaleTimeString() + ' — ' +
        (data.live.ok ? (data.live.isLive ? 'Kick says LIVE 🔴' : 'Kick reachable, not live') : 'Kick API did not answer (manual toggle still works)')
      : 'No check yet.';
  } catch (e) { toast(e.message); }
});

/* Console: events admin */
async function renderEventAdmin() {
  const box = $('#eventAdminList');
  try {
    const data = await api('/api/events');
    box.innerHTML = data.events.length ? '' : '<p class="muted">No events yet.</p>';
    for (const e of data.events) {
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = '<span><b>' + esc(e.title) + '</b> <span class="muted">' + esc(e.kind) + ' · ' +
        new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' · ' + e.going + ' going</span></span>';
      const del = document.createElement('button');
      del.className = 'btn ghost small';
      del.textContent = 'Delete';
      del.onclick = async () => { try { await api('/api/events/' + e.id, { method: 'DELETE' }); renderEventAdmin(); } catch (err) { toast(err.message); } };
      row.appendChild(del);
      box.appendChild(row);
    }
  } catch (e) { /* founder only */ }
}
$('#evCreate').addEventListener('click', async () => {
  const at = $('#evAt').value;
  if (!at) return toast('Pick a date and time.');
  try {
    await api('/api/events', {
      method: 'POST',
      body: { title: $('#evTitle').value, kind: $('#evKind').value, at: new Date(at).toISOString(), description: $('#evDesc').value },
    });
    $('#evTitle').value = ''; $('#evDesc').value = ''; $('#evAt').value = '';
    toast('Event created 📅');
    renderEventAdmin();
  } catch (e) { toast(e.message); }
});

/* Console: emote approval queue */
async function loadEmoteAdmin() {
  const box = $('#emoteAdminList');
  try {
    const data = await api('/api/admin/emotes');
    box.innerHTML = data.pending.length ? '' : '<p class="muted">No emotes waiting. 😴</p>';
    for (const e of data.pending) {
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = '<span><img class="emote-img" src="' + esc(e.image) + '" alt=""> <b>:' + esc(e.name) + ':</b> <span class="muted">by ' + esc(e.author ? e.author.displayName : '?') + '</span></span>';
      const wrap = document.createElement('span');
      const ok = document.createElement('button');
      ok.className = 'btn gold small'; ok.textContent = 'Approve';
      ok.onclick = async () => {
        try {
          await api('/api/admin/emotes/' + e.id + '/approve', { method: 'POST' });
          const bootData = await api('/api/bootstrap');
          state.emotes = bootData.emotes || [];
          renderEmoteBar();
          loadEmoteAdmin();
          toast('Emote approved 😀');
        } catch (err) { toast(err.message); }
      };
      const no = document.createElement('button');
      no.className = 'btn ghost small'; no.textContent = 'Reject';
      no.onclick = async () => { try { await api('/api/emotes/' + e.id, { method: 'DELETE' }); loadEmoteAdmin(); } catch (err) { toast(err.message); } };
      wrap.append(ok, no);
      row.appendChild(wrap);
      box.appendChild(row);
    }
  } catch (e) { /* staff only */ }
}
$('#gnClear').addEventListener('click', () => { $('#setGnAt').value = ''; $('#setGnLabel').value = ''; });
$('#sodClear').addEventListener('click', () => { $('#setSodUrl').value = ''; $('#setSodTitle').value = ''; });

/* ---------------- auth ---------------- */
function openAuth() { $('#authModal').hidden = false; }
function closeAuth() { $('#authModal').hidden = true; }
$('#navAuthBtn').addEventListener('click', openAuth);
$('#authClose').addEventListener('click', closeAuth);
$('#authModal').addEventListener('click', (e) => { if (e.target === $('#authModal')) closeAuth(); });
$('#tabLogin').addEventListener('click', () => {
  $('#tabLogin').classList.add('active'); $('#tabSignup').classList.remove('active');
  $('#loginForm').hidden = false; $('#signupForm').hidden = true;
});
$('#tabSignup').addEventListener('click', () => {
  $('#tabSignup').classList.add('active'); $('#tabLogin').classList.remove('active');
  $('#signupForm').hidden = false; $('#loginForm').hidden = true;
});
function afterAuth(data) {
  state.me = data.user;
  state.csrf = data.csrfToken;
  closeAuth();
  renderHeader();
  connectSocket();
  renderVibes();
  loadFeed();
  toast('Welcome to Vantahowl, ' + data.user.displayName + ' 🐺');
  if (data.streak && data.streak.streak > 1) {
    toast('🔥 Login streak: ' + data.streak.streak + ' days' +
      (data.streak.bonus > 0 ? ' — milestone bonus +' + data.streak.bonus + ' 🪙!' : ''));
    if (data.streak.bonus > 0) setCoins(data.user.coins);
  }
  // Refresh per-user bits (emotes, live state, DM unread) without a second socket.
  api('/api/bootstrap').then((b) => {
    state.emotes = b.emotes || [];
    state.live = b.live || null;
    applyLive();
    setDmUnread(b.dmUnread || 0);
    renderEmoteBar();
    loadHowl();
  }).catch(() => {});
}
$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#loginErr').textContent = '';
  try {
    const data = await api('/api/login', { method: 'POST', body: { username: $('#loginUser').value, password: $('#loginPass').value } });
    afterAuth(data);
  } catch (e) { $('#loginErr').textContent = e.message; }
});
$('#signupForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#signupErr').textContent = '';
  try {
    const data = await api('/api/signup', {
      method: 'POST',
      body: { username: $('#suUser').value, displayName: $('#suDisplay').value, password: $('#suPass').value, dob: $('#suDob').value },
    });
    if (data.user.role === 'founder') toast('👑 Founder claimed! +25 Howl Coins');
    afterAuth(data);
  } catch (e) { $('#signupErr').textContent = e.message; }
});
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* session may be gone */ }
  location.reload();
});

boot().catch((e) => toast('Could not load Vantahowl: ' + e.message));
