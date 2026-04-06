'use strict';

const WebSocket = require('ws');
const { cardToString } = require('../../engine/cards');
const { buildSidePots } = require('../../engine/settlement');
const { sortPlayersBySeat } = require('../../engine/seats');

function sendJson(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(JSON.stringify(payload));
}

function publicPlayer(player, room) {
  const sessionTotals = getPlayerSessionTotals(player);
  return {
    id: player.id,
    name: player.name,
    seatIndex: player.seatIndex,
    chips: player.chips,
    score: sessionTotals.profitLoss,
    totalBuyIn: sessionTotals.totalBuyIn,
    profitLoss: sessionTotals.profitLoss,
    buyInHistory: player.buyInHistory || [],
    connectionState: player.connectionState,
    isSittingOut: player.isSittingOut,
  };
}

function serializeRoomLobby(room) {
  return {
    code: room.code,
    ownerId: room.ownerId,
    phase: room.phase,
    bigBlind: room.blinds.big,
    maxPlayers: room.maxPlayers,
    players: sortPlayersBySeat(room.players).map((player) => publicPlayer(player, room)),
    scores: buildScoreboard(room),
    session: {
      idleDeadlineAt: room.gameSession.idleDeadlineAt,
      idleTimeoutMs: room.gameSession.idleTimeoutMs,
      pausedReason: room.gameSession.pausedReason,
      rebuyDeadlineAt: room.gameSession.rebuyDeadlineAt,
      rebuyGraceMs: room.gameSession.rebuyGraceMs,
      rebuyPendingPlayerIds: room.gameSession.rebuyPendingPlayerIds || [],
      finalizedAt: room.gameSession.finalizedAt,
      finalReason: room.gameSession.finalReason,
    },
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
    score: getPlayerSessionTotals(player).profitLoss,
    totalBuyIn: getPlayerSessionTotals(player).totalBuyIn,
    profitLoss: getPlayerSessionTotals(player).profitLoss,
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
  const viewer = room.players.find((player) => player.id === viewerId) || null;

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
    timers: {
      actionDeadlineAt: room.gameSession.actionDeadlineAt,
      actionTimeoutMs: room.gameSession.actionTimeoutMs,
      viewerDisconnectDeadlineAt: viewer ? viewer.disconnectDeadlineAt : null,
      disconnectGraceMs: room.gameSession.disconnectGraceMs,
      idleDeadlineAt: room.gameSession.idleDeadlineAt,
      idleTimeoutMs: room.gameSession.idleTimeoutMs,
    },
    history: {
      recentHands: room.history.recentHands,
      recentEvents: room.history.recentEvents,
    },
    sidePots: buildSidePots(room.players).map((sidePot, index) => ({
      amount: sidePot.amount,
      label: index === 0 ? '主池' : `边池 ${index}`,
      eligiblePlayerIds: sidePot.eligiblePlayers
        .filter((player) => !player.hasFolded)
        .map((player) => player.id),
    })),
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
      totalBuyIn: getPlayerSessionTotals(player).totalBuyIn,
      score: getPlayerSessionTotals(player).profitLoss,
      profitLoss: getPlayerSessionTotals(player).profitLoss,
      buyInCount: Array.isArray(player.buyInHistory) ? player.buyInHistory.length : 0,
      buyInHistory: player.buyInHistory || [],
    }))
    .sort((left, right) => right.profitLoss - left.profitLoss || right.chips - left.chips);
}

function getPlayerSessionTotals(player) {
  const totalBuyIn = Number(player.totalBuyIn || 0);
  return {
    totalBuyIn,
    profitLoss: Number(player.chips || 0) - totalBuyIn,
  };
}

module.exports = {
  broadcastGameState,
  broadcastRoom,
  buildScoreboard,
  sendJson,
  serializeGameState,
  serializeRoomLobby,
};
