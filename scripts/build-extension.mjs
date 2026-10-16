import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
const source = new URL('../extension/', import.meta.url);
const zip = new JSZip();
for (const name of (await readdir(source)).sort()) {
  if (!['README.txt', 'manifest.json', 'popup.css', 'popup.html', 'popup.js'].includes(name)) continue;
  zip.file(name, await readFile(new URL(name, source)), { date: new Date('2026-01-01T00:00:00Z') });
}
await writeFile(new URL('../public/applypilot-extension.zip', import.meta.url),
  await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Built a single v2 extension at ${fileURLToPath(new URL('../public/applypilot-extension.zip', import.meta.url))}`);
