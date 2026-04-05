'use strict';

function createEmptyHandState() {
  return {
    id: null,
    phase: 'waiting',
    deck: [],
    board: [],
    pot: 0,
    currentBet: 0,
    minRaise: 0,
    lastRaiseSize: 0,
    buttonSeatIndex: -1,
    smallBlindSeatIndex: -1,
    bigBlindSeatIndex: -1,
    actingSeatIndex: -1,
    pendingSeatIndexes: [],
    showdownSeatIndexes: [],
    handNumber: 0,
    actionLog: [],
  };
}

function createHandState(overrides = {}) {
  return {
    ...createEmptyHandState(),
    ...overrides,
  };
}

module.exports = {
  createEmptyHandState,
  createHandState,
};
