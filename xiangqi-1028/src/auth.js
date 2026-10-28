'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'yijing_token';
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(payload, secret) {
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !payload.uid || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  try {
    const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
    const expected = Buffer.from(expectedHash, 'hex');
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
  } catch (_) {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function issueToken(userId, secret) {
  return signToken({ uid: userId, iat: Date.now(), exp: Date.now() + TOKEN_TTL }, secret);
}

function tokenFromRequest(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] || '';
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: TOKEN_TTL,
    path: '/',
  };
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
    stats: user.stats || { wins: 0, losses: 0, draws: 0, games: 0 },
    points: Math.max(0, Number(user.points) || 0),
    cards: user.cards || {},
  };
}

function attachUser(store) {
  return (req, res, next) => {
    const token = tokenFromRequest(req);
    const payload = verifyToken(token, store.secret);
    const user = payload ? store.userById(payload.uid) : null;
    req.user = user;
    next();
  };
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' });
  next();
}

function socketUser(store, socket) {
  const token = parseCookies(socket.handshake.headers.cookie)[COOKIE_NAME];
  const payload = verifyToken(token, store.secret);
  return payload ? store.userById(payload.uid) : null;
}

module.exports = {
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  parseCookies,
  issueToken,
  tokenFromRequest,
  cookieOptions,
  publicUser,
  attachUser,
  requireUser,
  socketUser,
  verifyToken,
};
