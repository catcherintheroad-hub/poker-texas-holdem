'use strict';

const { cardToString } = require('../../engine/cards');
const { applyAction, handlePlayerExit, initializeHand } = require('../../engine/hand-flow');
const { DEFAULTS } = require('../../engine/rules');
const {
  findNextAvailableSeat,
  getNextOccupiedSeat,
  sortPlayersBySeat,
} = require('../../engine/seats');
const { createPlayer } = require('../../models/player');
const { createRoom } = require('../../models/room');
const {
  broadcastGameState,
  broadcastRoom,
  sendJson,
  serializeRoomLobby,
} = require('./messages');

function registerWebSocketServer(wss, store) {
  wss.on('connection', (socket) => {
    const context = {
      playerId: store.createPlayerId(),
      roomCode: null,
    };

    store.sockets.set(context.playerId, socket);

    socket.on('message', (rawMessage) => {
      let message;

      try {
        message = JSON.parse(rawMessage);
      } catch {
        sendJson(socket, { type: 'error', message: '无效消息格式' });
        return;
      }

      routeMessage({ context, message, socket, store });
    });

    socket.on('close', () => {
      handleDisconnect({ context, store });
    });

    socket.on('error', () => {
      handleDisconnect({ context, store });
    });
  });
}

function routeMessage({ context, message, socket, store }) {
  switch (message.type) {
    case 'create_room':
      handleCreateRoom({ context, message, socket, store });
      return;
    case 'join_room':
      handleJoinRoom({ context, message, socket, store });
      return;
    case 'start_game':
      handleStartGame({ context, socket, store });
      return;
    case 'action':
      handleAction({ context, message, socket, store });
      return;
    case 'chat':
      handleChat({ context, message, socket, store });
      return;
    case 'leave_room':
      handleLeaveRoom({ context, store });
      return;
    default:
      sendJson(socket, { type: 'error', message: '未知消息类型' });
  }
}

function handleCreateRoom({ context, message, socket, store }) {
  if (context.roomCode) {
    sendJson(socket, { type: 'error', message: '你已经在房间中' });
    return;
  }

  const bigBlind = clampNumber(message.bigBlind, DEFAULTS.minBigBlind, DEFAULTS.maxBigBlind, DEFAULTS.minBigBlind);
  const maxPlayers = clampNumber(message.maxPlayers, DEFAULTS.minPlayers, DEFAULTS.maxPlayers, DEFAULTS.maxPlayers);
  const code = store.createRoomCode();
  const room = createRoom({
    code,
    ownerId: context.playerId,
    bigBlind,
    maxPlayers,
  });
  const player = createPlayer({
    id: context.playerId,
    name: normalizePlayerName(message.playerName),
    seatIndex: 0,
  });

  room.players.push(player);
  room.updatedAt = Date.now();
  store.rooms.set(code, room);
  context.roomCode = code;

  sendJson(socket, {
    type: 'room_created',
    roomCode: code,
    playerId: context.playerId,
    player: { id: player.id, name: player.name, seatIndex: player.seatIndex, chips: player.chips },
    room: serializeRoomLobby(room),
  });
}

function handleJoinRoom({ context, message, socket, store }) {
  if (context.roomCode) {
    sendJson(socket, { type: 'error', message: '你已经在房间中' });
    return;
  }

  const code = String(message.roomCode || '').trim().toUpperCase();
  const room = store.rooms.get(code);

  if (!room) {
    sendJson(socket, { type: 'error', message: '房间不存在' });
    return;
  }

  if (room.phase !== 'waiting') {
    sendJson(socket, { type: 'error', message: '当前分支暂不支持游戏进行中途加入' });
    return;
  }

  if (room.players.length >= room.maxPlayers) {
    sendJson(socket, { type: 'error', message: '房间已满' });
    return;
  }

  const seatIndex = findNextAvailableSeat(room.players, room.maxPlayers);
  if (seatIndex < 0) {
    sendJson(socket, { type: 'error', message: '没有可用座位' });
    return;
  }

  const player = createPlayer({
    id: context.playerId,
    name: normalizePlayerName(message.playerName),
    seatIndex,
  });

  room.players.push(player);
  room.updatedAt = Date.now();
  context.roomCode = room.code;

  sendJson(socket, {
    type: 'room_joined',
    roomCode: room.code,
    playerId: context.playerId,
    player: { id: player.id, name: player.name, seatIndex: player.seatIndex, chips: player.chips },
    room: serializeRoomLobby(room),
  });

  broadcastRoom(room, store, {
    type: 'player_joined',
    player: { id: player.id, name: player.name, seatIndex: player.seatIndex, chips: player.chips },
    players: serializeRoomLobby(room).players,
    scores: serializeRoomLobby(room).scores,
  });
}

