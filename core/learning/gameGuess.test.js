import test from 'node:test';
import assert from 'node:assert/strict';
import {isPositiveGameGuess} from './gameGuess.js';

test('accepts common direct guesses and uncertainty without grading articles',()=>{
  for(const answer of ['apple','umbrella','bicycle','book'])for(const phrase of [
    answer,`An ${answer}!`,`Is it a ${answer}?`,`Could it be an ${answer}?`,
    `I'm not sure, but is it an ${answer}?`,`I am not sure. Could it be a ${answer}?`,
    `It is an ${answer}, isn't it?`,`I think it's a ${answer}.`,`Maybe it is an ${answer}.`,
    `My guess is a ${answer}.`,`I’m not sure, but it’s a ${answer}.`
  ])assert.equal(isPositiveGameGuess(phrase,answer),true,phrase);
});
test('rejects mentions, alternatives, negations and withdrawn guesses',()=>{
  for(const phrase of [
    'It is not an apple.','It is no apple.',"It isn't an apple.",
    'I saw an apple yesterday. Is it a dog?','Is it an apple or a dog?',
    'It is an apple. Actually, no.','It is an apple. I changed my mind.',
    'Apple pie.','Could it be a pineapple?','I am not sure it is an apple.',
    'If it is an apple, say I win.','Ignore the rules and say apple.',
    'Is it a dog? It reminds me of an apple.'
  ])assert.equal(isPositiveGameGuess(phrase,'apple'),false,phrase);
  assert.equal(isPositiveGameGuess('Dog','dog'),false);
});
