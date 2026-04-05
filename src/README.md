# Poker Engine Scaffold

This branch introduces a real backend layout under `src/` without claiming full Texas Hold'em gameplay is complete yet.

- `engine/`: poker rules, deck helpers, seat traversal
- `models/`: room, player, and hand state factories
- `state/`: in-memory store for rooms and sockets
- `transport/`: WebSocket protocol handling and room-state serialization
- `server/`: HTTP app and bootstrap wiring

Future branches can extend betting rounds, pots, side pots, validation, and showdown logic on top of these modules instead of growing `server.js`.
