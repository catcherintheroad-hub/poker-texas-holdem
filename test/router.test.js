'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const WebSocket = require('ws');

const { registerWebSocketServer } = require('../src/transport/ws/router');
const { createStore } = require('../src/state/store');
const { serializeGameState } = require('../src/transport/ws/messages');

test('router can create, join, and start a room', () => {
  const harness = createHarness();
  const owner = harness.connectSocket();
  const guest = harness.connectSocket();

  owner.sendMessage({ type: 'create_room', playerName: 'Owner', bigBlind: 10, maxPlayers: 4 });
  const created = owner.findMessage('room_created');
  assert.ok(created);

  guest.sendMessage({ type: 'join_room', roomCode: created.roomCode, playerName: 'Guest' });
  const joined = guest.findMessage('room_joined');
  assert.ok(joined);

  owner.sendMessage({ type: 'start_game' });
  const gameState = owner.findMessage('game_state');
  assert.ok(gameState);
  assert.equal(gameState.phase, 'preflop');
  assert.equal(gameState.players.length, 2);
  assert.ok(gameState.hand);
  assert.equal(typeof gameState.hand.seats.actingSeatIndex, 'number');
  assert.equal(typeof gameState.hand.betting.currentBet, 'number');

  cleanupHarness(harness, created.roomCode);
});

test('disconnect grace period preserves seat and resume restores the session in-hand', () => {
  const harness = createHarness();
  const owner = harness.connectSocket();
  const guest = harness.connectSocket();

  owner.sendMessage({ type: 'create_room', playerName: 'Owner', bigBlind: 10, maxPlayers: 4 });
  const created = owner.findMessage('room_created');
  guest.sendMessage({ type: 'join_room', roomCode: created.roomCode, playerName: 'Guest' });
  owner.sendMessage({ type: 'start_game' });

  const room = harness.store.rooms.get(created.roomCode);
  room.gameSession.disconnectGraceMs = 1000;

  const ownerPlayerId = created.playerId;
  const ownerPlayer = room.players.find((player) => player.id === ownerPlayerId);
  const ownerCardsBefore = ownerPlayer.holeCards.length;

  owner.closeSocket();

  assert.equal(ownerPlayer.connectionState, 'disconnected');
  assert.equal(ownerPlayer.hasFolded, false);
  assert.equal(ownerPlayer.holeCards.length, ownerCardsBefore);

  const resumed = harness.connectSocket();
  resumed.sendMessage({ type: 'resume_session', playerId: ownerPlayerId, roomCode: created.roomCode });

  const resumedMessage = resumed.findMessage('session_resumed');
  assert.ok(resumedMessage);
  assert.equal(resumedMessage.playerId, ownerPlayerId);
  assert.equal(resumedMessage.gameState.phase, 'preflop');
  assert.deepEqual(
    resumedMessage.gameState.players.find((player) => player.id === ownerPlayerId).hand.length,
    2,
  );

  cleanupHarness(harness, created.roomCode);
});

test('sit_out in waiting room keeps the player seated but out of the next hand', () => {
  const harness = createHarness();
  const owner = harness.connectSocket();
  const guest = harness.connectSocket();
  const sitter = harness.connectSocket();

  owner.sendMessage({ type: 'create_room', playerName: 'Owner', bigBlind: 10, maxPlayers: 4 });
  const created = owner.findMessage('room_created');
  guest.sendMessage({ type: 'join_room', roomCode: created.roomCode, playerName: 'Guest' });
  sitter.sendMessage({ type: 'join_room', roomCode: created.roomCode, playerName: 'Sitter' });

  sitter.sendMessage({ type: 'sit_out' });
  const room = harness.store.rooms.get(created.roomCode);
  const sitterId = sitter.findMessage('room_joined').playerId;
  const sitterPlayer = room.players.find((player) => player.id === sitterId);
  assert.equal(sitterPlayer.isSittingOut, true);

  owner.sendMessage({ type: 'start_game' });
  const state = owner.findMessage('game_state');
  const sitterState = state.players.find((player) => player.id === sitterId);
  assert.equal(sitterState.hand, null);

  cleanupHarness(harness, created.roomCode);
});

