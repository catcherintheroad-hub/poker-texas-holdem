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
  serializeGameState,
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
    case 'resume_session':
      handleResumeSession({ context, message, socket, store });
      return;
    case 'start_game':
      handleStartGame({ context, socket, store });
      return;
    case 'sit_out':
      handleParticipationChange({ context, store, mode: 'sit_out' });
      return;
    case 'sit_in':
      handleParticipationChange({ context, store, mode: 'sit_in' });
      return;
    case 'spectate':
      handleParticipationChange({ context, store, mode: 'spectate' });
      return;
    case 'action':
      handleAction({ context, message, socket, store });
      return;
    case 'chat':
      handleChat({ context, message, socket, store });
      return;
    case 'get_hand_history':
      handleGetHandHistory({ context, socket, store });
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
  logRoomEvent('room_created', { roomCode: code, playerId: context.playerId, maxPlayers, bigBlind });

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

  if (room.phase !== 'waiting' || room.gameSession.active) {
    sendJson(socket, { type: 'error', message: '当前牌局进行中，暂不支持中途加入' });
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
  logRoomEvent('player_joined', { roomCode: room.code, playerId: context.playerId, seatIndex });

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

function handleResumeSession({ context, message, socket, store }) {
  const playerId = String(message.playerId || '').trim();
  const roomCode = String(message.roomCode || '').trim().toUpperCase();
  const room = store.rooms.get(roomCode);

  if (!playerId || !room) {
    sendJson(socket, { type: 'session_invalid', message: '会话不存在或已失效' });
    return;
  }

  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) {
    sendJson(socket, { type: 'session_invalid', message: '玩家会话不存在或已失效' });
    return;
  }

  store.sockets.delete(context.playerId);
  context.playerId = playerId;
  context.roomCode = roomCode;
  store.sockets.set(playerId, socket);

  player.connectionState = 'connected';
  player.disconnectedAt = null;
  player.disconnectDeadlineAt = null;
  room.updatedAt = Date.now();
  clearDisconnectGraceTimer(room, playerId);
  logRoomEvent('session_resumed', { roomCode, playerId, phase: room.phase });

  sendJson(socket, {
    type: 'session_resumed',
    roomCode,
    playerId,
    room: serializeRoomLobby(room),
    gameState: room.phase === 'waiting' ? null : serializeGameState(room, playerId),
  });

  if (room.phase !== 'waiting') {
    broadcastGameState(room, store);
    syncActionTimer(room, store);
  }
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

  const eligiblePlayers = room.players.filter(
    (player) => player.chips > 0 && player.connectionState === 'connected' && !player.isSittingOut,
  );
  if (eligiblePlayers.length < DEFAULTS.minPlayers) {
    sendJson(socket, { type: 'error', message: '至少需要2名有筹码的玩家' });
    return;
  }

  if (room.phase !== 'waiting') {
    sendJson(socket, { type: 'error', message: '当前手牌尚未结束' });
    return;
  }

  clearNextHandTimer(room);
  room.gameSession.active = true;
  initializeHand(room);
  logRoomEvent('hand_started', { roomCode: room.code, handId: room.hand.id, handNumber: room.hand.handNumber });
  appendRoomEvent(room, {
    kind: 'hand_started',
    handId: room.hand.id,
    handNumber: room.hand.handNumber,
    phase: room.phase,
  });
  broadcastGameState(room, store);
  broadcastRoom(room, store, {
    type: 'engine_event',
    event: room.history.recentEvents[room.history.recentEvents.length - 1],
  });
  syncActionTimer(room, store);
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
    sendJson(socket, {
      type: 'action_result',
      status: 'rejected',
      action: message.action,
      message: result.error,
    });
    sendJson(socket, { type: 'error', message: result.error });
    return;
  }

  sendJson(socket, {
    type: 'action_result',
    status: 'accepted',
    action: message.action,
    amount: message.amount || 0,
    handId: room.hand.id,
    phase: room.phase,
  });

  logRoomEvent('player_action', {
    roomCode: room.code,
    playerId: player.id,
    action: message.action,
    amount: message.amount || 0,
    phase: room.phase,
  });
  appendRoomEvent(room, {
    kind: 'player_action_requested',
    handId: room.hand.id,
    handNumber: room.hand.handNumber,
    phase: room.phase,
    playerId: player.id,
    action: message.action,
    amount: message.amount || 0,
  });
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

