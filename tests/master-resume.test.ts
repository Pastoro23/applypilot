import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import ts from 'typescript';
import { UserFacingError } from '../app/errors.ts';

async function fixture(options: { signedIn?: boolean; extracted?: string; fail?: boolean } = {}) {
  let saved = { content: 'Original verified resume '.repeat(20), sourceFilename: 'original.pdf', updatedAt: '2026-01-01' };
  let writes = 0; let calls = 0;
  const modules: Record<string, Record<string, unknown>> = {
    'drizzle-orm': { eq: () => ({}) },
    'cloudflare:workers': { env: { DB: {} } },
    '@/db': { getDb: () => ({
      select: () => ({ from: () => ({ where: async () => [saved] }) }),
      insert: () => ({ values: (values: typeof saved) => ({ onConflictDoUpdate: () => ({ returning: async () => { writes++; saved = values; return [saved]; } }) }) }),
    }) },
    '@/db/schema': { masterResumes: { ownerEmail: 'owner_email' } },
    '@/app/ai': { assertAiConfigured: () => {}, resumePdfToText: async () => { calls++; if (options.fail) throw new UserFacingError('Extraction failed'); return options.extracted ?? 'Extracted candidate resume '.repeat(20); } },
    '@/app/ai-operations': { runAiOperation: async (_db: unknown, _owner: unknown, _kind: unknown, _input: unknown, work: () => Promise<unknown>) => work() },
    '@/app/errors': { UserFacingError },
    '../_lib': {
      requireApiUser: async () => options.signedIn === false ? null : { email: 'owner@example.invalid' },
      clean: (value: unknown, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '',
      apiError: (error: unknown) => Response.json({ error: error instanceof Error ? error.message : 'error' }, { status: error instanceof UserFacingError ? error.status : 500 }),
    },
  };
  const code = ts.transpileModule(readFileSync(new URL('../app/api/master-resume/route.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = new SourceTextModule(code);
  await mod.link(async (name) => {
    const exports = modules[name]; if (!exports) throw new Error('Unexpected import ' + name);
    return new SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); });
  });
  await mod.evaluate();
  const api = mod.namespace as unknown as { GET(): Promise<Response>; POST(r: Request): Promise<Response>; PUT(r: Request): Promise<Response> };
  return { api, state: () => ({ saved, writes, calls }) };
}
function pdfRequest(content = '%PDF-1.7 synthetic fixture', name = 'new.pdf') {
  const body = new FormData(); body.set('file', new File([content], name, { type: 'application/pdf' }));
  return new Request('https://fixture.invalid/api/master-resume', { method: 'POST', body });
}
test('PDF extraction returns a review preview and does not overwrite the saved resume', async () => {
  const f = await fixture(); const original = f.state().saved.content;
  const response = await f.api.POST(pdfRequest()); const body = await response.json() as { extraction: { content: string; sourceFilename: string } };
  assert.equal(response.status, 200); assert.match(body.extraction.content, /Extracted candidate/);
  assert.equal(f.state().writes, 0); assert.equal(f.state().saved.content, original);
  const confirmed = await f.api.PUT(new Request('https://fixture.invalid/api/master-resume', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body.extraction),
  }));
  assert.equal(confirmed.status, 200); assert.equal(f.state().writes, 1);
  assert.equal(f.state().saved.content, body.extraction.content);
});
test('invalid, failed and oversized extractions preserve the previous master resume', async () => {
  for (const options of [{ fail: true }, { extracted: 'too short' }, { extracted: 'x'.repeat(30001) }]) {
    const f = await fixture(options); const response = await f.api.POST(pdfRequest());
    assert.ok(response.status >= 400); assert.equal(f.state().writes, 0);
  }
  const f = await fixture(); const invalid = await f.api.POST(pdfRequest('not a PDF'));
  assert.equal(invalid.status, 400); assert.equal(f.state().calls, 0);
});
test('resume routes reject unsigned users and oversize text is not silently truncated', async () => {
  const unsigned = await fixture({ signedIn: false });
  assert.equal((await unsigned.api.POST(pdfRequest())).status, 401);
  assert.equal((await unsigned.api.GET()).status, 401);
  const f = await fixture(); const response = await f.api.PUT(new Request('https://fixture.invalid/api/master-resume', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'x'.repeat(30001) }),
  }));
  assert.equal(response.status, 400); assert.equal(f.state().writes, 0);
});
