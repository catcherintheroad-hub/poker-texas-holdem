'use strict';

const { DEFAULTS } = require('../engine/rules');
const { createEmptyHandState } = require('./hand');

function createRoom({ code, ownerId, bigBlind, maxPlayers }) {
  return {
    code,
    ownerId,
    maxPlayers,
    blinds: {
      small: Math.max(1, Math.floor(bigBlind / 2)),
      big: bigBlind,
    },
    phase: 'waiting',
    players: [],
    hand: createEmptyHandState(),
    buttonSeatIndex: -1,
    chatHistory: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    scores: {},
    settings: {
      startingChips: DEFAULTS.startingChips,
    },
    gameSession: {
      active: false,
      restartDelayMs: 4000,
      actionTimeoutMs: 25000,
      disconnectGraceMs: 30000,
      nextHandTimer: null,
      actionTimeoutTimer: null,
      actionPlayerId: null,
      actionSeatIndex: null,
      actionHandId: null,
      actionDeadlineAt: null,
      disconnectTimers: new Map(),
    },
  };
}

module.exports = {
  createRoom,
};
