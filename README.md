# 🐺 Vantahowl

**One pack. One howl.** Vantahowl is the server-backed community home for
streamer **Bludhound420** (Houndy) and his viewers — a place to join, chat,
post pics and clips, squad up, and hang out in a voice & video lounge, wrapped
in a vantablack / crimson / gold theme with a full moon over the pack.

This is the real, deployable version: accounts, posts, chat, coins and
settings are saved on the server and shared by everyone who joins.

## What's inside

- **Accounts & safety** — signup with date of birth (13+), bcrypt password
  hashing (cost 12), httpOnly JWT cookie sessions, login lockout
  (5 fails → 15 minutes), CSRF tokens on every state-changing request,
  XSS-safe rendering, a tightened Content-Security-Policy, profanity
  masking (Founder-toggleable), reports + blocks, and a Founder-only
  append-only security event log.
- **Founder** — the account that signs up as `bludhound420` automatically
  becomes Founder (gold crown) and can never be banned or demoted. The
  Founder Console controls site name/announcement, signup open/close,
  Game Night countdown, Song of the Day, channel create/rename/hide/delete,
  member roles (incl. a Moderator tier), bans, the reports queue, and the
  Founder Spotlight post.
- **Channels** — The Lobby, Clips & Videos, Pics, Music, Chill Chat
  (Founder can add more). Each has a post feed (text, photo uploads up to
  5 MB with magic-byte verification, YouTube embeds, comments, toggle
  reactions 🔥 ❤️ 🌿 🎮 👑 🐺) **and** its own live chat, persisted on the
  server (last 1,000 messages per channel).
- **Voice & Video Lounge (BETA)** — real peer-to-peer voice/video calls via
  WebRTC with Socket.IO signaling.
- **Howl Coins economy** — +25 welcome coins, earn from posting, commenting,
  chatting, voting and check-ins (daily earn cap 50), full server-side
  ledger, and a priced gift catalog (🎁 🌹 🍕 🌿 🐺 👑) sendable on posts
  or direct to members.
- **Togetherness** — pack ranks (Pup → Wolf → Alpha), weekly Top of the
  Pack leaderboard, 3 rotating weekly quests with claimable coin rewards,
  10 achievement badges, polls with live percentages and changeable votes,
  daily vibe check-ins, a Founder-set Game Night countdown and Song of the
  Day, a Looking for Squad board (posts auto-expire in 24 hours), and an
  Arcade: Reaction Sprint (personal bests + Fastest Paws board, with an
  anti-cheat plausibility cap) and a Daily Spin (one server-drawn spin per
  day, up to 40 coins).

## Run it locally

```bash
npm install
npm start          # http://localhost:3000
```

Data lives in `./data` by default (override with `DATA_DIR`). The first
account to sign up with the username `bludhound420` becomes Founder —
sign up with it first, before anyone else, on a fresh deploy.

## Tests

```bash
npm test
```

The suite spawns the real server against a throwaway data directory and
runs 113 integration checks: auth + lockout, CSRF, Founder claim and
protection, channel CRUD and permissions, posts/comments/reactions, upload
validation (magic bytes + 5 MB cap), chat persistence, WebRTC signaling
relay, coin/gift ledger math, poll voting, quest progress + claim,
once-a-day spin, sprint plausibility, LFG expiry, report/block flows, ban
flow, and full restart persistence. Latest run: **113 passed, 0 failed**.

## Deploy to Render

`render.yaml` is included and preconfigured (Starter plan, Oregon region,
1 GB persistent disk at `/var/data`):

1. Push this repo to GitHub (or use Render's "New → Blueprint" with the repo).
2. Render reads `render.yaml`: it creates the web service, generates a
   `JWT_SECRET`, sets `FOUNDER_USERNAME=bludhound420` and
   `DATA_DIR=/var/data`, and attaches the 1 GB disk at `/var/data`.
   The disk matters: without it, members, posts and uploads would be wiped
   on every redeploy. (A persistent disk requires the paid Starter plan —
   $7/month plus $0.25/month for the 1 GB disk.)
3. Once live, open the URL and **sign up as `bludhound420` first** to claim
   Founder.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on (Render sets this). |
| `DATA_DIR` | `./data` | Where `db.json` and uploads live. Use the mounted disk in production. |
| `FOUNDER_USERNAME` | `bludhound420` | Username that claims Founder on signup. |
| `JWT_SECRET` | dev placeholder | Session signing secret. **Always set a real one in production** (render.yaml generates it). |
| `NODE_ENV` | — | Set to `production` for Secure session cookies. |

## Honest limitations

- **Voice/video media flow is untested.** The WebRTC *signaling* protocol
  (peer discovery, offer/answer/ICE relay) is covered by automated tests,
  but no microphone/camera exists in the build environment, so actual audio
  and video between two real devices has **not** been verified end to end.
  Do a two-device check after go-live. The lounge uses a public STUN server
  and no TURN server, so calls between some home networks/NATs may fail to
  connect media even when signaling works.
- **Single-instance scale.** The JSON datastore (atomic writes + rolling
  backup) is built for one server process — perfect for a community site,
  not for multi-instance scaling.
- **No password reset or email verification** — accounts are username +
  password + date of birth only. If a member forgets their password, the
  Founder can help them start fresh.
- Chat keeps the most recent 1,000 messages per channel; the security log
  keeps the most recent 1,000 events (the Console shows the latest 200).

## Tech

Node.js + Express 4 + Socket.IO 4 · bcryptjs · JWT cookies · multer
(magic-byte-verified uploads) · zero build step — the frontend is plain
HTML/CSS/JS in `public/`.
