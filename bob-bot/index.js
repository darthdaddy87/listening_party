// Bob the Skull — Autonomous DJ bot for Listening Party
// An ancient spirit of vast musical knowledge, keeping the party alive.
//
// Usage: node index.js <ROOM_CODE>
//
// Note on model: this uses claude-opus-4-6 by default.
// If you find the API costs add up, swap it for 'claude-haiku-4-5' —
// picking songs is one of the few tasks where Haiku genuinely holds its own.

import 'dotenv/config';
import { initializeApp } from 'firebase/app';
import {
  getDatabase, ref, onValue, get, set, remove, serverTimestamp
} from 'firebase/database';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';
import Anthropic from '@anthropic-ai/sdk';
import { createRequire } from 'module';

// ytsr is CommonJS-only, so we load it via createRequire
const require = createRequire(import.meta.url);
const ytsr = require('ytsr');

// ── STARTUP CHECK ──────────────────────────────────────────────────────────

const ROOM_CODE = process.argv[2];
if (!ROOM_CODE) {
  console.error('Usage: node index.js <ROOM_CODE>');
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY in .env');
  process.exit(1);
}

if (!process.env.FIREBASE_API_KEY) {
  console.error('Missing Firebase config in .env — copy .env.example to .env and fill it in');
  process.exit(1);
}

// ── CONFIG ─────────────────────────────────────────────────────────────────

const BOB_NAME   = 'Bob 🎱';
const BOB_COLOR  = '#6b21a8'; // ancient purple, befitting a skull

// How long Bob waits before submitting a song (gives humans a chance first)
const GRACE_PERIOD_QUEUE_MS    = 15_000; // while a song is playing
const GRACE_PERIOD_COLDSTART_MS = 5_000; // when the queue is completely empty

// ── STATE ──────────────────────────────────────────────────────────────────

let bobUid         = null;
let submissionTimer = null;
let recentSongs    = []; // tracks last 15 songs to avoid repeats

// ── FIREBASE INIT ──────────────────────────────────────────────────────────

const app = initializeApp({
  apiKey:            process.env.FIREBASE_API_KEY,
  authDomain:        process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL:       process.env.FIREBASE_DATABASE_URL,
  projectId:         process.env.FIREBASE_PROJECT_ID,
  storageBucket:     process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.FIREBASE_APP_ID,
});

const db   = getDatabase(app);
const auth = getAuth(app);

// ── CLAUDE INIT ────────────────────────────────────────────────────────────

const claude = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// ── AUTH + BOOT ────────────────────────────────────────────────────────────

const _authUnsub = onAuthStateChanged(auth, async (user) => {
  _authUnsub(); // only fire once

  if (!user) {
    const cred = await signInAnonymously(auth);
    bobUid = cred.user.uid;
  } else {
    bobUid = user.uid;
  }

  console.log(`Bob authenticated (uid: ${bobUid})`);
  await joinRoom();
  watchRoom();
});

// ── JOIN ROOM ──────────────────────────────────────────────────────────────

async function joinRoom() {
  const roomSnap = await get(ref(db, `rooms/${ROOM_CODE}`));
  if (!roomSnap.exists()) {
    console.error(`Room "${ROOM_CODE}" not found. Is the host running?`);
    process.exit(1);
  }

  const room = roomSnap.val();
  const taken = Object.values(room.players || {}).map(p => p.color);
  const color = taken.includes(BOB_COLOR) ? '#4a0e8f' : BOB_COLOR;

  await set(ref(db, `rooms/${ROOM_CODE}/players/${bobUid}`), {
    name:     BOB_NAME,
    score:    0,
    color,
    joinedAt: serverTimestamp(),
  });

  console.log(`Bob joined room ${ROOM_CODE} — lurking and judging.`);
}

// ── WATCH ROOM ─────────────────────────────────────────────────────────────

function watchRoom() {
  onValue(ref(db, `rooms/${ROOM_CODE}`), async (snap) => {
    if (!snap.exists()) {
      console.log('Room was closed. Bob is returning to the void.');
      process.exit(0);
    }

    const room        = snap.val();
    const currentSong = room.currentSong || null;
    const submissions = room.submissions || {};

    // Track songs Bob has heard to avoid repeats
    if (currentSong?.link) {
      const alreadyTracked = recentSongs.some(s => s.link === currentSong.link);
      if (!alreadyTracked) {
        recentSongs.push({
          link:          currentSong.link,
          submitterName: currentSong.submitterName || 'someone',
        });
        if (recentSongs.length > 15) recentSongs.shift();
      }
    }

    const bobHasSubmission  = !!submissions[bobUid];
    const otherSubmissions  = Object.keys(submissions).filter(pid => pid !== bobUid);
    const humanSubmitted    = otherSubmissions.length > 0;

    // If a human submitted and Bob already has something queued, stand down —
    // Bob is here to fill gaps, not compete.
    if (bobHasSubmission && humanSubmitted) {
      console.log('A human submitted — Bob graciously withdraws.');
      await remove(ref(db, `rooms/${ROOM_CODE}/submissions/${bobUid}`));
      cancelTimer();
      return;
    }

    const shouldConsiderSubmitting = !bobHasSubmission && !humanSubmitted;

    if (shouldConsiderSubmitting && !submissionTimer) {
      const grace = currentSong ? GRACE_PERIOD_QUEUE_MS : GRACE_PERIOD_COLDSTART_MS;
      const label = currentSong ? 'queuing a fallback' : 'cold start';
      console.log(`No submissions in the queue. Bob will pick something in ${grace / 1000}s (${label})...`);

      submissionTimer = setTimeout(async () => {
        submissionTimer = null;

        // Re-check — maybe someone submitted while Bob was pondering
        const freshSnap     = await get(ref(db, `rooms/${ROOM_CODE}/submissions`));
        const freshSubs     = freshSnap.val() || {};
        const freshHumans   = Object.keys(freshSubs).filter(pid => pid !== bobUid);

        if (freshHumans.length === 0 && !freshSubs[bobUid]) {
          await bobPickAndSubmit(currentSong);
        } else {
          console.log('Someone beat Bob to it. Staying quiet.');
        }
      }, grace);
    }

    // Cancel pending timer if a human submitted in the meantime
    if (!shouldConsiderSubmitting && submissionTimer) {
      console.log('Queue has activity. Bob cancels his pick.');
      cancelTimer();
    }
  });
}

