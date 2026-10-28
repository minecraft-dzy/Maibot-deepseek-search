'use strict';

const crypto = require('crypto');
const X = require('./xiangqi');
const {
  cardById,
  rayPath,
  horseTargets,
  palaceCoords,
  cannonCaptureTargets,
  cannonJumpTargets,
  adjacentOrtho,
  chongxiangTarget,
} = require('./skills');

const ATTACKING_PROMPT = '你是一流水平的进攻型棋手，计算深、判断准、出手狠。开局即抢占中路与要道，尽快出动车马炮，形成持续压迫；每一步都要制造新的威胁——捉子、牵制、将军、破士象、直取将门，逼对手不断应付，绝不给他喘息与调整的机会。看到破绽就集中子力强攻，能将军就将军，能得子就得子，能叫杀就绝不拖入残局。强攻时仍守住帅门、留好接应，不做无谓弃子。落子果断，步步紧逼，宁可多算三步，也不放过任何先手。聊天完全可选，只在确有话说时简短发言，不必回应每条消息；也可以与对手 AI 互相调侃、斗嘴，点到为止。';

const SPECIAL_PROMPT = '你是中国象棋世界冠军级别的引擎型棋手，本局必须拿出最高强度。每一步至少计算 8 到 12 个回合的强制变化，逐项核对将军、吃子、牵制、闷宫与将门弱点；先保证将帅安全，再追求最大子力与位置收益。开局抢占中路与要道，迅速出动车马炮；中局持续制造不可回避的威胁，能将军就将军，能得子就得子，能叫杀就绝不拖延；残局精确计算，不给对手任何和棋或翻盘机会。禁止随手棋、禁止无谓弃子、禁止在优势下草率简化。落子前自检：是否漏算对方反击、是否送将、是否有更强制的手段。语言简洁，不废话，不轻敌。';

const SPECIAL_REWARD = 120;

