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
- **Channels** — The Lobby, Clips & Videos, Pics, Music, Pack Pets 🐾,
  Chill Chat, and a **Stoner Lounge with a hard server-side 21+ gate**
  (checked against the date of birth from signup on every request — it
  isn't just hidden in the UI). The Founder can add more channels and set
  or remove the 21+ gate per channel. Each channel has a post feed (text,
  photo uploads up to 5 MB with magic-byte verification, YouTube embeds,
  comments, toggle reactions 🔥 ❤️ 🌿 🎮 👑 🐺) **and** its own live chat,
  persisted on the server (last 1,000 messages per channel).
- **Voice & Video Lounge (BETA)** — real peer-to-peer voice/video calls via
  WebRTC with Socket.IO signaling.
- **Howl Coins economy** — +25 welcome coins, earn from posting, commenting,
  chatting, voting and check-ins (daily earn cap 50), full server-side
  ledger, and a priced gift catalog (🎁 🌹 🍕 🌿 🐺 👑) sendable on posts
  or direct to members.
- **Togetherness** — pack ranks (Pup → Wolf → Alpha), weekly Top of the
  Pack leaderboard, 3 rotating weekly quests with claimable coin rewards,
  14 achievement badges, polls with live percentages and changeable votes,
  daily vibe check-ins, a Founder-set Game Night countdown and Song of the
  Day, a Looking for Squad board (posts auto-expire in 24 hours), and an
  Arcade: Reaction Sprint (personal bests + Fastest Paws board, with an
  anti-cheat plausibility cap) and a Daily Spin (one server-drawn spin per
  day, up to 40 coins).
- **Direct messages** — private 1:1 DMs between members with an inbox,
  unread counts and live delivery. Blocked members cannot DM each other
  (enforced server-side in both directions).
- **Watch Party** — a dedicated room where a host (Founder, a mod, or
  whoever set the current video) picks a YouTube video and play / pause /
  seek sync to the whole room over Socket.IO, with a live side chat.
- **The Pack Howl** — a big HOWL button: every press bumps a live
  pack-wide counter (broadcast to everyone), your personal howl total,
  the daily pack total, and your howl streak. 50 lifetime howls earns the
  🌕 Moon Howler badge.
- **Clip Battles** — the Founder pits two Clips & Videos posts head to
  head; members vote; closing a battle pays the winner a coin prize
  through the ledger and stamps their clip with a 👑 champion marker.
- **Trivia Nights** — a built-in 20-question gaming trivia bank.
  Founders/mods start a session in any channel chat: questions post on a
  timer, the first correct answer in chat wins 10 coins, and a final
  scoreboard posts at the end.
- **Pack Jukebox** — in the Music channel: members queue YouTube songs,
  upvotes reorder the queue, and the top track is "now playing."
- **"HOUNDY IS LIVE" banner** — a site-wide banner linking to
  kick.com/bludhound420. Two honest sources: a Founder manual toggle in
  the Console (always works) and a server-side auto-check of Kick's
  public channel API every minute. If Kick's API doesn't answer, the
  banner never claims he's live — the manual toggle is the fallback.
- **Events calendar** — the Founder creates events (Game Night, Movie
  Night, Trivia, Stream); members RSVP; upcoming events and the
  auto-computed **Pack MVP of the Week** (most weekly activity points,
  non-Founder) are spotlighted on the Lobby.
- **Custom pack emotes** — members submit emote images; Founder/mods
  approve them in the Console; approved emotes render as `:name:` in
  posts, comments and chat.
- **Suggestion Box** — members submit ideas, the pack upvotes, and the
  Founder marks them planned / done / dismissed.
- **Profile glow-up** — profile banner image plus a "now playing" game
  status shown on profiles and next to post authors.
- **Login streaks** — consecutive-day visits are tracked at signup,
  login and vibe check-in; streak milestones (3 / 7 / 14 / 30 days) pay
  coin bonuses through the ledger.
- **Kudos** — every member can give 3 kudos per week (coin-free); totals
  show on profiles and unlock badges at 5 and 15 received, plus a badge
  for generous givers.

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
runs 221 integration checks: auth + lockout, CSRF, Founder claim and
protection, channel CRUD and permissions, posts/comments/reactions, upload
validation (magic bytes + 5 MB cap), chat persistence, WebRTC signaling
relay, coin/gift ledger math, poll voting, quest progress + claim,
once-a-day spin, sprint plausibility, LFG expiry, report/block flows, ban
flow, the 21+ Stoner Lounge gate, DMs (incl. block enforcement), the Pack
Howl counter/streaks, login streaks, kudos weekly limits, the jukebox
queue, Clip Battles (vote/close/prize/crown), events + RSVP + MVP,
emote approvals, suggestions, the LIVE banner (manual toggle + honest
auto-check), Watch Party host permissions and sync state, a full trivia
session, and full restart persistence. Latest run: **221 passed,
0 failed**.

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
| `KICK_CHANNEL` | `bludhound420` | Kick channel slug for the LIVE banner auto-check. |
| `TRIVIA_QUESTION_MS` | `20000` | How long each trivia question stays open. |
| `TRIVIA_GAP_MS` | `4000` | Pause between trivia questions. |

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
- **Watch Party sync is host-driven and best-effort.** Play/pause/seek
  sync comes from the host's player events over Socket.IO; viewers are
  re-synced when the state changes and on join, but small drift between
  players is normal (YouTube buffering differs per connection). Party
  side-chat is live-only and is not persisted.
- **Kick auto-detect depends on Kick's public API** answering without
  credentials. The server checks once a minute and treats any failure as
  "not live" — it never guesses. If the API stops responding, the
  Founder's manual toggle in the Console is the reliable path.
- **Trivia sessions are in-memory.** If the server restarts mid-session,
  the round ends (coins already awarded stay awarded — they're in the
  ledger). The Watch Party's current video and position do persist.

## Tech

Node.js + Express 4 + Socket.IO 4 · bcryptjs · JWT cookies · multer
(magic-byte-verified uploads) · zero build step — the frontend is plain
HTML/CSS/JS in `public/`.
