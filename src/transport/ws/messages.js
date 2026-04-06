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
    connectionState: player.connectionState,
    isSittingOut: player.isSittingOut,
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
  const seatState = room.hand.seats;

  return {
    id: player.id,
    name: player.name,
    seatIndex: player.seatIndex,
    hand: isViewer ? player.holeCards.map(cardToString) : (isSeatedInHand ? ['?', '?'] : null),
    chips: player.chips,
    score: room.scores[player.id] || player.totalScore || 0,
    connectionState: player.connectionState,
    isSittingOut: player.isSittingOut,
    isFolded: player.hasFolded,
    isAllIn: player.isAllIn,
    isDealer: seatState.buttonSeatIndex === player.seatIndex,
    isSmallBlind: seatState.smallBlindSeatIndex === player.seatIndex,
    isBigBlind: seatState.bigBlindSeatIndex === player.seatIndex,
    currentBet: player.committedChips,
    isCurrentTurn: seatState.actingSeatIndex === player.seatIndex,
    lastAction: player.lastAction,
  };
}

function serializeGameState(room, viewerId) {
  const seatState = room.hand.seats;
  const bettingState = room.hand.betting;
  const actingPlayer = room.players.find((player) => player.seatIndex === seatState.actingSeatIndex) || null;

  return {
    type: 'game_state',
    phase: room.phase,
    communityCards: room.hand.board.map(cardToString),
    pot: bettingState.pot,
    currentBet: bettingState.currentBet,
    dealerIndex: seatState.buttonSeatIndex,
    players: sortPlayersBySeat(room.players).map((player) => serializePlayerForViewer(player, room, viewerId)),
    currentPlayerId: actingPlayer ? actingPlayer.id : null,
    minRaise: bettingState.minRaise,
    smallBlind: room.blinds.small,
    bigBlind: room.blinds.big,
    roundNumber: room.hand.handNumber,
    scores: buildScoreboard(room),
    hand: {
      id: room.hand.id,
      number: room.hand.handNumber,
      phase: room.hand.phase,
      board: room.hand.board.map(cardToString),
      seats: {
        buttonSeatIndex: seatState.buttonSeatIndex,
        smallBlindSeatIndex: seatState.smallBlindSeatIndex,
        bigBlindSeatIndex: seatState.bigBlindSeatIndex,
        actingSeatIndex: seatState.actingSeatIndex,
      },
      betting: {
        pot: bettingState.pot,
        currentBet: bettingState.currentBet,
        minRaise: bettingState.minRaise,
        lastRaiseSize: bettingState.lastRaiseSize,
        pendingSeatIndexes: [...bettingState.pendingSeatIndexes],
        raiseRightsSeatIndexes: [...bettingState.raiseRightsSeatIndexes],
      },
      showdown: {
        seatIndexes: [...room.hand.showdown.seatIndexes],
      },
    },
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
