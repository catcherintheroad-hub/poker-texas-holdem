'use strict';

const { getEvaluator } = require('./evaluator');
const { prepareNextHandOrWaiting } = require('./hand-reset');

function resolveUncontestedWin(room, winner) {
  const handMeta = {
    handId: room.hand.id,
    handNumber: room.hand.handNumber,
    phase: room.phase,
  };
  const prize = room.hand.betting.pot;
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
    handMeta,
    winners: [winnerSnapshot],
    prize,
    pot: room.hand.betting.pot,
    handType: 'Uncontested',
    communityCards,
  };

  prepareNextHandOrWaiting(room);
  return outcome;
}

function resolveShowdown(room) {
  const handMeta = {
    handId: room.hand.id,
    handNumber: room.hand.handNumber,
    phase: room.phase,
  };
  const evaluator = getEvaluator();
  const contenders = getRemainingPlayers(room);
  const evaluations = new Map();

  for (const contender of contenders) {
    evaluations.set(contender.id, evaluator.evaluate([...contender.holeCards, ...room.hand.board]));
  }

  const sidePots = buildSidePots(room.players);
  const payoutByPlayerId = new Map();

  for (const sidePot of sidePots) {
    const eligibleContenders = sidePot.eligiblePlayers.filter((player) => !player.hasFolded);
    if (!eligibleContenders.length) {
      continue;
    }

    const winners = selectPotWinners(eligibleContenders, evaluations, evaluator);
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
    handMeta,
    winners: payoutWinners,
    prize: room.hand.betting.pot,
    pot: room.hand.betting.pot,
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

function getRemainingPlayers(room) {
  return room.players.filter((player) => !player.hasFolded && player.holeCards.length > 0);
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

function selectPotWinners(players, evaluations, evaluator) {
  let bestEvaluation = null;
  let winners = [];

  for (const player of players) {
    const evaluation = evaluations.get(player.id);
    if (!bestEvaluation) {
      bestEvaluation = evaluation;
      winners = [player];
      continue;
    }

    const comparison = evaluator.compare(evaluation, bestEvaluation);
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
  buildSidePots,
  getRemainingPlayers,
  resolveShowdown,
  resolveUncontestedWin,
};
