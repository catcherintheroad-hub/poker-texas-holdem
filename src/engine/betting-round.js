'use strict';

const { findPlayerBySeat, getNextOccupiedSeat } = require('./seats');

function applyAction(room, player, action, amount, dependencies) {
  const { resolveUncontestedWin, advancePhase } = dependencies;

  if (!room || room.phase === 'waiting' || room.phase === 'showdown' || room.phase === 'scoring') {
    return { ok: false, error: '当前阶段不能操作' };
  }

  if (room.hand.seats.actingSeatIndex !== player.seatIndex) {
    return { ok: false, error: '还没轮到你' };
  }

  if (!canPlayerAct(player)) {
    return { ok: false, error: '当前玩家不能行动' };
  }

  const toCall = Math.max(0, room.hand.betting.currentBet - player.committedChips);
  const normalizedAction = normalizeAction(action, toCall, room);

  switch (normalizedAction) {
    case 'fold':
      player.hasFolded = true;
      player.status = 'folded';
      player.lastAction = 'fold';
      removePendingSeat(room.hand.betting.pendingSeatIndexes, player.seatIndex);
      removeRaiseRight(room.hand.betting.raiseRightsSeatIndexes, player.seatIndex);
      break;
    case 'check':
      if (toCall !== 0) {
        return { ok: false, error: '当前不能过牌' };
      }
      player.lastAction = 'check';
      removePendingSeat(room.hand.betting.pendingSeatIndexes, player.seatIndex);
      removeRaiseRight(room.hand.betting.raiseRightsSeatIndexes, player.seatIndex);
      break;
    case 'call': {
      if (toCall <= 0) {
        return { ok: false, error: '当前无需跟注' };
      }
      const commitAmount = Math.min(toCall, player.chips);
      commitChips(room, player, commitAmount);
      player.lastAction = commitAmount < toCall ? `all-in ${commitAmount}` : `call ${commitAmount}`;
      removePendingSeat(room.hand.betting.pendingSeatIndexes, player.seatIndex);
      removeRaiseRight(room.hand.betting.raiseRightsSeatIndexes, player.seatIndex);
      break;
    }
    case 'bet': {
      if (!canSeatRaise(room, player.seatIndex)) {
        return { ok: false, error: '当前不能下注或加注' };
      }
      if (room.hand.betting.currentBet !== 0) {
        return { ok: false, error: '当前不能下注，请使用加注' };
      }
      const totalBet = clampActionAmount(amount, room.hand.betting.minRaise, player.chips);
      if (totalBet < room.hand.betting.minRaise) {
        return { ok: false, error: `下注至少 ${room.hand.betting.minRaise}` };
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
      if (room.hand.betting.currentBet === 0) {
        return { ok: false, error: '当前无人下注，请使用 bet' };
      }
      const minTotal = room.hand.betting.currentBet + room.hand.betting.lastRaiseSize;
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
      player.lastAction = player.isAllIn && totalBet > room.hand.betting.currentBet ? `all-in ${commitAmount}` : `raise to ${totalBet}`;
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
      if (totalBet > room.hand.betting.currentBet && !canSeatRaise(room, player.seatIndex)) {
        return { ok: false, error: '短码 all-in 未重新打开加注权限' };
      }
      const commitAmount = player.chips;
      commitChips(room, player, commitAmount);
      player.lastAction = `all-in ${commitAmount}`;

      if (totalBet > room.hand.betting.currentBet) {
        if (isFullRaise(room, totalBet)) {
          registerAggressiveAction(room, player, totalBet);
        } else {
          registerShortAllInAction(room, player, totalBet);
        }
      } else {
        removePendingSeat(room.hand.betting.pendingSeatIndexes, player.seatIndex);
        removeRaiseRight(room.hand.betting.raiseRightsSeatIndexes, player.seatIndex);
      }
      break;
    }
    default:
      return { ok: false, error: '未知操作' };
  }

  room.hand.log.actionLog.push({
    seatIndex: player.seatIndex,
    playerId: player.id,
    action: normalizedAction,
    amount: Number.parseInt(amount, 10) || 0,
    phase: room.phase,
    timestamp: Date.now(),
  });
  room.updatedAt = Date.now();

  const remainingPlayers = room.players.filter((entry) => !entry.hasFolded && entry.holeCards.length > 0);
  if (remainingPlayers.length === 1) {
    return { ok: true, outcome: resolveUncontestedWin(room, remainingPlayers[0]) };
  }

  if (isBettingRoundComplete(room)) {
    return { ok: true, outcome: advancePhase(room) };
  }

  room.hand.seats.actingSeatIndex = getNextActingSeat(room, player.seatIndex);
  return { ok: true, outcome: { type: 'state_only' } };
}

function initializeBettingRound(room, phase, actingSeatIndex) {
  room.phase = phase;
  room.hand.phase = phase;
  room.hand.betting.currentBet = 0;
  room.hand.betting.minRaise = room.blinds.big;
  room.hand.betting.lastRaiseSize = room.blinds.big;
  room.hand.seats.actingSeatIndex = actingSeatIndex;
  room.hand.betting.pendingSeatIndexes = buildPendingSeatIndexes(room, actingSeatIndex);
  room.hand.betting.raiseRightsSeatIndexes = buildRaiseRightsSeatIndexes(room, actingSeatIndex);

  for (const player of room.players) {
    player.committedChips = 0;
    player.lastAction = null;
  }

  room.updatedAt = Date.now();
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
      if (player && canPlayerAct(player) && player.committedChips < room.hand.betting.currentBet) {
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
    return room.hand.seats.actingSeatIndex;
  }

  return getNextActingSeat(room, room.hand.seats.buttonSeatIndex);
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
  return room.hand.betting.pendingSeatIndexes.length === 0;
}

function getActionablePlayers(room) {
  return room.players.filter((player) => canPlayerAct(player));
}

function canPlayerAct(player) {
  return !player.hasFolded && !player.isAllIn && player.chips > 0 && player.holeCards.length > 0;
}

function registerAggressiveAction(room, player, totalBet) {
  const previousBet = room.hand.betting.currentBet;
  const raiseSize = totalBet - previousBet;

  room.hand.betting.currentBet = totalBet;
  room.hand.betting.lastRaiseSize = Math.max(room.hand.betting.lastRaiseSize, raiseSize);
  room.hand.betting.minRaise = room.hand.betting.currentBet + room.hand.betting.lastRaiseSize;
  room.hand.betting.pendingSeatIndexes = buildPendingSeatIndexes(room, getNextActingSeat(room, player.seatIndex), player.seatIndex);
  room.hand.betting.raiseRightsSeatIndexes = buildRaiseRightsSeatIndexes(room, getNextActingSeat(room, player.seatIndex), player.seatIndex);
  room.hand.seats.actingSeatIndex = getNextActingSeat(room, player.seatIndex);
}

function registerShortAllInAction(room, player, totalBet) {
  room.hand.betting.currentBet = totalBet;
  room.hand.betting.minRaise = room.hand.betting.currentBet + room.hand.betting.lastRaiseSize;
  room.hand.betting.pendingSeatIndexes = buildPendingSeatIndexesForCurrentBet(
    room,
    getNextActingSeat(room, player.seatIndex),
    player.seatIndex,
  );
  removeRaiseRight(room.hand.betting.raiseRightsSeatIndexes, player.seatIndex);
  room.hand.seats.actingSeatIndex = getNextActingSeat(room, player.seatIndex);
}

function commitChips(room, player, amount) {
  const commitAmount = Math.min(amount, player.chips);
  player.chips -= commitAmount;
  player.committedChips += commitAmount;
  player.totalCommittedChips += commitAmount;
  player.isAllIn = player.chips === 0;
  room.hand.betting.pot += commitAmount;
}

function normalizeAction(action, toCall, room) {
  if (action === 'raise' && toCall === 0 && room.hand.betting.currentBet === 0) {
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
  return room.hand.betting.raiseRightsSeatIndexes.includes(seatIndex);
}

function isFullRaise(room, totalBet) {
  return totalBet - room.hand.betting.currentBet >= room.hand.betting.lastRaiseSize;
}

module.exports = {
  applyAction,
  buildPendingSeatIndexes,
  buildRaiseRightsSeatIndexes,
  canPlayerAct,
  getFirstActingSeatForPhase,
  getNextActingSeat,
  initializeBettingRound,
  isBettingRoundComplete,
};
