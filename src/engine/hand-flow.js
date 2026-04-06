'use strict';

const { advancePhase } = require('./hand-progression');
const { initializeHand } = require('./hand-setup');
const { applyAction: applyBettingAction, getNextActingSeat, isBettingRoundComplete } = require('./betting-round');
const { getRemainingPlayers, resolveUncontestedWin } = require('./settlement');
const { normalizeHandState } = require('../models/hand');

function applyAction(room, player, action, amount) {
  room.hand = normalizeHandState(room.hand);
  return applyBettingAction(room, player, action, amount, {
    advancePhase,
    resolveUncontestedWin,
  });
}

function handlePlayerExit(room, playerId) {
  if (!room || room.phase === 'waiting') {
    return null;
  }

  room.hand = normalizeHandState(room.hand);

  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) {
    return null;
  }

  player.hasFolded = true;
  player.status = 'folded';
  player.holeCards = [];
  player.lastAction = 'left';
  removePendingSeat(room.hand.betting.pendingSeatIndexes, player.seatIndex);

  const remainingPlayers = getRemainingPlayers(room);
  if (remainingPlayers.length === 1) {
    return resolveUncontestedWin(room, remainingPlayers[0]);
  }

  if (room.hand.seats.actingSeatIndex === player.seatIndex) {
    if (isBettingRoundComplete(room)) {
      return advancePhase(room);
    }

    room.hand.seats.actingSeatIndex = getNextActingSeat(room, player.seatIndex);
  }

  room.updatedAt = Date.now();
  return { type: 'state_only' };
}

function removePendingSeat(pendingSeatIndexes, seatIndex) {
  const index = pendingSeatIndexes.indexOf(seatIndex);
  if (index >= 0) {
    pendingSeatIndexes.splice(index, 1);
  }
}

module.exports = {
  applyAction,
  handlePlayerExit,
  initializeHand,
};