test('router emits structured engine events alongside state snapshots', () => {
  const harness = createHarness();
  const owner = harness.connectSocket();
  const guest = harness.connectSocket();

  owner.sendMessage({ type: 'create_room', playerName: 'Owner', bigBlind: 10, maxPlayers: 4 });
  const created = owner.findMessage('room_created');
  guest.sendMessage({ type: 'join_room', roomCode: created.roomCode, playerName: 'Guest' });
  owner.sendMessage({ type: 'start_game' });

  owner.sent.length = 0;
  owner.sendMessage({ type: 'action', action: 'call', amount: 0 });

  const engineEvent = owner.findMessage('engine_event');
  assert.ok(engineEvent);
  assert.equal(engineEvent.event.kind, 'action_applied');
  assert.equal(typeof engineEvent.event.handId, 'string');

  cleanupHarness(harness, created.roomCode);
});

test('router returns action_result acknowledgements for accepted and rejected actions', () => {
  const harness = createHarness();
  const owner = harness.connectSocket();
  const guest = harness.connectSocket();

  owner.sendMessage({ type: 'create_room', playerName: 'Owner', bigBlind: 10, maxPlayers: 4 });
  const created = owner.findMessage('room_created');
  guest.sendMessage({ type: 'join_room', roomCode: created.roomCode, playerName: 'Guest' });
  owner.sendMessage({ type: 'start_game' });

  owner.sent.length = 0;
  owner.sendMessage({ type: 'action', action: 'call', amount: 0 });
  const accepted = owner.findMessage('action_result');
  assert.ok(accepted);
  assert.equal(accepted.status, 'accepted');

  guest.sent.length = 0;
  guest.sendMessage({ type: 'action', action: 'raise', amount: 1 });
  const rejected = guest.findMessage('action_result');
  assert.ok(rejected);
  assert.equal(rejected.status, 'rejected');

  cleanupHarness(harness, created.roomCode);
});

test('router can return recent hand and event history snapshots', () => {
  const harness = createHarness();
  const owner = harness.connectSocket();
  const guest = harness.connectSocket();

  owner.sendMessage({ type: 'create_room', playerName: 'Owner', bigBlind: 10, maxPlayers: 4 });
  const created = owner.findMessage('room_created');
  guest.sendMessage({ type: 'join_room', roomCode: created.roomCode, playerName: 'Guest' });
  owner.sendMessage({ type: 'start_game' });

  owner.sent.length = 0;
  owner.sendMessage({ type: 'get_hand_history' });
  const history = owner.findMessage('history_snapshot');

  assert.ok(history);
  assert.ok(Array.isArray(history.history.recentHands));
  assert.ok(Array.isArray(history.history.recentEvents));
  assert.equal(history.history.recentEvents.some((event) => event.kind === 'hand_started'), true);

  cleanupHarness(harness, created.roomCode);
});

test('router allows joining an active room and seats the new player out until next hand', () => {
  const harness = createHarness();
  const owner = harness.connectSocket();
  const guest = harness.connectSocket();
  const lateJoiner = harness.connectSocket();

  owner.sendMessage({ type: 'create_room', playerName: 'Owner', bigBlind: 10, maxPlayers: 4 });
  const created = owner.findMessage('room_created');
  guest.sendMessage({ type: 'join_room', roomCode: created.roomCode, playerName: 'Guest' });
  owner.sendMessage({ type: 'start_game' });

  lateJoiner.sendMessage({ type: 'join_room', roomCode: created.roomCode, playerName: 'Late' });
  const joined = lateJoiner.findMessage('room_joined');
  const state = lateJoiner.findMessage('game_state');

  assert.ok(joined);
  assert.equal(joined.joinedMidHand, true);
  assert.ok(state);
  assert.equal(state.players.find((player) => player.name === 'Late').isSittingOut, true);

  cleanupHarness(harness, created.roomCode);
});

