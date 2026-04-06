'use strict';

function createHandCore() {
  return {
    id: null,
    phase: 'waiting',
    deck: [],
    board: [],
    handNumber: 0,
    seats: {
      buttonSeatIndex: -1,
      smallBlindSeatIndex: -1,
      bigBlindSeatIndex: -1,
      actingSeatIndex: -1,
    },
    betting: {
      pot: 0,
      currentBet: 0,
      minRaise: 0,
      lastRaiseSize: 0,
      pendingSeatIndexes: [],
      raiseRightsSeatIndexes: [],
    },
    showdown: {
      seatIndexes: [],
    },
    log: {
      actionLog: [],
    },
  };
}

function attachLegacyAliases(hand) {
  defineAlias(hand, 'buttonSeatIndex', hand.seats, 'buttonSeatIndex');
  defineAlias(hand, 'smallBlindSeatIndex', hand.seats, 'smallBlindSeatIndex');
  defineAlias(hand, 'bigBlindSeatIndex', hand.seats, 'bigBlindSeatIndex');
  defineAlias(hand, 'actingSeatIndex', hand.seats, 'actingSeatIndex');

  defineAlias(hand, 'pot', hand.betting, 'pot');
  defineAlias(hand, 'currentBet', hand.betting, 'currentBet');
  defineAlias(hand, 'minRaise', hand.betting, 'minRaise');
  defineAlias(hand, 'lastRaiseSize', hand.betting, 'lastRaiseSize');
  defineAlias(hand, 'pendingSeatIndexes', hand.betting, 'pendingSeatIndexes');
  defineAlias(hand, 'raiseRightsSeatIndexes', hand.betting, 'raiseRightsSeatIndexes');

  defineAlias(hand, 'showdownSeatIndexes', hand.showdown, 'seatIndexes');
  defineAlias(hand, 'actionLog', hand.log, 'actionLog');

  return hand;
}

function defineAlias(target, aliasKey, source, sourceKey) {
  Object.defineProperty(target, aliasKey, {
    enumerable: true,
    configurable: true,
    get() {
      return source[sourceKey];
    },
    set(value) {
      source[sourceKey] = value;
    },
  });
}

function normalizeHandState(overrides = {}) {
  const next = { ...overrides };
  const normalized = createHandCore();

  normalized.id = next.id ?? normalized.id;
  normalized.phase = next.phase ?? normalized.phase;
  normalized.deck = cloneArray(next.deck ?? normalized.deck);
  normalized.board = cloneArray(next.board ?? normalized.board);
  normalized.handNumber = next.handNumber ?? normalized.handNumber;

  normalized.seats = {
    ...normalized.seats,
    ...(next.seats || {}),
    buttonSeatIndex: next.buttonSeatIndex ?? next.seats?.buttonSeatIndex ?? normalized.seats.buttonSeatIndex,
    smallBlindSeatIndex: next.smallBlindSeatIndex ?? next.seats?.smallBlindSeatIndex ?? normalized.seats.smallBlindSeatIndex,
    bigBlindSeatIndex: next.bigBlindSeatIndex ?? next.seats?.bigBlindSeatIndex ?? normalized.seats.bigBlindSeatIndex,
    actingSeatIndex: next.actingSeatIndex ?? next.seats?.actingSeatIndex ?? normalized.seats.actingSeatIndex,
  };

  normalized.betting = {
    ...normalized.betting,
    ...(next.betting || {}),
    pot: next.pot ?? next.betting?.pot ?? normalized.betting.pot,
    currentBet: next.currentBet ?? next.betting?.currentBet ?? normalized.betting.currentBet,
    minRaise: next.minRaise ?? next.betting?.minRaise ?? normalized.betting.minRaise,
    lastRaiseSize: next.lastRaiseSize ?? next.betting?.lastRaiseSize ?? normalized.betting.lastRaiseSize,
    pendingSeatIndexes: cloneArray(next.pendingSeatIndexes ?? next.betting?.pendingSeatIndexes ?? normalized.betting.pendingSeatIndexes),
    raiseRightsSeatIndexes: cloneArray(next.raiseRightsSeatIndexes ?? next.betting?.raiseRightsSeatIndexes ?? normalized.betting.raiseRightsSeatIndexes),
  };

  normalized.showdown = {
    ...normalized.showdown,
    ...(next.showdown || {}),
    seatIndexes: cloneArray(next.showdownSeatIndexes ?? next.showdown?.seatIndexes ?? normalized.showdown.seatIndexes),
  };

  normalized.log = {
    ...normalized.log,
    ...(next.log || {}),
    actionLog: cloneArray(next.actionLog ?? next.log?.actionLog ?? normalized.log.actionLog),
  };

  return attachLegacyAliases(normalized);
}

function createEmptyHandState() {
  return normalizeHandState();
}

function createHandState(overrides = {}) {
  return normalizeHandState(overrides);
}

function cloneArray(value) {
  return Array.isArray(value) ? [...value] : [];
}

module.exports = {
  createEmptyHandState,
  createHandState,
  normalizeHandState,
};
