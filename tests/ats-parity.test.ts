import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as server from '../app/apply-target.ts';
import * as extension from '../extension/ats.js';

// The server decides which hosted form an approval opens; the extension refuses anything it doesn't parse to the
// same job. The two copies (and page-lib's own, for the page side) must agree on every case.

type Expected = { ats: string; board: string; jobId: string; jobKey: string } | null;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/ats-urls.json', import.meta.url), 'utf8')) as {
  allowedHosts: string[]; parseAtsUrl: { url: string; expected: Expected }[];
};
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

// page-lib.js is a classic script that keeps pageJobKey private; run it in a bare context and lift that one function out.
function pageJobKey(): (href: string) => string | null {
  const source = readFileSync(new URL('../extension/page-lib.js', import.meta.url), 'utf8');
  const anchor = 'globalThis.__applypilot = api;';
  assert.ok(source.includes(anchor), 'page-lib.js still installs itself the way this test expects');
  const context: Record<string, unknown> = { URL, console };
  context.globalThis = context;
  vm.runInNewContext(source.replace(anchor, `${anchor} globalThis.__pageJobKey = pageJobKey;`), context);
  return context.__pageJobKey as (href: string) => string | null;
}

test('both copies allow exactly the same hosts, in the same order, and the manifest asks for exactly those', () => {
  assert.deepEqual(server.ALLOWED_HOSTS, fixture.allowedHosts);
  assert.deepEqual(extension.ALLOWED_HOSTS, fixture.allowedHosts);
  assert.deepEqual(extension.HOST_PATTERNS, fixture.allowedHosts.map((host) => `https://${host}/*`));
  assert.deepEqual(manifest.host_permissions, extension.HOST_PATTERNS);
});

test('every fixture URL parses identically on the server, in the extension and in the page', () => {
  const page = pageJobKey();
  assert.ok(fixture.parseAtsUrl.length >= 30, 'the fixture covers the cases');
  for (const { url, expected } of fixture.parseAtsUrl) {
    const fromServer = server.parseAtsUrl(url);
    assert.deepEqual(fromServer, expected, `server: ${url}`);
    assert.deepEqual(extension.parseAtsUrl(url), fromServer, `extension: ${url}`);
    assert.equal(page(url), fromServer?.jobKey ?? null, `page-lib: ${url}`);
    if (fromServer) assert.equal(extension.isAllowedUrl(url), true, `allowed host: ${url}`);
  }
});

test('job keys and ATS names agree', () => {
  for (const [ats, board, jobId] of [['greenhouse', 'AcMe', '123'], ['lever', 'Beta.Co', 'AbC-1'], ['ashby', 'g_1', 'x']] as const) {
    assert.equal(extension.jobKeyOf(ats, board, jobId), server.jobKeyOf(ats, board, jobId));
  }
  for (const value of ['greenhouse', 'lever', 'ashby', 'workday', 'Lever', '', null, undefined, 1]) {
    assert.equal(extension.isAts(value), server.isAts(value), String(value));
  }
});

test('every form the server would open is one the extension accepts for that job', () => {
  const LEVER = '5a1b2c3d-1111-2222-3333-444455556666';
  const ASHBY = '0f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff';
  const inputs = [
    { url: 'https://acme.com/careers?gh_jid=4012345', kind: 'greenhouse', token: 'Acme', externalId: '4012345' },
    { url: `https://jobs.lever.co/beta/${LEVER}`, kind: 'lever', token: 'beta', externalId: LEVER },
    { url: `https://jobs.eu.lever.co/beta/${LEVER}`, kind: 'lever', token: 'beta', externalId: LEVER },
    { url: `https://jobs.ashbyhq.com/Gamma/${ASHBY}`, kind: 'ashby', token: 'Gamma', externalId: ASHBY },
    { url: 'https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345' },
    { url: `https://jobs.eu.lever.co/beta/${LEVER}/apply` },
    { url: `https://jobs.ashbyhq.com/gamma/${ASHBY}/application` },
  ];
  for (const input of inputs) {
    const target = server.applyTarget(input);
    assert.ok(server.isApplyTarget(target), input.url);
    for (const url of target.applyUrls) {
      assert.equal(extension.isAllowedUrl(url), true, url);
      assert.equal(extension.parseAtsUrl(url)?.jobKey, target.jobKey, url);
      assert.equal(extension.parseAtsUrl(url)?.ats, target.ats, url);
    }
  }
});
