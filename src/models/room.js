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
    history: {
      recentHands: [],
      recentEvents: [],
      maxHands: 12,
      maxEvents: 100,
    },
    settings: {
      startingChips: DEFAULTS.startingChips,
    },
    gameSession: {
      active: false,
      restartDelayMs: 10000,
      actionTimeoutMs: 40000,
      idleTimeoutMs: 60 * 60 * 1000,
      disconnectGraceMs: 180000,
      nextHandTimer: null,
      actionTimeoutTimer: null,
      idleTimeoutTimer: null,
      actionPlayerId: null,
      actionSeatIndex: null,
      actionHandId: null,
      actionDeadlineAt: null,
      idleDeadlineAt: Date.now() + (60 * 60 * 1000),
      lastActivityAt: Date.now(),
      disconnectTimers: new Map(),
      pausedReason: null,
      finalizedAt: null,
      finalReason: null,
    },
  };
}

module.exports = {
  createRoom,
};
