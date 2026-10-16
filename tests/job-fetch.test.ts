import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkedJobUrl, fetchJobText, MAX_JOB_BYTES } from '../app/job-fetch.ts';
import { decodeEntities } from '../app/job-posting.ts';
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('private hosts, HTTP, credentials, other ports and suffix tricks are rejected before any fetch', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('should not fetch'); };
  for (const url of ['http://127.0.0.1', 'https://169.254.169.254', 'https://[::1]', 'https://localhost', 'https://greenhouse.io.attacker.invalid/x', 'https://jobs.lever.co:444/x', 'https://user:pass@jobs.lever.co/x', 'http://jobs.lever.co/x', 'https://careers.example.com/job']) {
    await assert.rejects(fetchJobText(url, 'html'));
  }
  assert.equal(calls, 0);
  assert.equal(checkedJobUrl('https://job-boards.greenhouse.io/a/jobs/1').hostname, 'job-boards.greenhouse.io');
});
test('redirects are validated before following; no request to a private destination', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => { calls.push(String(input)); assert.equal(init?.redirect, 'manual'); return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }); };
  await assert.rejects(fetchJobText('https://jobs.lever.co/a/1', 'html'), /Automatic reading/);
  assert.equal(calls.length, 1);
});
test('approved redirects work and cycles stop after a bounded number of requests', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return calls === 1 ? new Response(null, { status: 302, headers: { location: '/a/new' } }) : new Response('<p>job</p>', { headers: { 'content-type': 'text/html' } }); };
  assert.equal(await fetchJobText('https://jobs.lever.co/a/1', 'html'), '<p>job</p>');
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location: '/again' } }); };
  await assert.rejects(fetchJobText('https://jobs.lever.co/a/1', 'html'), /too many/);
  assert.equal(calls, 4);
});
test('announced and streamed oversized responses are rejected', async () => {
  globalThis.fetch = async () => new Response('small', { headers: { 'content-type': 'text/html', 'content-length': String(MAX_JOB_BYTES + 1) } });
  await assert.rejects(fetchJobText('https://jobs.lever.co/a/1', 'html'), /too large/);
  globalThis.fetch = async () => new Response(new Uint8Array(MAX_JOB_BYTES + 1), { headers: { 'content-type': 'text/html' } });
  await assert.rejects(fetchJobText('https://jobs.lever.co/a/1', 'html'), /too large/);
});
test('network deadline aborts a slow job reader', async () => {
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  await assert.rejects(fetchJobText('https://jobs.lever.co/a/1', 'html', 10), /took too long/);
});
test('non-page responses are rejected and invalid entities do not crash parsing', async () => {
  globalThis.fetch = async () => new Response('%PDF-1.7', { headers: { 'content-type': 'application/pdf' } });
  await assert.rejects(fetchJobText('https://jobs.lever.co/a/1', 'html'), /readable job/);
  assert.equal(decodeEntities('&#99999999; &#xD800;'), '&#99999999; &#xD800;');
});
