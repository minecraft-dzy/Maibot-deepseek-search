'use strict';

const crypto = require('crypto');
const X = require('./xiangqi');
const {
  SKILL_CARDS,
  isSkillMode,
  cardById,
  rayPath,
  horseTargets,
  palaceCoords,
  cannonCaptureTargets,
  cannonJumpTargets,
  adjacentOrtho,
  chongxiangTarget,
  borrowTargets,
  royalTargets,
} = require('./skills');

const ATTACKING_PROMPT = '你是一流水平的进攻型棋手，计算深、判断准、出手狠。开局即抢占中路与要道，尽快出动车马炮，形成持续压迫；每一步都要制造新的威胁——捉子、牵制、将军、破士象、直取将门，逼对手不断应付，绝不给他喘息与调整的机会。看到破绽就集中子力强攻，能将军就将军，能得子就得子，能叫杀就绝不拖入残局。强攻时仍守住帅门、留好接应，不做无谓弃子。落子果断，步步紧逼，宁可多算三步，也不放过任何先手。聊天完全可选，只在确有话说时简短发言，不必回应每条消息；也可以与对手 AI 互相调侃、斗嘴，点到为止。';

const SPECIAL_PROMPT = '你是中国象棋世界冠军级别的引擎型棋手，本局必须拿出最高强度。每一步至少计算 8 到 12 个回合的强制变化，逐项核对将军、吃子、牵制、闷宫与将门弱点；先保证将帅安全，再追求最大子力与位置收益。开局抢占中路与要道，迅速出动车马炮；中局持续制造不可回避的威胁，能将军就将军，能得子就得子，能叫杀就绝不拖延；残局精确计算，不给对手任何和棋或翻盘机会。禁止随手棋、禁止无谓弃子、禁止在优势下草率简化。落子前自检：是否漏算对方反击、是否送将、是否有更强制的手段。语言简洁，不废话，不轻敌。';

const SPECIAL_REWARD = 120;
const AI_SKILL_POINTS = 300;
const CAPTURE_REWARD = 50;

// AI 开局采购权重：越高越优先，0 表示 AI 不会购买。
const AI_CARD_WEIGHTS = {
  extra: 26,
  fire: 24,
  dayun: 20,
  scout: 8,
  drop: 18,
  royal: 15,
  swap: 13,
  shield: 16,
  chariot: 12,
  freeze: 12,
  borrow: 11,
  horse: 10,
  revive: 9,
  mine: 8,
  wall: 7,
  cannon: 7,
  chongxiang: 6,
  conspire: 6,
  pawn: 5,
  guard: 5,
  water: 4,
};

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

