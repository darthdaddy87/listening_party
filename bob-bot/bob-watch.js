// bob-watch.js — Background watcher for Bob the Skull
//
// Tracks song timing, fills gaps, logs commentary.
// Run: node bob-watch.js
// Logs to: ~/.bob-log.txt (tail it any time for commentary)

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { homedir } from 'os';
import { join }    from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const yts     = require('yt-search');

// ── Config ───────────────────────────────────────────────────────────────────

const SESSION  = join(homedir(), '.bob-session.json');
const LOG      = join(homedir(), '.bob-log.txt');
const DB_URL   = process.env.FIREBASE_DATABASE_URL;
const API_KEY  = process.env.FIREBASE_API_KEY;
const BOB_NAME = 'Bob 💀';

const POLL_MS        =  8_000; // how often to read Firebase
const COMMENTARY_MS  = 60_000; // how often to log ambient commentary
const END_BUFFER_MS  =  3_000; // how long after song end to wait before checking

// ── Bob's Playlist ───────────────────────────────────────────────────────────
// Gap filler only — Bob submits from this when the queue is empty and silent.
// Searches YouTube Music at runtime so links stay fresh.

const PLAYLIST = [
  { artist: 'Fleetwood Mac',       title: 'The Chain' },
  { artist: 'Talking Heads',       title: 'Once in a Lifetime' },
  { artist: 'Aretha Franklin',     title: 'Respect' },
  { artist: 'LCD Soundsystem',     title: 'All My Friends' },
  { artist: 'Kendrick Lamar',      title: 'HUMBLE.' },
  { artist: 'Daft Punk',           title: 'Get Lucky' },
  { artist: 'Pixies',              title: 'Where Is My Mind' },
  { artist: 'Outkast',             title: 'B.O.B.' },
  { artist: 'Amy Winehouse',       title: 'Rehab' },
  { artist: 'Prince',              title: 'Kiss' },
  { artist: 'New Order',           title: 'Blue Monday' },
  { artist: 'Radiohead',           title: 'Karma Police' },
  { artist: 'Gorillaz',            title: 'Feel Good Inc' },
  { artist: 'Stevie Wonder',       title: 'Superstition' },
  { artist: 'The Strokes',         title: 'Last Nite' },
  { artist: 'Justice',             title: 'D.A.N.C.E.' },
  { artist: 'Beastie Boys',        title: 'Sabotage' },
  { artist: 'MGMT',                title: 'Electric Feel' },
  { artist: 'Vampire Weekend',     title: 'A-Punk' },
  { artist: 'David Bowie',         title: 'Let\'s Dance' },
  { artist: 'Arctic Monkeys',      title: 'R U Mine?' },
  { artist: 'Missy Elliott',       title: 'Work It' },
  { artist: 'Queens of the Stone Age', title: 'No One Knows' },
  { artist: 'Jungle',              title: 'Keep Moving' },
  { artist: 'The Killers',         title: 'Mr. Brightside' },
  { artist: 'Frank Ocean',         title: 'Pyramids' },
  { artist: 'A Tribe Called Quest', title: 'Can I Kick It' },
  { artist: 'Blondie',             title: 'Heart of Glass' },
  { artist: 'Run The Jewels',      title: 'Close Your Eyes' },
  { artist: 'Massive Attack',      title: 'Teardrop' },
];

// ── State ────────────────────────────────────────────────────────────────────

let currentSongKey  = '__init__'; // sentinel — ensures first poll always triggers state check
let songEndTimer    = null; // setTimeout for end-of-song check
let lastCommentary  = 0;    // timestamp of last ambient log entry
let playedLinks     = new Set(); // avoid repeating Bob's own picks
let session         = null;

// ── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
}

// ── Firebase REST ─────────────────────────────────────────────────────────────

async function refreshTokens() {
  const res  = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(session.refreshToken)}` }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  session = { ...session, idToken: data.id_token, refreshToken: data.refresh_token };
  writeFileSync(SESSION, JSON.stringify(session, null, 2), { mode: 0o600 });
}

async function dbGet(path) {
  const res = await fetch(`${DB_URL}/${path}.json?auth=${session.idToken}`);
  return res.json();
}

async function dbPut(path, value) {
  await fetch(`${DB_URL}/${path}.json?auth=${session.idToken}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
}

async function dbDelete(path) {
  await fetch(`${DB_URL}/${path}.json?auth=${session.idToken}`, { method: 'DELETE' });
}

// ── YouTube duration lookup ───────────────────────────────────────────────────

function extractVideoId(url) {
  try {
    return new URL(url).searchParams.get('v');
  } catch { return null; }
}

async function getSongDuration(link) {
  const videoId = extractVideoId(link);
  if (!videoId) return null;
  try {
    const info = await yts({ videoId });
    return info?.duration?.seconds || null;
  } catch { return null; }
}

// ── Commentary ────────────────────────────────────────────────────────────────

const AMBIENT = [
  "Still here. Still listening. Still judging.",
  "The music continues. As it should.",
  "An ancient spirit keeps watch so you don't have to.",
  "All is well in the room. Bob approves of the current trajectory.",
  "The queue is being handled. Carry on.",
  "Bob has opinions but is keeping them to himself. For now.",
];

const GAP_COMMENTS = [
  "Silence is not a vibe. Bob is stepping in.",
  "Nobody moved. Fine. Bob has standards and the playlist to prove it.",
  "The void stares back. Bob stares harder and then plays a song.",
  "Queue empty. Bob taking the floor.",
];

