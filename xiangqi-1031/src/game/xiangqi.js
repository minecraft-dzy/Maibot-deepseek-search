'use strict';

const COLS = 9;
const ROWS = 10;
const FILES = 'abcdefghi';
const RED = 'red';
const BLACK = 'black';

const PIECE_NAMES = {
  K: { red: '帅', black: '将' },
  A: { red: '仕', black: '士' },
  E: { red: '相', black: '象' },
  H: { red: '马', black: '马' },
  R: { red: '车', black: '车' },
  C: { red: '炮', black: '炮' },
  P: { red: '兵', black: '卒' },
  W: { red: '墙', black: '墙' },
};

const SIDE_NAMES = { red: '红方', black: '黑方' };

function inside(row, col) {
  return row >= 0 && row < ROWS && col >= 0 && col < COLS;
}

function isPalace(color, row, col) {
  if (col < 3 || col > 5) return false;
  return color === RED ? row >= 7 && row <= 9 : row >= 0 && row <= 2;
}

function hasCrossedRiver(color, row) {
  return color === RED ? row <= 4 : row >= 5;
}

function createInitialBoard() {
  const board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  const backRank = ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R'];
  const counters = {};
  const put = (row, col, color, type) => {
    const key = `${color}${type}`;
    counters[key] = (counters[key] || 0) + 1;
    board[row][col] = { color, type, id: `${key}${counters[key]}` };
  };
  backRank.forEach((type, col) => put(0, col, BLACK, type));
  backRank.forEach((type, col) => put(9, col, RED, type));
  put(2, 1, BLACK, 'C');
  put(2, 7, BLACK, 'C');
  put(7, 1, RED, 'C');
  put(7, 7, RED, 'C');
  [0, 2, 4, 6, 8].forEach((col) => {
    put(3, col, BLACK, 'P');
    put(6, col, RED, 'P');
  });
  return board;
}

function cloneBoard(board) {
  return board.map((row) => row.map((piece) => (piece ? { ...piece } : null)));
}

function coordToPos(coord) {
  if (typeof coord !== 'string' || coord.length !== 2) return null;
  const file = FILES.indexOf(coord[0]);
  const rank = Number(coord[1]);
  if (file < 0 || !Number.isInteger(rank) || rank < 0 || rank > 9) return null;
  return { row: 9 - rank, col: file };
}

function posToCoord(row, col) {
  if (!inside(row, col)) return null;
  return `${FILES[col]}${9 - row}`;
}

function findKing(board, color) {
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const p = board[r][c];
      if (p && p.color === color && p.type === 'K') return { row: r, col: c };
    }
  }
  return null;
}

function addIfTarget(board, color, moves, from, row, col) {
  if (!inside(row, col)) return false;
  const target = board[row][col];
  if (target && target.color === color) return false;
  moves.push({ from, to: { row, col }, piece: board[from.row][from.col], captured: target });
  return !target;
}

