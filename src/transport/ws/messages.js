'use strict';

const WebSocket = require('ws');
const { cardToString } = require('../../engine/cards');
const { sortPlayersBySeat } = require('../../engine/seats');

function sendJson(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

function publicPlayer(player, room) {
  return {
    id: player.id,
    name: player.name,
    seatIndex: player.seatIndex,
    chips: player.chips,
    score: room.scores[player.id] || player.totalScore || 0,
  };
}

function serializeRoomLobby(room) {
  return {
    code: room.code,
    phase: room.phase,
    bigBlind: room.blinds.big,
    maxPlayers: room.maxPlayers,
    players: sortPlayersBySeat(room.players).map((player) => publicPlayer(player, room)),
    scores: buildScoreboard(room),
  };
}

function serializePlayerForViewer(player, room, viewerId) {
  const isViewer = player.id === viewerId;
  const isSeatedInHand = player.holeCards.length > 0;

  return {
    id: player.id,
    name: player.name,
    seatIndex: player.seatIndex,
    hand: isViewer ? player.holeCards.map(cardToString) : (isSeatedInHand ? ['?', '?'] : null),
    chips: player.chips,
    score: room.scores[player.id] || player.totalScore || 0,
    isFolded: player.hasFolded,
    isAllIn: player.isAllIn,
    isDealer: room.hand.buttonSeatIndex === player.seatIndex,
    isSmallBlind: room.hand.smallBlindSeatIndex === player.seatIndex,
    isBigBlind: room.hand.bigBlindSeatIndex === player.seatIndex,
    currentBet: player.committedChips,
    isCurrentTurn: room.hand.actingSeatIndex === player.seatIndex,
    lastAction: player.lastAction,
  };
}

function serializeGameState(room, viewerId) {
  const actingPlayer = room.players.find((player) => player.seatIndex === room.hand.actingSeatIndex) || null;

  return {
    type: 'game_state',
    phase: room.phase,
    communityCards: room.hand.board.map(cardToString),
    pot: room.hand.pot,
    currentBet: room.hand.currentBet,
    dealerIndex: room.hand.buttonSeatIndex,
    players: sortPlayersBySeat(room.players).map((player) => serializePlayerForViewer(player, room, viewerId)),
    currentPlayerId: actingPlayer ? actingPlayer.id : null,
    minRaise: room.hand.minRaise,
    smallBlind: room.blinds.small,
    bigBlind: room.blinds.big,
    roundNumber: room.hand.handNumber,
    scores: buildScoreboard(room),
  };
}

function broadcastRoom(room, store, payload) {
  for (const player of room.players) {
    sendJson(store.sockets.get(player.id), payload);
  }
}

function broadcastGameState(room, store) {
  for (const player of room.players) {
    sendJson(store.sockets.get(player.id), serializeGameState(room, player.id));
  }
}

function buildScoreboard(room) {
  return sortPlayersBySeat(room.players)
    .map((player) => ({
      id: player.id,
      name: player.name,
      chips: player.chips,
      score: room.scores[player.id] || player.totalScore || 0,
    }))
    .sort((left, right) => right.score - left.score || right.chips - left.chips);
}

module.exports = {
  broadcastGameState,
  broadcastRoom,
  buildScoreboard,
  sendJson,
  serializeGameState,
  serializeRoomLobby,
};