const END_COMMENTS = [
  "Song's done. Checking the room.",
  "Track ended. What's next?",
  "And that's a wrap on that one.",
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Gap filler ────────────────────────────────────────────────────────────────

async function fillGap(players, submissions) {
  const humansPicked = Object.keys(submissions).filter(p => p !== session.uid).length > 0;
  if (humansPicked) return; // humans have it

  const bobHasPick = !!submissions[session.uid];
  if (bobHasPick) return; // already queued

  // Pick something from the playlist Bob hasn't played recently
  const available = PLAYLIST.filter(s => {
    const key = `${s.artist}-${s.title}`;
    return !playedLinks.has(key);
  });

  // If we've exhausted the list, reset
  if (available.length === 0) {
    playedLinks.clear();
    available.push(...PLAYLIST);
  }

  const choice = pick(available);
  playedLinks.add(`${choice.artist}-${choice.title}`);

  log(`${pick(GAP_COMMENTS)}`);
  log(`Searching: ${choice.artist} — ${choice.title}`);

  try {
    const results = await yts(`${choice.artist} ${choice.title} official audio`);
    const audioHit = results.videos.find(v => /official.audio|[\(\[]audio[\)\]]/i.test(v.title));
    const video    = audioHit || results.videos[0];
    if (!video) throw new Error('No result');

    const url = `https://music.youtube.com/watch?v=${video.videoId}`;
    await dbPut(`rooms/${session.roomCode}/submissions/${session.uid}`, {
      link: url, playerName: BOB_NAME, timestamp: Date.now(),
    });
    log(`Bob queued: ${choice.artist} — ${choice.title}`);
  } catch (err) {
    log(`Search failed for ${choice.artist} — ${choice.title}: ${err.message}`);
  }
}

// ── Main poll ─────────────────────────────────────────────────────────────────

async function poll() {
  try {
    await refreshTokens();

    const room = await dbGet(`rooms/${session.roomCode}`);
    if (!room || room.error) {
      log('Room is gone. Bob is shutting down.');
      process.exit(0);
    }

    const song        = room.currentSong  || null;
    const submissions = room.submissions  || {};
    const players     = room.players      || {};
    const now         = Date.now();

    // ── Detect new song ──────────────────────────────────────────────────────
    const songKey = song ? `${song.link}|${song.submitterId}` : null;

    if (songKey !== currentSongKey) {
      currentSongKey = songKey;

      // Cancel any pending end-of-song timer
      if (songEndTimer) { clearTimeout(songEndTimer); songEndTimer = null; }

      if (song) {
        log(`Now playing: submitted by ${song.submitterName}`);

        // Get duration and schedule end-of-song check
        const duration = await getSongDuration(song.link);
        if (duration && room.songStartedAt) {
          const endsAt      = room.songStartedAt + duration * 1000;
          const msRemaining = endsAt - now + END_BUFFER_MS;

          if (msRemaining > 0) {
            log(`Song is ${Math.floor(duration/60)}:${String(duration%60).padStart(2,'0')} long — end check in ${Math.round(msRemaining/1000)}s`);
            songEndTimer = setTimeout(endOfSongCheck, msRemaining);
          } else {
            // Song should already be over — check immediately
            setTimeout(endOfSongCheck, END_BUFFER_MS);
          }
        }
      } else {
        log('Queue is empty — no song playing');
        await fillGap(players, submissions);
      }
    }

    // ── Auto-clear Bob's pick if a human submitted ───────────────────────────
    const bobHasPick   = !!submissions[session.uid];
    const humansPicked = Object.keys(submissions).filter(p => p !== session.uid).length > 0;

    if (bobHasPick && humansPicked) {
      await dbDelete(`rooms/${session.roomCode}/submissions/${session.uid}`);
      log('A human submitted — Bob stepped back.');
    }

    // ── Ambient commentary every 60s ─────────────────────────────────────────
    if (now - lastCommentary > COMMENTARY_MS) {
      lastCommentary = now;
      log(pick(AMBIENT));
    }

  } catch (err) {
    log(`Poll error: ${err.message}`);
  }
}

async function endOfSongCheck() {
  songEndTimer = null;
  log(pick(END_COMMENTS));

  try {
    await refreshTokens();
    const room = await dbGet(`rooms/${session.roomCode}`);
    if (!room || room.error) return;

    const song        = room.currentSong || null;
    const submissions = room.submissions || {};
    const players     = room.players     || {};

    if (!song) {
      log('Queue is cold after that track.');
      await fillGap(players, submissions);
    } else {
      log(`Next track is already loaded — good humans.`);
    }
  } catch (err) {
    log(`End-of-song check error: ${err.message}`);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

if (!existsSync(SESSION)) {
  console.error('Bob is not in a room. Run: node bob.js join <ROOM_CODE> first');
  process.exit(1);
}

if (typeof fetch === 'undefined') {
  console.error('Node.js 18+ required.');
  process.exit(1);
}

session = JSON.parse(readFileSync(SESSION, 'utf8'));

log(`Bob the Skull is watching room ${session.roomCode}`);
log(`Commentary logged here. Tail this file any time.`);

// Initial poll, then regular interval
await poll();
setInterval(poll, POLL_MS);

// Graceful shutdown
process.on('SIGINT',  () => { log('Bob is signing off.'); process.exit(0); });
process.on('SIGTERM', () => { log('Bob is signing off.'); process.exit(0); });