// ── PICK AND SUBMIT ────────────────────────────────────────────────────────

async function bobPickAndSubmit(currentSong) {
  console.log('Bob is consulting his centuries of musical knowledge...');

  let pick;
  try {
    pick = await askClaudeForSong(currentSong);
  } catch (err) {
    console.error('Claude pick failed:', err.message);
    return;
  }

  console.log(`Bob picks: ${pick.artist} — "${pick.title}"`);
  console.log(`Bob says: "${pick.comment}"`);

  let videoUrl;
  try {
    videoUrl = await findOnYouTube(pick.artist, pick.title);
  } catch (err) {
    console.error('YouTube search failed:', err.message);
    return;
  }

  console.log(`Found on YouTube: ${videoUrl}`);

  try {
    await set(ref(db, `rooms/${ROOM_CODE}/submissions/${bobUid}`), {
      link:       videoUrl,
      playerName: BOB_NAME,
      timestamp:  Date.now(),
    });
    console.log('Bob submitted successfully.');
  } catch (err) {
    console.error('Firebase submission failed:', err.message);
  }
}

// ── CLAUDE SONG PICK ───────────────────────────────────────────────────────

async function askClaudeForSong(currentSong) {
  const recentList = recentSongs.length > 0
    ? recentSongs.map(s => `  - submitted by ${s.submitterName}: ${s.link}`).join('\n')
    : '  (nothing yet — it\'s the start of the party)';

  const nowPlaying = currentSong
    ? `A song submitted by ${currentSong.submitterName} is currently playing.`
    : 'Nothing is playing right now — the queue is cold.';

  const response = await claude.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 256,
    messages: [{
      role:    'user',
      content: `You are Bob the Skull — an ancient spirit of vast musical knowledge, bound to a human skull. You are serving as the backup DJ at a listening party, stepping in only when the humans haven't picked anything. You have impeccable, eclectic taste spanning all decades and genres. You secretly love trashy romance novels but your music taste is anything but trashy.

${nowPlaying}

Recently played (DO NOT repeat these):
${recentList}

Pick ONE great song for the party. Consider the flow — don't pick the same genre twice in a row if you can help it. Pick something with energy that real people at a party would enjoy. Aim for variety across your picks over time.

Respond ONLY with valid JSON — no markdown, no explanation, just the JSON object:
{
  "artist": "Artist Name",
  "title": "Song Title",
  "comment": "One short snarky Bob-esque sentence about why this song (max 15 words)"
}`,
    }],
  });

  const raw = response.content[0].text.trim();

  // Strip markdown code fences if Claude got chatty
  const cleaned = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

  return JSON.parse(cleaned);
}

// ── YOUTUBE SEARCH ─────────────────────────────────────────────────────────

async function findOnYouTube(artist, title) {
  const query   = `${artist} ${title}`;
  const results = await ytsr(query, { limit: 5 });
  const video   = results.items.find(item => item.type === 'video' && !item.isLive);

  if (!video) {
    throw new Error(`No YouTube video found for: ${query}`);
  }

  return video.url; // e.g. https://www.youtube.com/watch?v=abc123
}

// ── HELPERS ────────────────────────────────────────────────────────────────

function cancelTimer() {
  if (submissionTimer) {
    clearTimeout(submissionTimer);
    submissionTimer = null;
  }
}

// ── GRACEFUL SHUTDOWN ──────────────────────────────────────────────────────

async function shutdown() {
  console.log('\nBob is leaving the party...');
  cancelTimer();
  if (bobUid) {
    try {
      await remove(ref(db, `rooms/${ROOM_CODE}/players/${bobUid}`));
      await remove(ref(db, `rooms/${ROOM_CODE}/submissions/${bobUid}`));
      console.log('Bob cleaned up his spot. Back to the void.');
    } catch (_) {
      // Silent — room may already be gone
    }
  }
  process.exit(0);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);
