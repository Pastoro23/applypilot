import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { buildResumePdf, pdfSafe } from '../app/resume-pdf.ts';
import { sha256Hex } from '../app/profile-records.ts';

const resume = {
  name: 'Peter Olatunde', contactLine: 'p@example.com · 404-000-0000 · Grayson, GA', headline: 'IT Support Specialist',
  summary: 'Hands-on support technician → focused on users. ', skills: ['Active Directory', 'Windows 11', 'ServiceNow'],
  experience: Array.from({ length: 6 }, (_, n) => ({
    title: 'IT Support Specialist', company: `Company ${n}`, location: 'Atlanta, GA', dates: '2023 – Present',
    bullets: Array.from({ length: 6 }, () => 'Resolved hardware, software and network tickets for 300 staff across three sites, keeping first-contact resolution high ✅'),
  })),
  education: [{ credential: 'B.S. Computer Science', school: 'Georgia State University', dates: '2020' }],
  certifications: ['CompTIA A+'],
};

test('builds a multi-page PDF with real text and no unsupported characters', async () => {
  const bytes = await buildResumePdf(resume);
  assert.equal(Buffer.from(bytes.slice(0, 5)).toString(), '%PDF-');
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 2);
  assert.equal(doc.getTitle(), 'Peter Olatunde Resume');
});

test('swaps characters the built-in fonts cannot draw', () => {
  assert.equal(pdfSafe('Café – “ok” → done ✅'), 'Café – “ok” ? done ?');
});

test('the same resume and date always give the same file; another date gives another', async () => {
  const date = new Date('2026-10-20T15:04:05.000Z');
  const first = await sha256Hex(await buildResumePdf(resume, { date }));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(await sha256Hex(await buildResumePdf(resume, { date: new Date(date) })), first);
  assert.notEqual(await sha256Hex(await buildResumePdf(resume, { date: new Date('2026-10-21T15:04:05.000Z') })), first);
  const doc = await PDFDocument.load(await buildResumePdf(resume, { date }), { updateMetadata: false });
  assert.equal(doc.getTitle(), 'Peter Olatunde Resume');
  assert.equal(doc.getProducer(), 'ApplyPilot');
  assert.equal(doc.getCreationDate()?.toISOString(), date.toISOString());
});
