import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
const source = new URL('../extension/', import.meta.url);
const target = new URL('../public/applypilot-extension.zip', import.meta.url);
const zip = new JSZip();
// Every file in extension/ goes in, so nothing the manifest loads can be left out. The folder stays flat.
for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isFile()) throw new Error(`extension/ must hold only files; found ${entry.name}`);
  zip.file(entry.name, await readFile(new URL(entry.name, source)), { date: new Date('2026-01-01T00:00:00Z') });
}
await writeFile(target, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Built extension ${JSON.parse(await readFile(new URL('manifest.json', source), 'utf8')).version} at ${fileURLToPath(target)}`);
