// Shut It — the whole game as pure functions. No DOM, no network.
//
// Each turn a player rolls two dice ONCE and must shut tiles (1-12) that add up to the
// total. A player whose roll cannot be made from their open tiles is stuck and out for
// the rest of the round. The round ends when everyone is out, or when someone shuts the
// whole box. Score = sum of the tiles still open; lowest total over all rounds wins.
//
// Tiles are stored as a 12-character string ('1' = open, '0' = shut) because Firebase RTDB
// prunes empty arrays/nulls and silently turns sparse arrays into objects.

export const TILE_COUNT = 12;
export const MAX_PLAYERS = 6;
export const ALL_OPEN = '1'.repeat(TILE_COUNT);

export const PLAYER_COLORS = [
  { key: 'red',    hex: '#ff4d4f', ink: '#ffffff', name: 'Red' },
  { key: 'sky',    hex: '#35c4ff', ink: '#03293c', name: 'Sky' },
  { key: 'yellow', hex: '#ffd52b', ink: '#3a2f05', name: 'Yellow' },
  { key: 'lime',   hex: '#9ef01a', ink: '#1c3003', name: 'Lime' },
  { key: 'teal',   hex: '#13e3c8', ink: '#032f2a', name: 'Teal' },
  { key: 'purple', hex: '#b06cff', ink: '#ffffff', name: 'Purple' },
  { key: 'pink',   hex: '#ff5cb8', ink: '#40062a', name: 'Pink' },
  { key: 'white',  hex: '#f4f7fb', ink: '#0d1b28', name: 'White' },
  { key: 'orange', hex: '#ff8a1f', ink: '#3a1d02', name: 'Orange' },
  { key: 'slate',  hex: '#93a7bd', ink: '#0d1b28', name: 'Slate' },
  { key: 'black',  hex: '#2a3444', ink: '#ffffff', name: 'Black' },
];

// ---------------------------------------------------------------- tiles
export function openTiles(str) {
  const out = [];
  for (let i = 0; i < TILE_COUNT; i++) if (str[i] === '1') out.push(i + 1);
  return out;
}
export function tileScore(str) { return openTiles(str).reduce((a, b) => a + b, 0); }
export function isBoxShut(str) { return !str.includes('1'); }
export function shutTiles(str, tiles) {
  const a = str.split('');
  for (const t of tiles) a[t - 1] = '0';
  return a.join('');
}

/** Every set of open tiles that sums to `total` (each set ascending). */
export function combosFor(str, total) {
  const open = openTiles(str);
  const out = [];
  (function go(i, left, chosen) {
    if (left === 0) { out.push(chosen.slice()); return; }
    for (let k = i; k < open.length; k++) {
      if (open[k] > left) break;
      chosen.push(open[k]);
      go(k + 1, left - open[k], chosen);
      chosen.pop();
    }
  })(0, total, []);
  return out;
}
export function canMake(str, total) { return combosFor(str, total).length > 0; }

// 2d6 totals, in 36ths
const WAYS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
/** Chance (0-1) that a single 2d6 roll can be made from these tiles. */
export function coverage(str) {
  let w = 0;
  for (let t = 2; t <= 12; t++) if (canMake(str, t)) w += WAYS[t];
  return w / 36;
}

// ---------------------------------------------------------------- game
export function newGame({ playerIds, rounds = 1, round = 1, totals = {}, startIndex = 0 }) {
  const order = playerIds.slice();
  const players = {};
  for (const pid of order) players[pid] = { tiles: ALL_OPEN, out: false, total: totals[pid] || 0 };
  return {
    round, rounds, phase: 'roll', order,
    turn: startIndex % order.length,
    startIndex: startIndex % order.length,
    players,
    dice: null,
    lastRoll: null,
    rollId: 0,
    shutBy: null,
    lastRoundScores: null,
    winners: null,
  };
}

export function currentPlayer(game) { return game.order[game.turn]; }

function clone(g) { return JSON.parse(JSON.stringify(g)); }

