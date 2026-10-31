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
const { GameService, DEFAULT_PROMPTS, SPECIAL_REWARD, AI_SKILL_POINTS, CAPTURE_REWARD } = require('./src/game/manager');
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
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors *",
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
const redeemLimiter = rateLimiter({ windowMs: 10 * 60 * 1000, max: 10, message: '兑换尝试过于频繁，请稍后再试' });

const DEBUG_POINTS_CODE = process.env.DEBUG_POINTS_CODE || 'dzy114514';
const DEBUG_POINTS_REWARD = 1000;
const REDEEM_CODES = {
  dzy114514: { points: 2000, label: '2000 积分' },
};
const onlineUsers = new Map();

// 积分按 64 位整数语义存储，上限取 JS 可精确表示的最大安全整数
const POINTS_MAX = Number.MAX_SAFE_INTEGER;

function normalizePoints(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(POINTS_MAX, n));
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  if (!req.user.admin) return res.status(403).json({ error: '需要管理员权限' });
  next();
}

function adminUserView(user) {
  const games = Object.values(store.games);
  const cards = user.cards || {};
  return {
    id: user.id,
    username: user.username,
    admin: user.admin === true,
    banned: user.banned === true,
    points: normalizePoints(user.points),
    stats: user.stats || { wins: 0, losses: 0, draws: 0, games: 0 },
    cardCount: Object.values(cards).reduce((sum, n) => sum + Math.max(0, Number(n) || 0), 0),
    cards,
    createdAt: user.createdAt || null,
    lastSeen: user.lastSeen || null,
    online: onlineUsers.has(user.id),
    sockets: onlineUsers.get(user.id)?.size || 0,
    gameCount: games.filter((g) => g.red?.userId === user.id || g.black?.userId === user.id).length,
  };
}

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

function isSecureRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return req.secure || proto === 'https';
}

function setAuthCookie(req, res, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions(isSecureRequest(req)));
}

function clearAuthCookie(req, res) {
  const secure = isSecureRequest(req);
  res.clearCookie(COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    secure,
  });
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
    lastSeen: new Date().toISOString(),
    stats: { wins: 0, losses: 0, draws: 0, games: 0 },
    points: 0,
    cards: {},
    redeemed: {},
  };
  store.addUser(user);
  setAuthCookie(req, res, issueToken(user.id, store.secret));
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
  if (user.banned) return res.status(403).json({ error: '账号已被封禁' });
  user.lastSeen = new Date().toISOString();
  store.save();
  setAuthCookie(req, res, issueToken(user.id, store.secret));
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  clearAuthCookie(req, res);
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
    aiSkillPoints: AI_SKILL_POINTS,
    aiCaptureReward: CAPTURE_REWARD,
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
  if (!['pvp', 'pve', 'aivai', 'skill', 'aiskill'].includes(mode)) return res.status(400).json({ error: '未知对局模式' });
  leaveMatchmaking(req.user.id);
  const side = req.body?.side === 'black' ? 'black' : 'red';
  const special = mode === 'pve' && req.body?.special === true;
  const aiOpponent = mode === 'skill' && req.body?.aiOpponent === true;
  const isPublic = req.body?.isPublic !== false;
  const cleanPrompt = (value, fallback) => {
    const text = String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
    return text ? text.slice(0, 4000) : fallback;
  };
  const game = service.createGame({
    mode,
    user: req.user,
    side,
    special,
    aiOpponent,
    isPublic,
    aiInitialPoints: req.body?.aiInitialPoints,
    aiCaptureReward: req.body?.aiCaptureReward,
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
  user.points = normalizePoints(user.points);
  user.cards = user.cards || {};
  const total = card.price * count;
  if (user.points < total) return res.status(400).json({ error: `积分不足，需要 ${total} 分` });
  user.points -= total;
  user.cards[cardId] = Math.max(0, Number(user.cards[cardId]) || 0) + count;
  store.save();
  res.json({ card, count, user: publicUser(user) });
});

