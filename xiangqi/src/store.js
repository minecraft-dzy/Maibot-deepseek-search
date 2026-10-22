'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'db.json');
    this.data = null;
  }

  load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(this.dbPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        const backup = `${this.dbPath}.broken-${Date.now()}`;
        try { fs.renameSync(this.dbPath, backup); } catch (_) { /* ignore */ }
        console.error(`[store] 数据文件损坏，已备份到 ${backup}:`, err.message);
      }
    }
    if (!data || typeof data !== 'object') {
      data = { version: 1, secret: crypto.randomBytes(32).toString('hex'), users: {}, games: {}, createdAt: new Date().toISOString() };
    }
    data.version = data.version || 1;
    data.users = data.users || {};
    data.games = data.games || {};
    if (!data.secret) data.secret = crypto.randomBytes(32).toString('hex');
    this.data = data;
    this.save();
    return this;
  }

  save() {
    const tmp = `${this.dbPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.dbPath);
  }

  get secret() {
    return this.data.secret;
  }

  get users() {
    return this.data.users;
  }

  get games() {
    return this.data.games;
  }

  userByName(username) {
    const name = String(username || '').trim().toLocaleLowerCase();
    return Object.values(this.data.users).find((u) => u.usernameLower === name) || null;
  }

  userById(id) {
    return this.data.users[id] || null;
  }

  addUser(user) {
    this.data.users[user.id] = user;
    this.save();
  }

  gameById(id) {
    return this.data.games[id] || null;
  }

  addGame(game) {
    this.data.games[game.id] = game;
    this.save();
  }

  removeGame(id) {
    delete this.data.games[id];
    this.save();
  }

  gamesForUser(userId) {
    return Object.values(this.data.games)
      .filter((g) => g.creatorId === userId || g.red.userId === userId || g.black.userId === userId)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  publicGames(limit = 24) {
    return Object.values(this.data.games)
      .filter((g) => {
        if (g.mode === 'pvp') return g.status === 'waiting';
        return g.status === 'playing';
      })
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .slice(0, limit);
  }
}

module.exports = Store;