function nextActive(g, from) {
  for (let i = 1; i <= g.order.length; i++) {
    const idx = (from + i) % g.order.length;
    if (!g.players[g.order[idx]].out) return idx;
  }
  return -1;
}

function endRound(g) {
  const scores = {};
  for (const pid of g.order) {
    scores[pid] = tileScore(g.players[pid].tiles);
    g.players[pid].total += scores[pid];
  }
  g.lastRoundScores = scores;
  g.dice = null;
  if (g.round >= g.rounds) {
    g.phase = 'gameOver';
    const best = Math.min(...g.order.map((p) => g.players[p].total));
    g.winners = g.order.filter((p) => g.players[p].total === best);
  } else {
    g.phase = 'roundEnd';
  }
}

function advance(g) {
  const nx = nextActive(g, g.turn);
  if (nx < 0) { endRound(g); return; }
  g.turn = nx;
  g.phase = 'roll';
}

/**
 * Apply a move for `pid`. Returns the next state, or throws Error with a player-facing
 * message. `rng` is injectable for tests.
 *   { type: 'roll' }            — roll two dice (phase 'roll')
 *   { type: 'shut', tiles: [] } — shut tiles summing to the roll (phase 'pick')
 */
export function applyMove(game, pid, move, rng = Math.random) {
  const g = clone(game);
  if (g.phase !== 'roll' && g.phase !== 'pick') throw new Error('The round is over.');
  if (currentPlayer(g) !== pid) throw new Error("It's not your turn.");
  const me = g.players[pid];

  if (move.type === 'roll') {
    if (g.phase !== 'roll') throw new Error('You already rolled.');
    const dice = [1 + Math.floor(rng() * 6), 1 + Math.floor(rng() * 6)];
    const total = dice[0] + dice[1];
    g.rollId += 1;
    g.dice = dice;
    g.lastRoll = { pid, dice, total, stuck: false };
    if (!canMake(me.tiles, total)) {
      me.out = true;
      g.lastRoll.stuck = true;
      g.dice = null;
      advance(g);
    } else {
      g.phase = 'pick';
    }
    return g;
  }

  if (move.type === 'shut') {
    if (g.phase !== 'pick') throw new Error('Roll first.');
    const tiles = Array.isArray(move.tiles) ? move.tiles.map(Number) : [];
    const total = g.dice[0] + g.dice[1];
    if (!tiles.length || new Set(tiles).size !== tiles.length) throw new Error('Pick tiles to shut.');
    for (const t of tiles) {
      if (!Number.isInteger(t) || t < 1 || t > TILE_COUNT || me.tiles[t - 1] !== '1') throw new Error('That tile is already shut.');
    }
    if (tiles.reduce((a, b) => a + b, 0) !== total) throw new Error(`Tiles must add up to ${total}.`);
    me.tiles = shutTiles(me.tiles, tiles);
    g.lastRoll.shut = tiles.slice().sort((a, b) => a - b);
    g.dice = null;
    if (isBoxShut(me.tiles)) {
      g.shutBy = pid;
      endRound(g);
    } else {
      advance(g);
    }
    return g;
  }
  throw new Error('Unknown move.');
}

export function startNextRound(game) {
  const totals = {};
  for (const pid of game.order) totals[pid] = game.players[pid].total;
  return newGame({
    playerIds: game.order, rounds: game.rounds, round: game.round + 1, totals,
    startIndex: game.startIndex + 1,
  });
}

/** Fix up what Firebase prunes/reshapes, so rules never see undefined. */
export function normalizeGame(game) {
  if (!game) return game;
  return {
    ...game,
    order: game.order ? Object.values(game.order) : [],
    dice: game.dice ? Object.values(game.dice) : null,
    lastRoll: game.lastRoll
      ? { ...game.lastRoll, dice: Object.values(game.lastRoll.dice), shut: game.lastRoll.shut ? Object.values(game.lastRoll.shut) : null }
      : null,
    winners: game.winners ? Object.values(game.winners) : null,
    shutBy: game.shutBy || null,
    lastRoundScores: game.lastRoundScores || null,
  };
}
