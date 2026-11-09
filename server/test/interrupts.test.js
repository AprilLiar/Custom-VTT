// The Interrupt lock (server/interrupts.js): one interrupter at a time; while
// an Action resolves, a press waits in a queue for the stack to finish.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeInterrupt, claimInterrupt, dropInterrupts, interruptOf, nextInterrupt, releaseInterrupt, unqueueInterrupt } from '../interrupts.js';

test('the Interrupt lock: claim, queue while busy or locked, release, then the next in line', () => {
  const F = 9001;
  dropInterrupts(F);
  assert.equal(interruptOf(F), null);
  assert.equal(claimInterrupt(F, { combatantId: 1, name: 'Ana', by: 's1' }, false), 'active');
  assert.equal(claimInterrupt(F, { combatantId: 1, name: 'Ana', by: 's1' }, false), 'already');
  assert.equal(claimInterrupt(F, { combatantId: 2, name: 'Cy', by: 's2' }, false), 'queued', 'someone else holds the lock');
  assert.deepEqual(interruptOf(F), { active: { combatantId: 1, name: 'Ana', by: 's1' }, queue: [{ combatantId: 2, name: 'Cy', by: 's2' }] });
  assert.equal(nextInterrupt(F), null, 'never while the lock is held');
  assert.equal(releaseInterrupt(F, 2), false, 'only the holder releases it');
  assert.equal(releaseInterrupt(F, 1), true);
  assert.equal(activeInterrupt(F), null);
  assert.deepEqual(nextInterrupt(F), { combatantId: 2, name: 'Cy', by: 's2' }, 'the stack finished: the next one takes it');
  assert.equal(releaseInterrupt(F), true);
  assert.equal(claimInterrupt(F, { combatantId: 3, name: 'Bo' }, true), 'queued', 'an Action is resolving: it waits');
  assert.equal(activeInterrupt(F), null);
  assert.equal(unqueueInterrupt(F, 3), true, 'given up before its turn came');
  assert.equal(interruptOf(F), null);
  claimInterrupt(F, { combatantId: 4, name: 'Dee' }, false);
  dropInterrupts(F);
  assert.equal(interruptOf(F), null, 'the fight ended');
});
