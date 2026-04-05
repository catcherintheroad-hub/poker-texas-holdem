'use strict';

const express = require('express');
const path = require('path');

function createApp(store) {
  const app = express();

  app.use(express.static(path.join(process.cwd(), 'public')));

  app.get('/api/rooms', (_request, response) => {
    const rooms = [...store.rooms.values()].map((room) => ({
      code: room.code,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      phase: room.phase,
      bigBlind: room.blinds.big,
    }));

    response.json({ rooms });
  });

  app.get('/api/debug/rooms', (_request, response) => {
    const rooms = [...store.rooms.values()].map((room) => ({
      code: room.code,
      phase: room.phase,
      ownerId: room.ownerId,
      buttonSeatIndex: room.buttonSeatIndex,
      handId: room.hand.id,
      actingSeatIndex: room.hand.actingSeatIndex,
      currentBet: room.hand.currentBet,
      pot: room.hand.pot,
      players: room.players.map((player) => ({
        id: player.id,
        name: player.name,
        seatIndex: player.seatIndex,
        chips: player.chips,
        connectionState: player.connectionState,
        isSittingOut: player.isSittingOut,
        hasFolded: player.hasFolded,
        isAllIn: player.isAllIn,
        disconnectedAt: player.disconnectedAt,
        disconnectDeadlineAt: player.disconnectDeadlineAt,
      })),
      gameSession: {
        active: room.gameSession.active,
        restartDelayMs: room.gameSession.restartDelayMs,
        actionTimeoutMs: room.gameSession.actionTimeoutMs,
        disconnectGraceMs: room.gameSession.disconnectGraceMs,
        actionPlayerId: room.gameSession.actionPlayerId,
        actionSeatIndex: room.gameSession.actionSeatIndex,
        actionHandId: room.gameSession.actionHandId,
        actionDeadlineAt: room.gameSession.actionDeadlineAt,
        hasNextHandTimer: Boolean(room.gameSession.nextHandTimer),
        hasActionTimeoutTimer: Boolean(room.gameSession.actionTimeoutTimer),
        disconnectTimerPlayerIds: [...room.gameSession.disconnectTimers.keys()],
      },
    }));

    response.json({ rooms, roomCount: rooms.length, generatedAt: Date.now() });
  });

  return app;
}

module.exports = {
  createApp,
};
