'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyAction, handlePlayerExit, initializeHand } = require('../src/engine/hand-flow');
const { compareEvaluations, evaluateBestHand } = require('../src/engine/hand-evaluator');
const { buildSidePots } = require('../src/engine/settlement');
const { createHandState } = require('../src/models/hand');
const { createPlayer } = require('../src/models/player');
const { createRoom } = require('../src/models/room');
const { prepareNextHandOrWaiting } = require('../src/engine/hand-reset');

test('evaluateBestHand prefers a straight flush over four of a kind', () => {
  const straightFlush = evaluateBestHand([
    card('A', '♠'),
    card('K', '♠'),
    card('Q', '♠'),
    card('J', '♠'),
    card('10', '♠'),
    card('2', '♦'),
    card('3', '♣'),
  ]);
  const fourKind = evaluateBestHand([
    card('9', '♠'),
    card('9', '♥'),
    card('9', '♦'),
    card('9', '♣'),
    card('A', '♠'),
    card('K', '♦'),
    card('2', '♣'),
  ]);

  assert.equal(straightFlush.name, 'Straight Flush');
  assert.equal(fourKind.name, 'Four of a Kind');
  assert.ok(compareEvaluations(straightFlush, fourKind) > 0);
});

test('initializeHand applies heads-up blind and acting-seat rules', () => {
  const room = createTestRoom(['a', 'b']);

  initializeHand(room);

  assert.equal(room.phase, 'preflop');
  assert.equal(room.hand.seats.buttonSeatIndex, 0);
  assert.equal(room.hand.seats.smallBlindSeatIndex, 0);
  assert.equal(room.hand.seats.bigBlindSeatIndex, 1);
  assert.equal(room.hand.seats.actingSeatIndex, 0);
});

test('initializeHand skips disconnected players when seating a new hand', () => {
  const room = createTestRoom(['a', 'b', 'c']);
  room.players[2].connectionState = 'disconnected';

  initializeHand(room);

  assert.equal(room.players[0].holeCards.length, 2);
  assert.equal(room.players[1].holeCards.length, 2);
  assert.equal(room.players[2].holeCards.length, 0);
  assert.equal(room.hand.seats.smallBlindSeatIndex, 0);
  assert.equal(room.hand.seats.bigBlindSeatIndex, 1);
});

test('initializeHand preserves disconnected players outside the hand', () => {
  const room = createTestRoom(['a', 'b', 'c']);
  room.players[2].connectionState = 'disconnected';

  initializeHand(room);

  assert.equal(room.players[2].connectionState, 'disconnected');
  assert.equal(room.players[2].holeCards.length, 0);
});

test('between-hand waiting state does not allow new players to count as joinable session state', () => {
  const room = createTestRoom(['a', 'b']);
  room.gameSession.active = true;

  initializeHand(room);
  prepareNextHandOrWaiting(room);

  assert.equal(room.phase, 'waiting');
  assert.equal(room.gameSession.active, true);
});

test('preflop action sequence advances to flop', () => {
  const room = createTestRoom(['a', 'b', 'c']);

  initializeHand(room);

  let actor = actingPlayer(room);
  let result = applyAction(room, actor, 'call', 0);
  assert.equal(result.ok, true);

  actor = actingPlayer(room);
  result = applyAction(room, actor, 'call', 0);
  assert.equal(result.ok, true);

  actor = actingPlayer(room);
  result = applyAction(room, actor, 'check', 0);
  assert.equal(result.ok, true);
  assert.equal(result.outcome.type, 'phase_advanced');
  assert.equal(room.phase, 'flop');
  assert.equal(room.hand.board.length, 3);
});

test('short all-in increases the bet without reopening raising to prior actors', () => {
  const room = createTestRoom(['a', 'b', 'c']);
  room.players[1].chips = 45;

  initializeHand(room);

  let actor = actingPlayer(room);
  let result = applyAction(room, actor, 'raise', 40);
  assert.equal(result.ok, true);

  actor = actingPlayer(room);
  result = applyAction(room, actor, 'allin', 0);
  assert.equal(result.ok, true);
  assert.equal(room.hand.betting.currentBet, 45);

  actor = actingPlayer(room);
  result = applyAction(room, actor, 'call', 0);
  assert.equal(result.ok, true);

  actor = actingPlayer(room);
  result = applyAction(room, actor, 'raise', 100);
  assert.equal(result.ok, false);
  assert.match(result.error, /未重新打开加注权限/);
});

test('heads-up all-in does not skip the opponent response', () => {
  const room = createTestRoom(['a', 'b']);

  initializeHand(room);

  const actor = actingPlayer(room);
  const result = applyAction(room, actor, 'allin', 0);

  assert.equal(result.ok, true);
  assert.equal(result.outcome.type, 'state_only');
  assert.equal(room.phase, 'preflop');
  assert.equal(room.hand.seats.actingSeatIndex, 1);
  assert.deepEqual(room.hand.betting.pendingSeatIndexes, [1]);
});

