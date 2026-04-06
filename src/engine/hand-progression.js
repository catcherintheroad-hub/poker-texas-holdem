'use strict';

const { drawCards } = require('./cards');
const {
  getFirstActingSeatForPhase,
  initializeBettingRound,
  isBettingRoundComplete,
} = require('./betting-round');
const { resolveShowdown } = require('./settlement');

const BOARD_CARD_COUNT = {
  preflop: 0,
  flop: 3,
  turn: 1,
  river: 1,
};

const NEXT_PHASE = {
  preflop: 'flop',
  flop: 'turn',
  turn: 'river',
  river: 'showdown',
};

function advancePhase(room) {
  const nextPhase = NEXT_PHASE[room.phase];

  if (!nextPhase || nextPhase === 'showdown') {
    return resolveShowdown(room);
  }

  const drawCount = BOARD_CARD_COUNT[nextPhase];
  if (drawCount > 0) {
    room.hand.board.push(...drawCards(room.hand.deck, drawCount));
  }

  const actingSeatIndex = getFirstActingSeatForPhase(room, nextPhase);
  initializeBettingRound(room, nextPhase, actingSeatIndex);
  if (isBettingRoundComplete(room)) {
    return advancePhase(room);
  }

  return { type: 'phase_advanced', phase: nextPhase };
}

module.exports = {
  advancePhase,
};