function handleParticipationChange({ context, store, mode }) {
  const room = getRoomForContext(context, store);
  if (!room) {
    return;
  }

  const player = room.players.find((entry) => entry.id === context.playerId);
  if (!player) {
    return;
  }

  if (mode === 'sit_in') {
    player.isSittingOut = false;
    player.status = player.chips > 0 ? 'active' : player.status;
    room.updatedAt = Date.now();
    logRoomEvent('player_sit_in', { roomCode: room.code, playerId: player.id });
    broadcastRoom(room, store, { type: 'room_updated', room: serializeRoomLobby(room) });
    if (room.phase !== 'waiting') {
      broadcastGameState(room, store);
      syncActionTimer(room, store);
    }
    return;
  }

  player.isSittingOut = true;
  if (mode === 'spectate') {
    player.status = 'spectating';
  }
  room.updatedAt = Date.now();
  logRoomEvent(mode === 'spectate' ? 'player_spectate' : 'player_sit_out', { roomCode: room.code, playerId: player.id });

  let outcome = null;
  if (room.phase !== 'waiting' && player.holeCards.length > 0 && !player.hasFolded) {
    outcome = handlePlayerExit(room, player.id);
  }

  broadcastRoom(room, store, { type: 'room_updated', room: serializeRoomLobby(room) });

  if (outcome) {
    publishOutcome(room, store, outcome);
    return;
  }

  if (room.phase !== 'waiting') {
    broadcastGameState(room, store);
    syncActionTimer(room, store);
  }
}

function handleLeaveRoom({ context, store }) {
  const room = getRoomForContext(context, store);
  if (!room) {
    return;
  }

  removePlayerFromRoom(room, context.playerId, store);
  context.roomCode = null;
}

function handleGetHandHistory({ context, socket, store }) {
  const room = getRoomForContext(context, store);
  if (!room) {
    sendJson(socket, { type: 'error', message: '房间不存在' });
    return;
  }

  sendJson(socket, {
    type: 'history_snapshot',
    history: {
      recentHands: room.history.recentHands,
      recentEvents: room.history.recentEvents,
    },
  });
}

function handleDisconnect({ context, store }) {
  const room = getRoomForContext(context, store);
  if (room) {
    markPlayerDisconnected(room, context.playerId, store);
  }

  store.sockets.delete(context.playerId);
}

function removePlayerFromRoom(room, playerId, store) {
  clearDisconnectGraceTimer(room, playerId);
  const outcome = handlePlayerExit(room, playerId);
  const playerIndex = room.players.findIndex((player) => player.id === playerId);
  if (playerIndex < 0) {
    return;
  }

  const [player] = room.players.splice(playerIndex, 1);
  room.updatedAt = Date.now();

  if (room.players.length === 0) {
    clearRoomTimers(room);
    store.rooms.delete(room.code);
    return;
  }

  if (room.ownerId === playerId) {
    room.ownerId = sortPlayersBySeat(room.players)[0].id;
  }

  if (room.phase !== 'waiting' && room.hand.seats.actingSeatIndex === player.seatIndex) {
    room.hand.seats.actingSeatIndex = getNextOccupiedSeat(room.players, player.seatIndex, room.maxPlayers);
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
    syncActionTimer(room, store);
  }
}

