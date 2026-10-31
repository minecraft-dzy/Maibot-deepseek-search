'use strict';

const X = require('./xiangqi');

const SKILL_CARDS = [
  {
    id: 'dayun',
    name: '大运',
    rarity: '传说',
    price: 100,
    mode: 'ray',
    pieceTypes: ['R'],
    description: '选中自己的车，棋盘显示 8 条红色射线。点击射线上任意一点，车移动到该处，并吃掉路径上除将/帅外的所有棋子（包括己方棋子）。墙可以抵挡大运，射线会在墙前中止。',
  },
  {
    id: 'pawn',
    name: '孬兵',
    rarity: '普通',
    price: 35,
    mode: 'piece',
    pieceTypes: ['P'],
    description: '选中自己的兵/卒，可以向前后左右任意方向移动一格。',
  },
  {
    id: 'chariot',
    name: '炮车',
    rarity: '稀有',
    price: 60,
    mode: 'piece',
    pieceTypes: ['R'],
    description: '选中自己的车，以炮的吃法隔一子吃掉对方一枚棋子，并占据它的位置。',
  },
  {
    id: 'horse',
    name: '飞马',
    rarity: '稀有',
    price: 55,
    mode: 'piece',
    pieceTypes: ['H'],
    description: '选中自己的马，无视蹩马腿，按马步移动到任意可落点。',
  },
  {
    id: 'cannon',
    name: '飞炮',
    rarity: '普通',
    price: 50,
    mode: 'piece',
    pieceTypes: ['C'],
    description: '选中自己的炮，在不吃子的情况下越过一个棋子，落到它后面的空位。',
  },
  {
    id: 'water',
    name: '水象',
    rarity: '稀有',
    price: 60,
    mode: 'apply',
    pieceTypes: ['E'],
    description: '选中自己的相/象，使其本局可以越过楚河汉界行动，仍然受塞象眼限制。',
  },
  {
    id: 'chongxiang',
    name: '冲象',
    rarity: '稀有',
    price: 60,
    mode: 'piece',
    pieceTypes: ['E'],
    description: '选中自己的相/象，向前直进一格并吃掉该格上的敌方棋子；可以越过楚河汉界。',
  },
  {
    id: 'shield',
    name: '盾',
    rarity: '稀有',
    price: 45,
    mode: 'apply',
    pieceTypes: ['K', 'A', 'E', 'H', 'R', 'C', 'P', 'W'],
    description: '选中自己的一枚棋子，为它附加一次免疫吃子的护盾。可以重复叠加，护盾会显示在棋子上。护盾被普通吃子击破时，攻击方本回合立即结束，不能在同一回合再次吃这枚棋子。',
  },
  {
    id: 'undo',
    name: '落子有悔',
    rarity: '史诗',
    price: 80,
    mode: 'instant',
    description: '撤回自己最近的一步落子；如果对方已经应招，则连同对方那一步一起撤回。',
  },
  {
    id: 'guard',
    name: '勇士',
    rarity: '普通',
    price: 45,
    mode: 'piece',
    pieceTypes: ['A'],
    description: '选中自己的士，在己方九宫格内任意移动，可以吃掉宫内的敌方棋子。',
  },
  {
    id: 'wall',
    name: '墙',
    rarity: '稀有',
    price: 55,
    mode: 'square',
    description: '在任意空位生成一枚不能移动的墙。墙会阻挡车炮、蹩马腿，也能抵挡大运的射线，还可以被对方吃掉。',
  },
  {
    id: 'freeze',
    name: '定身符',
    rarity: '稀有',
    price: 55,
    mode: 'enemy-apply',
    pieceTypes: ['A', 'E', 'H', 'R', 'C', 'P'],
    description: '指定敌方一枚非将棋子，使其下一次行动不能移动；它仍然会攻击周围，只是不能走动。',
  },
  {
    id: 'drop',
    name: '奇兵天降',
    rarity: '史诗',
    price: 90,
    mode: 'square',
    description: '在对方半场任意空位空投一枚己方兵/卒，立刻形成新的进攻点。',
  },
  {
    id: 'borrow',
    name: '借东风',
    rarity: '稀有',
    price: 65,
    mode: 'piece',
    pieceTypes: ['C'],
    description: '选中自己的炮，本次无视炮架，吃掉一条直线上没有遮挡的敌方棋子。',
  },
  {
    id: 'extra',
    name: '一鼓作气',
    rarity: '传说',
    price: 150,
    mode: 'instant',
    description: '本回合可以连续落子两次。使用后不能再使用其他卡牌，第二步不能直接吃掉将/帅。',
  },
  {
    id: 'revive',
    name: '招魂',
    rarity: '史诗',
    price: 100,
    mode: 'revive',
    description: '从本局已被吃掉的己方棋子中选一枚，在己方半场空位复活；将/帅除外。',
  },
  {
    id: 'conspire',
    name: '策反',
    rarity: '史诗',
    price: 80,
    mode: 'enemy-apply',
    pieceTypes: ['P'],
    description: '指定敌方一枚兵/卒，将其变为己方棋子，位置不变。',
  },
  {
    id: 'swap',
    name: '移形换位',
    rarity: '史诗',
    price: 90,
    mode: 'swap',
    pieceTypes: ['A', 'E', 'H', 'R', 'C', 'P', 'W'],
    description: '选择己方两枚非将棋子交换位置，交换后不能让自己被将军。',
  },
  {
    id: 'mine',
    name: '地雷',
    rarity: '稀有',
    price: 60,
    mode: 'square',
    description: '在任意空位埋下一枚可见的地雷。敌方非将棋子首次踏入会被炸毁；将/帅踏入只排雷。',
  },
  {
    id: 'fire',
    name: '火攻',
    rarity: '史诗',
    price: 110,
    mode: 'enemy-apply',
    pieceTypes: ['A', 'E', 'H', 'R', 'C', 'P', 'W'],
    description: '烧毁敌方一枚非将棋子，并烧毁它上下左右相邻的敌方兵/卒。',
  },
  {
    id: 'royal',
    name: '御驾亲征',
    rarity: '史诗',
    price: 100,
    mode: 'piece',
    pieceTypes: ['K'],
    description: '将/帅像车一样在九宫格内横竖移动并吃子，走完不能让自己被将军。',
  },
];

