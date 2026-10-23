'use strict';

const X = require('./xiangqi');

const SKILL_CARDS = [
  {
    id: 'dayun',
    name: '大运',
    rarity: '传说',
    price: 80,
    description: '对你的一枚车使用：选择一条射线方向，吃掉该射线上所有敌方棋子（将/帅除外）。使用后本回合结束。',
  },
];

const DIRECTIONS = {
  up: { label: '上', dr: -1, dc: 0 },
  down: { label: '下', dr: 1, dc: 0 },
  left: { label: '左', dr: 0, dc: -1 },
  right: { label: '右', dr: 0, dc: 1 },
};

function cardById(id) {
  return SKILL_CARDS.find((card) => card.id === id) || null;
}

function rayCells(from, dir) {
  const cells = [];
  let row = from.row + dir.dr;
  let col = from.col + dir.dc;
  while (X.inside(row, col)) {
    cells.push({ row, col });
    row += dir.dr;
    col += dir.dc;
  }
  return cells;
}

function dayunTargets(board, from, dir, color) {
  const targets = [];
  rayCells(from, dir).forEach(({ row, col }) => {
    const piece = board[row][col];
    if (piece && piece.color !== color && piece.type !== 'K') {
      targets.push({ row, col, piece: { ...piece } });
    }
  });
  return targets;
}

function useDayun(board, from, dir, color) {
  const targets = dayunTargets(board, from, dir, color);
  targets.forEach(({ row, col }) => {
    board[row][col] = null;
  });
  return targets;
}

module.exports = {
  SKILL_CARDS,
  DIRECTIONS,
  cardById,
  rayCells,
  dayunTargets,
  useDayun,
};
