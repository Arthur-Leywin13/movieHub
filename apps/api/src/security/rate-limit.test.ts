import assert from 'node:assert/strict';
import test from 'node:test';
import { SlidingWindowLimiter } from './rate-limit.ts';

test('refuse une tentative lorsque la fenêtre est pleine', () => {
  let now = 1_000;
  const limiter = new SlidingWindowLimiter({ max: 2, windowMs: 10_000, now: () => now });

  assert.equal(limiter.hit('ip:1').allowed, true);
  assert.equal(limiter.hit('ip:1').allowed, true);
  const blocked = limiter.hit('ip:1');

  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 10);

  now += 10_001;
  assert.equal(limiter.hit('ip:1').allowed, true);
});

test('garde un nombre de clés borné en évincant la plus ancienne', () => {
  let now = 1_000;
  const limiter = new SlidingWindowLimiter({
    max: 1,
    windowMs: 60_000,
    maxKeys: 2,
    now: () => now,
  });

  assert.equal(limiter.hit('a').allowed, true);
  now += 1;
  assert.equal(limiter.hit('b').allowed, true);
  now += 1;
  assert.equal(limiter.hit('c').allowed, true);

  // La clé la plus ancienne a été évincée, les deux autres gardent leur limite.
  assert.equal(limiter.hit('b').allowed, false);
  assert.equal(limiter.hit('c').allowed, false);
  assert.equal(limiter.hit('a').allowed, true);
});

test('rejette une configuration invalide', () => {
  assert.throws(() => new SlidingWindowLimiter({ max: 0, windowMs: 1 }), RangeError);
  assert.throws(() => new SlidingWindowLimiter({ max: 1, windowMs: 0 }), RangeError);
  assert.throws(() => new SlidingWindowLimiter({ max: 1, windowMs: 1, maxKeys: 0 }), RangeError);
});
