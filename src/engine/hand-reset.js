'use strict';

const { createHandState } = require('../models/hand');

function prepareNextHandOrWaiting(room) {
  room.phase = 'waiting';
  room.hand = createHandState({
    handNumber: room.hand.handNumber,
    phase: 'waiting',
  });
  room.updatedAt = Date.now();

  for (const player of room.players) {
    player.committedChips = 0;
    player.totalCommittedChips = 0;
    player.holeCards = [];
    player.lastAction = null;
    player.hasFolded = false;
    player.isAllIn = false;
    player.status = player.chips > 0 ? 'active' : 'sitting_out';
  }
}

module.exports = {
  prepareNextHandOrWaiting,
};
