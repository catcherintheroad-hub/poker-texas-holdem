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
      hand: {
        id: room.hand.id,
        phase: room.hand.phase,
        handNumber: room.hand.handNumber,
        board: room.hand.board,
        seats: {
          buttonSeatIndex: room.hand.seats.buttonSeatIndex,
          smallBlindSeatIndex: room.hand.seats.smallBlindSeatIndex,
          bigBlindSeatIndex: room.hand.seats.bigBlindSeatIndex,
          actingSeatIndex: room.hand.seats.actingSeatIndex,
        },
        betting: {
          currentBet: room.hand.betting.currentBet,
          pot: room.hand.betting.pot,
          minRaise: room.hand.betting.minRaise,
          lastRaiseSize: room.hand.betting.lastRaiseSize,
          pendingSeatIndexes: room.hand.betting.pendingSeatIndexes,
          raiseRightsSeatIndexes: room.hand.betting.raiseRightsSeatIndexes,
        },
        showdown: {
          seatIndexes: room.hand.showdown.seatIndexes,
        },
      },
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
      history: room.history,
    }));

    response.json({ rooms, roomCount: rooms.length, generatedAt: Date.now() });
  });

  return app;
}

module.exports = {
  createApp,
};
