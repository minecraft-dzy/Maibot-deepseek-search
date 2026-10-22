'use strict';

const crypto = require('crypto');
const X = require('./xiangqi');

const DEFAULT_PROMPTS = {
  red: '你执红先行。你的棋风锐利主动，重视先手与攻势，善于用炮、车组织压迫；但绝不冒进弃守帅门。用简短、从容的中文与对手交流。',
  black: '你执黑后行。你的棋风沉稳坚韧，擅长防守反击与子力交换，耐心寻找对手的破绽。用简短、从容的中文与对手交流。',
};

const AI_NAMES = {
  red: 'DeepSeek · 赤焰',
  black: 'DeepSeek · 玄甲',
};

const REASON_TEXT = {
  checkmate: '将死',
  stalemate: '困毙',
  king_captured: '主帅被擒',
  resign: '认输',
  stopped: '对局终止',
  draw: '和棋',
};

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

function clampText(text, max) {
  const value = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
  return value.length > max ? value.slice(0, max) : value;
}

function makeAISession() {
  return {
    messages: [],
    trace: [],
    seq: 0,
    status: 'idle',
    lastError: null,
  };
}

class GameService {
  constructor(store) {
    this.store = store;
    this.planner = null;
    this.io = null;
    this.roomSizes = new Map();
  }

  attach(io, planner) {
    this.io = io;
    this.planner = planner;
  }

  emit(game, event, payload) {
    if (this.io) this.io.to(`game:${game.id}`).emit(event, payload);
  }

  broadcast(game) {
    this.emit(game, 'game:update', this.toState(game));
  }

  save(game) {
    game.updatedAt = nowIso();
    this.store.save();
  }

  addTrace(game, color, entry, persist = true) {
    const ai = game.ai[color];
    if (!ai) return;
    ai.seq = (ai.seq || 0) + 1;
    const item = {
      seq: ai.seq,
      at: nowIso(),
      ...entry,
    };
    if (item.text) item.text = clampText(item.text, 24000);
    if (item.result) item.result = clampText(item.result, 16000);
    ai.trace.push(item);
    if (ai.trace.length > 600) ai.trace.splice(0, ai.trace.length - 600);
    if (persist) this.save(game);
    this.emit(game, 'ai:trace', { gameId: game.id, color, entry: item, count: ai.trace.length });
    return item;
  }

  setAIStatus(game, color, status, message) {
    const ai = game.ai[color];
    if (!ai) return;
    ai.status = status;
    if (status === 'error') ai.lastError = clampText(message || 'AI 调用失败', 600);
    this.save(game);
    this.emit(game, 'ai:status', {
      gameId: game.id,
      color,
      status,
      message: ai.lastError || '',
      at: nowIso(),
    });
  }

  makeSeat(color, user, type, prompt) {
    if (type === 'human') {
      return {
        color,
        type,
        userId: user.id,
        username: user.username,
        name: user.username,
        prompt: null,
        connected: false,
      };
    }
    return {
      color,
      type,
      userId: null,
      username: null,
      name: AI_NAMES[color],
      prompt: prompt || DEFAULT_PROMPTS[color],
      connected: true,
    };
  }

  createGame({ mode, user, side, redPrompt, blackPrompt }) {
    const id = this.createGameId();
    const createdAt = nowIso();
    const game = {
      id,
      mode,
      status: 'waiting',
      paused: false,
      creatorId: user.id,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      endedAt: null,
      board: X.createInitialBoard(),
      turn: X.RED,
      history: [],
      chats: [],
      lastMove: null,
      result: null,
      ai: {},
      statsApplied: false,
      operatorId: user.id,
    };

    if (mode === 'pvp') {
      game.red = this.makeSeat(X.RED, user, 'human');
      game.black = {
        color: X.BLACK,
        type: 'human',
        userId: null,
        username: null,
        name: '',
        prompt: null,
        connected: false,
      };
    } else if (mode === 'pve') {
      const humanColor = side === X.BLACK ? X.BLACK : X.RED;
      const aiColor = humanColor === X.RED ? X.BLACK : X.RED;
      game.red = humanColor === X.RED
        ? this.makeSeat(X.RED, user, 'human')
        : this.makeSeat(X.RED, user, 'ai', redPrompt);
      game.black = humanColor === X.BLACK
        ? this.makeSeat(X.BLACK, user, 'human')
        : this.makeSeat(X.BLACK, user, 'ai', blackPrompt);
      if (game.red.type === 'ai') game.ai.red = makeAISession();
      if (game.black.type === 'ai') game.ai.black = makeAISession();
      game.status = 'playing';
      game.startedAt = createdAt;
    } else if (mode === 'aivai') {
      game.red = this.makeSeat(X.RED, user, 'ai', redPrompt);
      game.black = this.makeSeat(X.BLACK, user, 'ai', blackPrompt);
      game.ai.red = makeAISession();
      game.ai.black = makeAISession();
      game.status = 'playing';
      game.startedAt = createdAt;
    } else {
      throw new Error('未知对局模式');
    }

    this.store.addGame(game);
    this.addChat(game, null, '对局已创建，等待棋手入席。', 'system', false);
    if (game.status === 'playing') {
      this.addChat(game, null, '对局开始，红方先行。', 'system', false);
      if (game.turn === X.RED && game.red.type === 'ai') {
        this.enqueue(game, X.RED, {
          type: 'game_start',
          title: '对局开始',
          text: '对局开始，你执红先行。请查看棋盘并落子。',
        });
      }
    }
    this.broadcast(game);
    return game;
  }

