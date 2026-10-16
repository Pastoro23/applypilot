import test from 'node:test';
import assert from 'node:assert/strict';
import { tailorWithLatestDescription, type JsonRequest } from '../app/tailoring-actions.ts';
const app = { id: 'job', jobDescription: 'old description '.repeat(10).trim(), tailoredRevision: 2 };
const draft = 'updated description '.repeat(12).trim();
test('tailoring saves the visible description before generating and sends the saved revision', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const api: JsonRequest = async <T>(url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)); calls.push({ url, body });
    return { application: { ...app, jobDescription: draft, tailoredRevision: url === '/api/applications' ? 3 : 4 } } as T;
  };
  const updates: unknown[] = [];
  await tailorWithLatestDescription(api, app, draft, 'notes', value => updates.push(value));
  assert.deepEqual(calls.map(c => c.url), ['/api/applications', '/api/tailor']);
  assert.equal(calls[1].body.jobDescription, draft); assert.equal(calls[1].body.revision, 3); assert.equal(updates.length, 1);
});
test('a failed description save prevents a paid tailoring call', async () => {
  const calls: string[] = []; const api: JsonRequest = async (url) => { calls.push(url); throw new Error('Save failed'); };
  await assert.rejects(tailorWithLatestDescription(api, app, draft, '', () => {}), /Save failed/);
  assert.deepEqual(calls, ['/api/applications']);
});
test('already-saved descriptions skip the extra write and oversize drafts are rejected', async () => {
  const calls: string[] = []; const api: JsonRequest = async <T>(url: string) => { calls.push(url); return { application: app } as T; };
  await tailorWithLatestDescription(api, app, app.jobDescription, '', () => {});
  assert.deepEqual(calls, ['/api/tailor']);
  await assert.rejects(tailorWithLatestDescription(api, app, 'x'.repeat(20001), '', () => {}), /20,000/);
  assert.equal(calls.length, 1);
});
