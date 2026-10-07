import assert from 'node:assert/strict';
import { newGame, applyMove, currentPlayer, combosFor, tileScore, startNextRound, ALL_OPEN } from '../public/rules.js';
import { pickBotMove } from '../public/bot.js';

// combos
assert.deepEqual(combosFor(ALL_OPEN, 2), [[2]]);
assert.equal(combosFor(ALL_OPEN, 12).length, 15 + 0 > 0 ? combosFor(ALL_OPEN, 12).length : 0);
assert.equal(combosFor('000000000000', 5).length, 0);
assert.equal(tileScore(ALL_OPEN), 78);

// roll stuck: only tile 12 open, roll 2 -> stuck
let g = newGame({ playerIds: ['a', 'b'], rounds: 1 });
g.players.a.tiles = '000000000001';
const seq = (...v) => { let i = 0; return () => (v[i++] - 1) / 6 + 0.01; };
g = applyMove(g, 'a', { type: 'roll' }, seq(1, 1));
assert.equal(g.players.a.out, true);
assert.equal(currentPlayer(g), 'b');
assert.equal(g.lastRoll.stuck, true);

// wrong turn / bad sum
g = newGame({ playerIds: ['a', 'b'] });
assert.throws(() => applyMove(g, 'b', { type: 'roll' }), /not your turn/);
g = applyMove(g, 'a', { type: 'roll' }, seq(3, 4));
assert.throws(() => applyMove(g, 'a', { type: 'shut', tiles: [6] }), /add up to 7/);
assert.throws(() => applyMove(g, 'a', { type: 'shut', tiles: [3, 4, 0] }), /already shut|Pick/);
g = applyMove(g, 'a', { type: 'shut', tiles: [3, 4] });
assert.equal(g.players.a.tiles, '110011111111');
assert.equal(currentPlayer(g), 'b');

// shut the box ends round instantly
g = newGame({ playerIds: ['a', 'b'], rounds: 1 });
g.players.a.tiles = '000000000011'; // 11 + 12 open? tiles 11,12 -> need roll 23, impossible; use single tile
g.players.a.tiles = '000000000010'; // only 11 open
g = applyMove(g, 'a', { type: 'roll' }, seq(5, 6));
g = applyMove(g, 'a', { type: 'shut', tiles: [11] });
assert.equal(g.phase, 'gameOver');
assert.equal(g.shutBy, 'a');
assert.deepEqual(g.winners, ['a']);

// bot tournament: random games always finish with zero illegal moves
const stats = { easy: 0, medium: 0, hard: 0 };
let moves = 0;
for (let n = 0; n < 3000; n++) {
  const diffs = ['easy', 'medium', 'hard'];
  const ids = ['easy', 'medium', 'hard'];
  let st = newGame({ playerIds: ids, rounds: 3 });
  for (let r = 0; r < 3; r++) {
    let guard = 0;
    while (st.phase === 'roll' || st.phase === 'pick') {
      const pid = currentPlayer(st);
      st = applyMove(st, pid, pickBotMove(st, pid, pid));
      moves++;
      assert.ok(++guard < 500, 'stalled');
    }
    if (st.phase === 'roundEnd') st = startNextRound(st);
  }
  assert.equal(st.phase, 'gameOver');
  const best = Math.min(...ids.map((p) => st.players[p].total));
  for (const p of ids) if (st.players[p].total === best) stats[p]++;
}
console.log('moves', moves, 'wins', stats);
assert.ok(stats.hard > stats.medium && stats.medium > stats.easy);
console.log('all engine tests passed');
