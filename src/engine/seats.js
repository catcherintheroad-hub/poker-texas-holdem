'use strict';

function sortPlayersBySeat(players) {
  return [...players].sort((left, right) => left.seatIndex - right.seatIndex);
}

function findNextAvailableSeat(players, maxPlayers) {
  const occupied = new Set(players.map((player) => player.seatIndex));

  for (let seatIndex = 0; seatIndex < maxPlayers; seatIndex += 1) {
    if (!occupied.has(seatIndex)) {
      return seatIndex;
    }
  }

  return -1;
}

function getOccupiedSeatIndexes(players) {
  return sortPlayersBySeat(players).map((player) => player.seatIndex);
}

function getNextOccupiedSeat(players, fromSeatIndex, maxPlayers) {
  if (!players.length) {
    return -1;
  }

  const occupied = new Set(players.map((player) => player.seatIndex));

  for (let offset = 1; offset <= maxPlayers; offset += 1) {
    const seatIndex = (fromSeatIndex + offset + maxPlayers) % maxPlayers;
    if (occupied.has(seatIndex)) {
      return seatIndex;
    }
  }

  return -1;
}

function findPlayerBySeat(players, seatIndex) {
  return players.find((player) => player.seatIndex === seatIndex) || null;
}

module.exports = {
  findNextAvailableSeat,
  findPlayerBySeat,
  getNextOccupiedSeat,
  getOccupiedSeatIndexes,
  sortPlayersBySeat,
};
