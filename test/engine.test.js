'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyAction, initializeHand } = require('../src/engine/hand-flow');
const { compareEvaluations, evaluateBestHand } = require('../src/engine/hand-evaluator');
const { createPlayer } = require('../src/models/player');
const { createRoom } = require('../src/models/room');

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
  assert.equal(room.hand.buttonSeatIndex, 0);
  assert.equal(room.hand.smallBlindSeatIndex, 0);
  assert.equal(room.hand.bigBlindSeatIndex, 1);
  assert.equal(room.hand.actingSeatIndex, 0);
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

test('river showdown resolves side pots across multiple winners', () => {
  const room = createTestRoom(['a', 'b', 'c']);
  const [a, b, c] = room.players;

  room.phase = 'river';
  room.hand = {
    id: 'river-sidepot',
    phase: 'river',
    deck: [],
    board: [card('K', '♠'), card('K', '♥'), card('2', '♣'), card('3', '♦'), card('4', '♣')],
    pot: 600,
    currentBet: 0,
    minRaise: 10,
    lastRaiseSize: 10,
    buttonSeatIndex: 0,
    smallBlindSeatIndex: 1,
    bigBlindSeatIndex: 2,
    actingSeatIndex: 0,
    pendingSeatIndexes: [0],
    showdownSeatIndexes: [],
    handNumber: 1,
    actionLog: [],
  };

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
});

test('folded players leave dead chips in the pot but cannot win at showdown', () => {
  const room = createTestRoom(['a', 'b', 'c']);
  const [a, b, c] = room.players;

  room.phase = 'river';
  room.hand = {
    id: 'river-folded',
    phase: 'river',
    deck: [],
    board: [card('A', '♣'), card('K', '♣'), card('Q', '♦'), card('7', '♥'), card('2', '♠')],
    pot: 700,
    currentBet: 0,
    minRaise: 10,
    lastRaiseSize: 10,
    buttonSeatIndex: 0,
    smallBlindSeatIndex: 1,
    bigBlindSeatIndex: 2,
    actingSeatIndex: 0,
    pendingSeatIndexes: [0],
    showdownSeatIndexes: [],
    handNumber: 1,
    actionLog: [],
  };

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
  return room.players.find((player) => player.seatIndex === room.hand.actingSeatIndex);
}

function card(rank, suit) {
  return { rank, suit };
}