function pseudoMovesFor(board, row, col) {
  const piece = board[row][col];
  if (!piece) return [];
  const moves = [];
  const from = { row, col };
  const { color, type } = piece;

  if (type === 'K') {
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dr, dc]) => {
      const r = row + dr;
      const c = col + dc;
      if (isPalace(color, r, c)) addIfTarget(board, color, moves, from, r, c);
    });
    // 白脸将：同列无遮挡时，帅/将可以“飞”吃对方将/帅。
    const forward = color === RED ? -1 : 1;
    for (let r = row + forward; r >= 0 && r < ROWS; r += forward) {
      const target = board[r][col];
      if (!target) continue;
      if (target.color !== color && target.type === 'K') {
        moves.push({ from, to: { row: r, col }, piece, captured: target });
      }
      break;
    }
  } else if (type === 'A') {
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([dr, dc]) => {
      const r = row + dr;
      const c = col + dc;
      if (isPalace(color, r, c)) addIfTarget(board, color, moves, from, r, c);
    });
  } else if (type === 'E') {
    [[2, 2], [2, -2], [-2, 2], [-2, -2]].forEach(([dr, dc]) => {
      const r = row + dr;
      const c = col + dc;
      if (!inside(r, c)) return;
      if (!piece.water && (color === RED ? r < 5 : r > 4)) return;
      if (board[row + dr / 2][col + dc / 2]) return;
      addIfTarget(board, color, moves, from, r, c);
    });
  } else if (type === 'H') {
    const patterns = [
      [-2, -1, -1, 0], [-2, 1, -1, 0], [2, -1, 1, 0], [2, 1, 1, 0],
      [-1, -2, 0, -1], [1, -2, 0, -1], [-1, 2, 0, 1], [1, 2, 0, 1],
    ];
    patterns.forEach(([dr, dc, lr, lc]) => {
      const r = row + dr;
      const c = col + dc;
      if (!inside(r, c) || board[row + lr][col + lc]) return;
      addIfTarget(board, color, moves, from, r, c);
    });
  } else if (type === 'R') {
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dr, dc]) => {
      let r = row + dr;
      let c = col + dc;
      while (inside(r, c)) {
        const target = board[r][c];
        if (!target) {
          moves.push({ from, to: { row: r, col: c }, piece, captured: null });
        } else {
          if (target.color !== color) {
            moves.push({ from, to: { row: r, col: c }, piece, captured: target });
          }
          break;
        }
        r += dr;
        c += dc;
      }
    });
  } else if (type === 'C') {
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dr, dc]) => {
      let r = row + dr;
      let c = col + dc;
      let screen = false;
      while (inside(r, c)) {
        const target = board[r][c];
        if (!screen) {
          if (!target) {
            moves.push({ from, to: { row: r, col: c }, piece, captured: null });
          } else {
            screen = true;
          }
        } else if (target) {
          if (target.color !== color) {
            moves.push({ from, to: { row: r, col: c }, piece, captured: target });
          }
          break;
        }
        r += dr;
        c += dc;
      }
    });
  } else if (type === 'P') {
    const forward = color === RED ? -1 : 1;
    addIfTarget(board, color, moves, from, row + forward, col);
    if (hasCrossedRiver(color, row)) {
      addIfTarget(board, color, moves, from, row, col - 1);
      addIfTarget(board, color, moves, from, row, col + 1);
    }
  }
  return moves;
}

function generatePseudoMoves(board, color) {
  const moves = [];
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const piece = board[r][c];
      if (piece && piece.color === color) moves.push(...pseudoMovesFor(board, r, c));
    }
  }
  return moves;
}

function isInCheck(board, color) {
  const king = findKing(board, color);
  if (!king) return true;
  const enemy = color === RED ? BLACK : RED;
  return generatePseudoMoves(board, enemy).some(
    (m) => m.to.row === king.row && m.to.col === king.col,
  );
}

function applyMove(board, from, to) {
  const piece = board[from.row][from.col];
  const captured = board[to.row][to.col];
  board[to.row][to.col] = piece;
  board[from.row][from.col] = null;
  return { piece, captured };
}

function isLegalMove(board, from, to, color) {
  if (!from || !to || !inside(from.row, from.col) || !inside(to.row, to.col)) return false;
  const piece = board[from.row][from.col];
  if (!piece || piece.color !== color) return false;
  const target = board[to.row][to.col];
  if (target && target.color === color) return false;
  const legal = generateLegalMoves(board, color, from);
  return legal.some((m) => m.to.row === to.row && m.to.col === to.col);
}

function generateLegalMoves(board, color, onlyFrom = null) {
  const candidateBoard = cloneBoard(board);
  const candidates = [];
  if (onlyFrom) {
    const piece = board[onlyFrom.row]?.[onlyFrom.col];
    if (!piece || piece.color !== color || piece.frozen > 0) return [];
    candidates.push(...pseudoMovesFor(board, onlyFrom.row, onlyFrom.col));
  } else {
    candidates.push(...generatePseudoMoves(board, color));
  }
  return candidates.filter((move) => {
    const mover = board[move.from.row]?.[move.from.col];
    if (mover?.frozen > 0) return false;
    applyMove(candidateBoard, move.from, move.to);
    const legal = !isInCheck(candidateBoard, color);
    // 恢复棋盘
    const moved = candidateBoard[move.to.row][move.to.col];
    candidateBoard[move.from.row][move.from.col] = moved;
    candidateBoard[move.to.row][move.to.col] = move.captured;
    return legal;
  });
}

