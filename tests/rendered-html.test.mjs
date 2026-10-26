import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

register(new URL('./cloudflare-loader.mjs', import.meta.url), import.meta.url);
const sqlite = new DatabaseSync(':memory:');
for (const f of readdirSync(new URL('../drizzle/', import.meta.url)).filter(n => n.endsWith('.sql')).sort()) {
  sqlite.exec(readFileSync(new URL('../drizzle/' + f, import.meta.url), 'utf8'));
}
function prepare(sql, values = []) {
  return {
    bind(...args) { return prepare(sql, args); },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...values), meta: {} }; },
    async raw() { return sqlite.prepare(sql).all(...values).map(row => Object.values(row)); },
    async run() { const r = sqlite.prepare(sql).run(...values); return { results: [], meta: { changes: Number(r.changes) } }; },
  };
}
const DB = {
  prepare,
  async batch(statements) {
    sqlite.exec('BEGIN');
    try { const result = []; for (const s of statements) result.push(await s.run()); sqlite.exec('COMMIT'); return result; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
};
globalThis.__APPLYPILOT_TEST_ENV__ = { DB };
const { default: worker } = await import('../dist/server/index.js');
const context = { waitUntil() {}, passThroughOnException() {} };
async function request(path = '/', { method = 'GET', body, owner } = {}) {
  const headers = { accept: 'application/json' };
  if (body) headers['content-type'] = 'application/json';
  if (owner) headers['oai-authenticated-user-email'] = owner;
  return worker.fetch(new Request('http://localhost' + path, {
    method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
  }), { ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) }, DB }, context);
}

test('built Worker renders production sign-in HTML without development metadata', async () => {
  const response = await worker.fetch(new Request('http://localhost/', { headers: { accept: 'text/html' } }),
    { ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } }, context);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
  assert.match(html, /ApplyPilot/); assert.match(html, /Sign in with ChatGPT/);
  assert.doesNotMatch(html, /name=["']codex-preview["']/);
});
test('built API routes require a signed-in user', async () => {
  for (const [path, method] of [['/api/overview','GET'], ['/api/master-resume','GET'], ['/api/master-resume','POST'], ['/api/tailor','POST'], ['/api/job-details','POST']]) {
    assert.equal((await request(path, { method })).status, 401, path);
  }
});
test('built APIs persist reviewed text and enforce ownership and expected description', async () => {
  const owner = 'worker-test@example.invalid';
  const overview = await request('/api/overview', { owner }); assert.equal(overview.status, 200);
  const resume = 'Verified source resume, employer and dates. '.repeat(12).trim();
  assert.equal((await request('/api/master-resume', { owner, method: 'PUT', body: { content: resume } })).status, 200);
  assert.equal((await (await request('/api/master-resume', { owner })).json()).resume.content, resume);
  const jobDescription = 'Support computers, printers and networks. '.repeat(10).trim();
  const added = await request('/api/applications', { owner, method: 'POST', body: { company: 'Test', role: 'Technician', jobDescription } });
  assert.equal(added.status, 201); const { application } = await added.json();
  const foreign = await request('/api/tailor', { owner: 'different@example.invalid', method: 'POST', body: { applicationId: application.id, revision: 0, jobDescription } });
  assert.equal(foreign.status, 404);
  const stale = await request('/api/tailor', { owner, method: 'POST', body: { applicationId: application.id, revision: 0, jobDescription: 'old text' } });
  assert.equal(stale.status, 409);
  const needsKey = await request('/api/tailor', { owner, method: 'POST', body: { applicationId: application.id, revision: 0, jobDescription } });
  assert.equal(needsKey.status, 503); assert.match((await needsKey.json()).error, /ANTHROPIC_API_KEY/);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM ai_operations').get().n, 0);
});
test('built submission routes check sign-in first, then insist on a JSON body', async () => {
  const owner = 'worker-submit@example.invalid';
  const routes = [['/api/submissions', 'GET'], ['/api/submissions', 'PATCH'], ['/api/submissions/approve', 'POST'],
    ['/api/submissions/claim', 'POST'], ['/api/submissions/results', 'POST']];
  for (const [path, method] of routes) {
    assert.equal((await request(path, { method, ...(method === 'GET' ? {} : { body: {} }) })).status, 401, `${method} ${path} unsigned`);
  }
  const env = { ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) }, DB };
  for (const [path, method] of routes.filter(([, m]) => m !== 'GET')) {
    // No header (a plain string body becomes text/plain), HTML form posts, and a lookalike type are all refused.
    const form = new FormData(); form.set('approvalId', 'x');
    for (const [type, body] of [[null, '{}'], ['text/plain', '{}'], ['application/x-www-form-urlencoded', 'a=1'], [null, form], ['application/jsonx', '{}']]) {
      const headers = { 'oai-authenticated-user-email': owner, ...(type ? { 'content-type': type } : {}) };
      const response = await worker.fetch(new Request('http://localhost' + path, { method, headers, body }), env, context);
      assert.equal(response.status, 415, `${method} ${path} as ${type ?? (typeof body === 'string' ? 'text/plain' : 'multipart')}`);
    }
  }
  // Signed JSON gets through to the handlers, which make no outbound calls.
  assert.equal((await request('/api/submissions', { owner })).status, 200);
  assert.equal((await request('/api/submissions', { owner, method: 'PATCH', body: { action: 'nothing' } })).status, 400);
  assert.equal((await request('/api/submissions/approve', { owner, method: 'POST', body: { items: [] } })).status, 400);
  const claim = await request('/api/submissions/claim', { owner, method: 'POST', body: {} });
  assert.equal(claim.status, 200); assert.deepEqual(await claim.json(), { ok: false, reason: 'invalid_request' });
  assert.equal((await request('/api/submissions/results', { owner, method: 'POST', body: { results: [] } })).status, 200);
});
