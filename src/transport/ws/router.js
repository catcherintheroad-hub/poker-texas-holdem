'use strict';

const WebSocket = require('ws');
const { createDeck, drawCards, shuffleDeck } = require('../../engine/cards');
const { DEFAULTS } = require('../../engine/rules');
const {
  findNextAvailableSeat,
  findPlayerBySeat,
  getNextOccupiedSeat,
  sortPlayersBySeat,
} = require('../../engine/seats');
const { createHandState } = require('../../models/hand');
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
      handleAction({ context, socket, store });
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

function handleAction({ context, socket, store }) {
  const room = getRoomForContext(context, store);
  if (!room) {
    sendJson(socket, { type: 'error', message: '房间不存在' });
    return;
  }

  sendJson(socket, {
    type: 'error',
    message: '当前分支只完成了引擎骨架，下注与结算逻辑将在后续分支实现',
  });
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

  if (room.hand.actingSeatIndex === player.seatIndex) {
    room.hand.actingSeatIndex = getNextOccupiedSeat(room.players, player.seatIndex, room.maxPlayers);
  }

  broadcastRoom(room, store, {
    type: 'player_left',
    playerId,
    players: serializeRoomLobby(room).players,
    newOwnerId: room.ownerId,
    scores: serializeRoomLobby(room).scores,
  });

  if (room.phase !== 'waiting') {
    broadcastGameState(room, store);
  }
}

function initializeHand(room) {
  const seatedPlayers = sortPlayersBySeat(room.players).filter((player) => player.chips > 0);
  const isHeadsUp = seatedPlayers.length === 2;
  const buttonSeatIndex = getNextOccupiedSeat(
    seatedPlayers,
    room.buttonSeatIndex >= 0 ? room.buttonSeatIndex : seatedPlayers[seatedPlayers.length - 1].seatIndex,
    room.maxPlayers,
  );
  const smallBlindSeatIndex = isHeadsUp
    ? buttonSeatIndex
    : getNextOccupiedSeat(seatedPlayers, buttonSeatIndex, room.maxPlayers);
  const bigBlindSeatIndex = getNextOccupiedSeat(seatedPlayers, smallBlindSeatIndex, room.maxPlayers);
  const actingSeatIndex = isHeadsUp
    ? smallBlindSeatIndex
    : getNextOccupiedSeat(seatedPlayers, bigBlindSeatIndex, room.maxPlayers);
  const deck = shuffleDeck(createDeck());

  for (const player of room.players) {
    player.holeCards = [];
    player.status = player.chips > 0 ? 'active' : 'sitting_out';
    player.connectionState = 'connected';
    player.committedChips = 0;
    player.hasFolded = false;
    player.isAllIn = false;
    player.lastAction = null;
  }

  for (const player of seatedPlayers) {
    player.holeCards = drawCards(deck, 2);
  }

  const smallBlindAmount = postBlind(findPlayerBySeat(room.players, smallBlindSeatIndex), room.blinds.small);
  const bigBlindAmount = postBlind(findPlayerBySeat(room.players, bigBlindSeatIndex), room.blinds.big);

  room.buttonSeatIndex = buttonSeatIndex;
  room.phase = 'preflop';
  room.hand = createHandState({
    id: `${room.code}-${Date.now()}`,
    phase: 'preflop',
    deck,
    board: [],
    // This branch only bootstraps a hand and turn order; betting progression comes later.
    pot: smallBlindAmount + bigBlindAmount,
    currentBet: room.blinds.big,
    minRaise: room.blinds.big * 2,
    buttonSeatIndex,
    smallBlindSeatIndex,
    bigBlindSeatIndex,
    actingSeatIndex,
    handNumber: room.hand.handNumber + 1,
    actionLog: [
      { type: 'system', message: 'Hand initialized from modular engine scaffold' },
    ],
  });
  room.updatedAt = Date.now();
}

function postBlind(player, amount) {
  if (!player) {
    return 0;
  }

  const blindAmount = Math.min(amount, player.chips);
  player.chips -= blindAmount;
  player.committedChips = blindAmount;
  player.isAllIn = player.chips === 0;
  player.lastAction = blindAmount === amount ? `blind ${blindAmount}` : `all-in blind ${blindAmount}`;
  return blindAmount;
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

module.exports = {
  registerWebSocketServer,
};