const RAY_DIRS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

const HORSE_OFFSETS = [
  [-2, -1], [-2, 1], [2, -1], [2, 1],
  [-1, -2], [1, -2], [-1, 2], [1, 2],
];

const ORTHO = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function cardById(id) {
  return SKILL_CARDS.find((card) => card.id === id) || null;
}

function rayPath(from, to) {
  if (!from || !to) return null;
  const dr = Math.sign(to.row - from.row);
  const dc = Math.sign(to.col - from.col);
  if (!dr && !dc) return null;
  if (dr && dc && Math.abs(to.row - from.row) !== Math.abs(to.col - from.col)) return null;
  if (dr && !dc && from.col !== to.col) return null;
  if (!dr && dc && from.row !== to.row) return null;
  const cells = [];
  let row = from.row + dr;
  let col = from.col + dc;
  while (true) {
    cells.push({ row, col });
    if (row === to.row && col === to.col) break;
    row += dr;
    col += dc;
    if (!X.inside(row, col)) return null;
  }
  return cells;
}

function rayCells(from) {
  const cells = [];
  RAY_DIRS.forEach(([dr, dc]) => {
    let row = from.row + dr;
    let col = from.col + dc;
    while (X.inside(row, col)) {
      cells.push({ row, col });
      row += dr;
      col += dc;
    }
  });
  return cells;
}

function horseTargets(from) {
  return HORSE_OFFSETS
    .map(([dr, dc]) => ({ row: from.row + dr, col: from.col + dc }))
    .filter((pos) => X.inside(pos.row, pos.col));
}

function palaceCoords(color) {
  const rows = color === X.RED ? [7, 8, 9] : [0, 1, 2];
  const coords = [];
  rows.forEach((row) => {
    for (let col = 3; col <= 5; col += 1) coords.push({ row, col });
  });
  return coords;
}

function cannonCaptureTargets(board, from, color) {
  const targets = [];
  ORTHO.forEach(([dr, dc]) => {
    let row = from.row + dr;
    let col = from.col + dc;
    let screen = false;
    while (X.inside(row, col)) {
      const piece = board[row][col];
      if (!screen) {
        if (piece) screen = true;
      } else if (piece) {
        if (piece.color !== color) targets.push({ row, col, piece: { ...piece } });
        break;
      }
      row += dr;
      col += dc;
    }
  });
  return targets;
}

function cannonJumpTargets(board, from) {
  const targets = [];
  ORTHO.forEach(([dr, dc]) => {
    let row = from.row + dr;
    let col = from.col + dc;
    let screen = false;
    while (X.inside(row, col)) {
      const piece = board[row][col];
      if (!screen) {
        if (piece) screen = true;
      } else if (piece) {
        break;
      } else {
        targets.push({ row, col });
      }
      row += dr;
      col += dc;
    }
  });
  return targets;
}

function adjacentOrtho(from) {
  return ORTHO
    .map(([dr, dc]) => ({ row: from.row + dr, col: from.col + dc }))
    .filter((pos) => X.inside(pos.row, pos.col));
}

function borrowTargets(board, from, color) {
  const targets = [];
  ORTHO.forEach(([dr, dc]) => {
    let row = from.row + dr;
    let col = from.col + dc;
    while (X.inside(row, col)) {
      const piece = board[row][col];
      if (piece) {
        if (piece.color !== color) targets.push({ row, col, piece: { ...piece } });
        break;
      }
      row += dr;
      col += dc;
    }
  });
  return targets;
}

function royalTargets(board, from, color) {
  const palace = new Set(palaceCoords(color).map((pos) => `${pos.row},${pos.col}`));
  const targets = [];
  ORTHO.forEach(([dr, dc]) => {
    let row = from.row + dr;
    let col = from.col + dc;
    while (palace.has(`${row},${col}`)) {
      const piece = board[row][col];
      if (piece) {
        if (piece.color !== color) targets.push({ row, col, piece: { ...piece } });
        break;
      }
      targets.push({ row, col });
      row += dr;
      col += dc;
    }
  });
  return targets;
}

function chongxiangTarget(board, from, color) {
  if (!from) return null;
  const dr = color === X.RED ? -1 : 1;
  const row = from.row + dr;
  const col = from.col;
  if (!X.inside(row, col)) return null;
  const piece = board[row][col];
  if (!piece || piece.color === color) return null;
  return { row, col, piece: { ...piece } };
}

const SKILL_MODES = new Set(['skill', 'aiskill']);

function isSkillMode(mode) {
  return SKILL_MODES.has(mode);
}

module.exports = {
  SKILL_CARDS,
  SKILL_MODES,
  isSkillMode,
  RAY_DIRS,
  HORSE_OFFSETS,
  ORTHO,
  cardById,
  rayPath,
  rayCells,
  horseTargets,
  palaceCoords,
  cannonCaptureTargets,
  cannonJumpTargets,
  adjacentOrtho,
  chongxiangTarget,
  borrowTargets,
  royalTargets,
};
