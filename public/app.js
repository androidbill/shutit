import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getDatabase, ref, set, get, update, onValue, runTransaction, onDisconnect, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
import { WORD_CODES } from './wordcodes.js';
import { APP_VERSION } from './version.js';
import {
  PLAYER_COLORS, MAX_PLAYERS, TILE_COUNT, newGame, applyMove, startNextRound, currentPlayer,
  normalizeGame, tileScore, combosFor,
} from './rules.js';
import { pickBotMove } from './bot.js';
import { sfx, unlock } from './audio.js';

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// RTDB gives a live client/server clock offset: the turn timer counts down from the SAME
// instant on every device, immune to a phone's clock drift.
let serverTimeOffset = 0;
onValue(ref(db, '.info/serverTimeOffset'), (snap) => { serverTimeOffset = snap.val() || 0; });
const serverNow = () => Date.now() + serverTimeOffset;

// ---------------------------------------------------------------- identity
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
let playerId = localStorage.getItem('shutit_pid');
if (!playerId) { playerId = uid(); localStorage.setItem('shutit_pid', playerId); }
let myName = localStorage.getItem('shutit_name') || '';
let myColor = parseInt(localStorage.getItem('shutit_color'), 10);
if (!(myColor >= 0 && myColor < PLAYER_COLORS.length)) myColor = 0;

// ---------------------------------------------------------------- dom helpers
const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const colorOf = (idx) => PLAYER_COLORS[idx] || PLAYER_COLORS[0];
const pillStyle = (idx) => `--c:${colorOf(idx).hex};--ink:${colorOf(idx).ink}`;

const SCREENS = ['screen-home', 'screen-join', 'screen-color', 'screen-lobby', 'screen-solo-setup', 'screen-game', 'screen-rules'];
function showScreen(id) { for (const s of SCREENS) (s === id ? show : hide)($(s)); }

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; show(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(t), 3000);
}

let shoutTimer = null;
function shoutout(msg, accent, { big = false, duration = 2200 } = {}) {
  const box = $('shoutout'); const card = $('shoutout-card');
  card.textContent = msg;
  card.style.setProperty('--c', accent || 'var(--brass)');
  card.classList.toggle('big', big);
  show(box);
  card.classList.remove('show'); void card.offsetWidth; card.classList.add('show');
  clearTimeout(shoutTimer);
  shoutTimer = setTimeout(() => { card.classList.remove('show'); hide(box); }, duration);
}

// ---------------------------------------------------------------- sound (HexColony's audio.js)
// dice = roll, road = a tile going down, yourTurn = your turn, win/lose = game over.
document.addEventListener('pointerdown', () => unlock(), { once: true });
const sndRoll = () => sfx.dice();
const sndShut = () => sfx.road();
const sndTurn = () => sfx.yourTurn();
const sndStuck = () => sfx.error();

// ---------------------------------------------------------------- kebab / about / refresh
$('kebab-btn').addEventListener('click', () => {
  $('menu-quit').classList.toggle('hidden', $('screen-game').classList.contains('hidden'));
  $('kebab-menu').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!$('kebab-menu').contains(e.target) && e.target !== $('kebab-btn')) hide($('kebab-menu'));
});
// A plain reload can silently no-op on an installed PWA; force a genuinely new navigation.
async function hardRefresh() {
  try {
    const regs = await navigator.serviceWorker?.getRegistrations();
    for (const r of regs || []) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
  } catch { /* ignore */ }
  const url = new URL(location.href);
  url.searchParams.set('fresh', Date.now().toString(36));
  location.replace(url.toString());
  setTimeout(() => { location.href = url.toString(); }, 1200);
  setTimeout(() => { location.reload(); }, 2600);
}
$('menu-refresh').addEventListener('click', () => { hide($('kebab-menu')); toast('Updating…'); hardRefresh(); });
$('menu-share').addEventListener('click', async () => {
  hide($('kebab-menu'));
  const url = location.href.split('?')[0] + (currentRoomCode ? `?room=${currentRoomCode}` : '');
  try {
    if (navigator.share) await navigator.share({ title: 'Shut It', url });
    else { await navigator.clipboard.writeText(url); toast('Link copied'); }
  } catch { /* cancelled */ }
});
$('menu-about').addEventListener('click', () => { hide($('kebab-menu')); $('about-version').textContent = `Version ${APP_VERSION}`; show($('about-modal')); });
$('menu-quit').addEventListener('click', () => { hide($('kebab-menu')); quitGame(); });
$('version-label').textContent = `v${APP_VERSION}`;
$('about-close').addEventListener('click', () => hide($('about-modal')));

// ---------------------------------------------------------------- install banner
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); deferredInstallPrompt = e;
  if (!$('screen-home').classList.contains('hidden')) show($('install-banner'));
});
$('btn-install').addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null; hide($('install-banner'));
});

