'use strict';

const { RANKS, SUITS } = require('./rules');

function createCard(rank, suit) {
  return { rank, suit };
}

function createDeck() {
  const deck = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(createCard(rank, suit));
    }
  }

  return deck;
}

function shuffleDeck(deck, random = Math.random) {
  const shuffled = [...deck];

  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  return shuffled;
}

function cardToString(card) {
  if (!card) {
    return '?';
  }

  return `${card.rank}${card.suit}`;
}

function drawCards(deck, count) {
  return deck.splice(0, count);
}

module.exports = {
  cardToString,
  createDeck,
  drawCards,
  shuffleDeck,
};
