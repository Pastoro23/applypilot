import test from 'node:test';
import assert from 'node:assert/strict';
import { spreadByCompany } from '../app/match-order.ts';

test('one big board cannot fill the top of the list', () => {
  const jobs = [
    { company: 'Meridial', score: 80, id: 'm1' }, { company: 'Meridial', score: 80, id: 'm2' }, { company: 'Meridial', score: 79, id: 'm3' },
    { company: 'Acme', score: 70, id: 'a1' }, { company: 'Acme', score: 60, id: 'a2' }, { company: 'Beta', score: 65, id: 'b1' },
  ];
  assert.deepEqual(spreadByCompany(jobs).map((job) => job.id), ['m1', 'a1', 'b1', 'm2', 'a2', 'm3']);
});
