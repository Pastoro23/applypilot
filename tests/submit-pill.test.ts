import test from 'node:test';
import assert from 'node:assert/strict';
import { alreadySubmittedReason, checkText, isStaleClaim, pillLabel, resumeNotice, staleText, submittedLabel } from '../app/submit-pill.ts';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const MIN = 60_000;
const claimedAt = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();
const row = (over: Record<string, unknown> = {}) =>
  ({ state: 'claimed', claimMode: 'supervised', claimedAt: claimedAt(1), clickedBy: '', ...over }) as Parameters<typeof pillLabel>[0];

test('a supervised claim is not called stale while Chrome still waits up to 30 minutes for your click', () => {
  const waiting = row({ claimedAt: claimedAt(20) });
  assert.equal(isStaleClaim(waiting, NOW), false);
  assert.equal(pillLabel(waiting, NOW, { state: 'waiting_for_you', note: 'Waiting for you to click Submit' }), 'Waiting for you to click Submit');
  assert.equal(isStaleClaim(row({ claimedAt: claimedAt(36) }), NOW), true);
  assert.equal(pillLabel(row({ claimedAt: claimedAt(36) }), NOW), 'Check this');
  assert.match(staleText(row()), /over 35 minutes/);
  // An automatic claim has no such wait.
  assert.equal(isStaleClaim(row({ claimMode: 'auto', claimedAt: claimedAt(16) }), NOW), true);
  assert.match(staleText(row({ claimMode: 'auto' })), /over 15 minutes/);
});

test('a live claim shows Chrome\'s own progress, not a finished note', () => {
  assert.equal(pillLabel(row(), NOW, { state: 'submitting', note: 'Submitting' }), 'Submitting…');
  assert.equal(pillLabel(row(), NOW, { state: 'done:submitted', note: 'Sent' }), 'Sending…');
  assert.equal(pillLabel(row(), NOW), 'Sending…');
  assert.equal(pillLabel(row({ state: 'approved', claimMode: '', claimedAt: null }), NOW, undefined, 'Duplicate'), "Approved · Chrome didn't take it");
});

test('the check text says who clicked Submit', () => {
  assert.match(checkText({ clickedBy: 'you' }), /^You clicked Submit/);
  assert.match(checkText({ clickedBy: 'applypilot' }), /^ApplyPilot clicked Submit/);
  assert.equal(pillLabel(row({ state: 'check', clickedBy: 'you' }), NOW), 'Check this');
});

test('sent and already-submitted wording follows who sent it', () => {
  assert.equal(submittedLabel('you'), 'Sent by you');
  assert.equal(submittedLabel('applypilot'), 'Sent by ApplyPilot');
  assert.equal(submittedLabel(''), 'Sent · you said it went through');
  assert.equal(alreadySubmittedReason('you'), 'Already submitted by you');
  assert.equal(alreadySubmittedReason('applypilot'), 'Already submitted by ApplyPilot');
  assert.equal(alreadySubmittedReason(''), 'Already submitted (you said it went through)');
});

test('"Resume sending" says Chrome is sending only when Chrome says so', () => {
  assert.equal(resumeNotice(true), 'Sending again in Chrome.');
  assert.match(resumeNotice(false), /hasn't started sending/);
});
