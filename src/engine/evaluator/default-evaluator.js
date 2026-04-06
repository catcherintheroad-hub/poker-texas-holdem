'use strict';

const { compareEvaluations, evaluateBestHand } = require('../hand-evaluator');

function evaluate(cards) {
  return evaluateBestHand(cards);
}

function compare(left, right) {
  return compareEvaluations(left, right);
}

module.exports = {
  compare,
  evaluate,
};
