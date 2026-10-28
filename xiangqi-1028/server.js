'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const Store = require('./src/store');
const {
  hashPassword,
  verifyPassword,
  issueToken,
  tokenFromRequest,
  verifyToken,
  cookieOptions,
  publicUser,
  attachUser,
  requireUser,
  socketUser,
  COOKIE_NAME,
} = require('./src/auth');
const { GameService, DEFAULT_PROMPTS, SPECIAL_REWARD } = require('./src/game/manager');
const { SKILL_CARDS, cardById } = require('./src/game/skills');
const { Planner } = require('./src/ai/planner');
const DeepSeekClient = require('./src/ai/deepseek');

function loadEnv(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) return;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = value;
    });
  } catch (_) {
    // .env 可选
  }
}

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 4096);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ROOT = __dirname;

const store = new Store(DATA_DIR).load();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingTimeout: 30000,
  cors: { origin: false },
});
const client = new DeepSeekClient();
const service = new GameService(store);
const planner = new Planner({ service, client });
service.attach(io, planner);

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
  );
  next();
});
app.use(express.json({ limit: '64kb' }));
app.use(attachUser(store));

function rateLimiter({ windowMs, max, message = '操作过于频繁，请稍后再试' }) {
  const buckets = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.reset < now) buckets.delete(key);
    }
  }, Math.min(windowMs, 60000)).unref();
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.reset < now) {
      bucket = { count: 0, reset: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.status(429).json({ error: message });
      return;
    }
    next();
  };
}

const authLimiter = rateLimiter({ windowMs: 15 * 60 * 1000, max: 30, message: '登录或注册尝试过多，请稍后再试' });
const gameLimiter = rateLimiter({ windowMs: 10 * 60 * 1000, max: 20, message: '创建对局过于频繁' });
const shopLimiter = rateLimiter({ windowMs: 10 * 60 * 1000, max: 60, message: '兑换过于频繁，请稍后再试' });
const debugLimiter = rateLimiter({ windowMs: 10 * 60 * 1000, max: 8, message: '尝试次数过多，请稍后再试' });

const DEBUG_POINTS_CODE = process.env.DEBUG_POINTS_CODE || 'dzy114514';
const DEBUG_POINTS_REWARD = 1000;

function normalizeUsername(value) {
  return String(value || '').trim();
}

function validateUsername(username) {
  if (!/^[\p{L}\p{N}_-]{2,16}$/u.test(username)) return '用户名需为 2–16 位汉字、字母、数字、下划线或短横线';
  return null;
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6 || password.length > 72) {
    return '密码长度需为 6–72 位';
  }
  return null;
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions());
}

function clearAuthCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax' });
}

app.post('/api/register', authLimiter, (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password;
  const usernameError = validateUsername(username);
  if (usernameError) return res.status(400).json({ error: usernameError });
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  if (store.userByName(username)) return res.status(409).json({ error: '该用户名已被使用' });
  if (Object.keys(store.users).length > 5000) return res.status(507).json({ error: '用户数量已达上限' });

  const { salt, hash } = hashPassword(password);
  const user = {
    id: `u_${crypto.randomBytes(8).toString('hex')}`,
    username,
    usernameLower: username.toLocaleLowerCase(),
    salt,
    passwordHash: hash,
    createdAt: new Date().toISOString(),
    stats: { wins: 0, losses: 0, draws: 0, games: 0 },
    points: 0,
    cards: {},
  };
  store.addUser(user);
  setAuthCookie(res, issueToken(user.id, store.secret));
  res.json({ user: publicUser(user) });
});

app.post('/api/login', authLimiter, (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = req.body?.password;
  if (!username || typeof password !== 'string') return res.status(400).json({ error: '请输入用户名和密码' });
  const user = store.userByName(username);
  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  setAuthCookie(res, issueToken(user.id, store.secret));
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const payload = verifyToken(tokenFromRequest(req), store.secret);
  const user = payload ? store.userById(payload.uid) : null;
  res.json({ user: publicUser(user) });
});

app.get('/api/lobby', requireUser, (req, res) => {
  const myGames = store.gamesForUser(req.user.id).slice(0, 60).map((g) => service.toSummary(g));
  const publicGames = store.publicGames(30)
    .filter((g) => g.creatorId !== req.user.id && g.red.userId !== req.user.id && g.black.userId !== req.user.id)
    .map((g) => service.toSummary(g));
  res.json({
    user: publicUser(req.user),
    myGames,
    publicGames,
    defaults: DEFAULT_PROMPTS,
    shop: SKILL_CARDS,
    specialReward: SPECIAL_REWARD,
    model: {
      name: 'DeepSeek-V4.1-Flash',
      id: client.model,
      configured: client.configured,
      effort: client.effort,
    },
    bossModel: {
      name: 'DeepSeek V4 Pro',
      id: client.bossModel,
      effort: client.effort,
    },
  });
});