app.post('/api/debug/points', requireUser, debugLimiter, (req, res) => {
  const user = req.user;
  const code = String(req.body?.code || '');
  if (code !== DEBUG_POINTS_CODE) return res.status(403).json({ error: '调试密码不正确' });
  user.points = normalizePoints(normalizePoints(user.points) + DEBUG_POINTS_REWARD);
  user.cards = user.cards || {};
  store.save();
  res.json({ ok: true, reward: DEBUG_POINTS_REWARD, user: publicUser(user) });
});

app.post('/api/redeem', requireUser, redeemLimiter, (req, res) => {
  const code = String(req.body?.code || '').trim().toLowerCase();
  if (!code) return res.status(400).json({ error: '请输入兑换码' });
  const item = REDEEM_CODES[code];
  if (!item) return res.status(404).json({ error: '兑换码无效' });
  const user = req.user;
  user.redeemed = user.redeemed && typeof user.redeemed === 'object' ? user.redeemed : {};
  if (user.redeemed[code]) return res.status(409).json({ error: '该兑换码已使用' });
  user.redeemed[code] = new Date().toISOString();
  user.points = normalizePoints(normalizePoints(user.points) + item.points);
  store.save();
  res.json({ ok: true, reward: item.points, user: publicUser(user) });
});

app.get('/api/admin/overview', requireUser, requireAdmin, (req, res) => {
  const users = Object.values(store.users);
  const games = Object.values(store.games)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const activeGames = games.filter((game) => game.status === 'playing' || game.status === 'waiting');
  res.json({
    now: new Date().toISOString(),
    stats: {
      users: users.length,
      online: onlineUsers.size,
      games: games.length,
      activeGames: activeGames.length,
      totalPoints: users.reduce((sum, user) => sum + Math.max(0, Number(user.points) || 0), 0),
      admins: users.filter((user) => user.admin === true).length,
    },
    users: users
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .map(adminUserView),
    games: games.map((game) => ({
      id: game.id,
      mode: game.mode,
      status: game.status,
      isPublic: game.isPublic !== false,
      special: game.special === true,
      aiOpponent: game.aiOpponent === true,
      createdAt: game.createdAt || null,
      startedAt: game.startedAt || null,
      endedAt: game.endedAt || null,
      moveCount: Array.isArray(game.history) ? game.history.length : 0,
      red: { name: game.red?.name || '', type: game.red?.type || '', userId: game.red?.userId || null },
      black: { name: game.black?.name || '', type: game.black?.type || '', userId: game.black?.userId || null },
      winner: game.result?.winner || null,
      reason: game.result?.reason || null,
    })),
    onlineUsers: [...onlineUsers.keys()]
      .map((id) => store.userById(id))
      .filter(Boolean)
      .map((user) => ({ id: user.id, username: user.username, sockets: onlineUsers.get(user.id)?.size || 0 })),
  });
});

app.post('/api/admin/users/:id/points', requireUser, requireAdmin, (req, res) => {
  const user = store.userById(String(req.params.id || ''));
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const rawDelta = Number(req.body?.delta);
  const delta = Math.trunc(rawDelta);
  if (!Number.isFinite(rawDelta) || delta === 0) return res.status(400).json({ error: '请输入非零积分变化' });
  if (!Number.isSafeInteger(delta)) return res.status(400).json({ error: '积分调整超出可处理范围' });
  user.points = normalizePoints(normalizePoints(user.points) + delta);
  store.save();
  res.json({ ok: true, user: adminUserView(user) });
});

app.post('/api/admin/users/:id/ban', requireUser, requireAdmin, (req, res) => {
  const user = store.userById(String(req.params.id || ''));
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const banned = req.body?.banned === true;
  if (banned && user.id === req.user.id) return res.status(400).json({ error: '不能封禁自己' });
  user.banned = banned;
  if (banned) {
    const sockets = onlineUsers.get(user.id);
    if (sockets) {
      for (const socketId of [...sockets]) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) socket.disconnect(true);
      }
    }
  }
  store.save();
  res.json({ ok: true, user: adminUserView(user) });
});