test('serialized game state includes live side-pot breakdown for all-in scenarios', () => {
  const harness = createHarness();
  const owner = harness.connectSocket();
  const guest = harness.connectSocket();
  const third = harness.connectSocket();

  owner.sendMessage({ type: 'create_room', playerName: 'Owner', bigBlind: 10, maxPlayers: 4 });
  const created = owner.findMessage('room_created');
  guest.sendMessage({ type: 'join_room', roomCode: created.roomCode, playerName: 'Guest' });
  third.sendMessage({ type: 'join_room', roomCode: created.roomCode, playerName: 'Third' });
  const room = harness.store.rooms.get(created.roomCode);
  const [a, b, c] = room.players;

  room.phase = 'turn';
  room.hand = {
    id: 'live-sidepots',
    phase: 'turn',
    deck: [],
    board: [],
    handNumber: 1,
    seats: {
      buttonSeatIndex: 0,
      smallBlindSeatIndex: 1,
      bigBlindSeatIndex: 2,
      actingSeatIndex: 0,
    },
    betting: {
      pot: 600,
      currentBet: 0,
      minRaise: 10,
      lastRaiseSize: 10,
      pendingSeatIndexes: [0],
      raiseRightsSeatIndexes: [0],
    },
    showdown: {
      seatIndexes: [],
    },
    log: {
      actionLog: [],
    },
  };
  a.holeCards = [{ rank: 'A', suit: '♠' }, { rank: 'A', suit: '♥' }];
  b.holeCards = [{ rank: 'K', suit: '♠' }, { rank: 'K', suit: '♥' }];
  c.holeCards = [{ rank: 'Q', suit: '♠' }, { rank: 'Q', suit: '♥' }];
  a.totalCommittedChips = 100;
  b.totalCommittedChips = 200;
  c.totalCommittedChips = 300;

  const state = serializeGameState(room, a.id);

  assert.deepEqual(state.sidePots.map((pot) => pot.amount), [300, 200, 100]);
  cleanupHarness(harness, created.roomCode);
});

test('hand_result payload signals when the table is waiting for rebuys or joiners', () => {
  const harness = createHarness();
  const owner = harness.connectSocket();
  const guest = harness.connectSocket();

  owner.sendMessage({ type: 'create_room', playerName: 'Owner', bigBlind: 10, maxPlayers: 4 });
  const created = owner.findMessage('room_created');
  guest.sendMessage({ type: 'join_room', roomCode: created.roomCode, playerName: 'Guest' });
  owner.sendMessage({ type: 'start_game' });

  const room = harness.store.rooms.get(created.roomCode);
  room.gameSession.restartDelayMs = 10000;

  owner.sent.length = 0;
  guest.sent.length = 0;

  guest.sendMessage({ type: 'sit_out' });
  const result = owner.findMessage('hand_result');

  assert.ok(result);
  assert.equal(result.restartDelayMs, null);
  assert.equal(result.nextHandStartsAt, null);
  assert.equal(result.waitingForPlayers, true);

  cleanupHarness(harness, created.roomCode);
});

test('session pauses instead of ending the room when too few players remain for the next hand', async () => {
  const harness = createHarness();
  const owner = harness.connectSocket();
  const guest = harness.connectSocket();

  owner.sendMessage({ type: 'create_room', playerName: 'Owner', bigBlind: 10, maxPlayers: 4 });
  const created = owner.findMessage('room_created');
  guest.sendMessage({ type: 'join_room', roomCode: created.roomCode, playerName: 'Guest' });
  owner.sendMessage({ type: 'start_game' });

  const room = harness.store.rooms.get(created.roomCode);
  room.gameSession.restartDelayMs = 20;

  owner.sent.length = 0;
  guest.sent.length = 0;

  guest.sendMessage({ type: 'sit_out' });
  await new Promise((resolve) => setTimeout(resolve, 40));

  const paused = owner.findMessage('session_paused');
  const gameOver = owner.findMessage('game_over');

  assert.ok(paused);
  assert.equal(gameOver, null);
  assert.equal(room.gameSession.active, true);
  assert.equal(room.phase, 'waiting');
  assert.equal(room.gameSession.pausedReason, 'waiting_for_players');

  cleanupHarness(harness, created.roomCode);
});