function markPlayerDisconnected(room, playerId, store) {
  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) {
    return;
  }

  player.connectionState = 'disconnected';
  player.disconnectedAt = Date.now();
  player.disconnectDeadlineAt = player.disconnectedAt + room.gameSession.disconnectGraceMs;
  room.updatedAt = Date.now();
  setDisconnectGraceTimer(room, playerId, store);
  logRoomEvent('player_disconnected', { roomCode: room.code, playerId, disconnectDeadlineAt: player.disconnectDeadlineAt });

  broadcastRoom(room, store, { type: 'room_updated', room: serializeRoomLobby(room) });
  if (room.phase !== 'waiting') {
    broadcastGameState(room, store);
    syncActionTimer(room, store);
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
    syncActionTimer(room, store);
    return;
  }

  const handMeta = outcome.handMeta || {};
  const outcomeEvent = {
    kind: outcome.type,
    handId: handMeta.handId || room.hand.id,
    handNumber: handMeta.handNumber ?? room.hand.handNumber,
    phase: handMeta.phase || room.phase,
  };

  switch (outcome.type) {
    case 'hand_result':
      appendCompletedHand(room, outcome, outcomeEvent);
      logRoomEvent('hand_result', {
        roomCode: room.code,
        pot: outcome.pot,
        winners: outcome.winners.map((winner) => winner.id),
      });
      appendRoomEvent(room, {
        ...outcomeEvent,
        kind: 'hand_finished',
        pot: outcome.pot,
        winners: outcome.winners.map((winner) => ({
          id: winner.id,
          name: winner.name,
          prize: winner.prize,
        })),
      });
      broadcastRoom(room, store, {
        type: 'hand_result',
        event: room.history.recentEvents[room.history.recentEvents.length - 1],
        winners: outcome.winners.map((winner) => ({
          id: winner.id,
          name: winner.name,
          hand: winner.hand.map(cardToString),
          handType: winner.handType || outcome.handType,
          prize: winner.prize,
        })),
        prize: outcome.prize,
        pot: outcome.pot,
        communityCards: outcome.communityCards.map(cardToString),
        scores: serializeRoomLobby(room).scores,
        sidePots: outcome.sidePots || [],
        restartDelayMs: room.gameSession.restartDelayMs,
        nextHandStartsAt: Date.now() + room.gameSession.restartDelayMs,
      });
      broadcastGameState(room, store);
      scheduleNextHand(room, store);
      syncActionTimer(room, store);
      return;
    case 'showdown_pending':
      broadcastGameState(room, store);
      broadcastRoom(room, store, {
        type: 'error',
        event: { ...outcomeEvent, kind: 'showdown_pending' },
        message: '已进入 showdown，牌型比较与分池将在下一分支完成',
      });
      syncActionTimer(room, store);
      return;
    case 'phase_advanced':
      appendRoomEvent(room, {
        ...outcomeEvent,
        kind: 'phase_advanced',
        nextPhase: outcome.phase,
      });
      broadcastRoom(room, store, {
        type: 'engine_event',
        event: room.history.recentEvents[room.history.recentEvents.length - 1],
      });
      broadcastGameState(room, store);
      syncActionTimer(room, store);
      return;
    case 'state_only':
    default:
      appendRoomEvent(room, {
        ...outcomeEvent,
        kind: 'action_applied',
      });
      broadcastRoom(room, store, {
        type: 'engine_event',
        event: room.history.recentEvents[room.history.recentEvents.length - 1],
      });
      broadcastGameState(room, store);
      syncActionTimer(room, store);
  }
}

function scheduleNextHand(room, store) {
  clearNextHandTimer(room);

  if (!room.gameSession.active) {
    return;
  }

  const eligiblePlayers = room.players.filter(
    (player) => player.chips > 0 && player.connectionState === 'connected' && !player.isSittingOut,
  );
  if (eligiblePlayers.length < DEFAULTS.minPlayers) {
    room.gameSession.active = false;
    broadcastRoom(room, store, {
      type: 'game_over',
      winner: eligiblePlayers[0] ? eligiblePlayers[0].name : null,
      finalScores: serializeRoomLobby(room).scores,
    });
    return;
  }

  room.gameSession.nextHandTimer = setTimeout(() => {
    room.gameSession.nextHandTimer = null;

    if (!store.rooms.has(room.code) || !room.gameSession.active) {
      return;
    }

    const readyPlayers = room.players.filter(
      (player) => player.chips > 0 && player.connectionState === 'connected' && !player.isSittingOut,
    );
    if (readyPlayers.length < DEFAULTS.minPlayers) {
      room.gameSession.active = false;
      broadcastRoom(room, store, {
        type: 'game_over',
        winner: readyPlayers[0] ? readyPlayers[0].name : null,
        finalScores: serializeRoomLobby(room).scores,
      });
      return;
    }

    initializeHand(room);
    appendRoomEvent(room, {
      kind: 'hand_started',
      handId: room.hand.id,
      handNumber: room.hand.handNumber,
      phase: room.phase,
    });
    broadcastRoom(room, store, {
      type: 'engine_event',
      event: room.history.recentEvents[room.history.recentEvents.length - 1],
    });
    broadcastGameState(room, store);
  }, room.gameSession.restartDelayMs);
}

function clearNextHandTimer(room) {
  if (!room.gameSession || !room.gameSession.nextHandTimer) {
    return;
  }

  clearTimeout(room.gameSession.nextHandTimer);
  room.gameSession.nextHandTimer = null;
}