app.post('/api/admin/users/:id/cards', requireUser, requireAdmin, (req, res) => {
  const user = store.userById(String(req.params.id || ''));
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const card = cardById(String(req.body?.cardId || ''));
  const count = Math.trunc(Number(req.body?.count));
  if (!card) return res.status(400).json({ error: '未知卡牌' });
  if (!Number.isFinite(count) || count === 0) return res.status(400).json({ error: '请输入非零数量' });
  if (Math.abs(count) > 99) return res.status(400).json({ error: '单次发卡不能超过 99 张' });
  user.cards = user.cards && typeof user.cards === 'object' ? user.cards : {};
  user.cards[card.id] = Math.max(0, (Number(user.cards[card.id]) || 0) + count);
  if (!user.cards[card.id]) delete user.cards[card.id];
  store.save();
  res.json({ ok: true, user: adminUserView(user), card });
});

app.post('/api/admin/cards/grant', requireUser, requireAdmin, (req, res) => {
  const userIds = Array.isArray(req.body?.userIds)
    ? [...new Set(req.body.userIds.map((id) => String(id || '')).filter(Boolean))]
    : [];
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!userIds.length) return res.status(400).json({ error: '请选择玩家' });
  if (userIds.length > 100) return res.status(400).json({ error: '单次最多选择 100 名玩家' });
  const items = [];
  for (const item of rawItems) {
    const card = cardById(String(item?.cardId || ''));
    const count = Math.trunc(Number(item?.count));
    if (!card || !Number.isFinite(count) || count === 0) continue;
    if (Math.abs(count) > 99) return res.status(400).json({ error: '单张卡数量不能超过 99' });
    items.push({ card, count });
  }
  if (!items.length) return res.status(400).json({ error: '请选择卡牌和数量' });
  const users = userIds.map((id) => store.userById(id)).filter(Boolean);
  if (!users.length) return res.status(404).json({ error: '玩家不存在' });
  for (const user of users) {
    user.cards = user.cards && typeof user.cards === 'object' ? user.cards : {};
    for (const { card, count } of items) {
      user.cards[card.id] = Math.max(0, (Number(user.cards[card.id]) || 0) + count);
      if (!user.cards[card.id]) delete user.cards[card.id];
    }
  }
  store.save();
  res.json({
    ok: true,
    count: users.length,
    items: items.map(({ card, count }) => ({ cardId: card.id, name: card.name, count })),
    users: users.map(adminUserView),
  });
});

app.post('/api/admin/games/:id/finish', requireUser, requireAdmin, (req, res) => {
  const game = store.gameById(String(req.params.id || '').toUpperCase());
  if (!game) return res.status(404).json({ error: '对局不存在' });
  if (game.status !== 'playing') return res.status(409).json({ error: '对局不在进行中' });
  const winner = req.body?.winner === 'red' || req.body?.winner === 'black' ? req.body.winner : null;
  service.finish(game, { winner, reason: 'admin', by: null });
  res.json({ ok: true });
});

app.delete('/api/admin/games/:id', requireUser, requireAdmin, (req, res) => {
  const id = String(req.params.id || '').toUpperCase();
  const game = store.gameById(id);
  if (!game) return res.status(404).json({ error: '对局不存在' });
  game.status = 'finished';
  game.paused = true;
  delete store.games[id];
  for (const key of [...presence.keys()]) {
    if (key.startsWith(`${id}:`)) presence.delete(key);
  }
  if (service.roomSizes) service.roomSizes.delete(id);
  store.save();
  io.to(`game:${id}`).emit('game:deleted', { gameId: id });
  res.json({ ok: true });
});

