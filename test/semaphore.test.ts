/**
 * Tests for the per-engine request gate.
 *
 * @module dsh-web-search-bing/test/semaphore
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Semaphore, gateFor, resetGates } from '../src/semaphore.ts';

test('a gate admits its permits and queues the rest', async () => {
  const gate = new Semaphore(1);
  const first = await gate.acquire();
  let admitted = false;
  const second = gate.acquire().then((release) => { admitted = true; return release; });
  await Promise.resolve();
  assert.equal(admitted, false);
  assert.equal(gate.pending, 1);
  first();
  const releaseSecond = await second;
  assert.equal(admitted, true);
  assert.equal(gate.running, 1);
  releaseSecond();
  assert.equal(gate.running, 0);
});

test('releases are idempotent and never leak a permit', async () => {
  const gate = new Semaphore(2);
  const a = await gate.acquire();
  const b = await gate.acquire();
  a();
  a();
  assert.equal(gate.running, 1);
  const c = await gate.acquire();
  assert.equal(gate.running, 2);
  b();
  c();
  assert.equal(gate.running, 0);
});

test('a cancelled waiter leaves the queue without taking a permit', async () => {
  const gate = new Semaphore(1);
  const release = await gate.acquire();
  const controller = new AbortController();
  const waiting = gate.acquire(controller.signal);
  controller.abort(new Error('cancelled by caller'));
  await assert.rejects(waiting, /cancelled by caller/);
  assert.equal(gate.pending, 0);
  release();
  assert.equal(gate.running, 0);
});

test('gates are shared by id', () => {
  resetGates();
  const a = gateFor('exa', 1);
  assert.equal(gateFor('exa', 1), a);
  assert.notEqual(gateFor('firecrawl', 1), a);
  assert.throws(() => new Semaphore(0), /at least one permit/);
});
