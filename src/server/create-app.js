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

  return app;
}

module.exports = {
  createApp,
};
