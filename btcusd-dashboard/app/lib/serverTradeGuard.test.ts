import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { calculateAtrFromCloseBars } from './serverTradeGuard';

describe('server trade guard price protection', () => {
  it('requires enough one-minute bars before deriving a protective distance', () => {
    assert.equal(calculateAtrFromCloseBars(new Array(14).fill(100)), null);
  });

  it('calculates ATR from recent one-minute close-to-close moves', () => {
    const prices = Array.from({ length: 15 }, (_, index) => 100 + index * 2);
    assert.equal(calculateAtrFromCloseBars(prices), 2);
  });
});