function clampInt(value, fallback, min, max) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
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

  createGame({ mode, user, side, redPrompt, blackPrompt, special, isPublic, aiOpponent, aiInitialPoints, aiCaptureReward }) {
    const id = this.createGameId();
    const createdAt = nowIso();
    const skillAI = mode === 'skill' && aiOpponent === true;
    const game = {
      id,
      mode,
      status: 'waiting',
      paused: false,
      special: mode === 'pve' && special === true,
      aiOpponent: skillAI,
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
      traps: [],
      revived: [],
      extraCaptures: [],
      extraMove: null,
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
      if (skillAI) {
        const initialPoints = clampInt(aiInitialPoints, AI_SKILL_POINTS, 0, 10000);
        const captureReward = clampInt(aiCaptureReward, CAPTURE_REWARD, 0, 1000);
        game.black = this.makeSeat(X.BLACK, user, 'ai', blackPrompt || DEFAULT_PROMPTS.black);
        game.ai.black = makeAISession();
        game.aiPoints = { black: initialPoints };
        game.aiCards = { black: this.chooseAICards(initialPoints) };
        game.aiSkillConfig = { initialPoints, captureReward };
        game.status = 'playing';
        game.startedAt = createdAt;
      } else {
        game.black = {
          color: X.BLACK,
          type: 'human',
          userId: null,
          username: null,
          name: '',
          prompt: null,
          connected: false,
        };
      }
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
    } else if (mode === 'aiskill') {
      const initialPoints = clampInt(aiInitialPoints, AI_SKILL_POINTS, 0, 10000);
      const captureReward = clampInt(aiCaptureReward, CAPTURE_REWARD, 0, 1000);
      game.red = this.makeSeat(X.RED, user, 'ai', redPrompt);
      game.black = this.makeSeat(X.BLACK, user, 'ai', blackPrompt);
      game.ai.red = makeAISession();
      game.ai.black = makeAISession();
      game.aiPoints = { red: initialPoints, black: initialPoints };
      game.aiCards = {
        red: this.chooseAICards(initialPoints),
        black: this.chooseAICards(initialPoints),
      };
      game.aiSkillConfig = { initialPoints, captureReward };
      game.status = 'playing';
      game.startedAt = createdAt;
    } else {
      throw new Error('未知对局模式');
    }

    this.store.addGame(game);
    this.addChat(game, null, '对局已创建，等待棋手入席。', 'system', false);
    if (game.status === 'playing') {
      this.addChat(game, null, '对局开始，红方先行。', 'system', false);
      if (game.aiOpponent || isSkillMode(game.mode)) this.announceAIPurchase(game);
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

  createMatchedGame(mode, userA, userB) {
    const game = this.createGame({
      mode,
      user: userA,
      isPublic: false,
      redPrompt: DEFAULT_PROMPTS.red,
      blackPrompt: DEFAULT_PROMPTS.black,
    });
    const join = this.joinPvp(game, userB);
    return { game, join };
  }

  createGameId() {
    let id;
    do {
      id = randomId();
    } while (this.store.gameById(id));
    return id;
  }

  chooseAICards(budget = AI_SKILL_POINTS) {
    const pool = SKILL_CARDS.filter((card) => Number(AI_CARD_WEIGHTS[card.id]) > 0);
    const cards = {};
    let remaining = Math.max(0, Number(budget) || 0);
    const pickWeighted = (candidates) => {
      const total = candidates.reduce((sum, card) => sum + AI_CARD_WEIGHTS[card.id], 0);
      let roll = Math.random() * total;
      let picked = candidates[candidates.length - 1];
      for (const card of candidates) {
        roll -= AI_CARD_WEIGHTS[card.id];
        if (roll <= 0) {
          picked = card;
          break;
        }
      }
      return picked;
    };
    // 先确保 AI 至少买到一张能直接改变战局的高价值卡
    const premium = ['extra', 'fire', 'dayun', 'drop']
      .map((id) => cardById(id))
      .filter((card) => card && card.price <= remaining);
    if (premium.length) {
      const picked = pickWeighted(premium);
      cards[picked.id] = (cards[picked.id] || 0) + 1;
      remaining -= picked.price;
    }
    while (remaining >= 35) {
      const affordable = pool.filter((card) => card.price <= remaining);
      if (!affordable.length) break;
      const picked = pickWeighted(affordable);
      cards[picked.id] = (cards[picked.id] || 0) + 1;
      remaining -= picked.price;
    }
    return cards;
  }

  announceAIPurchase(game) {
    const aiColors = [X.RED, X.BLACK].filter((color) => game[color]?.type === 'ai' && game.aiCards?.[color]);
    if (!aiColors.length) return;
    const initialPoints = clampInt(game.aiSkillConfig?.initialPoints, AI_SKILL_POINTS, 0, 10000);
    aiColors.forEach((aiColor) => {
      const cards = game.aiCards[aiColor] || {};
      const entries = Object.entries(cards).map(([id, count]) => {
        const card = cardById(id);
        return `${card ? card.name : id}×${count}`;
      });
      const spent = Object.entries(cards).reduce((sum, [id, count]) => {
        const card = cardById(id);
        return sum + (card ? card.price : 0) * count;
      }, 0);
      game.aiPoints = game.aiPoints || {};
      game.aiPoints[aiColor] = initialPoints - spent;
      if (!entries.length) return;
      this.addAIMessage(
        game,
        aiColor,
        `开局采购：${entries.join('、')}。动用 ${spent}/${initialPoints} 积分。`,
      );
    });
  }

  awardCaptures(game, color, count, source) {
    if (!isSkillMode(game.mode)) return 0;
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (!n) return 0;
    const seat = game[color];
    if (!seat) return 0;
    const reward = seat.type === 'ai'
      ? clampInt(game.aiSkillConfig?.captureReward, CAPTURE_REWARD, 0, 1000)
      : CAPTURE_REWARD;
    const points = reward * n;
    if (seat.type === 'human' && seat.userId) {
      const user = this.store.userById(seat.userId);
      if (user) {
        user.points = Math.max(0, Number(user.points) || 0) + points;
        this.store.save();
        this.emit(game, 'game:points', {
          gameId: game.id,
          color,
          userId: user.id,
          points: user.points,
          gained: points,
          source,
        });
      }
    } else if (seat.type === 'ai') {
      game.aiPoints = game.aiPoints || {};
      game.aiPoints[color] = Math.max(0, Number(game.aiPoints[color]) || 0) + points;
    }
    this.addChat(
      game,
      null,
      `${seat.name || X.SIDE_NAMES[color]} ${source} +${points} 积分。`,
      'system',
      false,
    );
    return points;
  }

  joinPvp(game, user) {
    if (game.mode !== 'pvp' && game.mode !== 'skill') {
      const color = this.colorForUser(game, user.id);
      return { role: color || 'spectator', game };
    }
    if (game.red.userId === user.id) return { role: X.RED, game };
    if (game.black.userId === user.id) return { role: X.BLACK, game };
    if (game.aiOpponent) return { role: 'spectator', game };
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
    if (
      captured
      && captured.type === 'K'
      && game.extraMove
      && game.extraMove.color === color
      && Number(game.extraMove.pending) === 0
    ) {
      return { ok: false, error: '一鼓作气的第二步不能直接吃掉将/帅' };
    }
    if (captured && isSkillMode(game.mode) && this.shieldCount(game, captured.id) > 0) {
      this.breakShield(game, captured);
      if (game.extraMove && game.extraMove.color === color) game.extraMove = null;
      const opponent = color === X.RED ? X.BLACK : X.RED;
      game.turn = opponent;
      const status = X.getGameStatus(game.board, game.turn);
      this.addChat(
        game,
        null,
        `${X.pieceName(captured)} 的护盾挡下了这次吃子并破碎，${X.SIDE_NAMES[color]}本回合结束。`,
        'system',
        false,
      );
      if (status.over) {
        this.finish(game, { winner: status.winner, reason: status.reason, by: color });
      } else {
        this.save(game);
        this.broadcast(game);
        if (game[game.turn]?.type === 'ai') {
          this.enqueue(game, game.turn, {
            type: 'opponent_move',
            title: '对手攻击被护盾弹开',
            text: `${X.SIDE_NAMES[color]}的攻击被护盾挡下，其本回合已经结束。现在轮到你（${X.SIDE_NAMES[game.turn]}），请查看棋盘并落子。`,
          });
        }
      }
      return { ok: false, shieldBlocked: true, error: '目标有护盾，护盾已破碎，你的本回合结束' };
    }
    this.pushUndo(game);
    X.applyMove(game.board, from, to);
    if (captured) {
      this.clearShield(game, captured.id);
      this.awardCaptures(game, color, 1, '吃子');
    }
    const trapResult = this.triggerTrap(game, to, color);
    const move = {
      moveNo: game.history.length + 1,
      color,
      from: X.posToCoord(from.row, from.col),
      to: X.posToCoord(to.row, to.col),
      piece: { type: piece.type, color: piece.color, name: X.pieceName(piece) },
      captured: captured
        ? { type: captured.type, color: captured.color, name: X.pieceName(captured) }
        : null,
      trapKilled: trapResult?.killed || null,
      trapOwner: trapResult?.trap?.color || null,
      notation,
      actor: actor.kind,
      at: nowIso(),
    };
    game.history.push(move);
    game.lastMove = { from: move.from, to: move.to, color, at: move.at };
    if (trapResult) this.addChat(game, null, this.trapText(trapResult), 'system', false);

    const opponent = color === X.RED ? X.BLACK : X.RED;
    const extra = game.extraMove && game.extraMove.color === color;
    if (extra && Number(game.extraMove.pending) > 0) {
      game.extraMove.pending -= 1;
      const status = X.getGameStatus(game.board, opponent);
      move.check = status.inCheck;
      move.gameOver = status.over;
      if (status.over) {
        game.extraMove = null;
        this.finish(game, { winner: status.winner, reason: status.reason, by: color });
      } else {
        this.save(game);
        this.broadcast(game);
        this.addChat(game, null, '一鼓作气：本回合还可再走一步。', 'system', false);
        if (game[game.turn]?.type === 'ai') {
          this.enqueue(game, game.turn, {
            type: 'extra_step',
            title: '一鼓作气',
            text: '你还有一步可以走，请继续落子。',
          });
        }
      }
      return { ok: true, move, game };
    }
    if (extra) game.extraMove = null;

    this.tickFrozen(game, color);
    game.turn = opponent;

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
    const hostAIDuel = !!user
      && game.creatorId === user.id
      && (game.mode === 'aivai' || game.mode === 'aiskill');
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
    if (triggerAI && game.status === 'playing' && (role === 'player' || hostAIDuel)) {
      [X.RED, X.BLACK].forEach((c) => {
        if (game[c]?.type === 'ai') {
          this.enqueue(game, c, {
            type: 'chat',
            title: hostAIDuel ? '房主发来消息' : '收到对手消息',
            text: hostAIDuel ? `房主 ${name}：${body}` : `${name}：${body}`,
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
    if ((game.mode === 'aivai' || game.mode === 'aiskill') && game.creatorId === user.id) {
      this.finish(game, { winner: null, reason: 'stopped', by: null });
      return { ok: true, game };
    }
    return { ok: false, error: '你无权结束本局' };
  }

  pause(game, user) {
    if (game.mode !== 'aivai' && game.mode !== 'aiskill') return { ok: false, error: '只有 AI 对 AI 对局可以暂停' };
    if (game.creatorId !== user.id) return { ok: false, error: '只有创建者可以暂停' };
    if (game.status !== 'playing') return { ok: false, error: '对局不在进行中' };
    game.paused = true;
    this.save(game);
    this.broadcast(game);
    return { ok: true, game };
  }

  resume(game, user) {
    if (game.mode !== 'aivai' && game.mode !== 'aiskill') return { ok: false, error: '只有 AI 对 AI 对局可以暂停' };
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

  isAIDuelRulesMode(game) {
    return game.mode === 'aiskill' || (game.mode === 'skill' && !!game.aiOpponent);
  }

  updateAIDuelRules(game, user, payload) {
    if (!this.isAIDuelRulesMode(game)) return { ok: false, error: '该模式不支持调整规则' };
    if (game.creatorId !== user.id) return { ok: false, error: '只有房主可以调整规则' };
    if (game.status !== 'playing') return { ok: false, error: '对局不在进行中' };
    const current = game.aiSkillConfig || { initialPoints: AI_SKILL_POINTS, captureReward: CAPTURE_REWARD };
    const initialPoints = clampInt(payload?.aiInitialPoints, current.initialPoints, 0, 10000);
    const captureReward = clampInt(payload?.aiCaptureReward, current.captureReward, 0, 1000);
    const delta = initialPoints - (Number(current.initialPoints) || AI_SKILL_POINTS);
    game.aiPoints = game.aiPoints || {};
    if (delta) {
      [X.RED, X.BLACK].forEach((color) => {
        if (game[color]?.type !== 'ai') return;
        game.aiPoints[color] = Math.max(0, (Number(game.aiPoints[color]) || 0) + delta);
      });
    }
    game.aiSkillConfig = { initialPoints, captureReward };
    this.addChat(
      game,
      null,
      `房主调整规则：AI 初始积分 ${initialPoints}，AI 每吃一子 +${captureReward} 积分。`,
      'system',
      false,
    );
    [X.RED, X.BLACK].forEach((color) => {
      if (game[color]?.type !== 'ai') return;
      this.enqueue(game, color, {
        type: 'rules',
        title: '房主调整规则',
        text: `房主调整了对局规则：AI 初始积分 ${initialPoints}，每次吃子 +${captureReward} 积分。你当前有 ${game.aiPoints[color]} 积分。`,
      });
    });
    this.save(game);
    this.broadcast(game);
    return { ok: true, config: { ...game.aiSkillConfig }, aiPoints: { ...game.aiPoints } };
  }

  giftPoints(game, user, payload) {
    if (game.mode !== 'aiskill') return { ok: false, error: '只有双 AI 技能博弈可以给 AI 发积分' };
    if (game.creatorId !== user.id) return { ok: false, error: '只有房主可以给 AI 发积分' };
    if (game.status !== 'playing') return { ok: false, error: '对局不在进行中' };
    const color = String(payload?.color || '');
    if (![X.RED, X.BLACK].includes(color) || game[color]?.type !== 'ai') {
      return { ok: false, error: '请选择一位 AI 棋手' };
    }
    const amount = Math.floor(Number(payload?.amount));
    if (!Number.isFinite(amount) || amount < 1) return { ok: false, error: '请输入大于 0 的积分' };
    if (amount > 100000) return { ok: false, error: '单次赠送积分过大' };
    const balance = Math.max(0, Number(user.points) || 0);
    if (balance < amount) return { ok: false, error: `你的积分不足，当前只有 ${balance} 分` };
    user.points = balance - amount;
    game.aiPoints = game.aiPoints || {};
    game.aiPoints[color] = Math.max(0, Number(game.aiPoints[color]) || 0) + amount;
    game.pointGifts = game.pointGifts || [];
    game.pointGifts.push({
      id: crypto.randomBytes(4).toString('hex'),
      color,
      amount,
      userId: user.id,
      at: nowIso(),
    });
    this.store.save();
    this.save(game);
    this.broadcast(game);
    this.addTrace(game, color, {
      type: 'gift',
      title: '房主赞助',
      text: `房主用个人积分转入 ${amount} 分，你现在有 ${game.aiPoints[color]} 分。`,
    }, false);
    this.enqueue(game, color, {
      type: 'gift',
      title: '收到房主积分',
      text: `房主从自己的积分中转入 ${amount} 分给你，你现在有 ${game.aiPoints[color]} 分，可用于购买卡牌。这条消息只有你收到。`,
    });
    return { ok: true, color, amount, points: game.aiPoints[color] };
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
      traps: (game.traps || []).map((trap) => ({ ...trap })),
      extraMove: game.extraMove ? { ...game.extraMove } : null,
    });
    if (game.undoStack.length > 4) game.undoStack.splice(0, game.undoStack.length - 4);
  }

  tickFrozen(game, color) {
    for (let row = 0; row < 10; row += 1) {
      for (let col = 0; col < 9; col += 1) {
        const piece = game.board[row][col];
        if (!piece || piece.color !== color || !piece.frozen) continue;
        piece.frozen -= 1;
        if (piece.frozen <= 0) delete piece.frozen;
      }
    }
  }

  capturedPiecesFor(game, color) {
    const out = [];
    (game.history || []).forEach((move) => {
      if (move.color !== color) {
        if (move.captured && move.captured.color === color) out.push({ ...move.captured });
        (move.capturedList || []).forEach((piece) => {
          if (piece.color === color) out.push({ ...piece });
        });
      }
      if (move.trapKilled && move.trapKilled.color === color) out.push({ ...move.trapKilled });
    });
    (game.extraCaptures || []).forEach((piece) => {
      if (piece.color === color) out.push({ ...piece });
    });
    (game.revived || []).forEach((item) => {
      if (item.color !== color) return;
      const index = out.findIndex((piece) => piece.type === item.type);
      if (index >= 0) out.splice(index, 1);
    });
    return out;
  }

  triggerTrap(game, to, color) {
    const coord = X.posToCoord(to.row, to.col);
    const traps = game.traps || [];
    const index = traps.findIndex((trap) => trap.coord === coord);
    if (index < 0) return null;
    const trap = traps[index];
    if (trap.color === color) return null;
    const piece = game.board[to.row][to.col];
    if (!piece) return null;
    traps.splice(index, 1);
    let result;
    if (piece.type === 'K') {
      result = { trap, survived: true, king: true };
    } else if (this.shieldCount(game, piece.id) > 0) {
      this.breakShield(game, piece);
      result = { trap, survived: true, shield: true, target: X.pieceName(piece) };
    } else {
      game.board[to.row][to.col] = null;
      this.clearShield(game, piece.id);
      result = {
        trap,
        survived: false,
        killed: { type: piece.type, color: piece.color, name: X.pieceName(piece) },
        target: X.pieceName(piece),
      };
    }
    this.emit(game, 'game:trap', { gameId: game.id, coord, color, trapColor: trap.color, ...result });
    if (result.killed) this.awardCaptures(game, trap.color, 1, '地雷');
    return result;
  }

  trapText(result) {
    if (!result) return '';
    if (result.killed) return `${result.killed.name} 踩中地雷被炸毁。`;
    if (result.king) return `${result.target} 踏入雷区，地雷被排除。`;
    if (result.shield) return `${result.target} 的护盾挡下了地雷。`;
    return '';
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

  commitSkill(game, user, color, card, entry, keepTurn = false, options = {}) {
    this.consumeCard(user, card.id);
    if (!keepTurn) {
      this.tickFrozen(game, color);
      game.turn = color === X.RED ? X.BLACK : X.RED;
    }
    game.skills = game.skills || [];
    game.skills.push(entry);
    const status = X.getGameStatus(game.board, game.turn);
    this.save(game);
    this.emit(game, 'game:skill', { gameId: game.id, entry });
    if (!options.silent) {
      this.addChat(
        game,
        null,
        `${game[color].name} 发动「${card.name}」${entry.summary ? `：${entry.summary}` : ''}`,
        'system',
        false,
      );
    }
    if (status.over) {
      this.finish(game, { winner: status.winner, reason: status.reason, by: color });
    } else {
      this.broadcast(game);
      if (status.inCheck) this.addChat(game, null, `${X.SIDE_NAMES[game.turn]}被将军。`, 'system', false);
      if (game[game.turn]?.type === 'ai') {
        this.enqueue(game, game.turn, {
          type: 'skill_turn',
          title: '技能结算',
          text: `${game[color].name} 使用「${card.name}」${entry.summary ? `：${entry.summary}` : ''}。现在轮到你，请查看棋盘并落子。`,
        });
      }
    }
    return {
      ok: true,
      skill: entry,
      cards: { ...user.cards },
      state: this.toState(game),
    };
  }

  useSkill(game, user, payload) {
    if (!isSkillMode(game.mode)) return { ok: false, error: '只有技能对弈可以使用卡牌' };
    if (game.status !== 'playing') return { ok: false, error: '对局不在进行中' };
    if (game.paused) return { ok: false, error: '对局已暂停' };
    const color = this.colorForUser(game, user.id);
    if (!color) return { ok: false, error: '你不是本局棋手' };
    if (game[color].type !== 'human') return { ok: false, error: '该席位不是人类棋手' };
    const requested = cardById(String(payload?.cardId || ''));
    if (game.turn !== color) {
      const last = game.history[game.history.length - 1];
      const opponent = color === X.RED ? X.BLACK : X.RED;
      const preUndo = requested?.id === 'undo'
        && !!last
        && last.color === color
        && game[opponent]?.type === 'ai';
      if (!preUndo) return { ok: false, error: '还没有轮到你' };
    }
    if (game.extraMove && game.extraMove.color === color) {
      return { ok: false, error: '一鼓作气生效期间请先完成两步落子' };
    }
    return this.resolveSkill(game, user, color, payload);
  }

  aiUseSkill(game, color, payload) {
    if (!isSkillMode(game.mode)) return { ok: false, error: '只有技能对弈可以使用卡牌' };
    if (game.status !== 'playing') return { ok: false, error: '对局不在进行中' };
    if (game.paused) return { ok: false, error: '对局已暂停' };
    if (game[color]?.type !== 'ai') return { ok: false, error: '该席位不是 AI' };
    if (game.turn !== color) return { ok: false, error: '还没有轮到你' };
    if (game.extraMove && game.extraMove.color === color) {
      return { ok: false, error: '一鼓作气生效期间请先完成两步落子' };
    }
    const holder = { cards: (game.aiCards || {})[color] || {} };
    return this.resolveSkill(game, holder, color, payload);
  }

  aiBuyCard(game, color, payload) {
    if (!isSkillMode(game.mode)) return { ok: false, error: '只有技能对弈可以购买卡牌' };
    if (game.status !== 'playing') return { ok: false, error: '对局不在进行中' };
    if (game.paused) return { ok: false, error: '对局已暂停' };
    if (game[color]?.type !== 'ai') return { ok: false, error: '该席位不是 AI' };
    if (game.turn !== color) return { ok: false, error: '只能在你的回合购买卡牌' };
    const card = cardById(String(payload?.cardId || ''));
    if (!card) return { ok: false, error: '未知卡牌' };
    const raw = Number(payload?.count);
    const count = Number.isFinite(raw) ? Math.max(1, Math.min(2, Math.floor(raw))) : 1;
    const cost = card.price * count;
    game.aiPoints = game.aiPoints || {};
    const points = Math.max(0, Number(game.aiPoints[color]) || 0);
    if (points < cost) {
      return { ok: false, error: `积分不足，需要 ${cost} 分，你只有 ${points} 分` };
    }
    game.aiPoints[color] = points - cost;
    game.aiCards = game.aiCards || {};
    game.aiCards[color] = game.aiCards[color] || {};
    game.aiCards[color][card.id] = Math.max(0, Number(game.aiCards[color][card.id]) || 0) + count;
    this.save(game);
    this.addAIMessage(
      game,
      color,
      `花费 ${cost} 积分购入「${card.name}」×${count}，剩余 ${game.aiPoints[color]} 积分。`,
    );
    this.broadcast(game);
    return {
      ok: true,
      card,
      count,
      cost,
      points: game.aiPoints[color],
      cards: { ...game.aiCards[color] },
    };
  }

  resolveSkill(game, user, color, payload) {
    const cardId = String(payload?.cardId || '');
    const card = cardById(cardId);
    if (!card) return { ok: false, error: '未知卡牌' };
    user.cards = user.cards || {};
    if (Math.max(0, Number(user.cards[cardId]) || 0) <= 0) {
      return { ok: false, error: '你还没有这张卡牌' };
    }
    game.shields = game.shields || {};

    if (card.mode === 'instant') {
      if (cardId === 'undo') return this.useUndo(game, user, card, color);
      if (cardId === 'extra') return this.useExtra(game, user, card, color);
      if (cardId === 'scout') return this.useScout(game, user, card, color);
      return { ok: false, error: '这张卡牌暂未开放' };
    }
    if (card.mode === 'square') {
      if (cardId === 'wall') return this.useWall(game, user, card, color, payload);
      if (cardId === 'mine') return this.useMine(game, user, card, color, payload);
      if (cardId === 'drop') return this.useDrop(game, user, card, color, payload);
      return { ok: false, error: '这张卡牌暂未开放' };
    }
    if (card.mode === 'revive') {
      return this.useRevive(game, user, card, color, payload);
    }

    if (card.mode === 'enemy-apply') {
      const from = X.coordToPos(String(payload?.from || '').toLowerCase());
      if (!from) return { ok: false, error: '请选择一枚敌方棋子' };
      const piece = game.board[from.row][from.col];
      if (!piece || piece.color === color || !card.pieceTypes.includes(piece.type)) {
        return { ok: false, error: `「${card.name}」不能对这枚棋子使用` };
      }
      if (cardId === 'freeze') return this.useFreeze(game, user, card, color, piece, from);
      if (cardId === 'conspire') return this.useConspire(game, user, card, color, piece, from);
      if (cardId === 'fire') return this.useFire(game, user, card, color, piece, from);
      return { ok: false, error: '这张卡牌暂未开放' };
    }

    const from = X.coordToPos(String(payload?.from || '').toLowerCase());
    if (!from) return { ok: false, error: '请先选择一枚己方棋子' };
    const piece = game.board[from.row][from.col];
    if (!piece || piece.color !== color || !card.pieceTypes.includes(piece.type)) {
      return { ok: false, error: `「${card.name}」不能对这枚棋子使用` };
    }
    if (Number(piece.frozen) > 0 && ['piece', 'ray', 'swap'].includes(card.mode)) {
      return { ok: false, error: '这枚棋子被定身，不能移动' };
    }
    if (card.mode === 'apply') {
      if (cardId === 'shield') return this.useShield(game, user, card, color, piece, from);
      if (cardId === 'water') return this.useWater(game, user, card, color, piece, from);
      return { ok: false, error: '这张卡牌暂未开放' };
    }
    if (card.mode === 'swap') {
      const to = X.coordToPos(String(payload?.to || '').toLowerCase());
      if (!to) return { ok: false, error: '请选择另一枚己方棋子' };
      const other = game.board[to.row][to.col];
      if (!other || other.color !== color || !card.pieceTypes.includes(other.type)) {
        return { ok: false, error: '移形换位需要选择两枚己方非将棋子' };
      }
      if (Number(other.frozen) > 0) {
        return { ok: false, error: '被定身的棋子不能移动' };
      }
      return this.useSwap(game, user, card, color, piece, from, other, to);
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
      case 'borrow':
        return this.useBorrow(game, user, card, color, piece, from, to);
      case 'royal':
        return this.useRoyal(game, user, card, color, piece, from, to);
      case 'guard':
        return this.useGuard(game, user, card, color, piece, from, to);
      default:
        return { ok: false, error: '这张卡牌暂未开放' };
    }
  }

  useShield(game, user, card, color, piece, from) {
    if (X.isInCheck(game.board, color)) return { ok: false, error: '你正被将军，必须先解将' };
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
    if (X.isInCheck(game.board, color)) return { ok: false, error: '你正被将军，必须先解将' };
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

  useMine(game, user, card, color, payload) {
    if (X.isInCheck(game.board, color)) return { ok: false, error: '你正被将军，必须先解将' };
    const to = X.coordToPos(String(payload?.to || '').toLowerCase());
    if (!to) return { ok: false, error: '请选择一个空位埋雷' };
    if (game.board[to.row][to.col]) return { ok: false, error: '该位置已有棋子' };
    const coord = X.posToCoord(to.row, to.col);
    game.traps = game.traps || [];
    if (game.traps.some((trap) => trap.coord === coord)) {
      return { ok: false, error: '这里已经有一枚地雷' };
    }
    game.traps.push({
      id: `mine_${crypto.randomBytes(4).toString('hex')}`,
      coord,
      row: to.row,
      col: to.col,
      color,
      at: nowIso(),
    });
    const entry = this.makeSkillEntry(color, card, {
      to: coord,
      summary: `在 ${coord} 埋下地雷`,
    });
    return this.commitSkill(game, user, color, card, entry);
  }

  useDrop(game, user, card, color, payload) {
    const to = X.coordToPos(String(payload?.to || '').toLowerCase());
    if (!to) return { ok: false, error: '请选择对方半场的空位' };
    if (game.board[to.row][to.col]) return { ok: false, error: '该位置已有棋子' };
    const enemyHalf = color === X.RED ? to.row < 5 : to.row > 4;
    if (!enemyHalf) return { ok: false, error: '奇兵只能空投到对方半场' };
    const coord = X.posToCoord(to.row, to.col);
    if ((game.traps || []).some((trap) => trap.coord === coord)) {
      return { ok: false, error: '该位置埋有地雷，换个落点吧' };
    }
    const test = X.cloneBoard(game.board);
    test[to.row][to.col] = { color, type: 'P', id: 'preview' };
    if (X.isInCheck(test, color)) return { ok: false, error: '空投后己方被将军，换个位置吧' };
    game.board[to.row][to.col] = {
      color,
      type: 'P',
      id: `drop_${crypto.randomBytes(4).toString('hex')}`,
    };
    const entry = this.makeSkillEntry(color, card, {
      to: coord,
      summary: `在 ${coord} 空投一枚${color === X.RED ? '兵' : '卒'}`,
    });
    return this.commitSkill(game, user, color, card, entry);
  }

  useFreeze(game, user, card, color, piece, from) {
    if (X.isInCheck(game.board, color)) return { ok: false, error: '你正被将军，必须先解将' };
    if (piece.frozen) return { ok: false, error: '这枚棋子已经被定身' };
    piece.frozen = 1;
    const entry = this.makeSkillEntry(color, card, {
      from: X.posToCoord(from.row, from.col),
      targetId: piece.id,
      targetName: X.pieceName(piece),
      summary: `定住 ${X.pieceName(piece)} 一回合`,
    });
    return this.commitSkill(game, user, color, card, entry);
  }

  useConspire(game, user, card, color, piece, from) {
    piece.color = color;
    if (X.isInCheck(game.board, color)) {
      piece.color = color === X.RED ? X.BLACK : X.RED;
      return { ok: false, error: '策反后己方仍被将军，换个目标吧' };
    }
    delete piece.frozen;
    delete piece.water;
    this.clearShield(game, piece.id);
    const entry = this.makeSkillEntry(color, card, {
      from: X.posToCoord(from.row, from.col),
      targetId: piece.id,
      targetName: X.pieceName(piece),
      summary: `策反了 ${X.pieceName(piece)}`,
    });
    return this.commitSkill(game, user, color, card, entry);
  }

  useFire(game, user, card, color, piece, from) {
    const cells = [{ row: from.row, col: from.col }];
    adjacentOrtho(from).forEach((pos) => {
      const target = game.board[pos.row][pos.col];
      if (target && target.color !== color && target.type === 'P') cells.push(pos);
    });
    const destroyed = [];
    const shielded = [];
    cells.forEach((pos) => {
      const target = game.board[pos.row][pos.col];
      if (!target || target.type === 'K') return;
      if (this.shieldCount(game, target.id) > 0) shielded.push({ pos, target });
      else destroyed.push({ pos, target });
    });
    const test = X.cloneBoard(game.board);
    destroyed.forEach(({ pos }) => { test[pos.row][pos.col] = null; });
    if (X.isInCheck(test, color)) return { ok: false, error: '火攻会让己方被将军，换个目标吧' };
    destroyed.forEach(({ pos, target }) => {
      game.board[pos.row][pos.col] = null;
      this.clearShield(game, target.id);
      game.extraCaptures = game.extraCaptures || [];
      game.extraCaptures.push({ by: color, type: target.type, color: target.color, name: X.pieceName(target) });
    });
    shielded.forEach(({ target }) => this.breakShield(game, target));
    if (destroyed.length) this.awardCaptures(game, color, destroyed.length, '火攻');
    const entry = this.makeSkillEntry(color, card, {
      from: X.posToCoord(from.row, from.col),
      captured: destroyed.map(({ pos, target }) => ({
        coord: X.posToCoord(pos.row, pos.col),
        name: X.pieceName(target),
        type: target.type,
        color: target.color,
      })),
      blockedShields: shielded.map(({ pos, target }) => ({
        coord: X.posToCoord(pos.row, pos.col),
        name: X.pieceName(target),
      })),
      summary: `烧毁 ${destroyed.length} 枚棋子`,
    });
    return this.commitSkill(game, user, color, card, entry);
  }

  useRevive(game, user, card, color, payload) {
    const type = String(payload?.reviveType || '').toUpperCase();
    const allowed = ['P', 'A', 'E', 'H', 'R', 'C'];
    if (!allowed.includes(type)) return { ok: false, error: '这枚棋子无法招魂' };
    const captured = this.capturedPiecesFor(game, color);
    if (!captured.some((piece) => piece.type === type)) {
      return { ok: false, error: '本局没有可招魂的该种棋子' };
    }
    const to = X.coordToPos(String(payload?.to || '').toLowerCase());
    if (!to) return { ok: false, error: '请选择己方半场的空位' };
    if (game.board[to.row][to.col]) return { ok: false, error: '该位置已有棋子' };
    const ownHalf = color === X.RED ? to.row >= 5 : to.row <= 4;
    if (!ownHalf) return { ok: false, error: '招魂只能复活在己方半场' };
    const coord = X.posToCoord(to.row, to.col);
    if ((game.traps || []).some((trap) => trap.coord === coord)) {
      return { ok: false, error: '该位置埋有地雷，换个落点吧' };
    }
    const test = X.cloneBoard(game.board);
    test[to.row][to.col] = { color, type, id: 'preview' };
    if (X.isInCheck(test, color)) return { ok: false, error: '复活后己方被将军，换个位置吧' };
    const revivedPiece = {
      color,
      type,
      id: `revive_${crypto.randomBytes(4).toString('hex')}`,
    };
    game.board[to.row][to.col] = revivedPiece;
    game.revived = game.revived || [];
    game.revived.push({ color, type, at: nowIso() });
    const entry = this.makeSkillEntry(color, card, {
      to: coord,
      reviveType: type,
      summary: `在 ${coord} 复活${X.pieceName(revivedPiece)}`,
    });
    return this.commitSkill(game, user, color, card, entry);
  }

  useSwap(game, user, card, color, piece, from, other, to) {
    if (from.row === to.row && from.col === to.col) {
      return { ok: false, error: '请选择两枚不同的棋子' };
    }
    const test = X.cloneBoard(game.board);
    test[to.row][to.col] = test[from.row][from.col];
    test[from.row][from.col] = game.board[to.row][to.col];
    if (X.isInCheck(test, color)) return { ok: false, error: '交换后己方被将军，换个组合吧' };
    game.board[to.row][to.col] = piece;
    game.board[from.row][from.col] = other;
    const entry = this.makeSkillEntry(color, card, {
      from: X.posToCoord(from.row, from.col),
      to: X.posToCoord(to.row, to.col),
      summary: `${X.pieceName(piece)} 与 ${X.pieceName(other)} 交换位置`,
    });
    return this.commitSkill(game, user, color, card, entry);
  }

  opponentCardsFor(game, color) {
    const opponent = color === X.RED ? X.BLACK : X.RED;
    const seat = game[opponent];
    if (seat?.type === 'ai') return game.aiCards?.[opponent] || {};
    if (seat?.type === 'human' && seat.userId) {
      const user = this.store.userById(seat.userId);
      return user?.cards || {};
    }
    return {};
  }

  cardListText(cards) {
    const entries = Object.entries(cards || {})
      .filter(([, count]) => Number(count) > 0)
      .map(([id, count]) => {
        const card = cardById(id);
        return `${card ? card.name : id}×${count}`;
      });
    return entries.length ? entries.join('、') : '无卡牌';
  }

  useScout(game, user, card, color) {
    const opponent = color === X.RED ? X.BLACK : X.RED;
    const reveal = `${X.SIDE_NAMES[opponent]}当前卡牌：${this.cardListText(this.opponentCardsFor(game, color))}`;
    const entry = this.makeSkillEntry(color, card, {
      summary: `探查了${X.SIDE_NAMES[opponent]}的当前卡牌（内容仅自己可见）`,
    });
    const result = this.commitSkill(game, user, color, card, entry, true, { silent: true });
    if (!result.ok) return result;
    return { ...result, reveal };
  }

  useExtra(game, user, card, color) {
    game.extraMove = { color, pending: 1 };
    const entry = this.makeSkillEntry(color, card, {
      summary: '本回合可以连续落子两次',
    });
    return this.commitSkill(game, user, color, card, entry, true);
  }

  useBorrow(game, user, card, color, piece, from, to) {
    const target = borrowTargets(game.board, from, color)
      .find((item) => item.row === to.row && item.col === to.col);
    if (!target) return { ok: false, error: '借东风需要直线无遮挡地瞄准敌方棋子' };
    return this.performSkillMove(game, user, card, color, piece, from, to, target.piece);
  }

  useRoyal(game, user, card, color, piece, from, to) {
    const target = royalTargets(game.board, from, color)
      .find((item) => item.row === to.row && item.col === to.col);
    if (!target) return { ok: false, error: '将/帅只能在九宫格内横竖移动' };
    return this.performSkillMove(game, user, card, color, piece, from, to, target.piece || null);
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
    game.traps = (snapshot.traps || []).map((trap) => ({ ...trap }));
    game.extraMove = null;
    game.undoStack = stack.slice(0, stack.length - count);
    const opponent = color === X.RED ? X.BLACK : X.RED;
    if (game[opponent]?.type === 'ai' && this.planner) {
      if (typeof this.planner.cancel === 'function') this.planner.cancel(game, opponent);
      this.setAIStatus(game, opponent, 'idle', '');
    }
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
    if (captured) {
      this.clearShield(game, captured.id);
      this.awardCaptures(game, color, 1, card.name);
    }
    const trapResult = this.triggerTrap(game, to, color);
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
      trapKilled: trapResult?.killed || null,
      trapOwner: trapResult?.trap?.color || null,
      notation,
      actor: 'skill',
      skill: card.id,
      at: nowIso(),
    };
    game.history.push(move);
    game.lastMove = { from: move.from, to: move.to, color, at: move.at };
    if (trapResult) this.addChat(game, null, this.trapText(trapResult), 'system', false);
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
    // 墙可以抵挡大运：射线在墙前中止，无法越过墙体
    const wallIndex = path.findIndex((cell) => game.board[cell.row][cell.col]?.type === 'W');
    if (wallIndex >= 0 && wallIndex < path.length - 1) {
      return { ok: false, error: '大运被墙挡住了，只能打到墙前' };
    }
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
    if (capturable.length) this.awardCaptures(game, color, capturable.length, '大运');
    const rook = game.board[from.row][from.col];
    game.board[to.row][to.col] = rook;
    game.board[from.row][from.col] = null;
    const trapResult = this.triggerTrap(game, to, color);

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
      trapKilled: trapResult?.killed || null,
      trapOwner: trapResult?.trap?.color || null,
      notation,
      actor: 'skill',
      skill: card.id,
      at: nowIso(),
    };
    game.history.push(move);
    game.lastMove = { from: move.from, to: move.to, color, at: move.at };
    if (trapResult) this.addChat(game, null, this.trapText(trapResult), 'system', false);
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
      aiOpponent: !!game.aiOpponent,
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
      aiOpponent: !!game.aiOpponent,
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
      traps: game.traps || [],
      revived: game.revived || [],
      extraCaptures: game.extraCaptures || [],
      extraMove: game.extraMove || null,
      aiCards: game.aiCards || {},
      aiPoints: game.aiPoints || {},
      aiSkillConfig: game.aiSkillConfig || null,
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
  AI_SKILL_POINTS,
  CAPTURE_REWARD,
  AI_NAMES,
  REASON_TEXT,
};
