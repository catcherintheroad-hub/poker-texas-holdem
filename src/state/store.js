'use strict';

const crypto = require('crypto');
const { DEFAULTS } = require('../engine/rules');

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createStore() {
  const rooms = new Map();
  const sockets = new Map();

  function createPlayerId() {
    return crypto.randomBytes(8).toString('hex');
  }

  function createRoomCode() {
    let code = '';

    do {
      code = '';
      for (let index = 0; index < DEFAULTS.roomCodeLength; index += 1) {
        const offset = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
        code += ROOM_CODE_ALPHABET[offset];
      }
    } while (rooms.has(code));

    return code;
  }

  return {
    createPlayerId,
    createRoomCode,
    rooms,
    sockets,
  };
}

module.exports = {
  createStore,
};