test('rebuy records buy-in history and resumes a paused session', async () => {
  const harness = createHarness();
  const owner = harness.connectSocket();
  const guest = harness.connectSocket();

  owner.sendMessage({ type: 'create_room', playerName: 'Owner', bigBlind: 10, maxPlayers: 4 });
  const created = owner.findMessage('room_created');
  guest.sendMessage({ type: 'join_room', roomCode: created.roomCode, playerName: 'Guest' });
  const joined = guest.findMessage('room_joined');
  owner.sendMessage({ type: 'start_game' });

  const room = harness.store.rooms.get(created.roomCode);
  room.gameSession.restartDelayMs = 20;
  guest.sent.length = 0;

  const guestPlayer = room.players.find((player) => player.id === joined.playerId);
  guestPlayer.chips = 0;
  guestPlayer.isSittingOut = true;

  pauseSessionForTest(room, harness.store);
  guest.sendMessage({ type: 'rebuy', amount: 500 });
  const rebuyResult = guest.findMessage('rebuy_result');

  assert.ok(rebuyResult);
  assert.equal(rebuyResult.status, 'accepted');
  assert.equal(guestPlayer.chips, 500);
  assert.equal(guestPlayer.totalBuyIn, 1500);
  assert.equal(guestPlayer.buyInHistory.at(-1).amount, 500);
  assert.equal(guestPlayer.isSittingOut, false);

  await new Promise((resolve) => setTimeout(resolve, 40));
  const resumedState = owner.findMessage('game_state');
  assert.ok(resumedState);
  assert.equal(room.phase, 'preflop');

  cleanupHarness(harness, created.roomCode);
});

test('scoreboard serializes total buy-ins and running profit/loss', () => {
  const harness = createHarness();
  const owner = harness.connectSocket();

  owner.sendMessage({ type: 'create_room', playerName: 'Owner', bigBlind: 10, maxPlayers: 4 });
  const created = owner.findMessage('room_created');
  const room = harness.store.rooms.get(created.roomCode);
  const player = room.players[0];

  player.chips = 1350;
  player.totalBuyIn = 1600;
  player.buyInHistory.push({ amount: 600, kind: 'rebuy', ts: Date.now() });

  const lobby = serializeGameState(room, player.id);
  const scoreboardEntry = lobby.scores.find((entry) => entry.id === player.id);

  assert.equal(scoreboardEntry.totalBuyIn, 1600);
  assert.equal(scoreboardEntry.profitLoss, -250);
  assert.equal(scoreboardEntry.score, -250);
  assert.equal(scoreboardEntry.buyInCount, 2);

  cleanupHarness(harness, created.roomCode);
});

function pauseSessionForTest(room, store) {
  room.phase = 'waiting';
  room.gameSession.pausedReason = 'waiting_for_players';
  room.gameSession.active = true;
  if (room.gameSession.nextHandTimer) {
    clearTimeout(room.gameSession.nextHandTimer);
    room.gameSession.nextHandTimer = null;
  }
  if (store && room.players.length) {
    room.updatedAt = Date.now();
  }
}

function createHarness() {
  const wss = new EventEmitter();
  const store = createStore();
  registerWebSocketServer(wss, store);

  return {
    connectSocket() {
      const socket = createFakeSocket();
      wss.emit('connection', socket);
      return socket;
    },
    store,
  };
}

function createFakeSocket() {
  const socket = new EventEmitter();
  socket.readyState = WebSocket.OPEN;
  socket.sent = [];
  socket.send = (payload) => {
    socket.sent.push(JSON.parse(payload));
  };
  socket.sendMessage = (payload) => {
    socket.emit('message', JSON.stringify(payload));
  };
  socket.findMessage = (type) => {
    for (let index = socket.sent.length - 1; index >= 0; index -= 1) {
      if (socket.sent[index].type === type) {
        return socket.sent[index];
      }
    }
    return null;
  };
  socket.closeSocket = () => {
    socket.readyState = WebSocket.CLOSED;
    socket.emit('close');
  };
  return socket;
}

function cleanupHarness(harness, roomCode) {
  const room = harness.store.rooms.get(roomCode);
  if (!room || !room.gameSession) {
    return;
  }

  if (room.gameSession.actionTimeoutTimer) {
    clearTimeout(room.gameSession.actionTimeoutTimer);
  }
  if (room.gameSession.nextHandTimer) {
    clearTimeout(room.gameSession.nextHandTimer);
  }
  for (const timer of room.gameSession.disconnectTimers.values()) {
    clearTimeout(timer);
  }
}