app.post('/api/match/join', requireUser, (req, res) => {
  const mode = String(req.body?.mode || '');
  if (!['pvp', 'skill'].includes(mode)) return res.status(400).json({ error: '未知匹配模式' });
  pruneMatchmaking();
  const user = req.user;
  const ready = matchResults.get(user.id);
  if (ready) {
    matchResults.delete(user.id);
    return res.json({ matched: true, ...ready });
  }
  let entry = matchQueue.get(user.id);
  if (!entry || entry.mode !== mode) {
    entry = { userId: user.id, mode, joinedAt: Date.now(), lastSeen: Date.now() };
    matchQueue.set(user.id, entry);
  } else {
    entry.lastSeen = Date.now();
  }
  const candidates = [...matchQueue.values()]
    .filter((item) => item.userId !== user.id && item.mode === mode)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  const opponent = candidates.find((item) => store.userById(item.userId));
  if (opponent) {
    const opponentUser = store.userById(opponent.userId);
    matchQueue.delete(user.id);
    matchQueue.delete(opponent.userId);
    const { game } = service.createMatchedGame(mode, opponentUser, user);
    const now = Date.now();
    const firstResult = { gameId: game.id, role: 'red', mode, at: now };
    const secondResult = { gameId: game.id, role: 'black', mode, at: now };
    matchResults.set(opponent.userId, firstResult);
    matchResults.set(user.id, secondResult);
    return res.json({ matched: true, ...secondResult });
  }
  const info = matchPosition(entry);
  res.json({ queued: true, mode, position: info.position, queueSize: info.queueSize });
});

app.get('/api/match/status', requireUser, (req, res) => {
  pruneMatchmaking();
  const user = req.user;
  const ready = matchResults.get(user.id);
  if (ready) {
    matchResults.delete(user.id);
    return res.json({ matched: true, ...ready });
  }
  const entry = matchQueue.get(user.id);
  if (!entry) return res.json({ queued: false });
  entry.lastSeen = Date.now();
  const info = matchPosition(entry);
  res.json({ queued: true, mode: entry.mode, position: info.position, queueSize: info.queueSize });
});

app.post('/api/match/leave', requireUser, (req, res) => {
  const ready = matchResults.get(req.user.id);
  if (ready) {
    matchResults.delete(req.user.id);
    return res.json({ ok: true, matched: true, ...ready });
  }
  leaveMatchmaking(req.user.id);
  res.json({ ok: true });
});

app.post('/api/games/:id/join', requireUser, (req, res) => {
  const game = store.gameById(String(req.params.id || '').toUpperCase());
  if (!game) return res.status(404).json({ error: '对局不存在' });
  leaveMatchmaking(req.user.id);
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
const matchQueue = new Map();
const matchResults = new Map();
const MATCH_QUEUE_TTL = 30000;
const MATCH_RESULT_TTL = 90000;

function pruneMatchmaking() {
  const now = Date.now();
  for (const [id, entry] of matchQueue) {
    if (now - entry.lastSeen > MATCH_QUEUE_TTL) matchQueue.delete(id);
  }
  for (const [id, result] of matchResults) {
    if (now - result.at > MATCH_RESULT_TTL) matchResults.delete(id);
  }
}

function leaveMatchmaking(userId) {
  matchQueue.delete(userId);
  matchResults.delete(userId);
}

function matchPosition(entry) {
  const list = [...matchQueue.values()]
    .filter((item) => item.mode === entry.mode)
    .sort((a, b) => a.joinedAt - b.joinedAt);
  const index = list.findIndex((item) => item.userId === entry.userId);
  return { position: Math.max(1, index + 1), queueSize: list.length };
}

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
  if (user.banned) return next(new Error('账号已被封禁'));
  socket.data.user = user;
  socket.data.joined = null;
  next();
});

io.on('connection', (socket) => {
  const user = socket.data.user;
  if (!onlineUsers.has(user.id)) onlineUsers.set(user.id, new Set());
  onlineUsers.get(user.id).add(socket.id);
  user.lastSeen = new Date().toISOString();
  store.save();
  socket.on('disconnect', () => {
    const sockets = onlineUsers.get(user.id);
    if (!sockets) return;
    sockets.delete(socket.id);
    if (!sockets.size) onlineUsers.delete(user.id);
  });

  socket.on('join_game', (payload, ack) => {
    if (typeof ack !== 'function') ack = () => {};
    const gameId = String(payload?.gameId || '').toUpperCase();
    const game = store.gameById(gameId);
    if (!game) return ack({ ok: false, error: '对局不存在' });
    leaveMatchmaking(user.id);
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
