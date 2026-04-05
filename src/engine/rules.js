'use strict';

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const STREET_ORDER = ['preflop', 'flop', 'turn', 'river', 'showdown'];
const ROOM_PHASES = ['waiting', ...STREET_ORDER, 'scoring'];

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8080,
  startingChips: 1000,
  minBigBlind: 10,
  maxBigBlind: 1000,
  minPlayers: 2,
  maxPlayers: 10,
  roomCodeLength: 4,
  maxPlayerNameLength: 20,
  maxChatLength: 200,
};

module.exports = {
  DEFAULTS,
  RANKS,
  ROOM_PHASES,
  STREET_ORDER,
  SUITS,
};
