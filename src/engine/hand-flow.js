'use strict';

const { createDeck, drawCards, shuffleDeck } = require('./cards');
const { compareEvaluations, evaluateBestHand } = require('./hand-evaluator');
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
    raiseRightsSeatIndexes: buildRaiseRightsSeatIndexes(room, actingSeatIndex),
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
      removeRaiseRight(room.hand.raiseRightsSeatIndexes, player.seatIndex);
      break;
    case 'check':
      if (toCall !== 0) {
        return { ok: false, error: '当前不能过牌' };
      }
      player.lastAction = 'check';
      removePendingSeat(room.hand.pendingSeatIndexes, player.seatIndex);
      removeRaiseRight(room.hand.raiseRightsSeatIndexes, player.seatIndex);
      break;
    case 'call': {
      if (toCall <= 0) {
        return { ok: false, error: '当前无需跟注' };
      }
      const commitAmount = Math.min(toCall, player.chips);
      commitChips(room, player, commitAmount);
      player.lastAction = commitAmount < toCall ? `all-in ${commitAmount}` : `call ${commitAmount}`;
      removePendingSeat(room.hand.pendingSeatIndexes, player.seatIndex);
      removeRaiseRight(room.hand.raiseRightsSeatIndexes, player.seatIndex);
      break;
    }
    case 'bet': {
      if (!canSeatRaise(room, player.seatIndex)) {
        return { ok: false, error: '当前不能下注或加注' };
      }
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
      if (!canSeatRaise(room, player.seatIndex)) {
        return { ok: false, error: '短码 all-in 未重新打开加注权限' };
      }
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
      if (isFullRaise(room, totalBet)) {
        registerAggressiveAction(room, player, totalBet);
      } else {
        registerShortAllInAction(room, player, totalBet);
      }
      break;
    }
    case 'allin': {
      const totalBet = player.committedChips + player.chips;
      if (totalBet <= player.committedChips) {
        return { ok: false, error: '没有可全下的筹码' };
      }
      if (totalBet > room.hand.currentBet && !canSeatRaise(room, player.seatIndex)) {
        return { ok: false, error: '短码 all-in 未重新打开加注权限' };
      }
      const commitAmount = player.chips;
      commitChips(room, player, commitAmount);
      player.lastAction = `all-in ${commitAmount}`;

      if (totalBet > room.hand.currentBet) {
        if (isFullRaise(room, totalBet)) {
          registerAggressiveAction(room, player, totalBet);
        } else {
          registerShortAllInAction(room, player, totalBet);
        }
      } else {
        removePendingSeat(room.hand.pendingSeatIndexes, player.seatIndex);
        removeRaiseRight(room.hand.raiseRightsSeatIndexes, player.seatIndex);
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
  room.hand.raiseRightsSeatIndexes = buildRaiseRightsSeatIndexes(room, actingSeatIndex);

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
    return resolveShowdown(room);
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
    handType: 'Uncontested',
    prize,
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
  return resolveShowdown(room);
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
    player.totalCommittedChips = 0;
    player.holeCards = [];
    player.lastAction = null;
    player.hasFolded = false;
    player.isAllIn = false;
    player.status = player.chips > 0 ? 'active' : 'sitting_out';
  }
}

