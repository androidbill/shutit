// Bots only ever return a move; it goes through the same applyMove a human tap does.
import { combosFor, shutTiles, tileScore, isBoxShut } from './rules.js';

const WAYS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

// Expected final score of a box under best play: with one roll per turn and a stuck roll
// ending your round, the only choice that matters is WHICH tiles to keep, and there are just
// 4096 boxes — so Hard solves the game exactly instead of using a heuristic.
const memo = new Map();
function expected(tiles) {
  if (isBoxShut(tiles)) return 0;
  const hit = memo.get(tiles);
  if (hit !== undefined) return hit;
  let ev = 0;
  for (let t = 2; t <= 12; t++) {
    const combos = combosFor(tiles, t);
    let v = tileScore(tiles); // stuck: you keep what is open
    for (const c of combos) v = Math.min(v, expected(shutTiles(tiles, c)));
    ev += (WAYS[t] / 36) * v;
  }
  memo.set(tiles, ev);
  return ev;
}

export function pickBotMove(game, pid, difficulty = 'medium') {
  if (game.phase === 'roll') return { type: 'roll' };
  const me = game.players[pid];
  const total = game.dice[0] + game.dice[1];
  const combos = combosFor(me.tiles, total);
  if (!combos.length) return { type: 'roll' }; // unreachable: stuck players never reach 'pick'
  let best;
  if (difficulty === 'easy') {
    best = combos[Math.floor(Math.random() * combos.length)];
  } else if (difficulty === 'medium') {
    // classic advice: shut the high tiles first, keep the small ones for flexibility
    best = combos.slice().sort((a, b) => Math.max(...b) - Math.max(...a) || a.length - b.length)[0];
  } else {
    let bestVal = Infinity;
    for (const c of combos) {
      const v = expected(shutTiles(me.tiles, c));
      if (v < bestVal) { bestVal = v; best = c; }
    }
  }
  return { type: 'shut', tiles: best };
}
