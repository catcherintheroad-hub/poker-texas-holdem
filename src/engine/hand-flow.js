'use strict';

const { createDeck, drawCards, shuffleDeck } = require('./cards');
const { createHandState } = require('../models/hand');
const {
  findPlayerBySeat,
  getNextOccupiedSeat,
  sortPlayersBySeat,
} = require('./seats');

const BOARD_CARD_COUNT = {
  preflop: 0,
  flop: 3,
  turn: 1,
  river: 1,
};

const NEXT_PHASE = {
  preflop: 'flop',
  flop: 'turn',
  turn: 'river',
  river: 'showdown',
};

function initializeHand(room) {
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
    pot: smallBlindAmount + bigBlindAmount,
    currentBet: Math.max(smallBlindAmount, bigBlindAmount),
    minRaise: room.blinds.big,
    lastRaiseSize: room.blinds.big,
    buttonSeatIndex,
    smallBlindSeatIndex,
    bigBlindSeatIndex,
    actingSeatIndex,
    pendingSeatIndexes: buildPendingSeatIndexes(room, actingSeatIndex),
    handNumber: room.hand.handNumber + 1,
    actionLog: [
      { type: 'system', message: 'Hand initialized from modular engine scaffold' },
    ],
  });
  room.updatedAt = Date.now();
}

function applyAction(room, player, action, amount) {
  if (!room || room.phase === 'waiting' || room.phase === 'showdown' || room.phase === 'scoring') {
    return { ok: false, error: '当前阶段不能操作' };
  }

  if (room.hand.actingSeatIndex !== player.seatIndex) {
    return { ok: false, error: '还没轮到你' };
  }

  if (!canPlayerAct(player)) {
    return { ok: false, error: '当前玩家不能行动' };
  }

  const toCall = Math.max(0, room.hand.currentBet - player.committedChips);
  const normalizedAction = normalizeAction(action, toCall);

  switch (normalizedAction) {
    case 'fold':
      player.hasFolded = true;
      player.status = 'folded';
      player.lastAction = 'fold';
      removePendingSeat(room.hand.pendingSeatIndexes, player.seatIndex);
      break;
    case 'check':
      if (toCall !== 0) {
        return { ok: false, error: '当前不能过牌' };
      }
      player.lastAction = 'check';
      removePendingSeat(room.hand.pendingSeatIndexes, player.seatIndex);
      break;
    case 'call': {
      if (toCall <= 0) {
        return { ok: false, error: '当前无需跟注' };
      }
      const commitAmount = Math.min(toCall, player.chips);
      commitChips(room, player, commitAmount);
      player.lastAction = commitAmount < toCall ? `all-in ${commitAmount}` : `call ${commitAmount}`;
      removePendingSeat(room.hand.pendingSeatIndexes, player.seatIndex);
      break;
    }
    case 'bet': {
      if (room.hand.currentBet !== 0) {
        return { ok: false, error: '当前不能下注，请使用加注' };
      }
      const totalBet = clampActionAmount(amount, room.hand.minRaise, player.chips);
      if (totalBet < room.hand.minRaise) {
        return { ok: false, error: `下注至少 ${room.hand.minRaise}` };
      }
      commitChips(room, player, totalBet);
      player.lastAction = totalBet === player.committedChips && player.isAllIn ? `all-in ${totalBet}` : `bet ${totalBet}`;
      registerAggressiveAction(room, player, totalBet);
      break;
    }
    case 'raise': {
      if (room.hand.currentBet === 0) {
        return { ok: false, error: '当前无人下注，请使用 bet' };
      }
      const minTotal = room.hand.currentBet + room.hand.lastRaiseSize;
      const desiredTotal = Number.parseInt(amount, 10);
      const maxTotal = player.committedChips + player.chips;
      const totalBet = Number.isNaN(desiredTotal) ? 0 : Math.min(desiredTotal, maxTotal);

      if (totalBet < minTotal && totalBet !== maxTotal) {
        return { ok: false, error: `加注至少到 ${minTotal}` };
      }
      if (totalBet <= player.committedChips) {
        return { ok: false, error: '加注金额无效' };
      }

      const commitAmount = totalBet - player.committedChips;
      commitChips(room, player, commitAmount);
      player.lastAction = player.isAllIn && totalBet > room.hand.currentBet ? `all-in ${commitAmount}` : `raise to ${totalBet}`;
      registerAggressiveAction(room, player, totalBet);
      break;
    }
    case 'allin': {
      const totalBet = player.committedChips + player.chips;
      if (totalBet <= player.committedChips) {
        return { ok: false, error: '没有可全下的筹码' };
      }
      const commitAmount = player.chips;
      commitChips(room, player, commitAmount);
      player.lastAction = `all-in ${commitAmount}`;

      if (totalBet > room.hand.currentBet) {
        registerAggressiveAction(room, player, totalBet);
      } else {
        removePendingSeat(room.hand.pendingSeatIndexes, player.seatIndex);
      }
      break;
    }
    default:
      return { ok: false, error: '未知操作' };
  }

  room.hand.actionLog.push({
    seatIndex: player.seatIndex,
    playerId: player.id,
    action: normalizedAction,
    amount: Number.parseInt(amount, 10) || 0,
    phase: room.phase,
    timestamp: Date.now(),
  });
  room.updatedAt = Date.now();

  const remainingPlayers = getRemainingPlayers(room);
  if (remainingPlayers.length === 1) {
    return { ok: true, outcome: resolveUncontestedWin(room, remainingPlayers[0]) };
  }

  if (isBettingRoundComplete(room)) {
    return { ok: true, outcome: advancePhase(room) };
  }

  room.hand.actingSeatIndex = getNextActingSeat(room, player.seatIndex);
  return { ok: true, outcome: { type: 'state_only' } };
}