  createGameId() {
    let id;
    do {
      id = randomId();
    } while (this.store.gameById(id));
    return id;
  }

  joinPvp(game, user) {
    if (game.mode !== 'pvp') {
      const color = this.colorForUser(game, user.id);
      return { role: color || 'spectator', game };
    }
    if (game.red.userId === user.id) return { role: X.RED, game };
    if (game.black.userId === user.id) return { role: X.BLACK, game };
    if (!game.black.userId) {
      game.black = this.makeSeat(X.BLACK, user, 'human');
      game.status = 'playing';
      game.startedAt = nowIso();
      this.addChat(game, null, '黑方已入席，对局开始。', 'system', false);
      this.save(game);
      this.broadcast(game);
      return { role: X.BLACK, game };
    }
    return { role: 'spectator', game };
  }

  colorForUser(game, userId) {
    if (game.red?.userId === userId) return X.RED;
    if (game.black?.userId === userId) return X.BLACK;
    return null;
  }

  enqueue(game, color, event) {
    if (!this.planner) return;
    this.planner.enqueue(game, color, event);
  }

  setPresence(game, user, connected) {
    if (!user) return null;
    const color = this.colorForUser(game, user.id);
    if (!color) return null;
    game[color].connected = connected;
    if (connected) this.save(game);
    return color;
  }

  applyMove(game, fromCoord, toCoord, actor) {
    if (game.status !== 'playing') return { ok: false, error: '对局尚未开始或已经结束' };
    if (game.paused) return { ok: false, error: '对局已暂停' };
    let color = null;
    if (actor.kind === 'human') {
      color = this.colorForUser(game, actor.user.id);
      if (!color) return { ok: false, error: '你不是本局棋手' };
      if (game[color].type !== 'human') return { ok: false, error: '该席位不是人类棋手' };
    } else if (actor.kind === 'ai') {
      color = actor.color;
      if (game[color]?.type !== 'ai') return { ok: false, error: '该席位不是 AI' };
    } else {
      return { ok: false, error: '无效的操作者' };
    }
    if (game.turn !== color) return { ok: false, error: '还没有轮到你落子' };

    const from = X.coordToPos(fromCoord);
    const to = X.coordToPos(toCoord);
    if (!from || !to) return { ok: false, error: '坐标无效，请使用 a0–i9' };
    const piece = game.board[from.row][from.col];
    if (!piece || piece.color !== color) return { ok: false, error: '起点没有你的棋子' };
    if (!X.isLegalMove(game.board, from, to, color)) {
      return { ok: false, error: '该着法不合法（可能被挡住、会送将或不符合棋子走法）' };
    }

    const notation = X.moveNotation(game.board, from, to);
    const captured = game.board[to.row][to.col];
    X.applyMove(game.board, from, to);
    const move = {
      moveNo: game.history.length + 1,
      color,
      from: X.posToCoord(from.row, from.col),
      to: X.posToCoord(to.row, to.col),
      piece: { type: piece.type, color: piece.color, name: X.pieceName(piece) },
      captured: captured
        ? { type: captured.type, color: captured.color, name: X.pieceName(captured) }
        : null,
      notation,
      actor: actor.kind,
      at: nowIso(),
    };
    game.history.push(move);
    game.lastMove = { from: move.from, to: move.to, color, at: move.at };
    game.turn = color === X.RED ? X.BLACK : X.RED;

    const status = X.getGameStatus(game.board, game.turn);
    move.check = status.inCheck;
    move.gameOver = status.over;

    if (status.over) {
      this.finish(game, {
        winner: status.winner,
        reason: status.reason,
        by: color,
      });
    } else {
      this.save(game);
      this.broadcast(game);
      const nextSeat = game[game.turn];
      if (nextSeat.type === 'ai') {
        const checkText = status.inCheck ? '你现在正被将军，必须先解将。' : '';
        this.enqueue(game, game.turn, {
          type: 'opponent_move',
          title: '对手落子',
          text: `对手刚刚落子：${notation}。现在轮到你（${X.SIDE_NAMES[game.turn]}）。${checkText}请调用 view_board 查看局面，然后落子。`,
        });
      }
    }
    return { ok: true, move, game };
  }