function syncActionTimer(room, store) {
  if (!room.gameSession) {
    return;
  }

  const actingPlayer = room.players.find((player) => player.seatIndex === room.hand.seats.actingSeatIndex) || null;
  if (!actingPlayer || room.phase === 'waiting' || room.phase === 'showdown' || room.phase === 'scoring') {
    clearActionTimer(room);
    return;
  }

  if (
    room.gameSession.actionTimeoutTimer &&
    room.gameSession.actionPlayerId === actingPlayer.id &&
    room.gameSession.actionSeatIndex === actingPlayer.seatIndex &&
    room.gameSession.actionHandId === room.hand.id
  ) {
    return;
  }

  clearActionTimer(room);
  const scheduledPlayerId = actingPlayer.id;
  const scheduledSeatIndex = actingPlayer.seatIndex;
  const scheduledHandId = room.hand.id;
  room.gameSession.actionPlayerId = actingPlayer.id;
  room.gameSession.actionSeatIndex = actingPlayer.seatIndex;
  room.gameSession.actionHandId = room.hand.id;
  room.gameSession.actionDeadlineAt = Date.now() + room.gameSession.actionTimeoutMs;
  room.gameSession.actionTimeoutTimer = setTimeout(() => {
    room.gameSession.actionTimeoutTimer = null;
    room.gameSession.actionPlayerId = null;
    room.gameSession.actionSeatIndex = null;
    room.gameSession.actionHandId = null;
    room.gameSession.actionDeadlineAt = null;

    if (
      !store.rooms.has(room.code) ||
      room.hand.id !== scheduledHandId ||
      room.hand.seats.actingSeatIndex !== scheduledSeatIndex
    ) {
      return;
    }

    const currentPlayer = room.players.find((player) => player.id === scheduledPlayerId);
    if (!currentPlayer) {
      return;
    }

    const result = applyAction(room, currentPlayer, 'fold', 0);
    if (!result.ok) {
      return;
    }

    broadcastRoom(room, store, {
      type: 'error',
      message: `${currentPlayer.name} 超时未操作，系统已自动弃牌`,
    });
    logRoomEvent('action_timeout', { roomCode: room.code, playerId: currentPlayer.id, handId: scheduledHandId });
    publishOutcome(room, store, result.outcome);
  }, room.gameSession.actionTimeoutMs);
}

function clearActionTimer(room) {
  if (!room.gameSession || !room.gameSession.actionTimeoutTimer) {
    room.gameSession.actionPlayerId = null;
    room.gameSession.actionSeatIndex = null;
    room.gameSession.actionHandId = null;
    room.gameSession.actionDeadlineAt = null;
    return;
  }

  clearTimeout(room.gameSession.actionTimeoutTimer);
  room.gameSession.actionTimeoutTimer = null;
  room.gameSession.actionPlayerId = null;
  room.gameSession.actionSeatIndex = null;
  room.gameSession.actionHandId = null;
  room.gameSession.actionDeadlineAt = null;
}

function setDisconnectGraceTimer(room, playerId, store) {
  clearDisconnectGraceTimer(room, playerId);

  const timer = setTimeout(() => {
    room.gameSession.disconnectTimers.delete(playerId);
    if (!store.rooms.has(room.code)) {
      return;
    }

    const player = room.players.find((entry) => entry.id === playerId);
    if (!player || player.connectionState === 'connected') {
      return;
    }

    logRoomEvent('disconnect_grace_expired', { roomCode: room.code, playerId });
    removePlayerFromRoom(room, playerId, store);
  }, room.gameSession.disconnectGraceMs);

  room.gameSession.disconnectTimers.set(playerId, timer);
}

function clearDisconnectGraceTimer(room, playerId) {
  if (!room.gameSession || !room.gameSession.disconnectTimers.has(playerId)) {
    return;
  }

  clearTimeout(room.gameSession.disconnectTimers.get(playerId));
  room.gameSession.disconnectTimers.delete(playerId);

  const player = room.players.find((entry) => entry.id === playerId);
  if (player) {
    player.disconnectedAt = null;
    player.disconnectDeadlineAt = null;
  }
}

function clearRoomTimers(room) {
  clearNextHandTimer(room);
  clearActionTimer(room);

  if (!room.gameSession) {
    return;
  }

  for (const timer of room.gameSession.disconnectTimers.values()) {
    clearTimeout(timer);
  }
  room.gameSession.disconnectTimers.clear();
}

function logRoomEvent(event, details) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    scope: 'poker-room',
    event,
    ...details,
  }));
}

function appendRoomEvent(room, event) {
  room.history.recentEvents.push({
    ...event,
    ts: Date.now(),
  });

  while (room.history.recentEvents.length > room.history.maxEvents) {
    room.history.recentEvents.shift();
  }
}

function appendCompletedHand(room, outcome, event) {
  room.history.recentHands.push({
    handId: event.handId,
    handNumber: event.handNumber,
    phase: event.phase,
    pot: outcome.pot,
    handType: outcome.handType,
    communityCards: outcome.communityCards.map(cardToString),
    winners: outcome.winners.map((winner) => ({
      id: winner.id,
      name: winner.name,
      handType: winner.handType,
      prize: winner.prize,
      hand: winner.hand.map(cardToString),
    })),
    sidePots: outcome.sidePots || [],
    ts: Date.now(),
  });

  while (room.history.recentHands.length > room.history.maxHands) {
    room.history.recentHands.shift();
  }
}

module.exports = {
  registerWebSocketServer,
};