function handlePlayerExit(room, playerId) {
  if (!room || room.phase === 'waiting') {
    return null;
  }

  const player = room.players.find((entry) => entry.id === playerId);
  if (!player) {
    return null;
  }

  player.hasFolded = true;
  player.status = 'folded';
  player.holeCards = [];
  player.lastAction = 'left';
  removePendingSeat(room.hand.pendingSeatIndexes, player.seatIndex);

  const remainingPlayers = getRemainingPlayers(room);
  if (remainingPlayers.length === 1) {
    return resolveUncontestedWin(room, remainingPlayers[0]);
  }

  if (room.hand.actingSeatIndex === player.seatIndex) {
    if (isBettingRoundComplete(room)) {
      return advancePhase(room);
    }

    room.hand.actingSeatIndex = getNextActingSeat(room, player.seatIndex);
  }

  room.updatedAt = Date.now();
  return { type: 'state_only' };
}

function initializeBettingRound(room, phase, actingSeatIndex) {
  room.phase = phase;
  room.hand.phase = phase;
  room.hand.currentBet = 0;
  room.hand.minRaise = room.blinds.big;
  room.hand.lastRaiseSize = room.blinds.big;
  room.hand.actingSeatIndex = actingSeatIndex;
  room.hand.pendingSeatIndexes = buildPendingSeatIndexes(room, actingSeatIndex);

  for (const player of room.players) {
    player.committedChips = 0;
    player.lastAction = null;
  }

  room.updatedAt = Date.now();
}

function advancePhase(room) {
  const nextPhase = NEXT_PHASE[room.phase];

  if (!nextPhase) {
    return resolveShowdownPlaceholder(room);
  }

  if (nextPhase === 'showdown') {
    room.phase = 'showdown';
    room.hand.phase = 'showdown';
    room.hand.actingSeatIndex = -1;
    room.hand.pendingSeatIndexes = [];
    room.hand.showdownSeatIndexes = getRemainingPlayers(room).map((player) => player.seatIndex);
    room.updatedAt = Date.now();
    return { type: 'showdown_pending' };
  }

  const drawCount = BOARD_CARD_COUNT[nextPhase];
  if (drawCount > 0) {
    room.hand.board.push(...drawCards(room.hand.deck, drawCount));
  }

  const actingSeatIndex = getFirstActingSeatForPhase(room, nextPhase);
  initializeBettingRound(room, nextPhase, actingSeatIndex);
  if (isBettingRoundComplete(room)) {
    return advancePhase(room);
  }

  return { type: 'phase_advanced', phase: nextPhase };
}

function resolveUncontestedWin(room, winner) {
  const prize = room.hand.pot;
  const communityCards = [...room.hand.board];
  const winnerSnapshot = {
    id: winner.id,
    name: winner.name,
    hand: [...winner.holeCards],
  };
  awardChips(room, [winner], prize);

  const outcome = {
    type: 'hand_result',
    winners: [winnerSnapshot],
    prize,
    pot: room.hand.pot,
    handType: 'Uncontested',
    communityCards,
  };

  prepareNextHandOrWaiting(room);
  return outcome;
}

function resolveShowdownPlaceholder(room) {
  room.phase = 'waiting';
  room.hand = createHandState({
    handNumber: room.hand.handNumber,
    phase: 'waiting',
  });
  room.updatedAt = Date.now();

  return {
    type: 'showdown_pending',
  };
}

