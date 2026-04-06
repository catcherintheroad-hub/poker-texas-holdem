'use strict';

const { createDeck, drawCards, shuffleDeck } = require('./cards');
const { buildPendingSeatIndexes, buildRaiseRightsSeatIndexes } = require('./betting-round');
const { createHandState, normalizeHandState } = require('../models/hand');
const { findPlayerBySeat, getNextOccupiedSeat, sortPlayersBySeat } = require('./seats');

function initializeHand(room) {
  room.hand = normalizeHandState(room.hand);

  const seatedPlayers = getHandParticipants(room);
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

  resetPlayersForNewHand(room.players);

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
    seats: {
      buttonSeatIndex,
      smallBlindSeatIndex,
      bigBlindSeatIndex,
      actingSeatIndex,
    },
    betting: {
      pot: smallBlindAmount + bigBlindAmount,
      currentBet: Math.max(smallBlindAmount, bigBlindAmount),
      minRaise: room.blinds.big,
      lastRaiseSize: room.blinds.big,
      pendingSeatIndexes: buildPendingSeatIndexes(room, actingSeatIndex),
      raiseRightsSeatIndexes: buildRaiseRightsSeatIndexes(room, actingSeatIndex),
    },
    handNumber: room.hand.handNumber + 1,
    log: {
      actionLog: [
        { type: 'system', message: 'Hand initialized from modular engine scaffold' },
      ],
    },
  });
  room.updatedAt = Date.now();
}

function getHandParticipants(room) {
  return sortPlayersBySeat(room.players).filter(
    (player) => player.chips > 0 && player.connectionState === 'connected' && !player.isSittingOut,
  );
}

function resetPlayersForNewHand(players) {
  for (const player of players) {
    player.holeCards = [];
    player.status = player.chips > 0 ? 'active' : 'sitting_out';
    player.connectionState = 'connected';
    player.committedChips = 0;
    player.totalCommittedChips = 0;
    player.hasFolded = false;
    player.isAllIn = false;
    player.lastAction = null;
  }
}

function postBlind(player, amount) {
  if (!player) {
    return 0;
  }

  const blindAmount = Math.min(amount, player.chips);
  player.chips -= blindAmount;
  player.committedChips = blindAmount;
  player.totalCommittedChips += blindAmount;
  player.isAllIn = player.chips === 0;
  player.lastAction = blindAmount === amount ? `blind ${blindAmount}` : `all-in blind ${blindAmount}`;
  return blindAmount;
}

module.exports = {
  initializeHand,
};
