'use strict';

const HAND_CATEGORY_NAMES = [
  'High Card',
  'One Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
];

const RANK_TO_VALUE = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

function evaluateBestHand(cards) {
  if (!Array.isArray(cards) || cards.length < 5) {
    throw new Error('At least five cards are required to evaluate a poker hand');
  }

  let bestEvaluation = null;

  for (const combination of combinations(cards, 5)) {
    const evaluation = evaluateFiveCardHand(combination);
    if (!bestEvaluation || compareEvaluations(evaluation, bestEvaluation) > 0) {
      bestEvaluation = evaluation;
    }
  }

  return bestEvaluation;
}

function compareEvaluations(left, right) {
  if (left.category !== right.category) {
    return left.category - right.category;
  }

  const limit = Math.max(left.tiebreakers.length, right.tiebreakers.length);
  for (let index = 0; index < limit; index += 1) {
    const leftValue = left.tiebreakers[index] || 0;
    const rightValue = right.tiebreakers[index] || 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return 0;
}

function evaluateFiveCardHand(cards) {
  const values = cards.map((card) => RANK_TO_VALUE[card.rank]).sort((left, right) => right - left);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const straightHigh = getStraightHigh(values);
  const counts = buildCounts(values);
  const groups = [...counts.entries()]
    .map(([value, count]) => ({ value: Number(value), count }))
    .sort((left, right) => right.count - left.count || right.value - left.value);

  if (flush && straightHigh) {
    return buildEvaluation(8, [straightHigh], cards);
  }

  if (groups[0].count === 4) {
    const kicker = groups.find((group) => group.count === 1).value;
    return buildEvaluation(7, [groups[0].value, kicker], cards);
  }

  if (groups[0].count === 3 && groups[1].count === 2) {
    return buildEvaluation(6, [groups[0].value, groups[1].value], cards);
  }

  if (flush) {
    return buildEvaluation(5, values, cards);
  }

  if (straightHigh) {
    return buildEvaluation(4, [straightHigh], cards);
  }

  if (groups[0].count === 3) {
    const kickers = groups.filter((group) => group.count === 1).map((group) => group.value).sort((left, right) => right - left);
    return buildEvaluation(3, [groups[0].value, ...kickers], cards);
  }

  if (groups[0].count === 2 && groups[1].count === 2) {
    const pairValues = groups.filter((group) => group.count === 2).map((group) => group.value).sort((left, right) => right - left);
    const kicker = groups.find((group) => group.count === 1).value;
    return buildEvaluation(2, [...pairValues, kicker], cards);
  }

  if (groups[0].count === 2) {
    const kickers = groups.filter((group) => group.count === 1).map((group) => group.value).sort((left, right) => right - left);
    return buildEvaluation(1, [groups[0].value, ...kickers], cards);
  }

  return buildEvaluation(0, values, cards);
}

function buildEvaluation(category, tiebreakers, cards) {
  return {
    category,
    tiebreakers,
    name: HAND_CATEGORY_NAMES[category],
    cards,
  };
}

function getStraightHigh(values) {
  const unique = [...new Set(values)].sort((left, right) => left - right);
  if (unique.length !== 5) {
    return null;
  }

  const wheel = [2, 3, 4, 5, 14];
  if (unique.every((value, index) => value === wheel[index])) {
    return 5;
  }

  for (let index = 1; index < unique.length; index += 1) {
    if (unique[index] !== unique[index - 1] + 1) {
      return null;
    }
  }

  return unique[unique.length - 1];
}

function buildCounts(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function combinations(items, size, start = 0, prefix = [], result = []) {
  if (prefix.length === size) {
    result.push([...prefix]);
    return result;
  }

  for (let index = start; index <= items.length - (size - prefix.length); index += 1) {
    prefix.push(items[index]);
    combinations(items, size, index + 1, prefix, result);
    prefix.pop();
  }

  return result;
}

module.exports = {
  compareEvaluations,
  evaluateBestHand,
};