// ---------------------------------------------------------------- version check
let updateBannerShown = false;
async function checkVersion() {
  if (updateBannerShown) return;
  try {
    const res = await fetch(`version.js?t=${Date.now()}`, { cache: 'no-store' });
    const m = (await res.text()).match(/APP_VERSION\s*=\s*'([^']+)'/);
    if (m && m[1] !== APP_VERSION) { updateBannerShown = true; show($('update-banner')); }
  } catch { /* offline */ }
}
checkVersion();
let lastVersionCheck = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastVersionCheck > 60000) { lastVersionCheck = Date.now(); checkVersion(); }
});
setInterval(() => { lastVersionCheck = Date.now(); checkVersion(); }, 2 * 60 * 1000);
$('update-refresh').addEventListener('click', () => { $('update-refresh').textContent = 'Updating…'; hardRefresh(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register(`sw.js?v=${APP_VERSION}`).catch(() => {});

// ================================================================== ROOM / ONLINE STATE
let currentRoomCode = null;
let roomUnsub = null;
let connUnsub = null;
let latestRoom = null;
let isHost = false;
let soloMode = null; // { botCount, difficulty, rounds } while playing solo
let turnTimerInterval = null;
let autoPlayBusy = false;

const roomRef = (code, ...path) => ref(db, ['rooms', code, ...path].join('/'));
const randomCode = () => WORD_CODES[Math.floor(Math.random() * WORD_CODES.length)];
const activeIds = (room) => (room.order || []).filter((pid) => room.players?.[pid] && !room.players[pid].left);

function saveIdentity(name, color) {
  if (name !== undefined) { myName = name; localStorage.setItem('shutit_name', name); }
  if (color !== undefined) { myColor = color; localStorage.setItem('shutit_color', String(color)); }
}

async function createRoom(colorIdx) {
  saveIdentity(undefined, colorIdx);
  let code;
  for (let tries = 0; tries < 20; tries++) {
    code = randomCode();
    if (!(await get(roomRef(code))).exists()) break;
  }
  await set(roomRef(code), {
    createdAt: Date.now(),
    hostId: playerId,
    status: 'lobby',
    settings: { rounds: 1, turnSeconds: 0 },
    players: { [playerId]: { name: myName, color: colorIdx, joinedAt: Date.now() } },
    order: [playerId],
  });
  enterRoom(code, true);
}

/** Take (or change to) a colour, atomically — two people tapping the same one cannot both win. */
async function claimColor(code, colorIdx, { joining = false } = {}) {
  const res = await runTransaction(roomRef(code, 'players'), (players) => {
    players = players || {};
    const others = Object.entries(players).filter(([id, p]) => id !== playerId && !p.left);
    if (others.some(([, p]) => p.color === colorIdx)) return; // taken: abort
    if (joining && !players[playerId] && others.length >= MAX_PLAYERS) return;
    players[playerId] = { ...(players[playerId] || {}), name: myName, color: colorIdx, joinedAt: players[playerId]?.joinedAt || Date.now(), left: false };
    return players;
  });
  return res.committed;
}

async function joinRoom(code, colorIdx) {
  const snap = await get(roomRef(code));
  if (!snap.exists()) { toast('Room not found'); return false; }
  const room = snap.val();
  const isMember = !!room.players?.[playerId];
  if (room.status !== 'lobby' && !isMember) { toast('That game has already started'); return false; }
  if (!(await claimColor(code, colorIdx, { joining: true }))) { toast('That colour was just taken — or the room is full'); return false; }
  saveIdentity(undefined, colorIdx);
  await runTransaction(roomRef(code, 'order'), (order) => {
    order = order || [];
    if (!order.includes(playerId)) order.push(playerId);
    return order;
  });
  enterRoom(code, room.hostId === playerId);
  return true;
}

function enterRoom(code, hosting) {
  currentRoomCode = code;
  isHost = hosting;
  resetFx();
  localStorage.setItem('shutit_room', code);
  if (connUnsub) connUnsub();
  // On EVERY (re)connect, mark ourselves present and re-arm the disconnect hook — a phone
  // that blinks offline must not stay flagged 'left' (the host would auto-play its turns).
  connUnsub = onValue(ref(db, '.info/connected'), (snap) => {
    if (!snap.val() || !currentRoomCode) return;
    const pref = roomRef(currentRoomCode, 'players', playerId, 'left');
    onDisconnect(pref).set(true).then(() => set(pref, false)).catch(() => {});
  });
  if (roomUnsub) roomUnsub();
  clearInterval(turnTimerInterval);
  turnTimerInterval = setInterval(tickTurnTimer, 1000);
  roomUnsub = onValue(roomRef(code), (snap) => {
    latestRoom = snap.val();
    if (!latestRoom) { toast('Room closed'); leaveRoom(); showScreen('screen-home'); return; }
    if (latestRoom.game) latestRoom.game = normalizeGame(latestRoom.game);
    isHost = latestRoom.hostId === playerId;
    renderRoom();
  });
}

function leaveRoom() {
  if (roomUnsub) { roomUnsub(); roomUnsub = null; }
  if (connUnsub) { connUnsub(); connUnsub = null; }
  clearInterval(turnTimerInterval);
  hide($('turn-timer'));
  currentRoomCode = null; latestRoom = null; soloMode = null;
  localStorage.removeItem('shutit_room');
}

/** Tell the room we are gone; hand the host crown on if it was ours. */
async function departRoom() {
  const code = currentRoomCode; const room = latestRoom;
  if (!code || !room) return;
  const updates = { [`players/${playerId}/left`]: true };
  if (room.hostId === playerId) {
    const next = activeIds(room).find((pid) => pid !== playerId);
    if (next) updates.hostId = next;
  }
  try { await update(roomRef(code), updates); } catch { /* offline */ }
}

async function quitGame() {
  if (soloMode) { stopSolo(); showScreen('screen-home'); return; }
  if (isHost && currentRoomCode && latestRoom?.status === 'active') {
    if (!confirm('End this game for everyone and return to the lobby?')) return;
    await update(roomRef(currentRoomCode), { status: 'lobby', game: null });
    return;
  }
  await departRoom(); leaveRoom(); showScreen('screen-home');
}

function renderRoom() {
  if (!latestRoom) return;
  if (latestRoom.status === 'lobby') { if (fx.ready) resetFx(); renderLobby(); if (!colorOpen()) showScreen('screen-lobby'); return; }
  if (latestRoom.status === 'active') { renderGame(); showScreen('screen-game'); }
}

// ---------------------------------------------------------------- colour screen
// One screen serves create, join, solo and "change colour" in the lobby.
let colorCtx = null;
const colorOpen = () => colorCtx !== null;

function openColor(ctx) {
  colorCtx = ctx;
  drawColors();
  showScreen('screen-color');
}
function closeColor() { colorCtx = null; if (colorUnsub) { colorUnsub(); colorUnsub = null; } }
let colorUnsub = null;

function drawColors() {
  if (!colorCtx) return;
  const taken = colorCtx.taken(); // Map colorIdx -> name
  const current = colorCtx.current();
  $('color-preview').innerHTML = `<span class="name-pill" style="${pillStyle(current)}">${esc(myName || 'You')}</span>`;
  $('color-sub').textContent = colorCtx.sub;
  $('color-grid').innerHTML = PLAYER_COLORS.map((c, i) => {
    const by = taken.get(i);
    const cls = ['color-cell']; if (by) cls.push('taken'); if (i === current && !by) cls.push('mine');
    return `<button class="${cls.join(' ')}" data-i="${i}" style="--c:${c.hex};--ink:${c.ink}" ${by ? 'disabled' : ''} aria-label="${esc(c.name)}">${by ? esc(by.slice(0, 2)) : (i === current ? '✓' : '')}</button>`;
  }).join('');
  for (const b of $('color-grid').querySelectorAll('.color-cell')) {
    b.addEventListener('click', async () => {
      const idx = Number(b.dataset.i);
      const ctx = colorCtx; if (!ctx) return;
      try {
        const ok = await ctx.onPick(idx);
        if (ok === false) drawColors();
      } catch (err) { console.error(err); toast('Connection problem — try again'); }
    });
  }
}
$('color-back').addEventListener('click', () => {
  const back = colorCtx?.back || 'screen-home';
  closeColor();
  if (back === 'screen-lobby') { renderRoom(); showScreen('screen-lobby'); } else showScreen(back);
});

function takenFromPlayers(players) {
  const m = new Map();
  for (const [id, p] of Object.entries(players || {})) if (id !== playerId && !p.left && p.color !== undefined) m.set(p.color, p.name || '?');
  return m;
}

function startColorForCreate() {
  let pick = myColor;
  openColor({
    sub: 'This is your name pill and your dice.', back: 'screen-home',
    taken: () => new Map(), current: () => pick,
    onPick: async (idx) => { pick = idx; closeColor(); await createRoom(idx); },
  });
}

async function startColorForJoin(code) {
  const snap = await get(roomRef(code));
  if (!snap.exists()) { toast('Room not found'); return; }
  const room = snap.val();
  if (room.status !== 'lobby' && !room.players?.[playerId]) { toast('That game has already started'); return; }
  let players = room.players || {};
  let pick = myColor;
  const unsub = onValue(roomRef(code, 'players'), (s) => { players = s.val() || {}; if (colorOpen() && colorCtx?.code === code) drawColors(); });
  colorUnsub = unsub;
  openColor({
    code, sub: 'A colour with initials on it is already taken.', back: 'screen-join',
    taken: () => takenFromPlayers(players),
    current: () => { const t = takenFromPlayers(players); if (!t.has(pick)) return pick; const free = PLAYER_COLORS.findIndex((_, i) => !t.has(i)); return free < 0 ? pick : free; },
    onPick: async (idx) => {
      pick = idx;
      const ok = await joinRoom(code, idx);
      if (ok) { closeColor(); renderRoom(); }
      return ok;
    },
  });
}

function startColorForLobby() {
  const code = currentRoomCode;
  openColor({
    code, sub: 'Tap another colour to swap.', back: 'screen-lobby',
    taken: () => takenFromPlayers(latestRoom?.players),
    current: () => latestRoom?.players?.[playerId]?.color ?? myColor,
    onPick: async (idx) => {
      const ok = await claimColor(code, idx);
      if (!ok) { toast('Somebody already has that colour.'); return false; }
      saveIdentity(undefined, idx);
      closeColor(); renderRoom(); showScreen('screen-lobby');
    },
  });
  // keep the grid live while open
  colorUnsub = onValue(roomRef(code, 'players'), () => { if (colorOpen() && colorCtx?.code === code) drawColors(); });
}

// ---------------------------------------------------------------- lobby
function renderLobby() {
  const room = latestRoom;
  $('lobby-code').textContent = currentRoomCode;
  $('lobby-players').innerHTML = activeIds(room).map((pid) => {
    const p = room.players[pid];
    return `<span class="name-pill${pid === room.hostId ? ' is-host' : ''}" style="${pillStyle(p.color)}">${esc(p.name || '?')}</span>`;
  }).join('');
  $('set-rounds').value = String(room.settings?.rounds || 1);
  $('set-turn-seconds').value = String(room.settings?.turnSeconds || 0);
  $('set-rounds').disabled = !isHost;
  $('set-turn-seconds').disabled = !isHost;
  const n = activeIds(room).length;
  if (isHost) {
    show($('lobby-start')); hide($('lobby-wait-msg'));
    $('lobby-start').disabled = n < 2;
    $('lobby-start').textContent = n < 2 ? 'Waiting for players…' : 'Start Game';
  } else { hide($('lobby-start')); show($('lobby-wait-msg')); }
}
$('lobby-change-color').addEventListener('click', startColorForLobby);
$('set-rounds').addEventListener('change', (e) => { if (isHost) update(roomRef(currentRoomCode, 'settings'), { rounds: parseInt(e.target.value, 10) }); });
$('set-turn-seconds').addEventListener('change', (e) => { if (isHost) update(roomRef(currentRoomCode, 'settings'), { turnSeconds: parseInt(e.target.value, 10) }); });
$('lobby-leave').addEventListener('click', async () => { await departRoom(); leaveRoom(); showScreen('screen-home'); });
$('lobby-start').addEventListener('click', async () => {
  const room = latestRoom;
  const order = activeIds(room);
  if (order.length < 2) return;
  const game = newGame({ playerIds: order, rounds: room.settings?.rounds || 1, startIndex: Math.floor(Math.random() * order.length) });
  await update(roomRef(currentRoomCode), { status: 'active', order, game, turnStartedAt: serverTimestamp() });
});

// ---------------------------------------------------------------- moves (online)
// actingPid defaults to us, but the timeout fallback also acts for an unresponsive player —
// there is no server function on the Spark plan to do it authoritatively.
async function sendMove(move, actingPid = playerId) {
  if (soloMode) { applySoloMove(move); return; }
  let result;
  await runTransaction(roomRef(currentRoomCode, 'game'), (game) => {
    if (!game) return;
    try { result = applyMove(normalizeGame(game), actingPid, move); return result; }
    catch (err) { result = { error: err.message }; return; }
  });
  if (result?.error) { if (actingPid === playerId) toast(result.error); return; }
  if (result) await update(roomRef(currentRoomCode), { turnStartedAt: serverTimestamp() });
}

function tickTurnTimer() {
  const timerEl = $('turn-timer');
  const room = latestRoom; const game = room?.game;
  const secs = room?.settings?.turnSeconds || 0;
  if (!room || room.status !== 'active' || !game || (game.phase !== 'roll' && game.phase !== 'pick')) { hide(timerEl); return; }
  const startedAt = typeof room.turnStartedAt === 'number' ? room.turnStartedAt : null;
  if (!startedAt) { hide(timerEl); return; }
  const curPid = currentPlayer(game);
  const mine = curPid === playerId;
  const curLeft = !!room.players?.[curPid]?.left;

  let remainingMs = secs ? startedAt + secs * 1000 - serverNow() : Infinity;
  if (curLeft) remainingMs = Math.min(remainingMs, startedAt + 2500 - serverNow());
  if (secs) {
    const s = Math.max(0, Math.ceil(remainingMs / 1000));
    show(timerEl); timerEl.textContent = String(s);
    timerEl.classList.toggle('mine', mine); timerEl.classList.toggle('urgent', s <= 5);
  } else hide(timerEl);

  if (remainingMs > 0 || autoPlayBusy) return;
  // Who acts: you on your own timeout; the host for a player who left; anyone, a few
  // seconds later, for a player who is simply stuck on their phone.
  const actor = mine ? curPid : (curLeft ? (isHost ? curPid : (remainingMs <= -6000 ? curPid : null)) : (remainingMs <= -4000 ? curPid : null));
  if (!actor) return;
  autoPlayBusy = true;
  (async () => sendMove(pickBotMove(game, actor, 'medium'), actor))()
    .catch((err) => console.error('auto-play failed', err))
    .finally(() => { autoPlayBusy = false; });
}

async function requestNextRound() {
  if (soloMode) { soloState = startNextRound(soloState); renderSoloGame(); scheduleBot(); return; }
  await runTransaction(roomRef(currentRoomCode, 'game'), (game) => {
    if (!game || game.phase !== 'roundEnd') return;
    return startNextRound(normalizeGame(game));
  });
  await update(roomRef(currentRoomCode), { turnStartedAt: serverTimestamp() });
}

// ================================================================== SOLO MODE
let soloState = null;
let soloNames = {};
let soloSettings = null;
let botTimer = null;

function shuffled(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function startSolo(colorIdx) {
  saveIdentity(undefined, colorIdx);
  const { botCount, difficulty, rounds } = soloSettings;
  const free = shuffled(PLAYER_COLORS.map((_, i) => i).filter((i) => i !== colorIdx));
  const ids = ['you', ...Array.from({ length: botCount }, (_, i) => `bot${i + 1}`)];
  soloNames = { you: { name: myName || 'You', color: colorIdx } };
  ids.slice(1).forEach((id, i) => { soloNames[id] = { name: `Bot ${i + 1}`, color: free[i] }; });
  playerId = 'you';
  soloMode = { botCount, difficulty, rounds };
  currentRoomCode = null;
  resetFx();
  soloState = newGame({ playerIds: ids, rounds, startIndex: Math.floor(Math.random() * ids.length) });
  showScreen('screen-game');
  renderSoloGame();
  scheduleBot();
}
function stopSolo() {
  clearTimeout(botTimer); soloMode = null; soloState = null;
  playerId = localStorage.getItem('shutit_pid');
  clearSoloSave();
}
function applySoloMove(move) {
  try { soloState = applyMove(soloState, currentPlayer(soloState), move); }
  catch (err) { toast(err.message); return; }
  renderSoloGame(); scheduleBot();
}
function scheduleBot() {
  clearTimeout(botTimer);
  if (!soloState || (soloState.phase !== 'roll' && soloState.phase !== 'pick')) return;
  const pid = currentPlayer(soloState);
  if (pid === 'you') return;
  botTimer = setTimeout(() => {
    const move = pickBotMove(soloState, pid, soloMode.difficulty);
    try { soloState = applyMove(soloState, pid, move); } catch { /* skip */ }
    renderSoloGame(); scheduleBot();
  }, soloState.phase === 'roll' ? 900 : 2300);
}
function renderSoloGame() {
  renderGameCommon(soloState, soloNames, 'you');
  if (soloState.phase === 'gameOver') clearSoloSave(); else saveSolo();
}
function saveSolo() {
  try { localStorage.setItem('shutit_solo', JSON.stringify({ soloState, soloNames, soloMode })); } catch { /* ignore */ }
}
function clearSoloSave() { try { localStorage.removeItem('shutit_solo'); } catch { /* ignore */ } }
function resumeSolo() {
  try {
    const s = JSON.parse(localStorage.getItem('shutit_solo'));
    if (!s?.soloState || s.soloState.phase === 'gameOver') return false;
    soloState = normalizeGame(s.soloState); soloNames = s.soloNames; soloMode = s.soloMode;
    soloSettings = { ...soloMode };
    playerId = 'you'; resetFx();
    showScreen('screen-game'); renderSoloGame(); scheduleBot();
    return true;
  } catch { return false; }
}

// ================================================================== GAME RENDERING (shared)
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
// The throw: two big dice fly in from the edges, spin through random faces, and zoom down onto
// their numbers. Until they land the result stays hidden everywhere (see `rolling` below).
const ROLL_MS = 1500;
const ROLL_HOLD_MS = 450;
let rollAnimUntil = 0;
let rollAnimTimer = null;
function playRollAnim(dice, colorIdx) {
  const old = document.getElementById('roll-overlay'); if (old) old.remove();
  const ov = document.createElement('div');
  ov.id = 'roll-overlay'; ov.className = 'roll-overlay';
  ov.innerHTML = '<div class="big-die-wrap"></div><div class="big-die-wrap"></div>';
  document.body.appendChild(ov);
  const w = Math.min(window.innerWidth, 520);
  ov.querySelectorAll('.big-die-wrap').forEach((wrap, i) => {
    const set = (v) => { wrap.innerHTML = dieHtml(v, colorIdx); };
    set(1 + Math.floor(Math.random() * 6));
    const dir = i === 0 ? -1 : 1;
    wrap.animate([
      { transform: `translate(${dir * w * 0.9}px, ${-window.innerHeight * 0.35}px) scale(3.4) rotate(${dir * -540}deg)`, opacity: 0 },
      { opacity: 1, offset: 0.12 },
      { transform: `translate(${dir * -6}px, 24px) scale(2.3) rotate(${dir * 40}deg)`, offset: 0.7 },
      { transform: 'translate(0, 0) scale(1.9) rotate(0deg)', opacity: 1 },
    ], { duration: ROLL_MS, easing: 'cubic-bezier(.2,.75,.3,1)', fill: 'forwards' });
    // faces change quickly at first, then slow to a stop on the real value
    let t = 0; let gap = 60;
    (function tick() {
      t += gap; gap *= 1.16;
      if (t < ROLL_MS - 120) { set(1 + Math.floor(Math.random() * 6)); setTimeout(tick, gap); }
      else set(dice[i]);
    })();
  });
  rollAnimUntil = Date.now() + ROLL_MS + ROLL_HOLD_MS;
  clearTimeout(rollAnimTimer);
  rollAnimTimer = setTimeout(() => {
    ov.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' }).onfinish = () => ov.remove();
    if (lastRender) renderGameCommon(lastRender.game, lastRender.names, lastRender.myId);
  }, ROLL_MS + ROLL_HOLD_MS);
  return ROLL_MS + ROLL_HOLD_MS;
}

function dieHtml(v, colorIdx, tumble) {
  const on = new Set(PIPS[v] || []);
  return `<div class="die${tumble ? ' tumble' : ''}" style="${pillStyle(colorIdx)}">${Array.from({ length: 9 }, (_, i) => `<i${on.has(i) ? ' class="on"' : ''}></i>`).join('')}</div>`;
}

let fx = null;
let sel = new Set();
let selKey = '';
let lastRender = null;
let endKey = null;
let endRevealAt = 0;
let endTimer = null;

function resetFx() {
  rollAnimUntil = 0; clearTimeout(rollAnimTimer); document.getElementById('roll-overlay')?.remove();
  fx = { ready: false, rollKey: null, turnPid: null, shoutKey: null, prevTiles: {}, wasMyTurn: false };
  sel = new Set(); selKey = ''; endKey = null; clearTimeout(endTimer);
  hide($('round-end-panel')); hide($('gameover-panel'));
}

function renderGame() {
  if (!latestRoom?.game) return;
  const room = latestRoom;
  const names = {};
  for (const pid of room.game.order) names[pid] = { name: room.players?.[pid]?.name || '?', color: room.players?.[pid]?.color ?? 0 };
  renderGameCommon(room.game, names, playerId);
}

function renderGameCommon(game, names, myId) {
  lastRender = { game, names, myId };
  const live = game.phase === 'roll' || game.phase === 'pick';
  const curPid = currentPlayer(game);
  const isMyTurn = live && curPid === myId;
  const me = game.players[myId];
  const myCol = names[myId]?.color ?? myColor;
  const nameOf = (pid) => (pid === myId ? 'You' : (names[pid]?.name || '?'));
  const first = !fx.ready;
  let rolling = Date.now() < rollAnimUntil; // dice still in the air: hide the outcome

  // ---- sync of one-shot effects (sounds, shoutouts) — never on the first paint
  const rollKey = game.lastRoll ? `${game.round}:${game.rollId}` : `${game.round}:0`;
  const newRoll = rollKey !== fx.rollKey;
  if (!first && newRoll && game.lastRoll) {
    sndRoll();
    const wait = playRollAnim(game.lastRoll.dice, names[game.lastRoll.pid]?.color ?? 0);
    rolling = true;
    if (game.lastRoll.stuck) {
      setTimeout(sndStuck, wait);
      setTimeout(() => shoutout(`${nameOf(game.lastRoll.pid)} ${game.lastRoll.pid === myId ? 'are' : 'is'} stuck!`, colorOf(names[game.lastRoll.pid]?.color).hex, { duration: 1800 }), wait);
    }
  }
  if (!first && game.shutBy && fx.shoutKey !== `shut:${game.round}`) {
    shoutout('SHUT IT!', colorOf(names[game.shutBy]?.color).hex, { big: true, duration: 2600 });
  }
  if (game.shutBy) fx.shoutKey = `shut:${game.round}`;
  if (!first && isMyTurn && !fx.wasMyTurn) { sndTurn(); shoutout('Your turn', colorOf(myCol).hex, { duration: 1400 }); }
  fx.wasMyTurn = isMyTurn;
  fx.turnPid = curPid;

  // ---- selection state resets whenever the roll or the player changes
  const key = `${game.round}:${game.rollId}:${curPid}:${game.phase}`;
  if (key !== selKey) { selKey = key; sel = new Set(); }

  // ---- header
  $('game-round-info').textContent = game.rounds > 1 ? `Round ${game.round} of ${game.rounds}` : '';
  $('player-rail').innerHTML = game.order.map((pid) => {
    const p = game.players[pid];
    const cls = ['rail-pill']; if (p.out) cls.push('is-out'); if (live && pid === curPid) cls.push('active-turn');
    return `<div class="${cls.join(' ')}" style="${pillStyle(names[pid]?.color)}">
      <span>${esc(pid === myId ? (names[pid]?.name || 'You') : names[pid]?.name)}</span>
      <span class="rail-score">${tileScore(p.tiles)}</span>
      ${game.rounds > 1 ? `<span class="rail-total">Σ${p.total}</span>` : ''}
    </div>`;
  }).join('');

  // ---- opponents' boards
  $('opponents').innerHTML = game.order.filter((pid) => pid !== myId).map((pid) => {
    const p = game.players[pid];
    const tiles = Array.from({ length: TILE_COUNT }, (_, i) => `<span class="mini-tile${p.tiles[i] === '1' ? '' : ' shut'}">${i + 1}</span>`).join('');
    return `<div class="opp-row${p.out ? ' is-out' : ''}${live && pid === curPid ? ' active-turn' : ''}" style="--c:${colorOf(names[pid]?.color).hex}">
      <span class="opp-name">${esc(names[pid]?.name)}</span><div class="mini-board">${tiles}</div></div>`;
  }).join('');

  // ---- dice tray + caption
  const tray = $('dice-tray');
  let dice = null; let diceOwner = curPid; let dim = false; let caption = '';
  if (rolling) {
    dice = null;
  } else if (game.phase === 'pick' && game.dice) {
    dice = game.dice; diceOwner = curPid;
    caption = `${nameOf(curPid)} rolled <b>${dice[0] + dice[1]}</b>`;
  } else if (game.lastRoll) {
    dice = game.lastRoll.dice; diceOwner = game.lastRoll.pid; dim = true;
    const who = nameOf(game.lastRoll.pid);
    if (game.lastRoll.stuck) caption = `${who} rolled <b>${game.lastRoll.total}</b> — no move, out`;
    else if (game.lastRoll.shut) caption = `${who} rolled <b>${game.lastRoll.total}</b> <small>shut ${game.lastRoll.shut.join(' + ')}</small>`;
  }
  const ownerColor = names[diceOwner]?.color ?? 0;
  tray.className = `dice-tray${dim ? ' dim' : ''}${dice ? '' : ' empty'}`;
  tray.innerHTML = dice
    ? dieHtml(dice[0], ownerColor, false) + dieHtml(dice[1], ownerColor, false)
    : '<div class="die"></div><div class="die"></div>';
  $('dice-caption').innerHTML = caption;
  fx.rollKey = rollKey;

  // ---- prompt + roll button
  const rollBtn = $('roll-btn');
  const canRoll = isMyTurn && game.phase === 'roll';
  rollBtn.classList.toggle('hidden', !canRoll);
  rollBtn.style.setProperty('--c', colorOf(myCol).hex); rollBtn.style.setProperty('--ink', colorOf(myCol).ink);
  rollBtn.textContent = '🎲 Roll';
  rollBtn.onclick = () => { if (canRoll) sendMove({ type: 'roll' }); };
  let prompt = '';
  if (rolling) prompt = 'Rolling…';
  else if (isMyTurn && game.phase === 'roll') prompt = 'Your turn — roll the dice';
  else if (isMyTurn) prompt = `Pick tiles that add up to ${game.dice[0] + game.dice[1]}`;
  else if (live) prompt = `Waiting on ${nameOf(curPid)}…`;
  if (live && me?.out && !isMyTurn) prompt = `You're out this round — waiting on ${nameOf(curPid)}`;
  $('act-prompt').textContent = prompt;

  // ---- my board
  const total = isMyTurn && game.phase === 'pick' && !rolling ? game.dice[0] + game.dice[1] : 0;
  const usable = new Set();
  if (total) for (const c of combosFor(me.tiles, total)) for (const t of c) usable.add(t);
  const board = $('my-board');
  board.style.setProperty('--mine', colorOf(myCol).hex); board.style.setProperty('--mine-ink', colorOf(myCol).ink);
  board.classList.toggle('my-turn', isMyTurn);
  const prev = fx.prevTiles[myId];
  board.innerHTML = Array.from({ length: TILE_COUNT }, (_, i) => {
    const n = i + 1; const open = me.tiles[i] === '1';
    const cls = ['tile'];
    if (!open) { cls.push('shut'); if (prev && prev[i] === '1' && !first) cls.push('just-shut'); }
    else if (total) { cls.push(usable.has(n) ? 'usable' : 'unusable'); if (sel.has(n)) cls.push('selected'); }
    return `<button class="${cls.join(' ')}" data-n="${n}">${n}</button>`;
  }).join('');
  const shutCount = (t) => t.split('0').length - 1;
  if (prev && shutCount(me.tiles) > shutCount(prev) && !first) sndShut();
  fx.prevTiles[myId] = me.tiles;
  for (const b of board.querySelectorAll('.tile')) {
    b.onclick = () => {
      const n = Number(b.dataset.n);
      if (!total || me.tiles[n - 1] !== '1' || !usable.has(n)) return;
      if (sel.has(n)) sel.delete(n); else sel.add(n);
      renderGameCommon(game, names, myId);
    };
  }

  // ---- selection bar
  const bar = $('sel-bar');
  bar.classList.toggle('hidden', !total);
  if (total) {
    const sum = [...sel].reduce((a, b) => a + b, 0);
    const sumEl = $('sel-sum');
    sumEl.textContent = `${sum} / ${total}`;
    sumEl.className = `sel-sum${sum === total ? ' ok' : sum > total ? ' over' : ''}`;
    $('sel-shut').disabled = sum !== total;
    $('sel-shut').onclick = () => { if (sum === total) { const tiles = [...sel]; sel = new Set(); sendMove({ type: 'shut', tiles }); } };
    $('sel-clear').onclick = () => { sel = new Set(); renderGameCommon(game, names, myId); };
  }
  $('my-name').textContent = `${names[myId]?.name || 'You'} — ${tileScore(me.tiles)} pts${me.out ? ' (out)' : ''}`;

  // ---- round end / game over, held back so the last move can be seen
  const ending = game.phase === 'roundEnd' || game.phase === 'gameOver';
  let showEnd = false;
  if (ending) {
    const k = `${game.round}:${game.phase}`;
    if (k !== endKey) {
      endKey = k; endRevealAt = Date.now() + (first ? 0 : 2600);
      clearTimeout(endTimer);
      endTimer = setTimeout(() => { if (lastRender) renderGameCommon(lastRender.game, lastRender.names, lastRender.myId); }, 2700);
    }
    showEnd = Date.now() >= endRevealAt;
  } else endKey = null;
  fx.ready = true;
  renderEndPanels(game, names, myId, ending && showEnd);
}

function renderEndPanels(game, names, myId, showEnd) {
  const nameOf = (pid) => (pid === myId ? 'You' : (names[pid]?.name || '?'));
  const rows = (sortFn, winners) => game.order.slice().sort(sortFn).map((pid) => `
    <div class="score-row${winners?.includes(pid) ? ' is-winner' : ''}" style="${pillStyle(names[pid]?.color)}">
      <span>${winners?.includes(pid) ? '🏆 ' : ''}${esc(names[pid]?.name)}${pid === myId ? ' (you)' : ''}</span>
      <span class="sr-round">${game.lastRoundScores?.[pid] ?? 0}</span>
      <span class="sr-total">${game.players[pid].total}</span>
    </div>`).join('');
  const head = '<div class="score-head"><span></span><span>Round</span><span>Total</span></div>';
  const host = !!soloMode || isHost;

  if (game.phase === 'roundEnd' && showEnd) {
    show($('round-end-panel'));
    $('round-end-title').textContent = game.shutBy ? `${nameOf(game.shutBy)} shut it!` : `Round ${game.round} over`;
    $('round-end-scores').innerHTML = head + rows((a, b) => game.players[a].total - game.players[b].total);
    $('round-end-next').classList.toggle('hidden', !host);
    $('round-end-wait').classList.toggle('hidden', host);
  } else hide($('round-end-panel'));

  if (game.phase === 'gameOver' && showEnd) {
    show($('gameover-panel'));
    const w = game.winners || [];
    if (fx.endSound !== game.round) { fx.endSound = game.round; (w.includes(myId) ? sfx.win : sfx.lose)(); }
    $('gameover-title').textContent = w.length > 1
      ? `Tie: ${w.map(nameOf).join(' & ')}`
      : (w[0] === myId ? 'You win! 🎉' : `${nameOf(w[0])} wins!`);
    $('gameover-standings').innerHTML = head + rows((a, b) => game.players[a].total - game.players[b].total, w);
    $('gameover-lobby').textContent = soloMode ? 'Play Again' : 'Back to Lobby';
    $('gameover-lobby').classList.toggle('hidden', !host);
    $('gameover-wait').classList.toggle('hidden', host);
  } else hide($('gameover-panel'));
}

$('round-end-next').addEventListener('click', () => requestNextRound());
$('gameover-lobby').addEventListener('click', async () => {
  if (soloMode) { const ids = soloState.order; soloState = newGame({ playerIds: ids, rounds: soloMode.rounds, startIndex: Math.floor(Math.random() * ids.length) }); resetFx(); renderSoloGame(); scheduleBot(); return; }
  await update(roomRef(currentRoomCode), { status: 'lobby', game: null });
});
$('gameover-home').addEventListener('click', async () => {
  if (soloMode) { stopSolo(); showScreen('screen-home'); return; }
  await departRoom(); leaveRoom(); showScreen('screen-home');
});

// ================================================================== HOME / NAV
let pendingCode = null;
function requireName() {
  const name = $('home-name').value.trim().slice(0, 14);
  if (!name) {
    const el = $('home-name');
    el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); el.focus();
    toast('Enter your name first');
    return null;
  }
  saveIdentity(name);
  return name;
}
$('home-name').value = myName;
$('home-name').addEventListener('input', () => $('home-name').classList.remove('shake'));

$('btn-host').addEventListener('click', () => { if (requireName()) startColorForCreate(); });
$('btn-join').addEventListener('click', () => {
  if (!requireName()) return;
  $('join-code').value = pendingCode || '';
  showScreen('screen-join');
});
$('join-submit').addEventListener('click', async () => {
  const code = $('join-code').value.trim().toUpperCase();
  if (!code) { toast('Enter a room code'); return; }
  pendingCode = null;
  await startColorForJoin(code);
});
$('btn-solo').addEventListener('click', () => {
  if (!requireName()) return;
  $('solo-bot-count').value = localStorage.getItem('shutit_bots') || '3';
  $('solo-bot-difficulty').value = localStorage.getItem('shutit_diff') || 'medium';
  $('solo-rounds').value = localStorage.getItem('shutit_solo_rounds') || '1';
  showScreen('screen-solo-setup');
});
$('solo-start').addEventListener('click', () => {
  soloSettings = {
    botCount: parseInt($('solo-bot-count').value, 10),
    difficulty: $('solo-bot-difficulty').value,
    rounds: parseInt($('solo-rounds').value, 10),
  };
  localStorage.setItem('shutit_bots', String(soloSettings.botCount));
  localStorage.setItem('shutit_diff', soloSettings.difficulty);
  localStorage.setItem('shutit_solo_rounds', String(soloSettings.rounds));
  let pick = myColor;
  openColor({
    sub: 'This is your name pill and your dice.', back: 'screen-solo-setup',
    taken: () => new Map(), current: () => pick,
    onPick: (idx) => { pick = idx; closeColor(); startSolo(idx); },
  });
});
$('btn-rules').addEventListener('click', () => showScreen('screen-rules'));
for (const btn of document.querySelectorAll('.back-btn')) {
  btn.addEventListener('click', () => showScreen(btn.dataset.back));
}

// ---------------------------------------------------------------- boot / resume
(function boot() {
  resetFx();
  if (resumeSolo()) return;
  const params = new URLSearchParams(location.search);
  const linked = (params.get('room') || '').toUpperCase();
  const saved = localStorage.getItem('shutit_room');
  const toResume = linked || saved;
  showScreen('screen-home');
  if (!toResume) return;
  get(roomRef(toResume)).then((snap) => {
    if (snap.exists() && snap.val().players?.[playerId] && myName) { enterRoom(toResume, snap.val().hostId === playerId); return; }
    if (linked && snap.exists()) {
      pendingCode = linked;
      toast(myName ? 'Tap Join Game to enter the room' : 'Enter your name, then tap Join Game');
    }
  }).catch(() => {});
})();
