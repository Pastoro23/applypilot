import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import JSZip from 'jszip';
test('downloadable extension contains only current v2.1 root files, byte for byte', async () => {
  const zip = await JSZip.loadAsync(readFileSync(new URL('../public/applypilot-extension.zip', import.meta.url)));
  const files = readdirSync(new URL('../extension/', import.meta.url)).sort();
  assert.deepEqual(Object.keys(zip.files).sort(), files);
  for (const name of files) assert.deepEqual(await zip.file(name)!.async('nodebuffer'), readFileSync(new URL('../extension/' + name, import.meta.url)));
  assert.equal(JSON.parse(await zip.file('manifest.json')!.async('string')).version, '2.1.0');
});
