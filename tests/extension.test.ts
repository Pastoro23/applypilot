import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import JSZip from 'jszip';
import { ALLOWED_HOSTS, parseAtsUrl } from '../extension/ats.js';

const dir = new URL('../extension/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, dir));
const manifest = JSON.parse(read('manifest.json').toString('utf8'));
const DASHBOARD = 'https://applypilot-hub.amused-bream-5718.chatgpt.site';
const HOSTS = ['https://job-boards.greenhouse.io/*', 'https://boards.greenhouse.io/*', 'https://jobs.lever.co/*', 'https://jobs.eu.lever.co/*',
  'https://jobs.ashbyhq.com/*'];

test('downloadable extension holds every file in extension/, byte for byte, and the folder is flat', async () => {
  const entries = readdirSync(dir, { withFileTypes: true });
  assert.ok(entries.every((e) => e.isFile()), 'extension/ has only files');
  const files = entries.map((e) => e.name).sort();
  const zip = await JSZip.loadAsync(readFileSync(new URL('../public/applypilot-extension.zip', import.meta.url)));
  assert.deepEqual(Object.keys(zip.files).sort(), files);
  for (const name of files) assert.deepEqual(await zip.file(name)!.async('nodebuffer'), read(name), name);
  assert.equal(JSON.parse(await zip.file('manifest.json')!.async('string')).version, '3.0.0');
});

test('manifest 3.0.0 asks only for what the runner needs', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '3.0.0');
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage', 'unlimitedStorage']);
  assert.deepEqual(manifest.host_permissions, HOSTS);
  assert.deepEqual(manifest.background, { service_worker: 'background.js', type: 'module' });
  assert.equal(manifest.action.default_popup, 'popup.html');
});

test('one content script, on the dashboard origin only', () => {
  assert.equal(manifest.content_scripts.length, 1);
  const [cs] = manifest.content_scripts;
  assert.deepEqual(cs.matches, [`${DASHBOARD}/*`]);
  assert.deepEqual(cs.js, ['bridge.js']);
  assert.equal(cs.all_frames, true);
});

test('no broad or dangerous permissions and no external connection key', () => {
  const asked = [...manifest.permissions, ...manifest.host_permissions, ...(manifest.optional_permissions ?? []), ...(manifest.optional_host_permissions ?? [])];
  for (const p of ['tabs', 'webRequest', 'webRequestBlocking', 'debugger', 'cookies', 'alarms', '<all_urls>', 'downloads', 'nativeMessaging']) {
    assert.ok(!asked.includes(p), p);
  }
  assert.ok(!asked.some((p) => /^\*:|^https?:\/\/\*\//.test(p)), 'no wildcard hosts');
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.key, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
});

test('every file the manifest and pages load is in the folder', () => {
  const files = new Set(readdirSync(dir));
  const wanted = ['background.js', 'bridge.js', 'popup.html', 'popup.js', 'popup.css', 'runner.html', 'runner.js', 'runner.css', 'runner-core.js',
    'ats.js', 'page-lib.js', 'README.txt'];
  for (const name of wanted) assert.ok(files.has(name), name);
  assert.match(read('runner.html').toString('utf8'), /<script type="module" src="runner\.js"><\/script>/);
  assert.match(read('popup.js').toString('utf8'), /files: \["page-lib\.js"\]/);
  assert.match(read('popup.js').toString('utf8'), /globalThis\.__applypilot\.assistant\(p, r, a\)/);
  assert.doesNotMatch(read('popup.js').toString('utf8'), /function assistant\b/);
});

test('no extension code uses the debugger, programmatic form submission or simulated keys', () => {
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const code = stripComments(read(name).toString('utf8'));
    assert.doesNotMatch(code, /chrome\.debugger/, name);
    assert.doesNotMatch(code, /\brequestSubmit\s*\(/, name);
    assert.doesNotMatch(code, /\.submit\s*\(\s*\)/, name);
    assert.doesNotMatch(code, /key:\s*["']Enter["']/, name);
  }
  // Only page-lib touches the page; the runner and background never click anything themselves.
  for (const name of ['background.js', 'bridge.js', 'runner.js', 'runner-core.js', 'ats.js']) {
    assert.doesNotMatch(stripComments(read(name).toString('utf8')), /\.click\s*\(/, name);
  }
});

test('extension/ats.js agrees with the shared ATS fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/ats-urls.json', import.meta.url), 'utf8'));
  assert.deepEqual(ALLOWED_HOSTS, fixture.allowedHosts);
  for (const { url, expected } of fixture.parseAtsUrl) assert.deepEqual(parseAtsUrl(url), expected, url);
});