app.post('/api/games', requireUser, gameLimiter, (req, res) => {
  const mode = String(req.body?.mode || '');
  if (!['pvp', 'pve', 'aivai', 'skill'].includes(mode)) return res.status(400).json({ error: '未知对局模式' });
  const side = req.body?.side === 'black' ? 'black' : 'red';
  const special = mode === 'pve' && req.body?.special === true;
  const cleanPrompt = (value, fallback) => {
    const text = String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
    return text ? text.slice(0, 4000) : fallback;
  };
  const game = service.createGame({
    mode,
    user: req.user,
    side,
    special,
    redPrompt: cleanPrompt(req.body?.redPrompt, DEFAULT_PROMPTS.red),
    blackPrompt: cleanPrompt(req.body?.blackPrompt, DEFAULT_PROMPTS.black),
  });
  res.json({ game: service.toSummary(game), state: service.toState(game) });
});

app.get('/api/skills', requireUser, (req, res) => {
  res.json({ cards: SKILL_CARDS, specialReward: SPECIAL_REWARD, user: publicUser(req.user) });
});

app.post('/api/skills/buy', requireUser, shopLimiter, (req, res) => {
  const cardId = String(req.body?.cardId || '');
  const card = cardById(cardId);
  if (!card) return res.status(400).json({ error: '未知卡牌' });
  const rawCount = Number(req.body?.count);
  const count = Number.isFinite(rawCount) ? Math.floor(rawCount) : 1;
  if (count < 1 || count > 99) return res.status(400).json({ error: '购买数量需在 1-99 之间' });
  const user = req.user;
  user.points = Math.max(0, Number(user.points) || 0);
  user.cards = user.cards || {};
  const total = card.price * count;
  if (user.points < total) return res.status(400).json({ error: `积分不足，需要 ${total} 分` });
  user.points -= total;
  user.cards[cardId] = Math.max(0, Number(user.cards[cardId]) || 0) + count;
  store.save();
  res.json({ card, count, user: publicUser(user) });
});

app.post('/api/games/:id/join', requireUser, (req, res) => {
  const game = store.gameById(String(req.params.id || '').toUpperCase());
  if (!game) return res.status(404).json({ error: '对局不存在' });
  const result = service.joinPvp(game, req.user);
  res.json({ role: result.role, state: service.toState(game) });
});

app.get('/api/games/:id', requireUser, (req, res) => {
  const game = store.gameById(String(req.params.id || '').toUpperCase());
  if (!game) return res.status(404).json({ error: '对局不存在' });
  res.json({ state: service.toState(game) });
});

app.get('/api/games/:id/ai/:color', requireUser, (req, res) => {
  const game = store.gameById(String(req.params.id || '').toUpperCase());
  if (!game) return res.status(404).json({ error: '对局不存在' });
  const color = req.params.color;
  if (!['red', 'black'].includes(color)) return res.status(400).json({ error: '颜色无效' });
  if (game[color]?.type !== 'ai') return res.status(404).json({ error: '该方不是 AI' });
  res.json({ color, trace: service.getTrace(game, color) });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    games: Object.keys(store.games).length,
    users: Object.keys(store.users).length,
    model: client.model,
    bossModel: client.bossModel,
    modelConfigured: client.configured,
  });
});

