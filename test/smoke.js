'use strict';
/*
 * Vantahowl smoke / integration suite.
 * Spawns the real server against a throwaway DATA_DIR, drives HTTP + Socket.IO,
 * restarts the server mid-suite to prove persistence, and prints exact counts.
 * Run: npm test
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io } = require('socket.io-client');
const { QUESTIONS: TRIVIA_BANK } = require('../lib/trivia');

const ROOT = path.join(__dirname, '..');
const PORT = 4123;
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vantahowl-test-'));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name); console.log('  ✗ ' + name + (extra ? ' — ' + extra : '')); }
}
async function test(name, fn) {
  try { await fn(); } catch (e) { failed++; failures.push(name + ' (threw)'); console.log('  ✗ ' + name + ' — threw: ' + e.message); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.cookies = {}; this.csrf = null; }
  cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => k + '=' + v).join('; '); }
  async req(method, p, body, opts) {
    opts = opts || {};
    const headers = {};
    if (body && !opts.form) headers['Content-Type'] = 'application/json';
    const ck = this.cookieHeader();
    if (ck) headers.Cookie = ck;
    if (this.csrf && method !== 'GET' && !opts.skipCsrf) headers['x-csrf-token'] = this.csrf;
    const res = await fetch(BASE + p, {
      method, headers, redirect: 'manual',
      body: opts.form ? body : (body ? JSON.stringify(body) : undefined),
    });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const pair = sc.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) this.cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* not json */ }
    if (data && data.csrfToken) this.csrf = data.csrfToken;
    return { status: res.status, data, headers: res.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b, o) { return this.req('POST', p, b, o); }
  patch(p, b) { return this.req('PATCH', p, b); }
  del(p) { return this.req('DELETE', p); }
}

let serverProc = null;
async function startServer() {
  serverProc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR, NODE_ENV: 'test',
      TRIVIA_QUESTION_MS: '9000', TRIVIA_GAP_MS: '600',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch (e) { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('server did not come up');
}
async function stopServer() {
  if (serverProc) { serverProc.kill('SIGKILL'); serverProc = null; await sleep(300); }
}

function connectSocket(client) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { extraHeaders: { Cookie: client.cookieHeader() }, transports: ['websocket', 'polling'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('socket connect timeout')), 5000);
  });
}
function waitEvent(socket, event, pred, timeout) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout waiting for ' + event)), timeout || 5000);
    socket.on(event, (d) => {
      if (!pred || pred(d)) { clearTimeout(to); resolve(d); }
    });
  });
}

const founder = new Client();
const alice = new Client();   // regular member
const bob = new Client();     // regular member
const ANON = new Client();
let lobbyId, musicId, clipsId, stonerId, alicesPostId, bobsPostId, pollId;
let aliceSocket = null, bobSocket = null, founderSocket = null;

