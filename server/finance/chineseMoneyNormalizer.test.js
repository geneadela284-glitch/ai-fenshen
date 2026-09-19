import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeChineseMoney } from './chineseMoneyNormalizer.js';

const CASES = [
  ['20', 20], ['100', 100], ['1000', 1000], ['10000', 10000],
  ['十', 10], ['十元', 10], ['二十', 20], ['三十', 30], ['四十', 40], ['九十', 90],
  ['一百', 100], ['两百', 200], ['三百', 300], ['一千', 1000], ['两千', 2000],
  ['三千', 3000], ['一万', 10000], ['两万', 20000], ['十万', 100000],
  ['二十五', 25], ['三十八', 38], ['一百二十', 120], ['一百二十三', 123],
  ['三百五十', 350], ['一千二百', 1200], ['一千二百三十四', 1234],
  ['一千零二十', 1020], ['一万二千', 12000], ['一万二千三百', 12300],
  ['三万五千', 35000], ['十万八千', 108000], ['一亿', 100000000], ['两亿', 200000000],
  ['一亿二千三百', 100002300], ['两百', 200], ['两千', 2000],
  ['两万', 20000], ['1千', 1000], ['2千', 2000], ['5千', 5000],
  ['1万', 10000], ['2万', 20000], ['10万', 100000], ['1.5万', 15000],
  ['2.5千', 2500], ['二十元', 20], ['三十块', 30], ['二十块钱', 20],
  ['一百元', 100], ['一千块', 1000], ['一万元', 10000], ['三千人民币', 3000],
  ['〇', 0], ['零', 0], ['人民币二十元', 20], ['  一千  ', 1000]
];

test('ChineseMoneyNormalizer resolves at least fifty deterministic money forms', () => {
  assert.ok(CASES.length >= 50);
  for (const [raw, amount] of CASES) {
    const result = normalizeChineseMoney(raw);
    assert.equal(result.status, 'resolved', raw);
    assert.equal(result.amount, amount, raw);
    assert.equal(result.amountMinor, amount * 100, raw);
  }
});

test('ChineseMoneyNormalizer fails closed for oral shorthand without a frozen rule', () => {
  for (const raw of ['两千三', '三千五', '一万二', '三万五']) {
    assert.equal(normalizeChineseMoney(raw).status, 'ambiguous', raw);
  }
});
