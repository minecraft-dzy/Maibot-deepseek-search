'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../src/game/xiangqi');

function emptyBoard() {
  return Array.from({ length: 10 }, () => Array(9).fill(null));
}

function put(board, coord, color, type) {
  const { row, col } = X.coordToPos(coord);
  board[row][col] = { color, type, id: `${color}${type}` };
}

test('初始局面红方共有44个合法着法', () => {
  const board = X.createInitialBoard();
  const moves = X.generateLegalMoves(board, X.RED);
  assert.equal(moves.length, 44);
  assert.equal(X.getGameStatus(board, X.RED).over, false);
});

test('马腿被挡时不能走', () => {
  const board = emptyBoard();
  put(board, 'd0', X.RED, 'K');
  put(board, 'e9', X.BLACK, 'K');
  put(board, 'b2', X.RED, 'H');
  put(board, 'b1', X.RED, 'P');
  const moves = X.generateLegalMoves(board, X.RED).filter((m) => m.from.row === 7 && m.from.col === 1);
  assert.equal(moves.some((m) => X.posToCoord(m.to.row, m.to.col) === 'a0'), false);
  assert.equal(moves.some((m) => X.posToCoord(m.to.row, m.to.col) === 'c0'), false);
});

test('象眼被塞不能走，且象不能过河', () => {
  const board = emptyBoard();
  put(board, 'd0', X.RED, 'K');
  put(board, 'e9', X.BLACK, 'K');
  put(board, 'c0', X.RED, 'E');
  put(board, 'b1', X.RED, 'P');
  let moves = X.generateLegalMoves(board, X.RED).filter((m) => X.posToCoord(m.from.row, m.from.col) === 'c0');
  assert.equal(moves.some((m) => X.posToCoord(m.to.row, m.to.col) === 'a2'), false);

  board[8][1] = null;
  put(board, 'e4', X.RED, 'E');
  moves = X.generateLegalMoves(board, X.RED).filter((m) => X.posToCoord(m.from.row, m.from.col) === 'e4');
  assert.equal(moves.some((m) => X.coordToPos(X.posToCoord(m.to.row, m.to.col)).row < 5), false);
});

test('炮吃子需要恰好一个炮架，否则只能移动', () => {
  const board = emptyBoard();
  put(board, 'd0', X.RED, 'K');
  put(board, 'e9', X.BLACK, 'K');
  put(board, 'b0', X.RED, 'C');
  put(board, 'b3', X.BLACK, 'P');
  put(board, 'b5', X.BLACK, 'P');
  put(board, 'b7', X.RED, 'P');
  const moves = X.generateLegalMoves(board, X.RED).filter((m) => X.posToCoord(m.from.row, m.from.col) === 'b0');
  assert.equal(moves.some((m) => X.posToCoord(m.to.row, m.to.col) === 'b3'), false);
  assert.equal(moves.some((m) => X.posToCoord(m.to.row, m.to.col) === 'b5'), true);
  assert.equal(moves.some((m) => X.posToCoord(m.to.row, m.to.col) === 'b7'), false);
});

test('将帅不能照面，挡子不能离开中线', () => {
  const board = emptyBoard();
  put(board, 'e0', X.RED, 'K');
  put(board, 'e1', X.RED, 'C');
  put(board, 'e5', X.BLACK, 'K');
  const moves = X.generateLegalMoves(board, X.RED);
  const rookMoves = moves.filter((m) => m.piece.type === 'C');
  assert.equal(rookMoves.some((m) => X.posToCoord(m.to.row, m.to.col) === 'a1'), false);
  assert.equal(rookMoves.some((m) => X.posToCoord(m.to.row, m.to.col) === 'e2'), true);
  assert.equal(X.isInCheck(board, X.RED), false);
  assert.equal(X.isInCheck(board, X.BLACK), false);
});

test('将帅照面局面被判为被将军', () => {
  const board = emptyBoard();
  put(board, 'e0', X.RED, 'K');
  put(board, 'e5', X.BLACK, 'K');
  assert.equal(X.isInCheck(board, X.RED), true);
  assert.equal(X.isInCheck(board, X.BLACK), true);
});

test('困毙判负', () => {
  const board = emptyBoard();
  put(board, 'e0', X.RED, 'K');
  put(board, 'e9', X.BLACK, 'K');
  put(board, 'd1', X.BLACK, 'R');
  put(board, 'f1', X.BLACK, 'R');
  put(board, 'e2', X.BLACK, 'P');
  const status = X.getGameStatus(board, X.RED);
  assert.equal(status.over, true);
  assert.equal(status.reason, 'stalemate');
  assert.equal(status.winner, X.BLACK);
});

test('FEN与棋盘序列化', () => {
  const board = X.createInitialBoard();
  const fen = X.boardToFen(board, X.RED);
  assert.equal(fen.split(' ')[0], 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR');
  assert.equal(X.boardToAscii(board).includes('楚河汉界'), true);
});