function handleStartGame({ context, socket, store }) {
  const room = getRoomForContext(context, store);
  if (!room) {
    sendJson(socket, { type: 'error', message: '房间不存在' });
    return;
  }

  if (room.ownerId !== context.playerId) {
    sendJson(socket, { type: 'error', message: '只有房主可以开始游戏' });
    return;
  }

  const eligiblePlayers = room.players.filter((player) => player.chips > 0);
  if (eligiblePlayers.length < DEFAULTS.minPlayers) {
    sendJson(socket, { type: 'error', message: '至少需要2名有筹码的玩家' });
    return;
  }

  initializeHand(room);
  broadcastGameState(room, store);
}

function handleAction({ context, message, socket, store }) {
  const room = getRoomForContext(context, store);
  if (!room) {
    sendJson(socket, { type: 'error', message: '房间不存在' });
    return;
  }

  const player = room.players.find((entry) => entry.id === context.playerId);
  if (!player) {
    sendJson(socket, { type: 'error', message: '玩家不存在' });
    return;
  }

  const result = applyAction(room, player, message.action, message.amount);
  if (!result.ok) {
    sendJson(socket, { type: 'error', message: result.error });
    return;
  }

  publishOutcome(room, store, result.outcome);
}

function handleChat({ context, message, socket, store }) {
  const room = getRoomForContext(context, store);
  if (!room) {
    sendJson(socket, { type: 'error', message: '房间不存在' });
    return;
  }

  const player = room.players.find((entry) => entry.id === context.playerId);
  if (!player) {
    sendJson(socket, { type: 'error', message: '玩家不存在' });
    return;
  }

  const text = String(message.message || '')
    .slice(0, DEFAULTS.maxChatLength)
    .replace(/[<>]/g, '')
    .trim();

  if (!text) {
    return;
  }

  room.chatHistory.push({
    fromPlayerId: player.id,
    fromName: player.name,
    message: text,
    timestamp: Date.now(),
  });
  room.updatedAt = Date.now();

  if (room.chatHistory.length > 100) {
    room.chatHistory.shift();
  }

  broadcastRoom(room, store, {
    type: 'chat_message',
    from: player.name,
    message: text,
  });
}

function handleLeaveRoom({ context, store }) {
  const room = getRoomForContext(context, store);
  if (!room) {
    return;
  }

  removePlayerFromRoom(room, context.playerId, store);
  context.roomCode = null;
}

function handleDisconnect({ context, store }) {
  const room = getRoomForContext(context, store);
  if (room) {
    removePlayerFromRoom(room, context.playerId, store);
  }

  store.sockets.delete(context.playerId);
  context.roomCode = null;
}

function removePlayerFromRoom(room, playerId, store) {
  const outcome = handlePlayerExit(room, playerId);
  const playerIndex = room.players.findIndex((player) => player.id === playerId);
  if (playerIndex < 0) {
    return;
  }

  const [player] = room.players.splice(playerIndex, 1);
  room.updatedAt = Date.now();

  if (room.players.length === 0) {
    store.rooms.delete(room.code);
    return;
  }

  if (room.ownerId === playerId) {
    room.ownerId = sortPlayersBySeat(room.players)[0].id;
  }

  if (room.phase !== 'waiting' && room.hand.actingSeatIndex === player.seatIndex) {
    room.hand.actingSeatIndex = getNextOccupiedSeat(room.players, player.seatIndex, room.maxPlayers);
  }

  broadcastRoom(room, store, {
    type: 'player_left',
    playerId,
    players: serializeRoomLobby(room).players,
    newOwnerId: room.ownerId,
    scores: serializeRoomLobby(room).scores,
  });

  if (outcome) {
    publishOutcome(room, store, outcome);
    return;
  }

  if (room.phase !== 'waiting') {
    broadcastGameState(room, store);
  }
}

function getRoomForContext(context, store) {
  if (!context.roomCode) {
    return null;
  }

  return store.rooms.get(context.roomCode) || null;
}

function normalizePlayerName(name) {
  return String(name || 'Player').slice(0, DEFAULTS.maxPlayerNameLength).trim() || 'Player';
}

function clampNumber(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (Number.isNaN(number)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, number));
}

function publishOutcome(room, store, outcome) {
  if (!outcome) {
    broadcastGameState(room, store);
    return;
  }

  switch (outcome.type) {
    case 'hand_result':
      broadcastRoom(room, store, {
        type: 'hand_result',
        winners: outcome.winners.map((winner) => ({
          id: winner.id,
          name: winner.name,
          hand: winner.hand.map(cardToString),
          handType: outcome.handType,
        })),
        prize: outcome.prize,
        pot: outcome.pot,
        communityCards: outcome.communityCards.map(cardToString),
        scores: serializeRoomLobby(room).scores,
      });
      broadcastGameState(room, store);
      return;
    case 'showdown_pending':
      broadcastGameState(room, store);
      broadcastRoom(room, store, {
        type: 'error',
        message: '已进入 showdown，牌型比较与分池将在下一分支完成',
      });
      return;
    case 'phase_advanced':
    case 'state_only':
    default:
      broadcastGameState(room, store);
  }
}

module.exports = {
  registerWebSocketServer,
};
