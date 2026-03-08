#!/usr/bin/env node
// Bob the Skull — interactive CLI for Listening Party
//
// Commands:
//   node bob.js join <ROOM_CODE>    Bob enters the room
//   node bob.js check               What's happening right now
//   node bob.js submit <URL>        Bob queues a song
//   node bob.js clear               Bob withdraws his current pick
//   node bob.js leave               Bob leaves gracefully

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join }    from 'path';

// ── Config ───────────────────────────────────────────────────────────────────

const DB_URL    = process.env.FIREBASE_DATABASE_URL;
const API_KEY   = process.env.FIREBASE_API_KEY;
const BOB_NAME  = 'Bob 🎱';
const BOB_COLOR = '#6b21a8'; // ancient purple
const SESSION   = join(homedir(), '.bob-session.json'); // lives outside the repo

// ── Session helpers ──────────────────────────────────────────────────────────

function loadSession() {
  if (!existsSync(SESSION)) {
    console.error('Bob is not in a room. Run:  node bob.js join <ROOM_CODE>');
    process.exit(1);
  }
  return JSON.parse(readFileSync(SESSION, 'utf8'));
}

function saveSession(data) {
  writeFileSync(SESSION, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function clearSession() {
  if (existsSync(SESSION)) unlinkSync(SESSION);
}

// ── Firebase Auth (REST) ─────────────────────────────────────────────────────

async function signInAnonymously() {
  const res  = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }) }
  );
  const data = await res.json();
  if (data.error) throw new Error(`Auth failed: ${data.error.message}`);
  return { uid: data.localId, idToken: data.idToken, refreshToken: data.refreshToken };
}

async function doRefresh(refreshTok) {
  const res  = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshTok)}` }
  );
  const data = await res.json();
  if (data.error) throw new Error(`Token refresh failed: ${data.error.message}`);
  return { idToken: data.id_token, refreshToken: data.refresh_token };
}

// Always refresh on load — idTokens expire after 1 hour, refreshing is instant
async function freshSession() {
  const session = loadSession();
  const tokens  = await doRefresh(session.refreshToken);
  const updated = { ...session, ...tokens };
  saveSession(updated);
  return updated;
}

// ── Firebase DB (REST) ───────────────────────────────────────────────────────

async function dbGet(path, token) {
  const res = await fetch(`${DB_URL}/${path}.json?auth=${token}`);
  return res.json();
}

async function dbPut(path, value, token) {
  const res = await fetch(`${DB_URL}/${path}.json?auth=${token}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return res.json();
}

async function dbDelete(path, token) {
  await fetch(`${DB_URL}/${path}.json?auth=${token}`, { method: 'DELETE' });
}

// ── join ─────────────────────────────────────────────────────────────────────

async function cmdJoin(roomCode) {
  if (!roomCode) { console.error('Usage: node bob.js join <ROOM_CODE>'); process.exit(1); }

  console.log(`Bob is summoning himself into room ${roomCode}...`);

  const { uid, idToken, refreshToken } = await signInAnonymously();

  const room = await dbGet(`rooms/${roomCode}`, idToken);
  if (!room || room.error) {
    console.error(`Room "${roomCode}" not found — is the host running?`);
    process.exit(1);
  }

  const taken = Object.values(room.players || {}).map(p => p.color);
  const color = taken.includes(BOB_COLOR) ? '#4a0e8f' : BOB_COLOR;

  await dbPut(`rooms/${roomCode}/players/${uid}`, {
    name: BOB_NAME, score: 0, color,
    joinedAt: { '.sv': 'timestamp' },
  }, idToken);

  saveSession({ uid, idToken, refreshToken, roomCode });
  console.log(`Done. Bob is in room ${roomCode} and already judging everyone's taste.`);
}

// ── check ────────────────────────────────────────────────────────────────────