  addChat(game, user, text, role, triggerAI = true) {
    const body = clampText(text, 500);
    if (!body) return null;
    let color = null;
    let name = '观众';
    let userId = null;
    if (user) {
      color = this.colorForUser(game, user.id);
      name = user.username;
      userId = user.id;
      if (!color) role = 'spectator';
      else role = 'player';
    }
    if (role === 'system') {
      color = null;
      name = '棋局';
    }
    const message = {
      id: crypto.randomBytes(6).toString('hex'),
      at: nowIso(),
      userId,
      name,
      color,
      role,
      text: body,
    };
    game.chats.push(message);
    if (game.chats.length > 300) game.chats.splice(0, game.chats.length - 300);
    this.save(game);
    this.emit(game, 'game:chat', { gameId: game.id, message });
    if (triggerAI && game.status === 'playing' && (role === 'player' || role === 'spectator')) {
      [X.RED, X.BLACK].forEach((c) => {
        if (game[c]?.type === 'ai') {
          this.enqueue(game, c, {
            type: 'chat',
            title: role === 'spectator' ? '收到观众消息' : '收到对手消息',
            text: `${name}：${body}`,
            fromColor: color,
          });
        }
      });
    }
    return message;
  }

  addAIMessage(game, color, text) {
    const body = clampText(text, 300);
    if (!body) return null;
    const message = {
      id: crypto.randomBytes(6).toString('hex'),
      at: nowIso(),
      userId: null,
      name: game[color].name,
      color,
      role: 'ai',
      text: body,
    };
    game.chats.push(message);
    if (game.chats.length > 300) game.chats.splice(0, game.chats.length - 300);
    this.save(game);
    this.emit(game, 'game:chat', { gameId: game.id, message });
    return message;
  }

  finish(game, { winner, reason, by }) {
    if (game.status === 'finished') return;
    game.status = 'finished';
    game.endedAt = nowIso();
    game.result = {
      winner: winner || null,
      reason,
      reasonText: REASON_TEXT[reason] || reason,
      by: by || null,
      winnerName: winner ? game[winner].name : null,
      at: game.endedAt,
    };
    this.applyStats(game);
    this.save(game);
    const text = winner
      ? `${X.SIDE_NAMES[winner]}（${game[winner].name}）获胜，原因：${game.result.reasonText}。`
      : `对局结束：${game.result.reasonText}。`;
    this.addChat(game, null, text, 'system', false);
    this.broadcast(game);
    this.emit(game, 'game:over', { gameId: game.id, result: game.result });
  }

  applyStats(game) {
    if (game.statsApplied) return;
    game.statsApplied = true;
    [X.RED, X.BLACK].forEach((color) => {
      const seat = game[color];
      if (!seat?.userId) return;
      const user = this.store.userById(seat.userId);
      if (!user) return;
      user.stats = user.stats || { wins: 0, losses: 0, draws: 0, games: 0 };
      user.stats.games += 1;
      if (!game.result?.winner) user.stats.draws += 1;
      else if (game.result.winner === color) user.stats.wins += 1;
      else user.stats.losses += 1;
    });
    this.store.save();
  }

  resign(game, user) {
    if (game.status !== 'playing') return { ok: false, error: '对局不在进行中' };
    const color = this.colorForUser(game, user.id);
    if (color) {
      const winner = color === X.RED ? X.BLACK : X.RED;
      this.addChat(game, user, '认输', 'player', false);
      this.finish(game, { winner, reason: 'resign', by: color });
      return { ok: true, game };
    }
    if (game.mode === 'aivai' && game.creatorId === user.id) {
      this.finish(game, { winner: null, reason: 'stopped', by: null });
      return { ok: true, game };
    }
    return { ok: false, error: '你无权结束本局' };
  }

