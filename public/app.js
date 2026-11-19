'use strict';
/* Vantahowl frontend — vanilla JS SPA. All user content is escaped before render. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  me: null, csrf: null, settings: null, channels: [], gifts: [], badgesMeta: [],
  reactions: [], vibes: [], currentChannel: null, socket: null,
  gnTimer: null, uploadUrl: null,
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtTime(ts) { return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }

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
  return '<span class="author" style="color:' + esc(a.accent || '#f2f0ea') + '">' + esc(a.displayName) +
    '</span> <span class="rank">' + esc(a.rank.icon) + ' ' + esc(a.rank.name) + '</span>' + crown;
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
  renderHeader();
  renderChannels();
  applySettings();
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
    '<div class="post-head"><div>' + authorHtml(p.author) + '</div><span class="post-time">' + fmtTime(p.createdAt) + '</span></div>' +
    (p.text ? '<div class="post-text">' + esc(p.text) + '</div>' : '') +
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
      p.comments.map((c) => '<div class="comment">' + authorHtml(c.author) + ' — ' + esc(c.text) + '</div>').join('') +
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
    '<span class="post-time">' + fmtTime(m.createdAt) + '</span><br>' + esc(m.text) + '</div>';
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
  initLoungeSocket(socket);
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
    (me.rank.next ? ' · next rank at ' + me.rank.next + ' points' : ' · top rank — lead the pack 👑') + '</p>';
  $('#badgeCase').innerHTML = state.badgesMeta.map((b) => {
    const owned = me.badges.includes(b.id);
    return '<div class="badge-item' + (owned ? '' : ' locked') + '"><span class="b-icon">' + b.icon + '</span>' + esc(b.name) + '<br><span>' + esc(b.desc) + '</span></div>';
  }).join('');
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
      '<p class="muted">' + esc(u.statusLine || '') + '</p>' +
      '<p>Posts: ' + (s.posts || 0) + ' · Comments: ' + (s.comments || 0) + ' · Chat: ' + (s.chats || 0) + ' · Gifts sent: ' + (s.giftsSent || 0) + '</p>' +
      '<div class="badge-case">' + state.badgesMeta.filter((b) => u.badges.includes(b.id)).map((b) => '<div class="badge-item"><span class="b-icon">' + b.icon + '</span>' + esc(b.name) + '</div>').join('') + '</div>' +
      (state.me && state.me.id !== u.id ? '<div class="post-actions">' +
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
      row.innerHTML = '<span>' + esc(c.emoji) + ' <b>' + esc(c.name) + '</b>' + (c.hidden ? ' <span class="muted">(hidden)</span>' : '') + '</span>';
      const wrap = document.createElement('span');
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
    gameNight: gnAt ? { label: $('#setGnLabel').value, at: new Date(gnAt).toISOString() } : null,
    songOfDay: sodUrl ? { title: $('#setSodTitle').value, youtube: sodUrl } : null,
  };
  try {
    const data = await api('/api/admin/settings', { method: 'PATCH', body });
    state.settings = { ...state.settings, ...data.settings };
    applySettings();
    toast('Settings saved 👑');
  } catch (e) { toast(e.message); }
});
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