function awardChips(room, winners, totalPot) {
  const orderedWinners = orderSeatsForPayout(room, winners);
  const evenShare = Math.floor(totalPot / orderedWinners.length);
  let remainder = totalPot - evenShare * orderedWinners.length;

  orderedWinners.forEach((winner) => {
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
  room.hand.raiseRightsSeatIndexes = buildRaiseRightsSeatIndexes(room, getNextActingSeat(room, player.seatIndex), player.seatIndex);
  room.hand.actingSeatIndex = getNextActingSeat(room, player.seatIndex);
}

function registerShortAllInAction(room, player, totalBet) {
  room.hand.currentBet = totalBet;
  room.hand.minRaise = room.hand.currentBet + room.hand.lastRaiseSize;
  room.hand.pendingSeatIndexes = buildPendingSeatIndexesForCurrentBet(
    room,
    getNextActingSeat(room, player.seatIndex),
    player.seatIndex,
  );
  removeRaiseRight(room.hand.raiseRightsSeatIndexes, player.seatIndex);
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

function buildRaiseRightsSeatIndexes(room, firstSeatIndex, excludedSeatIndex = null) {
  return buildPendingSeatIndexes(room, firstSeatIndex, excludedSeatIndex);
}

function buildPendingSeatIndexesForCurrentBet(room, firstSeatIndex, excludedSeatIndex = null) {
  const pending = [];
  let seatIndex = firstSeatIndex;

  while (seatIndex >= 0 && !pending.includes(seatIndex)) {
    if (seatIndex !== excludedSeatIndex) {
      const player = findPlayerBySeat(room.players, seatIndex);
      if (player && canPlayerAct(player) && player.committedChips < room.hand.currentBet) {
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
  return sortPlayersBySeat(room.players).filter((player) => player.chips > 0 && player.connectionState === 'connected');
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

function commitChips(room, player, amount) {
  const commitAmount = Math.min(amount, player.chips);
  player.chips -= commitAmount;
  player.committedChips += commitAmount;
  player.totalCommittedChips += commitAmount;
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

function removeRaiseRight(raiseRightsSeatIndexes, seatIndex) {
  const index = raiseRightsSeatIndexes.indexOf(seatIndex);
  if (index >= 0) {
    raiseRightsSeatIndexes.splice(index, 1);
  }
}

function canSeatRaise(room, seatIndex) {
  return room.hand.raiseRightsSeatIndexes.includes(seatIndex);
}

function isFullRaise(room, totalBet) {
  return totalBet - room.hand.currentBet >= room.hand.lastRaiseSize;
}

function resolveShowdown(room) {
  const contenders = getRemainingPlayers(room);
  const evaluations = new Map();

  for (const contender of contenders) {
    evaluations.set(contender.id, evaluateBestHand([...contender.holeCards, ...room.hand.board]));
  }

  const sidePots = buildSidePots(room.players);
  const payoutByPlayerId = new Map();

  for (const sidePot of sidePots) {
    const eligibleContenders = sidePot.eligiblePlayers.filter((player) => !player.hasFolded);
    if (!eligibleContenders.length) {
      continue;
    }

    const winners = selectPotWinners(eligibleContenders, evaluations);
    distributePot(room, winners, sidePot.amount, payoutByPlayerId);
  }

  const payoutWinners = contenders
    .filter((player) => (payoutByPlayerId.get(player.id) || 0) > 0)
    .map((player) => ({
      id: player.id,
      name: player.name,
      hand: [...player.holeCards],
      handType: evaluations.get(player.id).name,
      prize: payoutByPlayerId.get(player.id),
    }));

  const outcome = {
    type: 'hand_result',
    winners: payoutWinners,
    prize: room.hand.pot,
    pot: room.hand.pot,
    handType: payoutWinners[0] ? payoutWinners[0].handType : 'Showdown',
    communityCards: [...room.hand.board],
    sidePots: sidePots.map((sidePot) => ({
      amount: sidePot.amount,
      eligiblePlayerIds: sidePot.eligiblePlayers.map((player) => player.id),
    })),
  };

  prepareNextHandOrWaiting(room);
  return outcome;
}

function buildSidePots(players) {
  const contributors = players
    .filter((player) => player.totalCommittedChips > 0)
    .sort((left, right) => left.totalCommittedChips - right.totalCommittedChips || left.seatIndex - right.seatIndex);

  const contributionLevels = [...new Set(contributors.map((player) => player.totalCommittedChips))];
  const pots = [];
  let previousLevel = 0;

  for (const level of contributionLevels) {
    const eligiblePlayers = contributors.filter((player) => player.totalCommittedChips >= level);
    const amount = (level - previousLevel) * eligiblePlayers.length;

    if (amount > 0) {
      pots.push({ amount, eligiblePlayers });
    }

    previousLevel = level;
  }

  return pots;
}

function selectPotWinners(players, evaluations) {
  let bestEvaluation = null;
  let winners = [];

  for (const player of players) {
    const evaluation = evaluations.get(player.id);
    if (!bestEvaluation) {
      bestEvaluation = evaluation;
      winners = [player];
      continue;
    }

    const comparison = compareEvaluations(evaluation, bestEvaluation);
    if (comparison > 0) {
      bestEvaluation = evaluation;
      winners = [player];
    } else if (comparison === 0) {
      winners.push(player);
    }
  }

  return winners;
}

function distributePot(room, winners, amount, payoutByPlayerId) {
  const orderedWinners = orderSeatsForPayout(room, winners);
  const evenShare = Math.floor(amount / orderedWinners.length);
  let remainder = amount - evenShare * orderedWinners.length;

  for (const winner of orderedWinners) {
    const payout = evenShare + (remainder > 0 ? 1 : 0);
    winner.chips += payout;
    winner.totalScore += payout;
    room.scores[winner.id] = (room.scores[winner.id] || 0) + payout;
    payoutByPlayerId.set(winner.id, (payoutByPlayerId.get(winner.id) || 0) + payout);
    remainder = Math.max(0, remainder - 1);
  }
}

function orderSeatsForPayout(room, players) {
  return [...players].sort((left, right) => {
    const leftDistance = normalizeSeatDistance(room, left.seatIndex);
    const rightDistance = normalizeSeatDistance(room, right.seatIndex);
    return leftDistance - rightDistance;
  });
}

function normalizeSeatDistance(room, seatIndex) {
  return (seatIndex - room.buttonSeatIndex + room.maxPlayers) % room.maxPlayers;
}

module.exports = {
  applyAction,
  handlePlayerExit,
  initializeHand,
};