function prepareNextHandOrWaiting(room) {
  room.phase = 'waiting';
  room.hand = createHandState({
    handNumber: room.hand.handNumber,
    phase: 'waiting',
  });
  room.updatedAt = Date.now();

  for (const player of room.players) {
    player.committedChips = 0;
    player.holeCards = [];
    player.lastAction = null;
    player.hasFolded = false;
    player.isAllIn = false;
    player.status = player.chips > 0 ? 'active' : 'sitting_out';
  }
}

function awardChips(room, winners, totalPot) {
  const evenShare = Math.floor(totalPot / winners.length);
  let remainder = totalPot - evenShare * winners.length;

  winners.forEach((winner) => {
    const payout = evenShare + (remainder > 0 ? 1 : 0);
    winner.chips += payout;
    winner.totalScore += payout;
    room.scores[winner.id] = (room.scores[winner.id] || 0) + payout;
    remainder = Math.max(0, remainder - 1);
  });
}

function registerAggressiveAction(room, player, totalBet) {
  const previousBet = room.hand.currentBet;
  const raiseSize = totalBet - previousBet;

  room.hand.currentBet = totalBet;
  room.hand.lastRaiseSize = Math.max(room.hand.lastRaiseSize, raiseSize);
  room.hand.minRaise = room.hand.currentBet + room.hand.lastRaiseSize;
  room.hand.pendingSeatIndexes = buildPendingSeatIndexes(room, getNextActingSeat(room, player.seatIndex), player.seatIndex);
  room.hand.actingSeatIndex = getNextActingSeat(room, player.seatIndex);
}

function buildPendingSeatIndexes(room, firstSeatIndex, excludedSeatIndex = null) {
  const pending = [];
  let seatIndex = firstSeatIndex;

  while (seatIndex >= 0 && !pending.includes(seatIndex)) {
    if (seatIndex !== excludedSeatIndex) {
      const player = findPlayerBySeat(room.players, seatIndex);
      if (player && canPlayerAct(player)) {
        pending.push(seatIndex);
      }
    }

    seatIndex = getNextActingSeat(room, seatIndex);
    if (seatIndex === firstSeatIndex) {
      break;
    }
  }

  return pending;
}

function getFirstActingSeatForPhase(room, phase) {
  if (phase === 'preflop') {
    return room.hand.actingSeatIndex;
  }

  return getNextActingSeat(room, room.hand.buttonSeatIndex);
}

function getNextActingSeat(room, fromSeatIndex) {
  let nextSeatIndex = getNextOccupiedSeat(room.players, fromSeatIndex, room.maxPlayers);

  while (nextSeatIndex >= 0) {
    const player = findPlayerBySeat(room.players, nextSeatIndex);
    if (player && canPlayerAct(player)) {
      return nextSeatIndex;
    }

    nextSeatIndex = getNextOccupiedSeat(room.players, nextSeatIndex, room.maxPlayers);
    if (nextSeatIndex === fromSeatIndex) {
      break;
    }
  }

  return -1;
}

function isBettingRoundComplete(room) {
  return room.hand.pendingSeatIndexes.length === 0 || getActionablePlayers(room).length <= 1;
}

function getActionablePlayers(room) {
  return room.players.filter((player) => canPlayerAct(player));
}

function getHandParticipants(room) {
  return sortPlayersBySeat(room.players).filter((player) => player.chips > 0);
}

function getRemainingPlayers(room) {
  return room.players.filter((player) => !player.hasFolded && player.holeCards.length > 0);
}

function canPlayerAct(player) {
  return !player.hasFolded && !player.isAllIn && player.chips > 0 && player.holeCards.length > 0;
}

function resetPlayersForNewHand(players) {
  for (const player of players) {
    player.holeCards = [];
    player.status = player.chips > 0 ? 'active' : 'sitting_out';
    player.connectionState = 'connected';
    player.committedChips = 0;
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
  player.isAllIn = player.chips === 0;
  player.lastAction = blindAmount === amount ? `blind ${blindAmount}` : `all-in blind ${blindAmount}`;
  return blindAmount;
}

function commitChips(room, player, amount) {
  const commitAmount = Math.min(amount, player.chips);
  player.chips -= commitAmount;
  player.committedChips += commitAmount;
  player.isAllIn = player.chips === 0;
  room.hand.pot += commitAmount;
}

function normalizeAction(action, toCall) {
  if (action === 'raise' && toCall === 0) {
    return 'bet';
  }

  return action;
}

function clampActionAmount(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return 0;
  }

  return Math.min(max, Math.max(min, parsed));
}

function removePendingSeat(pendingSeatIndexes, seatIndex) {
  const index = pendingSeatIndexes.indexOf(seatIndex);
  if (index >= 0) {
    pendingSeatIndexes.splice(index, 1);
  }
}

module.exports = {
  applyAction,
  handlePlayerExit,
  initializeHand,
};
