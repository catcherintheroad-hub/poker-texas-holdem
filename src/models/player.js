'use strict';

const { DEFAULTS } = require('../engine/rules');

function createPlayer({ id, name, seatIndex }) {
  const startingChips = DEFAULTS.startingChips;
  return {
    id,
    name,
    seatIndex,
    chips: startingChips,
    totalScore: 0,
    totalBuyIn: startingChips,
    buyInHistory: [
      {
        amount: startingChips,
        kind: 'initial',
        ts: Date.now(),
      },
    ],
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
