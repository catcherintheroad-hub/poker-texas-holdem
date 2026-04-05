'use strict';

const { DEFAULTS } = require('../engine/rules');

function createPlayer({ id, name, seatIndex }) {
  return {
    id,
    name,
    seatIndex,
    chips: DEFAULTS.startingChips,
    totalScore: 0,
    status: 'active',
    isSittingOut: false,
    connectionState: 'connected',
    disconnectedAt: null,
    disconnectDeadlineAt: null,
    holeCards: [],
    committedChips: 0,
    totalCommittedChips: 0,
    hasFolded: false,
    isAllIn: false,
    lastAction: null,
  };
}

module.exports = {
  createPlayer,
};