  pause(game, user) {
    if (game.mode !== 'aivai') return { ok: false, error: '只有 AI 对 AI 对局可以暂停' };
    if (game.creatorId !== user.id) return { ok: false, error: '只有创建者可以暂停' };
    if (game.status !== 'playing') return { ok: false, error: '对局不在进行中' };
    game.paused = true;
    this.save(game);
    this.broadcast(game);
    return { ok: true, game };
  }

  resume(game, user) {
    if (game.mode !== 'aivai') return { ok: false, error: '只有 AI 对 AI 对局可以暂停' };
    if (game.creatorId !== user.id) return { ok: false, error: '只有创建者可以继续' };
    if (game.status !== 'playing') return { ok: false, error: '对局不在进行中' };
    game.paused = false;
    this.save(game);
    this.broadcast(game);
    if (game[game.turn].type === 'ai') {
      this.enqueue(game, game.turn, {
        type: 'resume',
        title: '对局继续',
        text: '对局继续。现在轮到你，请查看棋盘并落子。',
      });
    }
    return { ok: true, game };
  }

  retryAI(game, user) {
    if (game.status !== 'playing') return { ok: false, error: '对局不在进行中' };
    const color = this.colorForUser(game, user.id);
    const isParticipant = !!color;
    const isOperator = game.creatorId === user.id;
    if (!isParticipant && !isOperator) return { ok: false, error: '无权重试' };
    if (game[game.turn].type !== 'ai') return { ok: false, error: '当前不是 AI 回合' };
    if (game.paused) return { ok: false, error: '对局已暂停' };
    this.enqueue(game, game.turn, {
      type: 'retry',
      title: '重试 AI',
      text: '请继续当前回合。先查看棋盘，然后落子。',
    });
    return { ok: true, game };
  }

  getTrace(game, color) {
    if (!['red', 'black'].includes(color)) return null;
    return game.ai[color]?.trace || [];
  }

  traceSlice(game, color, count = 40) {
    const trace = game.ai[color]?.trace || [];
    return trace.slice(Math.max(0, trace.length - count));
  }

  toSummary(game) {
    return {
      id: game.id,
      mode: game.mode,
      status: game.status,
      paused: game.paused,
      turn: game.turn,
      moveCount: game.history.length,
      createdAt: game.createdAt,
      updatedAt: game.updatedAt,
      startedAt: game.startedAt,
      redName: game.red.name || '等待棋手',
      blackName: game.black.name || '等待棋手',
      redType: game.red.type,
      blackType: game.black.type,
      result: game.result,
      creatorId: game.creatorId,
      joinable: game.mode === 'pvp' && game.status === 'waiting' && !game.black.userId,
    };
  }

  toState(game) {
    let legalMoves = [];
    let check = false;
    if (game.status === 'playing') {
      legalMoves = X.generateLegalMoves(game.board, game.turn)
        .map((m) => ({ from: X.posToCoord(m.from.row, m.from.col), to: X.posToCoord(m.to.row, m.to.col) }));
      check = X.isInCheck(game.board, game.turn);
    }
    const ai = {};
    [X.RED, X.BLACK].forEach((color) => {
      const seat = game[color];
      if (seat.type !== 'ai') return;
      const traces = this.traceSlice(game, color, 40).map((entry) => ({
        ...entry,
        text: entry.text ? clampText(entry.text, 4000) : undefined,
        result: entry.result ? clampText(entry.result, 4000) : undefined,
      }));
      ai[color] = {
        name: seat.name,
        prompt: seat.prompt,
        status: game.ai[color]?.status || 'idle',
        lastError: game.ai[color]?.lastError || null,
        traceCount: game.ai[color]?.trace.length || 0,
        trace: traces,
      };
    });
    return {
      id: game.id,
      mode: game.mode,
      status: game.status,
      paused: game.paused,
      creatorId: game.creatorId,
      createdAt: game.createdAt,
      updatedAt: game.updatedAt,
      startedAt: game.startedAt,
      endedAt: game.endedAt,
      board: X.serializeBoard(game.board),
      turn: game.turn,
      check,
      legalMoves,
      history: game.history,
      lastMove: game.lastMove,
      result: game.result,
      seats: {
        red: { ...game.red },
        black: { ...game.black },
      },
      ai,
      chats: game.chats.slice(-120),
      spectatorCount: Math.max(0, (this.roomSizes.get(game.id) || 0) - [game.red, game.black].filter((s) => s.userId).length),
      moveCount: game.history.length,
    };
  }
}

module.exports = {
  GameService,
  DEFAULT_PROMPTS,
  AI_NAMES,
  REASON_TEXT,
};
