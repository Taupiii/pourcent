require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const tmi = require('tmi.js');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Game State ──────────────────────────────────────────────────────────────
let gameState = {
  phase: 'idle',       // idle | playing | stopped | leaderboard
  question: null,      // { label, answer, minLabel, maxLabel }
  answer: null,
  guesses: {},         // { username: value }
  scores: {},          // { username: points }
  winner: null,
  history: []
};

let twitchClient = null;
let twitchConfig = { channel: '', username: '', token: '' };

// ── WebSocket broadcast ─────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

function broadcastState() {
  broadcast({ type: 'state', payload: gameState });
}

// ── Twitch Bot ──────────────────────────────────────────────────────────────
function connectTwitch(channel, username, token) {
  if (twitchClient) {
    try { twitchClient.disconnect(); } catch(e) {}
    twitchClient = null;
  }

  twitchConfig = { channel, username, token };

  twitchClient = new tmi.Client({
    options: { debug: false },
    identity: { username, password: token },
    channels: [channel]
  });

  twitchClient.on('message', (ch, tags, message, self) => {
    if (self) return;
    if (gameState.phase !== 'playing') return;

    const num = parseFloat(message.trim().replace(',', '.'));
    if (isNaN(num) || num < 0 || num > 100) return;

    const username = tags['display-name'] || tags.username;
    const val = Math.round(num * 10) / 10;

    gameState.guesses[username] = val;

    // Check if exact answer
    if (val === gameState.answer) {
      handleWinner(username);
      return;
    }

    broadcastState();
  });

  twitchClient.connect().then(() => {
    broadcast({ type: 'twitch_status', connected: true, channel });
  }).catch(err => {
    broadcast({ type: 'twitch_status', connected: false, error: err.message });
  });
}

function handleWinner(username) {
  gameState.phase = 'stopped';
  gameState.winner = username;
  if (!gameState.scores[username]) gameState.scores[username] = 0;
  gameState.scores[username]++;
  broadcastState();

  if (twitchClient && twitchConfig.channel) {
    twitchClient.say(twitchConfig.channel,
      `🎉 ${username} a trouvé la bonne réponse : ${gameState.answer} ! (+1 point)`
    ).catch(() => {});
  }
}

// ── Average calculation ─────────────────────────────────────────────────────
function getAverage() {
  const vals = Object.values(gameState.guesses);
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

// ── REST API ────────────────────────────────────────────────────────────────

// Connect Twitch
app.post('/api/twitch/connect', (req, res) => {
  const { channel, username, token } = req.body;
  if (!channel || !username || !token)
    return res.status(400).json({ error: 'Missing fields' });
  connectTwitch(channel, username, token);
  res.json({ ok: true });
});

// Start a round
app.post('/api/game/start', (req, res) => {
  const { label, answer, minLabel, maxLabel } = req.body;
  if (label === undefined || answer === undefined)
    return res.status(400).json({ error: 'Missing label or answer' });

  gameState.phase = 'playing';
  gameState.question = { label, answer, minLabel: minLabel || '0', maxLabel: maxLabel || '100' };
  gameState.answer = parseFloat(answer);
  gameState.guesses = {};
  gameState.winner = null;

  broadcastState();
  res.json({ ok: true });
});

// Stop a round (manual)
app.post('/api/game/stop', (req, res) => {
  gameState.phase = 'stopped';
  broadcastState();
  res.json({ ok: true });
});

// Show leaderboard between rounds
app.post('/api/game/leaderboard', (req, res) => {
  gameState.phase = 'leaderboard';
  broadcastState();
  res.json({ ok: true });
});

// Reset to idle
app.post('/api/game/idle', (req, res) => {
  gameState.phase = 'idle';
  broadcastState();
  res.json({ ok: true });
});

// Reset scores
app.post('/api/game/reset-scores', (req, res) => {
  gameState.scores = {};
  broadcastState();
  res.json({ ok: true });
});

// Get full state
app.get('/api/state', (req, res) => {
  res.json({ ...gameState, average: getAverage() });
});

// ── WebSocket: push average periodically ───────────────────────────────────
setInterval(() => {
  if (gameState.phase === 'playing') {
    broadcast({
      type: 'average',
      value: getAverage(),
      guessCount: Object.keys(gameState.guesses).length
    });
  }
}, 500);

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`PercentGame server running on http://localhost:${PORT}`);

  // Auto-connect Twitch if .env credentials are present
  const ch = process.env.TWITCH_CHANNEL;
  const usr = process.env.TWITCH_USERNAME;
  const tok = process.env.TWITCH_TOKEN;
  if (ch && usr && tok) {
    console.log(`Auto-connecting Twitch → #${ch}`);
    connectTwitch(ch, usr, tok);
  }
});