const DEFAULT_PROMPTS = {
  red: ATTACKING_PROMPT,
  black: ATTACKING_PROMPT,
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

  createGame({ mode, user, side, redPrompt, blackPrompt, special, isPublic }) {
    const id = this.createGameId();
    const createdAt = nowIso();
    const game = {
      id,
      mode,
      status: 'waiting',
      paused: false,
      special: mode === 'pve' && special === true,
      isPublic: isPublic !== false,
      creatorId: user.id,
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      endedAt: null,
      board: X.createInitialBoard(),
      turn: X.RED,
      history: [],
      skills: [],
      shields: {},
      kingShieldUsed: { red: false, black: false },
      undoStack: [],
      chats: [],
      lastMove: null,
      result: null,
      reward: null,
      ai: {},
      statsApplied: false,
      operatorId: user.id,
    };

    if (mode === 'pvp' || mode === 'skill') {
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
      if (game.special) {
        redPrompt = SPECIAL_PROMPT;
        blackPrompt = SPECIAL_PROMPT;
      }
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
    if (game.mode !== 'pvp' && game.mode !== 'skill') {
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
    if (captured && game.mode === 'skill' && this.shieldCount(game, captured.id) > 0) {
      this.breakShield(game, captured);
      this.addChat(
        game,
        null,
        `${X.pieceName(captured)} 的护盾挡下了这次吃子，护盾已破碎。`,
        'system',
        false,
      );
      this.save(game);
      this.broadcast(game);
      return { ok: false, error: '目标有护盾，护盾已破碎，请重新落子' };
    }
    this.pushUndo(game);
    X.applyMove(game.board, from, to);
    if (captured) this.clearShield(game, captured.id);
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
        const commentText = actor.comment ? clampText(actor.comment, 60) : '';
        const sayText = commentText ? `对手落子后说：「${commentText}」。` : '';
        this.enqueue(game, game.turn, {
          type: 'opponent_move',
          title: '对手落子',
          text: `对手刚刚落子：${notation}。${sayText}现在轮到你（${X.SIDE_NAMES[game.turn]}）。${checkText}请调用 view_board 查看局面，然后落子。`,
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
    if (triggerAI && game.status === 'playing' && role === 'player') {
      [X.RED, X.BLACK].forEach((c) => {
        if (game[c]?.type === 'ai') {
          this.enqueue(game, c, {
            type: 'chat',
            title: '收到对手消息',
            text: `${name}：${body}`,
            fromColor: color,
          });
        }
      });
    }
    return message;
  }

  addAIMessage(game, color, text, options = {}) {
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
    if (options.notifyOpponent !== false && game.status === 'playing' && !game.paused) {
      const opponent = color === X.RED ? X.BLACK : X.RED;
      if (game[opponent]?.type === 'ai') {
        this.enqueue(game, opponent, {
          type: 'chat',
          title: '对手发言',
          text: `${game[color].name}：${body}`,
          fromColor: color,
          fromAI: true,
        });
      }
    }
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
    if (game.special && winner) {
      const winnerSeat = game[winner];
      const winnerUser = winnerSeat?.type === 'human' && winnerSeat.userId
        ? this.store.userById(winnerSeat.userId)
        : null;
      if (winnerUser) {
        winnerUser.points = Math.max(0, Number(winnerUser.points) || 0) + SPECIAL_REWARD;
        winnerUser.cards = winnerUser.cards || {};
        game.reward = { userId: winnerUser.id, points: SPECIAL_REWARD };
        this.store.save();
      }
    }
    this.applyStats(game);
    this.save(game);
    const text = winner
      ? `${X.SIDE_NAMES[winner]}（${game[winner].name}）获胜，原因：${game.result.reasonText}。`
      : `对局结束：${game.result.reasonText}。`;
    this.addChat(game, null, text, 'system', false);
    this.broadcast(game);
    this.emit(game, 'game:over', { gameId: game.id, result: game.result, reward: game.reward || null });
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

  shieldCount(game, pieceId) {
    return Math.max(0, Number(game.shields?.[pieceId]) || 0);
  }

  breakShield(game, piece) {
    if (!game.shields || !piece) return;
    const next = this.shieldCount(game, piece.id) - 1;
    if (next > 0) game.shields[piece.id] = next;
    else delete game.shields[piece.id];
  }

  clearShield(game, pieceId) {
    if (game.shields && pieceId) delete game.shields[pieceId];
  }

  pushUndo(game) {
    game.undoStack = game.undoStack || [];
    game.undoStack.push({
      board: X.cloneBoard(game.board),
      turn: game.turn,
      lastMove: game.lastMove ? { ...game.lastMove } : null,
      historyLength: game.history.length,
    });
    if (game.undoStack.length > 4) game.undoStack.splice(0, game.undoStack.length - 4);
  }

  consumeCard(user, cardId) {
    user.cards = user.cards || {};
    const next = Math.max(0, Number(user.cards[cardId]) || 0) - 1;
    if (next > 0) user.cards[cardId] = next;
    else delete user.cards[cardId];
  }

  makeSkillEntry(color, card, data) {
    return {
      id: crypto.randomBytes(4).toString('hex'),
      color,
      cardId: card.id,
      name: card.name,
      at: nowIso(),
      ...data,
    };
  }

  commitSkill(game, user, color, card, entry, keepTurn = false) {
    this.consumeCard(user, card.id);
    if (!keepTurn) game.turn = color === X.RED ? X.BLACK : X.RED;
    game.skills = game.skills || [];
    game.skills.push(entry);
    const status = X.getGameStatus(game.board, game.turn);
    this.save(game);
    this.emit(game, 'game:skill', { gameId: game.id, entry });
    this.addChat(
      game,
      null,
      `${game[color].name} 发动「${card.name}」${entry.summary ? `：${entry.summary}` : ''}`,
      'system',
      false,
    );
    if (status.over) {
      this.finish(game, { winner: status.winner, reason: status.reason, by: color });
    } else {
      this.broadcast(game);
      if (status.inCheck) this.addChat(game, null, `${X.SIDE_NAMES[game.turn]}被将军。`, 'system', false);
    }
    return {
      ok: true,
      skill: entry,
      cards: { ...user.cards },
      state: this.toState(game),
    };
  }

  useSkill(game, user, payload) {
    if (game.mode !== 'skill') return { ok: false, error: '只有技能对弈可以使用卡牌' };
    if (game.status !== 'playing') return { ok: false, error: '对局不在进行中' };
    if (game.paused) return { ok: false, error: '对局已暂停' };
    const color = this.colorForUser(game, user.id);
    if (!color) return { ok: false, error: '你不是本局棋手' };
    if (game[color].type !== 'human') return { ok: false, error: 'AI 不能使用卡牌' };
    if (game.turn !== color) return { ok: false, error: '还没有轮到你' };
    const cardId = String(payload?.cardId || '');
    const card = cardById(cardId);
    if (!card) return { ok: false, error: '未知卡牌' };
    user.cards = user.cards || {};
    if (Math.max(0, Number(user.cards[cardId]) || 0) <= 0) {
      return { ok: false, error: '你还没有这张卡牌' };
    }
    game.shields = game.shields || {};

    if (card.mode === 'instant') {
      if (cardId !== 'undo') return { ok: false, error: '这张卡牌暂未开放' };
      return this.useUndo(game, user, card, color);
    }
    if (card.mode === 'square') {
      if (cardId !== 'wall') return { ok: false, error: '这张卡牌暂未开放' };
      return this.useWall(game, user, card, color, payload);
    }

    const from = X.coordToPos(String(payload?.from || '').toLowerCase());
    if (!from) return { ok: false, error: '请先选择一枚己方棋子' };
    const piece = game.board[from.row][from.col];
    if (!piece || piece.color !== color || !card.pieceTypes.includes(piece.type)) {
      return { ok: false, error: `「${card.name}」不能对这枚棋子使用` };
    }
    if (card.mode === 'apply') {
      if (cardId === 'shield') return this.useShield(game, user, card, color, piece, from);
      if (cardId === 'water') return this.useWater(game, user, card, color, piece, from);
      return { ok: false, error: '这张卡牌暂未开放' };
    }

    const to = X.coordToPos(String(payload?.to || '').toLowerCase());
    if (!to) return { ok: false, error: '请选择落点' };
    if (from.row === to.row && from.col === to.col) return { ok: false, error: '落点不能与起点相同' };

    switch (cardId) {
      case 'dayun':
        return this.useDayun(game, user, card, color, piece, from, to);
      case 'pawn':
        return this.usePawn(game, user, card, color, piece, from, to);
      case 'chariot':
        return this.useChariot(game, user, card, color, piece, from, to);
      case 'horse':
        return this.useHorse(game, user, card, color, piece, from, to);
      case 'cannon':
        return this.useCannon(game, user, card, color, piece, from, to);
      case 'chongxiang':
        return this.useChongxiang(game, user, card, color, piece, from, to);
      case 'guard':
        return this.useGuard(game, user, card, color, piece, from, to);
      default:
        return { ok: false, error: '这张卡牌暂未开放' };
    }
  }

  useShield(game, user, card, color, piece, from) {
    if (piece.type === 'K') {
      game.kingShieldUsed = game.kingShieldUsed || { red: false, black: false };
      if (game.kingShieldUsed[color]) {
        return { ok: false, error: '将/帅一局只能获得一次护盾' };
      }
      if (this.shieldCount(game, piece.id) > 0) {
        return { ok: false, error: '将/帅只能拥有一层护盾' };
      }
      game.kingShieldUsed[color] = true;
    }
    const next = this.shieldCount(game, piece.id) + 1;
    game.shields[piece.id] = next;
    const entry = this.makeSkillEntry(color, card, {
      from: X.posToCoord(from.row, from.col),
      targetId: piece.id,
      targetName: X.pieceName(piece),
      shield: next,
      summary: `为 ${X.pieceName(piece)} 附加第 ${next} 层护盾`,
    });
    return this.commitSkill(game, user, color, card, entry);
  }

  useWater(game, user, card, color, piece, from) {
    if (piece.water) return { ok: false, error: '这枚相/象已经可以过河' };
    piece.water = true;
    const entry = this.makeSkillEntry(color, card, {
      from: X.posToCoord(from.row, from.col),
      targetId: piece.id,
      targetName: X.pieceName(piece),
      summary: `${X.pieceName(piece)} 获得过河能力`,
    });
    return this.commitSkill(game, user, color, card, entry);
  }

  useWall(game, user, card, color, payload) {
    const to = X.coordToPos(String(payload?.to || '').toLowerCase());
    if (!to) return { ok: false, error: '请选择一个空位放置墙' };
    if (game.board[to.row][to.col]) return { ok: false, error: '该位置已有棋子' };
    const test = X.cloneBoard(game.board);
    test[to.row][to.col] = { color, type: 'W', id: 'preview' };
    if (X.isInCheck(test, color)) return { ok: false, error: '放置后己方仍被将军，换个位置吧' };
    game.board[to.row][to.col] = {
      color,
      type: 'W',
      id: `wall_${crypto.randomBytes(4).toString('hex')}`,
    };
    const coord = X.posToCoord(to.row, to.col);
    const entry = this.makeSkillEntry(color, card, {
      to: coord,
      summary: `在 ${coord} 筑起一堵墙`,
    });
    return this.commitSkill(game, user, color, card, entry);
  }

  useUndo(game, user, card, color) {
    const history = game.history;
    if (!history.length) return { ok: false, error: '还没有落子可以撤回' };
    const last = history[history.length - 1];
    let count = 0;
    if (last.color === color) {
      count = 1;
    } else if (history.length >= 2 && history[history.length - 2].color === color) {
      count = 2;
    }
    if (!count) return { ok: false, error: '还没有你的落子可以撤回' };
    const stack = game.undoStack || [];
    if (stack.length < count) return { ok: false, error: '这一步暂时无法撤回' };
    const snapshot = stack[stack.length - count];
    const removed = history.splice(history.length - count, count);
    game.board = X.cloneBoard(snapshot.board);
    game.turn = color;
    game.lastMove = snapshot.lastMove || null;
    game.undoStack = stack.slice(0, stack.length - count);
    const entry = this.makeSkillEntry(color, card, {
      removed: removed.map((move) => move.notation),
      summary: `撤回 ${removed.length} 步落子`,
    });
    return this.commitSkill(game, user, color, card, entry, true);
  }

  performSkillMove(game, user, card, color, piece, from, to, captured) {
    const fromCoord = X.posToCoord(from.row, from.col);
    const toCoord = X.posToCoord(to.row, to.col);
    if (captured && this.shieldCount(game, captured.id) > 0) {
      this.breakShield(game, captured);
      const blocked = this.makeSkillEntry(color, card, {
        from: fromCoord,
        to: toCoord,
        blocked: true,
        captured: [],
        summary: `被 ${X.pieceName(captured)} 的护盾挡下`,
      });
      return this.commitSkill(game, user, color, card, blocked);
    }
    const test = X.cloneBoard(game.board);
    test[to.row][to.col] = test[from.row][from.col];
    test[from.row][from.col] = null;
    if (X.isInCheck(test, color)) return { ok: false, error: '这步会让己方被将军' };

    this.pushUndo(game);
    X.applyMove(game.board, from, to);
    if (captured) this.clearShield(game, captured.id);
    const notation = `${X.SIDE_NAMES[color]}${X.pieceName(piece)} ${fromCoord}→${toCoord}${captured ? ` 吃${X.pieceName(captured)}` : ''}（${card.name}）`;
    const move = {
      moveNo: game.history.length + 1,
      color,
      from: fromCoord,
      to: toCoord,
      piece: { type: piece.type, color: piece.color, name: X.pieceName(piece) },
      captured: captured
        ? { type: captured.type, color: captured.color, name: X.pieceName(captured) }
        : null,
      notation,
      actor: 'skill',
      skill: card.id,
      at: nowIso(),
    };
    game.history.push(move);
    game.lastMove = { from: move.from, to: move.to, color, at: move.at };
    const entry = this.makeSkillEntry(color, card, {
      from: fromCoord,
      to: toCoord,
      captured: captured
        ? [{ coord: toCoord, name: X.pieceName(captured), type: captured.type, color: captured.color }]
        : [],
      summary: notation,
    });
    return this.commitSkill(game, user, color, card, entry);
  }

  usePawn(game, user, card, color, piece, from, to) {
    if (!adjacentOrtho(from).some((pos) => pos.row === to.row && pos.col === to.col)) {
      return { ok: false, error: '孬兵只能前后左右移动一格' };
    }
    const captured = game.board[to.row][to.col];
    if (captured && captured.color === color) return { ok: false, error: '不能吃自己的棋子' };
    return this.performSkillMove(game, user, card, color, piece, from, to, captured);
  }

  useChariot(game, user, card, color, piece, from, to) {
    const target = cannonCaptureTargets(game.board, from, color)
      .find((item) => item.row === to.row && item.col === to.col);
    if (!target) return { ok: false, error: '炮车必须隔一子吃掉对方棋子' };
    return this.performSkillMove(game, user, card, color, piece, from, to, target.piece);
  }

  useHorse(game, user, card, color, piece, from, to) {
    if (!horseTargets(from).some((pos) => pos.row === to.row && pos.col === to.col)) {
      return { ok: false, error: '飞马必须走马步' };
    }
    const captured = game.board[to.row][to.col];
    if (captured && captured.color === color) return { ok: false, error: '不能吃自己的棋子' };
    return this.performSkillMove(game, user, card, color, piece, from, to, captured);
  }

  useCannon(game, user, card, color, piece, from, to) {
    const target = cannonJumpTargets(game.board, from)
      .find((item) => item.row === to.row && item.col === to.col);
    if (!target) return { ok: false, error: '飞炮必须越过一个棋子落到空位' };
    return this.performSkillMove(game, user, card, color, piece, from, to, null);
  }

  useChongxiang(game, user, card, color, piece, from, to) {
    const target = chongxiangTarget(game.board, from, color);
    if (!target || target.row !== to.row || target.col !== to.col) {
      return { ok: false, error: '冲象必须正前方一格有敌方棋子' };
    }
    return this.performSkillMove(game, user, card, color, piece, from, to, target.piece);
  }

  useGuard(game, user, card, color, piece, from, to) {
    if (!palaceCoords(color).some((pos) => pos.row === to.row && pos.col === to.col)) {
      return { ok: false, error: '勇士只能在己方九宫格内移动' };
    }
    const captured = game.board[to.row][to.col];
    if (captured && captured.color === color) return { ok: false, error: '不能吃自己的棋子' };
    return this.performSkillMove(game, user, card, color, piece, from, to, captured);
  }

  useDayun(game, user, card, color, piece, from, to) {
    const path = rayPath(from, to);
    if (!path) return { ok: false, error: '大运只能沿八条射线移动' };
    const destination = game.board[to.row][to.col];
    if (destination && destination.type === 'K') {
      return { ok: false, error: '将/帅不能被大运吃掉，请换个落点' };
    }
    if (destination && this.shieldCount(game, destination.id) > 0) {
      return { ok: false, error: '落点上的棋子有护盾，无法落点' };
    }
    const capturable = [];
    const shielded = [];
    path.forEach((cell) => {
      const target = game.board[cell.row][cell.col];
      if (!target || target.type === 'K') return;
      if (this.shieldCount(game, target.id) > 0) shielded.push({ cell, target });
      else capturable.push({ cell, target });
    });
    const test = X.cloneBoard(game.board);
    capturable.forEach(({ cell }) => {
      test[cell.row][cell.col] = null;
    });
    test[to.row][to.col] = test[from.row][from.col];
    test[from.row][from.col] = null;
    if (X.isInCheck(test, color)) return { ok: false, error: '这一击会让己方帅门失守，换个落点吧' };

    this.pushUndo(game);
    capturable.forEach(({ cell, target }) => {
      game.board[cell.row][cell.col] = null;
      this.clearShield(game, target.id);
    });
    shielded.forEach(({ target }) => this.breakShield(game, target));
    const rook = game.board[from.row][from.col];
    game.board[to.row][to.col] = rook;
    game.board[from.row][from.col] = null;

    const fromCoord = X.posToCoord(from.row, from.col);
    const toCoord = X.posToCoord(to.row, to.col);
    const capturedList = capturable.map(({ target }) => ({
      type: target.type,
      color: target.color,
      name: X.pieceName(target),
    }));
    const notation = `${X.SIDE_NAMES[color]}${X.pieceName(piece)} ${fromCoord}→${toCoord}（大运，吃 ${capturable.length} 子）`;
    const move = {
      moveNo: game.history.length + 1,
      color,
      from: fromCoord,
      to: toCoord,
      piece: { type: piece.type, color: piece.color, name: X.pieceName(piece) },
      captured: null,
      capturedList,
      notation,
      actor: 'skill',
      skill: card.id,
      at: nowIso(),
    };
    game.history.push(move);
    game.lastMove = { from: move.from, to: move.to, color, at: move.at };
    const entry = this.makeSkillEntry(color, card, {
      from: fromCoord,
      to: toCoord,
      captured: capturable.map(({ cell, target }) => ({
        coord: X.posToCoord(cell.row, cell.col),
        name: X.pieceName(target),
        type: target.type,
        color: target.color,
      })),
      blockedShields: shielded.map(({ cell, target }) => ({
        coord: X.posToCoord(cell.row, cell.col),
        name: X.pieceName(target),
      })),
      summary: notation,
    });
    return this.commitSkill(game, user, color, card, entry);
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
      special: !!game.special,
      isPublic: game.isPublic !== false,
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
      joinable: (game.mode === 'pvp' || game.mode === 'skill') && game.status === 'waiting' && !game.black.userId,
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
      special: !!game.special,
      isPublic: game.isPublic !== false,
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
      skills: (game.skills || []).slice(-30),
      shields: game.shields || {},
      kingShieldUsed: game.kingShieldUsed || { red: false, black: false },
      lastMove: game.lastMove,
      result: game.result,
      reward: game.reward || null,
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
  SPECIAL_PROMPT,
  SPECIAL_REWARD,
  AI_NAMES,
  REASON_TEXT,
};