test('river showdown resolves side pots across multiple winners', () => {
  const room = createTestRoom(['a', 'b', 'c']);
  const [a, b, c] = room.players;

  room.phase = 'river';
  room.hand = createHandState({
    id: 'river-sidepot',
    phase: 'river',
    deck: [],
    board: [card('K', '♠'), card('K', '♥'), card('2', '♣'), card('3', '♦'), card('4', '♣')],
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
    handNumber: 1,
    log: {
      actionLog: [],
    },
  });

  a.holeCards = [card('A', '♠'), card('A', '♥')];
  b.holeCards = [card('Q', '♠'), card('Q', '♥')];
  c.holeCards = [card('J', '♠'), card('J', '♥')];
  a.totalCommittedChips = 100;
  b.totalCommittedChips = 200;
  c.totalCommittedChips = 300;

  const result = applyAction(room, a, 'check', 0);

  assert.equal(result.ok, true);
  assert.equal(result.outcome.type, 'hand_result');
  assert.deepEqual(
    result.outcome.winners.map((winner) => [winner.name, winner.prize]),
    [['A', 300], ['B', 200], ['C', 100]],
  );
  assert.deepEqual(
    result.outcome.showdownPlayers.map((player) => [player.name, player.handType, player.prize]),
    [['A', 'Two Pair', 300], ['B', 'Two Pair', 200], ['C', 'Two Pair', 100]],
  );
});

test('folded players leave dead chips in the pot but cannot win at showdown', () => {
  const room = createTestRoom(['a', 'b', 'c']);
  const [a, b, c] = room.players;

  room.phase = 'river';
  room.hand = createHandState({
    id: 'river-folded',
    phase: 'river',
    deck: [],
    board: [card('A', '♣'), card('K', '♣'), card('Q', '♦'), card('7', '♥'), card('2', '♠')],
    seats: {
      buttonSeatIndex: 0,
      smallBlindSeatIndex: 1,
      bigBlindSeatIndex: 2,
      actingSeatIndex: 0,
    },
    betting: {
      pot: 700,
      currentBet: 0,
      minRaise: 10,
      lastRaiseSize: 10,
      pendingSeatIndexes: [0],
      raiseRightsSeatIndexes: [0],
    },
    showdown: {
      seatIndexes: [],
    },
    handNumber: 1,
    log: {
      actionLog: [],
    },
  });

  a.holeCards = [card('A', '♠'), card('10', '♠')];
  b.holeCards = [card('K', '♠'), card('10', '♣')];
  c.holeCards = [card('J', '♠'), card('J', '♥')];
  c.hasFolded = true;
  a.totalCommittedChips = 100;
  b.totalCommittedChips = 300;
  c.totalCommittedChips = 300;

  const result = applyAction(room, a, 'check', 0);

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.outcome.winners.map((winner) => [winner.name, winner.prize]),
    [['A', 300], ['B', 400]],
  );
});

function createTestRoom(playerIds) {
  const room = createRoom({
    code: 'TEST',
    ownerId: playerIds[0],
    bigBlind: 10,
    maxPlayers: 6,
  });

  playerIds.forEach((id, index) => {
    room.players.push(createPlayer({ id, name: id.toUpperCase(), seatIndex: index }));
  });

  return room;
}

function actingPlayer(room) {
  return room.players.find((player) => player.seatIndex === room.hand.seats.actingSeatIndex);
}

test('betting invariant keeps pot equal to total committed chips', () => {
  const room = createTestRoom(['a', 'b', 'c']);

  initializeHand(room);
  applyAction(room, actingPlayer(room), 'call', 0);
  applyAction(room, actingPlayer(room), 'raise', 40);
  applyAction(room, actingPlayer(room), 'call', 0);

  const totalCommitted = room.players.reduce((sum, player) => sum + player.totalCommittedChips, 0);
  assert.equal(room.hand.betting.pot, totalCommitted);
});

test('buildSidePots exposes live main pot and side pots from committed chips', () => {
  const room = createTestRoom(['a', 'b', 'c']);
  room.players[0].totalCommittedChips = 100;
  room.players[1].totalCommittedChips = 200;
  room.players[2].totalCommittedChips = 300;

  const sidePots = buildSidePots(room.players);

  assert.deepEqual(sidePots.map((pot) => pot.amount), [300, 200, 100]);
});

test('handlePlayerExit also removes raise rights for the leaving seat', () => {
  const room = createTestRoom(['a', 'b', 'c']);

  initializeHand(room);
  room.hand.betting.raiseRightsSeatIndexes = room.players.map((player) => player.seatIndex);

  handlePlayerExit(room, room.players[1].id);

  assert.equal(room.hand.betting.raiseRightsSeatIndexes.includes(room.players[1].seatIndex), false);
});

function card(rank, suit) {
  return { rank, suit };
}