app.use(express.static(path.join(ROOT, 'public'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error('[http]', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误' });
});

const presence = new Map();

function presenceKey(gameId, userId) {
  return `${gameId}:${userId}`;
}

function markPresence(game, user, delta) {
  if (!user) return;
  const key = presenceKey(game.id, user.id);
  const count = Math.max(0, (presence.get(key) || 0) + delta);
  if (count) presence.set(key, count);
  else presence.delete(key);
  service.setPresence(game, user, count > 0);
  service.broadcast(game);
}

io.use((socket, next) => {
  const user = socketUser(store, socket);
  if (!user) return next(new Error('未登录'));
  socket.data.user = user;
  socket.data.joined = null;
  next();
});

io.on('connection', (socket) => {
  const user = socket.data.user;

  socket.on('join_game', (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const gameId = String(payload?.gameId || '').toUpperCase();
    const game = store.gameById(gameId);
    if (!game) return ack({ ok: false, error: '对局不存在' });
    if (socket.data.joined && socket.data.joined !== gameId) {
      leaveCurrent();
    }
    const joinResult = service.joinPvp(game, user);
    if (!socket.data.joined) {
      socket.join(`game:${gameId}`);
      socket.data.joined = gameId;
      const previous = service.roomSizes.get(gameId) || 0;
      service.roomSizes.set(gameId, previous + 1);
      markPresence(game, user, 1);
    }
    const role = joinResult.role || service.colorForUser(game, user.id) || 'spectator';
    service.broadcast(game);
    ack({ ok: true, role, state: service.toState(game) });
  });

  function leaveCurrent() {
    const gameId = socket.data.joined;
    if (!gameId) return;
    const game = store.gameById(gameId);
    socket.leave(`game:${gameId}`);
    socket.data.joined = null;
    service.roomSizes.set(gameId, Math.max(0, (service.roomSizes.get(gameId) || 1) - 1));
    if (game) {
      markPresence(game, user, -1);
      service.broadcast(game);
    }
  }

  socket.on('move', (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const game = store.gameById(String(payload?.gameId || socket.data.joined || '').toUpperCase());
    if (!game) return ack({ ok: false, error: '对局不存在' });
    if (socket.data.joined !== game.id) return ack({ ok: false, error: '请先进入对局' });
    const result = service.applyMove(game, payload?.from, payload?.to, { kind: 'human', user });
    if (!result.ok) return ack({ ok: false, error: result.error });
    ack({ ok: true, move: result.move });
  });

  socket.on('chat', (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const game = store.gameById(String(payload?.gameId || socket.data.joined || '').toUpperCase());
    if (!game) return ack({ ok: false, error: '对局不存在' });
    if (socket.data.joined !== game.id) return ack({ ok: false, error: '请先进入对局' });
    const text = String(payload?.text || '');
    if (!text.trim()) return ack({ ok: false, error: '消息不能为空' });
    if (text.length > 500) return ack({ ok: false, error: '消息过长' });
    const now = Date.now();
    socket.data.chatWindow = (socket.data.chatWindow || []).filter((t) => now - t < 10000);
    if (socket.data.chatWindow.length >= 8) return ack({ ok: false, error: '发言过快，请稍后再试' });
    socket.data.chatWindow.push(now);
    const message = service.addChat(game, user, text, 'player');
    ack({ ok: true, message });
  });

  socket.on('use_skill', (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const game = store.gameById(String(payload?.gameId || socket.data.joined || '').toUpperCase());
    if (!game || socket.data.joined !== game.id) return ack({ ok: false, error: '对局不存在' });
    const result = service.useSkill(game, user, payload);
    if (!result.ok) return ack({ ok: false, error: result.error });
    ack({ ok: true, skill: result.skill, cards: result.cards, state: result.state });
  });

  socket.on('resign', (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const game = store.gameById(String(payload?.gameId || socket.data.joined || '').toUpperCase());
    if (!game || socket.data.joined !== game.id) return ack({ ok: false, error: '对局不存在' });
    const result = service.resign(game, user);
    ack(result);
  });

  socket.on('pause_game', (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const game = store.gameById(String(payload?.gameId || socket.data.joined || '').toUpperCase());
    if (!game || socket.data.joined !== game.id) return ack({ ok: false, error: '对局不存在' });
    ack(service.pause(game, user));
  });

  socket.on('resume_game', (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const game = store.gameById(String(payload?.gameId || socket.data.joined || '').toUpperCase());
    if (!game || socket.data.joined !== game.id) return ack({ ok: false, error: '对局不存在' });
    ack(service.resume(game, user));
  });

  socket.on('retry_ai', (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const game = store.gameById(String(payload?.gameId || socket.data.joined || '').toUpperCase());
    if (!game || socket.data.joined !== game.id) return ack({ ok: false, error: '对局不存在' });
    ack(service.retryAI(game, user));
  });

  socket.on('leave_game', () => {
    leaveCurrent();
  });

  socket.on('disconnect', () => {
    leaveCurrent();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[yijing] listening on 0.0.0.0:${PORT}`);
  console.log(`[yijing] model=${client.model} configured=${client.configured}`);
  planner.resumeAll(store.games);
});

function shutdown(signal) {
  console.log(`[yijing] ${signal} received, saving...`);
  try { store.save(); } catch (err) { console.error(err); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
