'use strict';

const http = require('http');
const WebSocket = require('ws');
const { DEFAULTS } = require('../engine/rules');
const { createApp } = require('./create-app');
const { createStore } = require('../state/store');
const { registerWebSocketServer } = require('../transport/ws/router');

function startServer(options = {}) {
  const port = Number.parseInt(process.env.PORT, 10) || options.port || DEFAULTS.port;
  const host = process.env.HOST || options.host || DEFAULTS.host;
  const store = createStore();
  const app = createApp(store);
  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server });

  registerWebSocketServer(wss, store);

  server.listen(port, host, () => {
    console.log(`Poker server running on http://localhost:${port}`);
    console.log(`Open http://localhost:${port}/poker.html to play`);
  });

  return { app, server, store, wss };
}

module.exports = {
  startServer,
};