function getGameStatus(board, turn) {
  const king = findKing(board, turn);
  if (!king) return { over: true, winner: turn === RED ? BLACK : RED, reason: 'king_captured' };
  const inCheck = isInCheck(board, turn);
  const moves = generateLegalMoves(board, turn);
  if (moves.length === 0) {
    return {
      over: true,
      winner: turn === RED ? BLACK : RED,
      reason: inCheck ? 'checkmate' : 'stalemate',
      inCheck,
    };
  }
  return { over: false, winner: null, reason: null, inCheck, moveCount: moves.length };
}

function boardToAscii(board) {
  const glyphs = {
    K: '帅', A: '仕', E: '相', H: '马', R: '车', C: '炮', P: '兵', W: '墙',
    k: '将', a: '士', e: '象', h: '马', r: '车', c: '炮', p: '卒', w: '墙',
  };
  const lines = [];
  lines.push('   a b c d e f g h i   （红方在下，rank 0 为红方底线）');
  for (let r = 0; r < ROWS; r += 1) {
    const rank = 9 - r;
    const cells = [];
    for (let c = 0; c < COLS; c += 1) {
      const p = board[r][c];
      cells.push(p ? glyphs[p.color === RED ? p.type : p.type.toLowerCase()] : '·');
    }
    lines.push(`${rank}  ${cells.join(' ')}`);
    if (r === 4) lines.push('   ~~~~~~~~ 楚河汉界 ~~~~~~~~');
  }
  return lines.join('\n');
}

function serializeBoard(board) {
  return board.map((row) => row.map((p) => (p ? { ...p } : null)));
}

function boardToFen(board, turn) {
  const map = { K: 'k', A: 'a', E: 'b', H: 'n', R: 'r', C: 'c', P: 'p', W: 'w' };
  const rows = [];
  for (let r = 0; r < ROWS; r += 1) {
    let empty = 0;
    let row = '';
    for (let c = 0; c < COLS; c += 1) {
      const p = board[r][c];
      if (!p) {
        empty += 1;
      } else {
        if (empty) { row += empty; empty = 0; }
        const code = map[p.type];
        row += p.color === RED ? code.toUpperCase() : code;
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return `${rows.join('/')} ${turn === RED ? 'w' : 'b'} - - 0 1`;
}

function pieceName(piece) {
  return PIECE_NAMES[piece.type]?.[piece.color] || piece.type;
}

function moveNotation(board, from, to) {
  const piece = board[from.row][from.col];
  const captured = board[to.row][to.col];
  if (!piece) return '';
  const side = SIDE_NAMES[piece.color];
  const capture = captured ? ` 吃${pieceName(captured)}` : '';
  return `${side}${pieceName(piece)} ${posToCoord(from.row, from.col)}→${posToCoord(to.row, to.col)}${capture}`;
}

function countMaterial(board, color) {
  const values = { K: 0, A: 2, E: 2, H: 4, R: 9, C: 4.5, P: 1 };
  let total = 0;
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < COLS; c += 1) {
      const p = board[r][c];
      if (p && p.color === color) total += values[p.type] || 0;
    }
  }
  return total;
}

module.exports = {
  COLS,
  ROWS,
  FILES,
  RED,
  BLACK,
  PIECE_NAMES,
  SIDE_NAMES,
  createInitialBoard,
  cloneBoard,
  coordToPos,
  posToCoord,
  inside,
  isPalace,
  generatePseudoMoves,
  generateLegalMoves,
  isLegalMove,
  isInCheck,
  applyMove,
  getGameStatus,
  findKing,
  boardToAscii,
  boardToFen,
  serializeBoard,
  pieceName,
  moveNotation,
  countMaterial,
};
