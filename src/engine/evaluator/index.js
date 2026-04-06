'use strict';

const defaultEvaluator = require('./default-evaluator');

function getEvaluator() {
  return defaultEvaluator;
}

module.exports = {
  getEvaluator,
};