async function main() {
  console.log('Vantahowl smoke suite — data dir: ' + DATA_DIR);
  await startServer();

  /* ---------- auth ---------- */
  console.log('\n[auth]');
  await test('founder signup claims Founder + 25 welcome coins', async () => {
    const r = await founder.post('/api/signup', { username: 'bludhound420', displayName: 'Houndy', password: 'howlpass420!', dob: '1995-04-20' });
    check('status 201', r.status === 201, JSON.stringify(r.data));
    check('role founder', r.data.user.role === 'founder');
    check('coins 25', r.data.user.coins === 25);
    founder.userId = r.data.user.id;
  });
  await test('member signups', async () => {
    const a = await alice.post('/api/signup', { username: 'luna_wolf', displayName: 'Luna', password: 'moonlight99', dob: '1998-02-11' });
    check('alice 201 member', a.status === 201 && a.data.user.role === 'member');
    check('alice coins 25', a.data.user.coins === 25);
    alice.userId = a.data.user.id;
    const b = await bob.post('/api/signup', { username: 'rex_hound', displayName: 'Rex', password: 'goodboy1234', dob: '2000-07-04' });
    check('bob 201', b.status === 201);
    bob.userId = b.data.user.id;
  });
  await test('signup validation', async () => {
    const dup = await ANON.post('/api/signup', { username: 'Luna_Wolf', displayName: 'X', password: 'whatever123', dob: '1990-01-01' });
    check('duplicate username 409', dup.status === 409);
    const short = await ANON.post('/api/signup', { username: 'newbie1', displayName: 'X', password: 'short', dob: '1990-01-01' });
    check('short password 400', short.status === 400);
    const young = await ANON.post('/api/signup', { username: 'newbie2', displayName: 'X', password: 'longenough1', dob: '2016-06-01' });
    check('under-13 dob 400', young.status === 400);
  });
  await test('login lockout after 5 fails', async () => {
    const c = new Client();
    await c.post('/api/signup', { username: 'locky', displayName: 'Locky', password: 'correctpass1', dob: '1992-03-03' });
    const lc = new Client();
    let last = null;
    for (let i = 0; i < 5; i++) last = await lc.post('/api/login', { username: 'locky', password: 'wrongpass' + i });
    check('5th fail locks (423)', last.status === 423, 'got ' + last.status);
    const good = await lc.post('/api/login', { username: 'locky', password: 'correctpass1' });
    check('correct password still locked (423)', good.status === 423);
  });
  await test('login + me + csrf guard', async () => {
    const bad = await ANON.post('/api/login', { username: 'luna_wolf', password: 'nope-nope-nope' });
    check('wrong password 401', bad.status === 401);
    const me0 = await ANON.get('/api/me');
    check('anonymous /api/me 401', me0.status === 401);
    // alice is already signed in from signup; verify csrf guard blocks token-less POST
    const noCsrf = await alice.post('/api/channels/x/posts', { text: 'hi' }, { skipCsrf: true });
    check('missing CSRF token 403', noCsrf.status === 403, 'got ' + noCsrf.status);
    const me = await alice.get('/api/me');
    check('/api/me returns alice', me.status === 200 && me.data.user.username === 'luna_wolf');
  });

  /* ---------- channels bootstrap ---------- */
  const boot = await founder.get('/api/bootstrap');
  lobbyId = boot.data.channels.find((c) => c.name === 'The Lobby').id;
  musicId = boot.data.channels.find((c) => c.name === 'Music').id;
  clipsId = boot.data.channels.find((c) => c.name === 'Clips & Videos').id;
  stonerId = boot.data.channels.find((c) => c.name === 'Stoner Lounge').id;
  check('7 default channels seeded (incl. Pack Pets + Stoner Lounge)', boot.data.channels.length === 7);
  check('Pack Pets channel seeded', boot.data.channels.some((c) => c.name === 'Pack Pets'));

  /* ---------- posts / comments / reactions ---------- */
  console.log('\n[content]');
  await test('alice posts to the Lobby (+5 coins)', async () => {
    const before = (await alice.get('/api/me')).data.user.coins;
    const r = await alice.post('/api/channels/' + lobbyId + '/posts', { text: 'First howl in Vantahowl! 🐺' });
    check('post 201', r.status === 201, JSON.stringify(r.data));
    alicesPostId = r.data.post.id;
    const after = (await alice.get('/api/me')).data.user.coins;
    check('coins +5 for post', after === before + 5, before + ' -> ' + after);
    check('First Howl badge earned', r.data.post.newBadges.some((b) => b.id === 'first-howl'));
  });
  await test('youtube embed post', async () => {
    const r = await alice.post('/api/channels/' + lobbyId + '/posts', { text: 'watch this', youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    check('youtubeId extracted', r.status === 201 && r.data.post.youtubeId === 'dQw4w9WgXcQ');
  });
  await test('image upload validation + photo post', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(128, 7)]);
    const fd = new FormData();
    fd.append('image', new Blob([png], { type: 'image/png' }), 'pic.png');
    const up = await alice.post('/api/upload', fd, { form: true });
    check('valid PNG accepted', up.status === 201 && /^\/uploads\/[a-f0-9]{32}\.png$/.test(up.data.url), JSON.stringify(up.data));
    const served = await fetch(BASE + up.data.url);
    check('uploaded file served', served.status === 200);
    const post = await alice.post('/api/channels/' + lobbyId + '/posts', { text: 'my setup', image: up.data.url });
    check('photo post 201', post.status === 201 && post.data.post.image === up.data.url);
    const fake = new FormData();
    fake.append('image', new Blob([Buffer.from('definitely not an image........')], { type: 'image/png' }), 'fake.png');
    const badUp = await alice.post('/api/upload', fake, { form: true });
    check('fake image rejected by magic bytes', badUp.status === 400);
    const big = new FormData();
    big.append('image', new Blob([Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(5 * 1024 * 1024 + 10, 3)])], { type: 'image/png' }), 'big.png');
    const bigUp = await alice.post('/api/upload', big, { form: true });
    check('oversized image rejected (5MB)', bigUp.status === 400);
  });
  await test('bob comments and reacts (toggle)', async () => {
    const c = await bob.post('/api/posts/' + alicesPostId + '/comments', { text: 'Clean setup! 🔥' });
    check('comment 201', c.status === 201);
    const feed = await alice.get('/api/channels/' + lobbyId + '/feed');
    const post = feed.data.posts.find((p) => p.id === alicesPostId);
    check('comment visible in feed', !!post && post.comments.length === 1 && post.comments[0].text.includes('Clean setup'));
    const r1 = await bob.post('/api/posts/' + alicesPostId + '/react', { emoji: '🔥' });
    check('reaction on: count 1 mine', r1.data.reactions['🔥'].count === 1 && r1.data.reactions['🔥'].mine === true);
    const r2 = await bob.post('/api/posts/' + alicesPostId + '/react', { emoji: '🔥' });
    check('reaction toggles off', !r2.data.reactions['🔥']);
    const r3 = await bob.post('/api/posts/' + alicesPostId + '/react', { emoji: '🔥' });
    check('reaction back on', r3.data.reactions['🔥'].count === 1);
  });
  await test('polls: create, vote, change vote, percentages', async () => {
    const p = await bob.post('/api/channels/' + lobbyId + '/polls', { question: 'Game of the week?', options: ['Warzone', 'Minecraft'] });
    check('poll 201', p.status === 201, JSON.stringify(p.data));
    pollId = p.data.poll.id;
    const [o1, o2] = p.data.poll.options.map((o) => o.id);
    const v1 = await alice.post('/api/polls/' + pollId + '/vote', { optionId: o1 });
    check('one vote = 100%', v1.data.poll.options[0].pct === 100 && v1.data.poll.totalVotes === 1);
    const v2 = await bob.post('/api/polls/' + pollId + '/vote', { optionId: o2 });
    check('split vote = 50/50', v2.data.poll.options[0].pct === 50 && v2.data.poll.options[1].pct === 50);
    const v3 = await alice.post('/api/polls/' + pollId + '/vote', { optionId: o2 });
    check('changed vote moves the count', v3.data.poll.options[0].count === 0 && v3.data.poll.options[1].count === 2 && v3.data.poll.myVote === o2);
  });

  /* ---------- chat + signaling ---------- */
  console.log('\n[chat & lounge signaling]');
  await test('socket chat: join, send, receive, history', async () => {
    aliceSocket = await connectSocket(alice);
    bobSocket = await connectSocket(bob);
    aliceSocket.emit('chat:join', lobbyId);
    bobSocket.emit('chat:join', lobbyId);
    await waitEvent(bobSocket, 'chat:history', (d) => d.channelId === lobbyId);
    const incoming = waitEvent(bobSocket, 'chat:message', (d) => d.channelId === lobbyId && d.message.text.includes('pack chat'));
    aliceSocket.emit('chat:send', { channelId: lobbyId, text: 'pack chat checking in 🐺' });
    const msg = await incoming;
    check('bob received alice\'s chat message', msg.message.author.username === 'luna_wolf');
    await sleep(350);
    const profane = waitEvent(bobSocket, 'chat:message', (d) => d.message.text.includes('s***'));
    aliceSocket.emit('chat:send', { channelId: lobbyId, text: 'this shit is cozy' });
    await profane;
    check('profanity masked in chat when setting on', true);
    const hist = await alice.get('/api/channels/' + lobbyId + '/messages');
    check('chat persisted via REST history', hist.data.messages.some((m) => m.text.includes('pack chat')));
  });
  await test('webrtc signaling relay: peers, offer, answer, ice', async () => {
    bobSocket.emit('lounge:join');
    const peersEvt = waitEvent(bobSocket, 'lounge:peers', null);
    aliceSocket.emit('lounge:join');
    const joinedEvt = waitEvent(bobSocket, 'lounge:peer-joined', (d) => d.username === 'luna_wolf');
    const joined = await joinedEvt;
    const peers = await peersEvt;
    check('existing peer learns of joiner', joined.socketId === aliceSocket.id);
    check('peers list event received', !!peers);
    const offerEvt = waitEvent(aliceSocket, 'rtc:offer', (d) => d.from === bobSocket.id);
    bobSocket.emit('rtc:offer', { to: aliceSocket.id, sdp: { type: 'offer', sdp: 'fake-offer-sdp' } });
    const offer = await offerEvt;
    check('offer relayed with sdp intact', offer.sdp.sdp === 'fake-offer-sdp');
    const answerEvt = waitEvent(bobSocket, 'rtc:answer', (d) => d.from === aliceSocket.id);
    aliceSocket.emit('rtc:answer', { to: bobSocket.id, sdp: { type: 'answer', sdp: 'fake-answer-sdp' } });
    const answer = await answerEvt;
    check('answer relayed', answer.sdp.sdp === 'fake-answer-sdp');
    const iceEvt = waitEvent(bobSocket, 'rtc:ice', (d) => d.from === aliceSocket.id);
    aliceSocket.emit('rtc:ice', { to: bobSocket.id, candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 9 typ host' } });
    const ice = await iceEvt;
    check('ice candidate relayed', ice.candidate.candidate.includes('candidate:1'));
    aliceSocket.emit('lounge:leave');
    bobSocket.emit('lounge:leave');
  });

  /* ---------- economy ---------- */
  console.log('\n[economy]');
  await test('gift on a post moves coins sender -> author (ledger math)', async () => {
    const bobPost = await bob.post('/api/channels/' + lobbyId + '/posts', { text: 'Rex checking in' });
    bobsPostId = bobPost.data.post.id;
    const aBefore = (await alice.get('/api/me')).data.user.coins;
    const bBefore = (await bob.get('/api/me')).data.user.coins;
    const g = await alice.post('/api/gifts', { gift: '🌹', postId: bobsPostId });
    check('gift 201', g.status === 201, JSON.stringify(g.data));
    const aAfter = (await alice.get('/api/me')).data.user.coins;
    const bAfter = (await bob.get('/api/me')).data.user.coins;
    check('sender debited 5', aAfter === aBefore - 5, aBefore + ' -> ' + aAfter);
    check('author credited 5', bAfter === bBefore + 5, bBefore + ' -> ' + bAfter);
    const feed = await bob.get('/api/channels/' + lobbyId + '/feed');
    const post = feed.data.posts.find((p) => p.id === bobsPostId);
    check('gift recorded on post with sender', post.gifts.length === 1 && post.gifts[0].from.username === 'luna_wolf');
  });
  await test('gift guards: self-gift and insufficient funds', async () => {
    const self = await alice.post('/api/gifts', { gift: '🌹', postId: alicesPostId });
    check('self-gift 400', self.status === 400);
    const pup = new Client();
    await pup.post('/api/signup', { username: 'pup_new', displayName: 'Pup', password: 'puppypower1', dob: '2001-01-01' });
    const broke = await pup.post('/api/gifts', { gift: '👑', postId: alicesPostId });
    check('crown (50) with 25 coins -> 400', broke.status === 400);
  });
  await test('daily spin: once per day only', async () => {
    const s1 = await alice.post('/api/arcade/spin', {});
    check('first spin ok, amount 0..40', s1.status === 200 && s1.data.amount >= 0 && s1.data.amount <= 40);
    const s2 = await alice.post('/api/arcade/spin', {});
    check('second spin same day 400', s2.status === 400);
  });
  await test('reaction sprint: plausibility cap + leaderboard', async () => {
    const ok = await alice.post('/api/arcade/sprint', { ms: 250 });
    check('250ms accepted as best', ok.status === 200 && ok.data.personalBest === 250);
    const fast = await alice.post('/api/arcade/sprint', { ms: 40 });
    check('40ms rejected as implausible', fast.status === 400);
    const board = await alice.get('/api/arcade/leaderboard');
    check('alice tops fastest paws', board.data.fastest.length >= 1 && board.data.fastest[0].ms === 250);
  });
  await test('vibe check-in once per day', async () => {
    const v1 = await bob.post('/api/vibe', { mood: 'Chill' });
    check('check-in ok', v1.status === 200 && v1.data.vibe.mood === 'Chill');
    const v2 = await bob.post('/api/vibe', { mood: 'Hyped' });
    check('second check-in 400', v2.status === 400);
  });
  await test('weekly quests: drive one to completion and claim', async () => {
    const q = await alice.get('/api/quests');
    check('3 active quests', q.data.quests.length === 3);
    const target = q.data.quests.find((x) => x.id !== 'vibes' && !x.claimed);
    check('a completable quest exists', !!target, JSON.stringify(q.data.quests.map((x) => x.id)));
    if (!target) return;
    const drive = async () => {
      const cur = (await alice.get('/api/quests')).data.quests.find((x) => x.id === target.id);
      if (cur.progress >= target.target) return;
      if (target.metric === 'posts') await alice.post('/api/channels/' + lobbyId + '/posts', { text: 'quest howl ' + Date.now() });
      else if (target.metric === 'comments') await alice.post('/api/posts/' + bobsPostId + '/comments', { text: 'quest comment ' + Date.now() });
      else if (target.metric === 'giftsSent') await alice.post('/api/gifts', { gift: '🌹', postId: bobsPostId });
      else if (target.metric === 'pollVotes') {
        const p = await bob.post('/api/channels/' + lobbyId + '/polls', { question: 'Quest poll ' + Date.now(), options: ['Yes', 'Howl yes'] });
        await alice.post('/api/polls/' + p.data.poll.id + '/vote', { optionId: p.data.poll.options[0].id });
      } else if (target.metric === 'chats') {
        aliceSocket.emit('chat:send', { channelId: lobbyId, text: 'quest chat ' + Date.now() });
        await sleep(320);
      }
      await drive();
    };
    await drive();
    const after = (await alice.get('/api/quests')).data.quests.find((x) => x.id === target.id);
    check('quest progress reached target', after.progress >= target.target, after.progress + '/' + target.target);
    const coinsBefore = (await alice.get('/api/me')).data.user.coins;
    const claim = await alice.post('/api/quests/claim', { questId: target.id });
    check('claim pays reward', claim.status === 200 && claim.data.reward === target.reward);
    const coinsAfter = (await alice.get('/api/me')).data.user.coins;
    check('coins increased by reward', coinsAfter === coinsBefore + target.reward, coinsBefore + ' -> ' + coinsAfter);
    const again = await alice.post('/api/quests/claim', { questId: target.id });
    check('double claim 400', again.status === 400);
  });
  await test('pack leaderboard shows weekly points', async () => {
    const lb = await alice.get('/api/leaderboard');
    check('leaderboard has alice with points', lb.data.top.some((r) => r.user.username === 'luna_wolf' && r.weeklyPoints > 0));
  });

  /* ---------- LFG ---------- */
  console.log('\n[lfg]');
  let lfgId;
  await test('squad board: post, 24h expiry stamp, mark filled rules', async () => {
    const r = await alice.post('/api/lfg', { game: 'Warzone', text: 'Need 2 for ranked, mics on' });
    check('lfg 201', r.status === 201, JSON.stringify(r.data));
    lfgId = r.data.lfg.id;
    const span = r.data.lfg.expiresAt - r.data.lfg.createdAt;
    check('expires ~24h out', Math.abs(span - 24 * 3600 * 1000) < 5000, 'span ' + span);
    const list = await bob.get('/api/lfg');
    check('listed for others', list.data.lfg.some((l) => l.id === lfgId));
    const wrong = await bob.post('/api/lfg/' + lfgId + '/filled', {});
    check('non-author cannot mark filled (403)', wrong.status === 403);
    const right = await alice.post('/api/lfg/' + lfgId + '/filled', {});
    check('author marks filled', right.status === 200);
  });

  /* ---------- reports & blocks ---------- */
  console.log('\n[safety]');
  await test('reports queue: file, dismiss, delete-content', async () => {
    const rep = await bob.post('/api/reports', { targetType: 'post', targetId: alicesPostId, reason: 'spam vibes' });
    check('report 201', rep.status === 201);
    const queue = await founder.get('/api/admin/reports');
    check('founder sees the report', queue.data.reports.some((r) => r.id === rep.data.report.id && r.status === 'open'));
    const dis = await founder.post('/api/admin/reports/' + rep.data.report.id + '/dismiss', {});
    check('dismiss ok', dis.status === 200);
    const rep2 = await bob.post('/api/reports', { targetType: 'post', targetId: alicesPostId, reason: 'still spammy' });
    const del = await founder.post('/api/admin/reports/' + rep2.data.report.id + '/delete-content', {});
    check('delete-content ok', del.status === 200);
    const feed = await alice.get('/api/channels/' + lobbyId + '/feed');
    check('reported post removed from feed', !feed.data.posts.some((p) => p.id === alicesPostId));
    const memberQueue = await alice.get('/api/admin/reports');
    check('member cannot read reports queue (403)', memberQueue.status === 403);
  });
  await test('blocks hide content; self-block rejected', async () => {
    const self = await bob.post('/api/blocks', { userId: bob.userId });
    check('self-block 400', self.status === 400);
    const blk = await bob.post('/api/blocks', { userId: alice.userId });
    check('block 200', blk.status === 200);
    const feed = await bob.get('/api/channels/' + lobbyId + '/feed');
    check('blocked author posts hidden', !feed.data.posts.some((p) => p.author && p.author.id === alice.userId));
    const un = await bob.del('/api/blocks/' + alice.userId);
    check('unblock 200', un.status === 200);
    const feed2 = await bob.get('/api/channels/' + lobbyId + '/feed');
    check('posts visible again after unblock', feed2.data.posts.some((p) => p.author && p.author.id === alice.userId));
  });

  /* ---------- admin ---------- */
  console.log('\n[admin]');
  await test('settings: founder only, reflected in bootstrap', async () => {
    const denied = await alice.patch('/api/admin/settings', { announcement: 'hacked' });
    check('member settings patch 403', denied.status === 403);
    const r = await founder.patch('/api/admin/settings', {
      announcement: 'Game Night every Saturday 8 PM CT 🐺',
      gameNight: { label: 'Game Night in Vantahowl', at: '2026-11-21T20:00:00-06:00' },
      songOfDay: { title: 'Moonlight Drive — Pack Mix', youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    });
    check('founder settings 200', r.status === 200, JSON.stringify(r.data));
    const b2 = await ANON.get('/api/bootstrap');
    check('announcement public', b2.data.settings.announcement.includes('Game Night every Saturday'));
    check('game night set', b2.data.settings.gameNight.label === 'Game Night in Vantahowl');
    const music = await ANON.get('/api/channels/' + musicId + '/feed');
    check('song of the day pinned in Music', !!music.data.songOfDay && music.data.songOfDay.youtubeId === 'dQw4w9WgXcQ');
  });
  await test('founder spotlight pins a post atop the Lobby', async () => {
    const sp = await founder.post('/api/admin/posts/' + bobsPostId + '/spotlight', {});
    check('spotlight 200', sp.status === 200);
    const feed = await alice.get('/api/channels/' + lobbyId + '/feed');
    check('spotlight post served separately', !!feed.data.spotlight && feed.data.spotlight.id === bobsPostId);
    const denied = await alice.post('/api/admin/posts/' + bobsPostId + '/spotlight', {});
    check('member spotlight 403', denied.status === 403);
  });
  await test('channel CRUD + hidden channel visibility', async () => {
    const denied = await alice.post('/api/admin/channels', { name: 'Nope', emoji: '🚫', topic: '' });
    check('member channel create 403', denied.status === 403);
    const c = await founder.post('/api/admin/channels', { name: 'Secret Den', emoji: '🕳️', topic: 'staff only' });
    check('channel created', c.status === 201);
    const cid = c.data.channel.id;
    const ren = await founder.patch('/api/admin/channels/' + cid, { name: 'Staff Den' });
    check('channel renamed', ren.status === 200 && ren.data.channel.name === 'Staff Den');
    await founder.patch('/api/admin/channels/' + cid, { hidden: true });
    const memberView = await alice.get('/api/bootstrap');
    check('hidden channel invisible to members', !memberView.data.channels.some((x) => x.id === cid));
    const founderView = await founder.get('/api/bootstrap');
    check('hidden channel visible to founder', founderView.data.channels.some((x) => x.id === cid));
    const memberFeed = await alice.get('/api/channels/' + cid + '/feed');
    check('member feed for hidden channel 404', memberFeed.status === 404);
    const del = await founder.del('/api/admin/channels/' + cid);
    check('channel deleted', del.status === 200);
    const after = await founder.get('/api/bootstrap');
    check('deleted channel gone', !after.data.channels.some((x) => x.id === cid));
  });
  await test('roles, founder protection, ban flow', async () => {
    const promote = await founder.patch('/api/admin/users/' + alice.userId + '/role', { role: 'moderator' });
    check('promote to moderator', promote.status === 200 && promote.data.user.role === 'moderator');
    const demoteFounder = await founder.patch('/api/admin/users/' + founder.userId + '/role', { role: 'member' });
    check('founder cannot be demoted (400)', demoteFounder.status === 400);
    const banFounder = await founder.patch('/api/admin/users/' + founder.userId + '/ban', { banned: true });
    check('founder cannot be banned (400)', banFounder.status === 400);
    await founder.patch('/api/admin/users/' + alice.userId + '/role', { role: 'member' });
    const ban = await founder.patch('/api/admin/users/' + bob.userId + '/ban', { banned: true });
    check('ban member ok', ban.status === 200 && ban.data.banned === true);
    const bannedLogin = await new Client().post('/api/login', { username: 'rex_hound', password: 'goodboy1234' });
    check('banned user cannot log in (403)', bannedLogin.status === 403);
    const feed = await alice.get('/api/channels/' + lobbyId + '/feed');
    check('banned author content hidden', !feed.data.posts.some((p) => p.author && p.author.id === bob.userId));
    const unban = await founder.patch('/api/admin/users/' + bob.userId + '/ban', { banned: false });
    check('unban ok', unban.status === 200);
    const okLogin = await new Client().post('/api/login', { username: 'rex_hound', password: 'goodboy1234' });
    check('unbanned user can log in', okLogin.status === 200);
  });
  await test('security log is founder-only and records events', async () => {
    const log = await founder.get('/api/admin/security-log');
    check('founder reads log', log.status === 200 && log.data.log.length > 0);
    check('log captured signup + ban events', log.data.log.some((e) => e.event === 'signup') && log.data.log.some((e) => e.event === 'ban'));
    const denied = await alice.get('/api/admin/security-log');
    check('member denied log (403)', denied.status === 403);
  });

  /* ---------- feature pack: age gate ---------- */
  console.log('\n[feature pack: stoner lounge gate]');
  let battleClipB = null;
  await test('stoner lounge: hard 21+ server-side gate', async () => {
    const teen = new Client();
    const t = await teen.post('/api/signup', { username: 'teen_wolf', displayName: 'Teen', password: 'teenpass1234', dob: '2010-06-01' });
    check('teen (16) signup ok', t.status === 201);
    const teenBoot = await teen.get('/api/bootstrap');
    check('teen cannot see Stoner Lounge in channel list', !teenBoot.data.channels.some((c) => c.id === stonerId));
    const teenFeed = await teen.get('/api/channels/' + stonerId + '/feed');
    check('teen feed request 404', teenFeed.status === 404);
    const teenPost = await teen.post('/api/channels/' + stonerId + '/posts', { text: 'sneaking in' });
    check('teen post attempt 404', teenPost.status === 404);
    const twenty = new Client();
    await twenty.post('/api/signup', { username: 'almost_21', displayName: 'Al', password: 'almostthere1', dob: '2006-01-15' });
    const twentyBoot = await twenty.get('/api/bootstrap');
    check('20-year-old also gated out', !twentyBoot.data.channels.some((c) => c.id === stonerId));
    const adultFeed = await alice.get('/api/channels/' + stonerId + '/feed');
    check('adult (28) can open Stoner Lounge', adultFeed.status === 200);
    const adultPost = await alice.post('/api/channels/' + stonerId + '/posts', { text: 'mellow evening, pack 🌿' });
    check('adult can post in Stoner Lounge', adultPost.status === 201);
    const petsPost = await alice.post('/api/channels/' + boot.data.channels.find((c) => c.name === 'Pack Pets').id + '/posts', { text: 'my cat judges my aim' });
    check('Pack Pets channel accepts posts', petsPost.status === 201);
  });

  /* ---------- feature pack: DMs ---------- */
  console.log('\n[feature pack: dms]');
  await test('direct messages: send, inbox, unread, read receipts', async () => {
    const dmEvt = waitEvent(bobSocket, 'dm:new', (d) => d.message.text.includes('hello via dm'));
    const sent = await alice.post('/api/dms/' + bob.userId, { text: 'hello via dm 🐺' });
    check('dm send 201', sent.status === 201, JSON.stringify(sent.data));
    const evt = await dmEvt;
    check('recipient socket got dm:new', evt.from.username === 'luna_wolf');
    const inbox = await bob.get('/api/dms');
    check('inbox lists conversation with unread 1', inbox.data.conversations.length >= 1 && inbox.data.conversations[0].unread === 1);
    check('inbox unread total 1', inbox.data.unread === 1);
    const meUnread = await bob.get('/api/me');
    check('/api/me reports dmUnread 1', meUnread.data.dmUnread === 1);
    const thread = await bob.get('/api/dms/' + alice.userId);
    check('thread has the message (not mine)', thread.data.messages.length === 1 && thread.data.messages[0].mine === false);
    const inbox2 = await bob.get('/api/dms');
    check('opening thread marks read (unread 0)', inbox2.data.unread === 0);
    const self = await alice.post('/api/dms/' + alice.userId, { text: 'note to self' });
    check('self-DM 400', self.status === 400);
  });
  await test('direct messages: blocked users cannot DM (either direction)', async () => {
    await bob.post('/api/blocks', { userId: alice.userId });
    const a2b = await alice.post('/api/dms/' + bob.userId, { text: 'you there?' });
    check('blocked sender -> 403', a2b.status === 403);
    const b2a = await bob.post('/api/dms/' + alice.userId, { text: 'reply attempt' });
    check('blocker also cannot DM back -> 403', b2a.status === 403);
    await bob.del('/api/blocks/' + alice.userId);
    const ok = await alice.post('/api/dms/' + bob.userId, { text: 'unblocked, back to howling' });
    check('DM works again after unblock', ok.status === 201);
  });

  /* ---------- feature pack: howl / profile / streak / kudos ---------- */
  console.log('\n[feature pack: howl, profile, streak, kudos]');
  await test('the Pack Howl: live counter, my total, streak', async () => {
    const upd = waitEvent(bobSocket, 'howl:update', (d) => d.total >= 1);
    aliceSocket.emit('howl:press');
    const u1 = await upd;
    check('howl broadcast to the pack', u1.today >= 1);
    await sleep(400);
    aliceSocket.emit('howl:press');
    await sleep(400);
    const state = await alice.get('/api/howl');
    check('pack total counted both howls', state.data.total >= 2, 'total ' + state.data.total);
    check('my howls = 2, streak = 1 day', state.data.mine.total === 2 && state.data.mine.streak === 1);
  });
  await test('profile glow-up: banner + now playing', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(64, 9)]);
    const fd = new FormData();
    fd.append('image', new Blob([png], { type: 'image/png' }), 'banner.png');
    const up = await alice.post('/api/upload', fd, { form: true });
    check('banner upload ok', up.status === 201);
    const patched = await alice.patch('/api/me', { banner: up.data.url, nowPlaying: 'Warzone' });
    check('profile patch ok', patched.status === 200 && patched.data.user.nowPlaying === 'Warzone');
    const prof = await bob.get('/api/users/' + alice.userId);
    check('banner + nowPlaying visible on public profile', prof.data.user.banner === up.data.url && prof.data.user.nowPlaying === 'Warzone');
    const bad = await alice.patch('/api/me', { banner: 'https://evil.example/x.png' });
    check('external banner URL rejected (400)', bad.status === 400);
  });
  await test('login streak is tracked and returned', async () => {
    const c = new Client();
    const r = await c.post('/api/login', { username: 'luna_wolf', password: 'moonlight99' });
    check('login ok', r.status === 200);
    check('streak reported (>= 1 day)', r.data.streak && r.data.streak.streak >= 1, JSON.stringify(r.data.streak));
    check('publicUser carries streak', r.data.user.streak >= 1);
  });
  await test('kudos: give, self-guard, weekly limit of 3, profile count', async () => {
    const k1 = await alice.post('/api/users/' + bob.userId + '/kudos', {});
    check('kudos 201, 2 left', k1.status === 201 && k1.data.targetKudos === 1 && k1.data.kudosLeft === 2, JSON.stringify(k1.data));
    const self = await alice.post('/api/users/' + alice.userId + '/kudos', {});
    check('self-kudos 400', self.status === 400);
    await alice.post('/api/users/' + bob.userId + '/kudos', {});
    const k3 = await alice.post('/api/users/' + bob.userId + '/kudos', {});
    check('third kudos ok, 0 left', k3.status === 201 && k3.data.kudosLeft === 0);
    const k4 = await alice.post('/api/users/' + founder.userId + '/kudos', {});
    check('fourth kudos in a week -> 400', k4.status === 400);
    const prof = await alice.get('/api/users/' + bob.userId);
    check('kudos count shows on profile (3)', prof.data.user.kudosReceived === 3 && prof.data.user.stats.kudosReceived === 3);
  });

  /* ---------- feature pack: jukebox ---------- */
  console.log('\n[feature pack: jukebox]');
  await test('pack jukebox: queue, votes reorder, skip rules', async () => {
    const add1 = await alice.post('/api/jukebox', { youtube: 'https://youtu.be/abc123XYZ09', title: 'Song A' });
    check('add song 201, now playing', add1.status === 201 && add1.data.nowPlaying.youtubeId === 'abc123XYZ09', JSON.stringify(add1.data));
    const dup = await alice.post('/api/jukebox', { youtube: 'abc123XYZ09', title: 'Song A again' });
    check('duplicate song 400', dup.status === 400);
    const add2 = await bob.post('/api/jukebox', { youtube: 'https://www.youtube.com/watch?v=def456UVW78', title: 'Song B' });
    check('second song queued', add2.status === 201 && add2.data.queue.length === 2);
    const jb = (await alice.get('/api/jukebox')).data;
    const songA = jb.queue.find((j) => j.youtubeId === 'abc123XYZ09');
    const songB = jb.queue.find((j) => j.youtubeId === 'def456UVW78');
    await bob.post('/api/jukebox/' + songA.id + '/vote', {});
    await alice.post('/api/jukebox/' + songB.id + '/vote', {});
    let state = (await alice.get('/api/jukebox')).data;
    check('tie 1-1 keeps the older song on top', state.nowPlaying.youtubeId === 'abc123XYZ09');
    await bob.post('/api/jukebox/' + songB.id + '/vote', {});
    state = (await alice.get('/api/jukebox')).data;
    check('second vote promotes Song B to now playing', state.nowPlaying.youtubeId === 'def456UVW78' && state.nowPlaying.votes === 2);
    const skipDenied = await alice.post('/api/jukebox/next', {});
    check('non-author non-staff cannot skip (403)', skipDenied.status === 403);
    const skipped = await bob.post('/api/jukebox/next', {});
    check('author skips own now-playing song', skipped.status === 200 && skipped.data.nowPlaying.youtubeId === 'abc123XYZ09');
    const clean = await founder.del('/api/jukebox/' + songA.id);
    check('founder can clear the queue', clean.status === 200 && clean.data.queue.length === 0);
  });

  /* ---------- feature pack: clip battles ---------- */
  console.log('\n[feature pack: clip battles]');
  await test('clip battles: founder-run bracket round with crown + prize', async () => {
    const clipA = await alice.post('/api/channels/' + clipsId + '/posts', { text: 'clip A', youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    const clipB = await bob.post('/api/channels/' + clipsId + '/posts', { text: 'clip B', youtube: 'https://www.youtube.com/watch?v=e-ORhEE9VVg' });
    battleClipB = clipB.data.post.id;
    const memberTry = await alice.post('/api/battles', { postAId: clipA.data.post.id, postBId: battleClipB, prize: 30 });
    check('member cannot create a battle (403)', memberTry.status === 403);
    const wrongChan = await founder.post('/api/battles', { postAId: bobsPostId, postBId: battleClipB, prize: 30 });
    check('lobby post cannot battle (400)', wrongChan.status === 400);
    const made = await founder.post('/api/battles', { postAId: clipA.data.post.id, postBId: battleClipB, prize: 30 });
    check('battle created, round 1', made.status === 201 && made.data.battle.round === 1 && made.data.battle.status === 'open', JSON.stringify(made.data));
    const second = await founder.post('/api/battles', { postAId: clipA.data.post.id, postBId: battleClipB, prize: 30 });
    check('second open battle refused (400)', second.status === 400);
    const bid = made.data.battle.id;
    await alice.post('/api/battles/' + bid + '/vote', { postId: clipA.data.post.id });
    await bob.post('/api/battles/' + bid + '/vote', { postId: battleClipB });
    const tie = await founder.post('/api/battles/' + bid + '/close', {});
    check('tied close without a pick -> 400', tie.status === 400);
    await alice.post('/api/battles/' + bid + '/vote', { postId: battleClipB });
    const bobCoins = (await bob.get('/api/me')).data.user.coins;
    const closed = await founder.post('/api/battles/' + bid + '/close', {});
    check('close crowns the vote leader', closed.status === 200 && closed.data.battle.winnerPostId === battleClipB, JSON.stringify(closed.data));
    const bobAfter = (await bob.get('/api/me')).data.user.coins;
    check('winner author paid the 30-coin prize', bobAfter === bobCoins + 30, bobCoins + ' -> ' + bobAfter);
    const feed = await alice.get('/api/channels/' + clipsId + '/feed');
    const winPost = feed.data.posts.find((p) => p.id === battleClipB);
    check('winning clip wears the crown in the feed', !!winPost && winPost.crowned === true);
    const lateVote = await alice.post('/api/battles/' + bid + '/vote', { postId: clipA.data.post.id });
    check('voting on a closed battle -> 400', lateVote.status === 400);
  });

  /* ---------- feature pack: events + MVP ---------- */
  console.log('\n[feature pack: events & mvp]');
  await test('events calendar: founder creates, pack RSVPs, lobby shows it + MVP', async () => {
    const memberTry = await alice.post('/api/events', { title: 'Sneaky', kind: 'Other', at: '2026-12-01T20:00:00Z' });
    check('member cannot create events (403)', memberTry.status === 403);
    const made = await founder.post('/api/events', {
      title: 'Game Night: Warzone', kind: 'Game Night',
      at: '2026-11-21T20:00:00-06:00', description: 'Squad up, mics on.',
    });
    check('event created', made.status === 201, JSON.stringify(made.data));
    const eid = made.data.event.id;
    const rsvp = await alice.post('/api/events/' + eid + '/rsvp', {});
    check('RSVP in: going 1, mine', rsvp.status === 200 && rsvp.data.event.going === 1 && rsvp.data.event.mine === true);
    const un = await alice.post('/api/events/' + eid + '/rsvp', {});
    check('RSVP toggles back off', un.data.event.going === 0);
    await alice.post('/api/events/' + eid + '/rsvp', {});
    const feed = await alice.get('/api/channels/' + lobbyId + '/feed');
    check('upcoming event shows on the Lobby', (feed.data.events || []).some((e) => e.id === eid));
    check('pack MVP spotlights an active member', !!feed.data.mvp && feed.data.mvp.weeklyPoints > 0 && feed.data.mvp.user.role !== 'founder',
      JSON.stringify(feed.data.mvp));
    const del = await founder.del('/api/events/' + eid);
    check('founder deletes event', del.status === 200);
    const list = await alice.get('/api/events');
    check('deleted event gone', !list.data.events.some((e) => e.id === eid));
  });

  /* ---------- feature pack: emotes + suggestions ---------- */
  console.log('\n[feature pack: emotes & suggestions]');
  await test('custom emotes: submit, approve, then usable pack-wide', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(48, 5)]);
    const fd = new FormData();
    fd.append('image', new Blob([png], { type: 'image/png' }), 'emote.png');
    const up = await alice.post('/api/upload', fd, { form: true });
    const sub = await alice.post('/api/emotes', { name: 'packlove', image: up.data.url });
    check('emote submitted as pending', sub.status === 201 && sub.data.emote.status === 'pending', JSON.stringify(sub.data));
    const bootAnon = await ANON.get('/api/bootstrap');
    check('pending emote not yet public', !bootAnon.data.emotes.some((e) => e.name === 'packlove'));
    const dup = await bob.post('/api/emotes', { name: 'packlove', image: up.data.url });
    check('duplicate emote name 409', dup.status === 409);
    const memberApprove = await alice.post('/api/admin/emotes/' + sub.data.emote.id + '/approve', {});
    check('member cannot approve emotes (403)', memberApprove.status === 403);
    const queue = await founder.get('/api/admin/emotes');
    check('founder sees the pending queue', queue.data.emotes.some((e) => e.id === sub.data.emote.id && e.status === 'pending'));
    const ok = await founder.post('/api/admin/emotes/' + sub.data.emote.id + '/approve', {});
    check('founder approves emote', ok.status === 200 && ok.data.emote.status === 'approved');
    const boot2 = await ANON.get('/api/bootstrap');
    check('approved emote now in bootstrap for everyone', boot2.data.emotes.some((e) => e.name === 'packlove'));
  });
  await test('suggestion box: submit, upvote toggle, founder triage', async () => {
    const s = await alice.post('/api/suggestions', { text: 'Add a dice roll command to chat' });
    check('suggestion 201 open', s.status === 201 && s.data.suggestion.status === 'open');
    const sid = s.data.suggestion.id;
    const v1 = await bob.post('/api/suggestions/' + sid + '/vote', {});
    check('upvote lands (1)', v1.data.suggestion.votes === 1 && v1.data.suggestion.mine === true);
    const v2 = await bob.post('/api/suggestions/' + sid + '/vote', {});
    check('upvote toggles off (0)', v2.data.suggestion.votes === 0);
    const memberTriage = await alice.patch('/api/admin/suggestions/' + sid, { status: 'planned' });
    check('member cannot triage (403)', memberTriage.status === 403);
    const triage = await founder.patch('/api/admin/suggestions/' + sid, { status: 'planned' });
    check('founder marks planned', triage.status === 200 && triage.data.suggestion.status === 'planned');
    const list = await bob.get('/api/suggestions');
    check('suggestion listed with status', list.data.suggestions.some((x) => x.id === sid && x.status === 'planned'));
  });

  /* ---------- feature pack: live banner ---------- */
  console.log('\n[feature pack: live banner]');
  await test('HOUNDY IS LIVE banner: manual toggle is honest + founder-only', async () => {
    const before = await ANON.get('/api/bootstrap');
    check('no manual source before toggle', before.data.live.source !== 'manual', JSON.stringify(before.data.live));
    check('banner links to the Kick channel', before.data.live.url === 'https://kick.com/bludhound420');
    const on = await founder.patch('/api/admin/settings', { liveManual: true });
    check('founder flips manual live on', on.status === 200);
    const lit = await ANON.get('/api/bootstrap');
    check('banner shows, source = manual', lit.data.live.show === true && lit.data.live.source === 'manual');
    const memberTry = await alice.patch('/api/admin/settings', { liveManual: false });
    check('member cannot touch the toggle (403)', memberTry.status === 403);
    const recheck = await founder.post('/api/admin/live-check', {});
    check('live-check endpoint responds with state', recheck.status === 200 && typeof recheck.data.live.show === 'boolean');
    await founder.patch('/api/admin/settings', { liveManual: false });
    const off = await ANON.get('/api/bootstrap');
    check('manual source clears after toggle off', off.data.live.source !== 'manual');
  });

  /* ---------- feature pack: watch party ---------- */
  console.log('\n[feature pack: watch party]');
  await test('watch party: host sets + controls, guests cannot hijack', async () => {
    founderSocket = await connectSocket(founder);
    founderSocket.emit('party:join');
    await waitEvent(founderSocket, 'party:state', (d) => 'state' in d);
    aliceSocket.emit('party:join');
    const joinState = await waitEvent(aliceSocket, 'party:state', (d) => 'state' in d);
    check('guest joins, no video yet, cannot host', joinState.state === null && joinState.canHost === false);
    const setEvt = waitEvent(aliceSocket, 'party:state', (d) => d.state && d.state.videoId === 'dQw4w9WgXcQ');
    founderSocket.emit('party:set', { youtube: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Movie Night' });
    const st = await setEvt;
    check('host set the video, playing, host = founder', st.state.playing === true && st.state.hostId === founder.userId);
    aliceSocket.emit('party:control', { action: 'pause', position: 5 });
    aliceSocket.emit('party:set', { youtube: 'https://www.youtube.com/watch?v=e-ORhEE9VVg', title: 'Hijack' });
    await sleep(400);
    const now = await alice.get('/api/party');
    check('guest control + set ignored (still playing, same video)', now.data.state.playing === true && now.data.state.videoId === 'dQw4w9WgXcQ');
    const pauseEvt = waitEvent(aliceSocket, 'party:state', (d) => d.state && d.state.playing === false);
    founderSocket.emit('party:control', { action: 'pause', position: 42 });
    const paused = await pauseEvt;
    check('host pause syncs to guests at position 42', paused.state.position === 42, JSON.stringify(paused.state));
    const chatEvt = waitEvent(founderSocket, 'party:chat', (d) => d.message.text.includes('popcorn ready'));
    aliceSocket.emit('party:chat', { text: 'popcorn ready 🍿' });
    await chatEvt;
    check('party side-chat relays between guests', true);
  });

  /* ---------- feature pack: trivia ---------- */
  console.log('\n[feature pack: trivia]');
  await test('trivia night: mod-run session, first correct answer scores', async () => {
    const memberTry = await alice.post('/api/trivia/start', { channelId: lobbyId });
    check('member cannot start trivia (403)', memberTry.status === 403);
    const started = await founder.post('/api/trivia/start', { channelId: lobbyId });
    check('founder starts trivia (5 questions)', started.status === 201 && started.data.questions === 5, JSON.stringify(started.data));
    const again = await founder.post('/api/trivia/start', { channelId: lobbyId });
    check('second start while running -> 400', again.status === 400);
    const sysMsg = (pred) => waitEvent(bobSocket, 'chat:message',
      (d) => d.message.author && d.message.author.username === 'trivia_moon' && pred(d.message.text), 20000);
    let answered = 0;
    for (let i = 0; i < 5; i++) {
      const qMsg = await sysMsg((t) => t.includes('Trivia Q' + (i + 1) + '/'));
      const m = /Trivia Q\d+\/\d+: (.*?) \(first correct/.exec(qMsg.message.text);
      check('question ' + (i + 1) + ' posted by Trivia Moon', !!m, qMsg.message.text);
      if (!m) break;
      const bank = TRIVIA_BANK.find((q) => q.q === m[1]);
      check('question ' + (i + 1) + ' found in the bank', !!bank, m[1]);
      if (!bank) break;
      if (i === 0) {
        aliceSocket.emit('chat:send', { channelId: lobbyId, text: 'a wildly wrong guess' });
        await sleep(400);
      }
      const winP = sysMsg((t) => t.includes('nailed it'));
      const finalP = i === 4 ? sysMsg((t) => t.includes('Trivia final scores')) : null;
      aliceSocket.emit('chat:send', { channelId: lobbyId, text: bank.answers[0] });
      const win = await winP;
      if (win.message.text.includes('Luna')) answered++;
      if (finalP) var finalMsg = await finalP;
    }
    check('alice answered all 5 first', answered === 5, 'answered ' + answered);
    const final = finalMsg;
    check('final scoreboard names Luna with 5', final.message.text.includes('Luna') && final.message.text.includes('5'), final.message.text);
    const sessions = await alice.get('/api/trivia');
    check('session cleaned up after the final question', sessions.data.sessions.length === 0);
    const start2 = await founder.post('/api/trivia/start', { channelId: musicId });
    check('trivia can start in another channel', start2.status === 201);
    const stop = await founder.post('/api/trivia/stop', { channelId: musicId });
    check('host can stop trivia early', stop.status === 200);
  });

  /* ---------- restart persistence ---------- */
  console.log('\n[persistence]');
  await test('data survives a full server restart', async () => {
    const coinsBefore = (await alice.get('/api/me')).data.user.coins;
    if (aliceSocket) aliceSocket.disconnect();
    if (bobSocket) bobSocket.disconnect();
    if (founderSocket) founderSocket.disconnect();
    await stopServer();
    // Backdate the LFG post so it is expired by the time the server returns.
    const dbFile = path.join(DATA_DIR, 'db.json');
    const raw = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    check('db.json exists on disk', raw.users.length >= 4);
    check('rolling backup exists', fs.existsSync(path.join(DATA_DIR, 'db.json.bak')));
    for (const l of raw.lfg) l.expiresAt = Date.now() - 1000;
    fs.writeFileSync(dbFile, JSON.stringify(raw));
    await startServer();
    const rc = new Client();
    const relogin = await rc.post('/api/login', { username: 'luna_wolf', password: 'moonlight99' });
    check('alice can log in after restart', relogin.status === 200);
    check('coins intact after restart', relogin.data.user.coins === coinsBefore, coinsBefore + ' vs ' + relogin.data.user.coins);
    const feed = await rc.get('/api/channels/' + lobbyId + '/feed');
    check('posts intact after restart', feed.data.posts.some((p) => p.id === bobsPostId) || (feed.data.spotlight && feed.data.spotlight.id === bobsPostId));
    const hist = await rc.get('/api/channels/' + lobbyId + '/messages');
    check('chat history intact after restart', hist.data.messages.some((m) => m.text.includes('pack chat')));
    const lfg = await rc.get('/api/lfg');
    check('expired LFG post no longer listed', !lfg.data.lfg.some((l) => l.id === lfgId));
    const settings = await rc.get('/api/bootstrap');
    check('settings intact after restart', settings.data.settings.announcement.includes('Game Night every Saturday'));
    const howl = await rc.get('/api/howl');
    check('pack howl total intact after restart', howl.data.total >= 2, 'total ' + howl.data.total);
    const thread = await rc.get('/api/dms/' + bob.userId);
    check('DM thread intact after restart', thread.data.messages.some((m) => m.text.includes('hello via dm')));
    const battles = await rc.get('/api/battles');
    check('closed battle + winner intact after restart',
      battles.data.battles.some((b) => b.status === 'closed' && b.winnerPostId === battleClipB));
    check('approved emote intact after restart', settings.data.emotes.some((e) => e.name === 'packlove'));
    const party = await rc.get('/api/party');
    check('watch party state intact after restart', !!party.data.state && party.data.state.videoId === 'dQw4w9WgXcQ' && party.data.state.playing === false);
  });

  await stopServer();
  console.log('\n========================================');
  console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
  if (failures.length) console.log('Failures:\n - ' + failures.join('\n - '));
  console.log('========================================');
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('SUITE ERROR', e);
  await stopServer();
  process.exit(1);
});