async function cmdCheck() {
  const { uid, idToken, roomCode } = await freshSession();

  const room = await dbGet(`rooms/${roomCode}`, idToken);
  if (!room || room.error) {
    console.log('Room is gone. Use: node bob.js leave');
    return;
  }

  const players     = room.players     || {};
  const submissions = room.submissions || {};
  const song        = room.currentSong || null;
  const bar         = '─'.repeat(52);

  console.log(`\n${bar}`);
  console.log(`  Room: ${roomCode}   Players in room: ${Object.keys(players).length}`);
  console.log(bar);

  // Current song
  if (song) {
    const secs    = room.songStartedAt ? Math.floor((Date.now() - room.songStartedAt) / 1000) : null;
    const timeStr = secs != null ? `  [${Math.floor(secs/60)}m ${secs%60}s in]` : '';
    console.log(`  Now playing:  submitted by ${song.submitterName}${timeStr}`);
    console.log(`  Link:         ${song.link}`);
  } else {
    console.log(`  Now playing:  nothing — queue is cold`);
  }

  // Submissions
  const subEntries = Object.entries(submissions);
  console.log(`\n  Queued picks (${subEntries.length}):`);
  if (subEntries.length > 0) {
    subEntries.forEach(([pid, sub]) => {
      const name = pid === uid ? `${players[pid]?.name || 'Bob'} (that's me)` : (players[pid]?.name || pid);
      console.log(`    • ${name}: ${sub.link}`);
    });
  } else {
    console.log(`    (none)`);
  }

  // Verdict
  const bobHasPick   = !!submissions[uid];
  const humansPicked = Object.keys(submissions).filter(p => p !== uid).length > 0;

  console.log(`\n${bar}`);
  if (!bobHasPick && !humansPicked) {
    console.log(`  ⚠  BOB SHOULD PICK — nothing is queued`);
  } else if (bobHasPick) {
    console.log(`  ✓  Bob is queued up. Waiting.`);
  } else {
    console.log(`  ✓  Humans have this. Bob can chill.`);
  }
  console.log(`${bar}\n`);
}

// ── submit ───────────────────────────────────────────────────────────────────

async function cmdSubmit(url) {
  if (!url) { console.error('Usage: node bob.js submit <YOUTUBE_URL>'); process.exit(1); }

  const { uid, idToken, roomCode } = await freshSession();

  await dbPut(`rooms/${roomCode}/submissions/${uid}`, {
    link: url, playerName: BOB_NAME, timestamp: Date.now(),
  }, idToken);

  console.log(`Bob queued: ${url}`);
}

// ── clear ────────────────────────────────────────────────────────────────────

async function cmdClear() {
  const { uid, idToken, roomCode } = await freshSession();
  await dbDelete(`rooms/${roomCode}/submissions/${uid}`, idToken);
  console.log(`Bob withdrew his pick.`);
}

// ── leave ────────────────────────────────────────────────────────────────────

async function cmdLeave() {
  const { uid, idToken, roomCode } = await freshSession();
  await dbDelete(`rooms/${roomCode}/players/${uid}`,     idToken);
  await dbDelete(`rooms/${roomCode}/submissions/${uid}`, idToken);
  clearSession();
  console.log(`Bob has left the room. The void reclaims him.`);
}

// ── dispatch ─────────────────────────────────────────────────────────────────

if (typeof fetch === 'undefined') {
  console.error('Node.js 18+ required. Check your version: node --version');
  process.exit(1);
}

const [,, cmd, arg] = process.argv;

switch (cmd) {
  case 'join':   await cmdJoin(arg);   break;
  case 'check':  await cmdCheck();     break;
  case 'submit': await cmdSubmit(arg); break;
  case 'clear':  await cmdClear();     break;
  case 'leave':  await cmdLeave();     break;
  default:
    console.log('\nUsage:');
    console.log('  node bob.js join <ROOM_CODE>   — Bob enters the room');
    console.log('  node bob.js check              — Read current room state');
    console.log('  node bob.js submit <URL>       — Queue a song');
    console.log('  node bob.js clear              — Withdraw Bob\'s current pick');
    console.log('  node bob.js leave              — Bob leaves gracefully\n');
}
