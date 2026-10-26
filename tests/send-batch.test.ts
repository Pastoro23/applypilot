import test from 'node:test';
import assert from 'node:assert/strict';
import { batchSkip, buildBatch, bytesToBase64, MAX_BATCH, resumeFilename, tailoredDate, usPosting } from '../app/send-batch.ts';
import { pdfSafe } from '../app/resume-pdf.ts';
import { buildAutofillProfile, profileHash, sha256Hex } from '../app/profile-records.ts';

const savedProfile = {
  firstName: 'Peter', lastName: 'Olatunde', legalName: 'Peter Olatunde', profileEmail: 'p@example.com', phone: '404-000-0000',
  city: 'Grayson', state: 'GA', postalCode: '30017', country: 'United States', linkedIn: '',
  workAuthorization: '', sponsorship: '', workAuthorized: 'yes', requiresSponsorship: 'no', skills: 'Windows 11, ServiceNow',
  workHistory: JSON.stringify([{ company: 'Modern Technology', title: 'IT Support', current: true }]), education: '[]',
};

const tailored = {
  fitScore: 82, fitSummary: 'Good fit.', requirements: [], changes: [], gaps: [],
  coverLetter: '  Dear hiring team,\n\nI would like to apply.  ',
  resume: {
    name: 'Peter Olatunde', contactLine: 'p@example.com · 404-000-0000', headline: 'IT Support Specialist', summary: 'Support tech.',
    skills: ['Windows 11'], experience: [{ title: 'IT Support', company: 'Modern Technology', location: 'Atlanta, GA', dates: '2023 – Present', bullets: ['Fixed things'] }],
    education: [], certifications: [],
  },
};

const settings = { auto: { greenhouse: false, lever: true, ashby: false }, dailyCap: 10, allowInvisibleCaptcha: true, allowOptionalSensitiveBlank: true, allowPrivacyAck: true };
const NOW = Date.parse('2026-10-26T12:00:00.000Z');

function app(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, company: 'Acme Health', role: 'Help Desk Technician', tailoredJson: JSON.stringify(tailored),
    tailoredAt: '2026-10-25T09:30:00.000Z', tailoredRevision: 2, ...extra,
  };
}

async function item(applicationId: string, extra: Record<string, unknown> = {}) {
  return {
    approvalId: crypto.randomUUID(), applicationId, jobKey: `lever:acme:${applicationId}`, ats: 'lever' as const,
    applyUrls: [`https://jobs.lever.co/acme/${applicationId}/apply`], revision: 2,
    profileHash: await profileHash(buildAutofillProfile(savedProfile)), includeCoverLetter: true, supersedesId: null,
    approvedAt: '2026-10-26T11:00:00.000Z', expiresAt: '2026-10-27T11:00:00.000Z', ...extra,
  };
}

test('base64 matches node for sizes around the chunk boundary and round-trips through atob', () => {
  for (const size of [0, 1, 2, 3, 4, 0x7fff, 0x8000, 0x8001, 0x10000 + 1, 100_003]) {
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const b64 = bytesToBase64(bytes);
    assert.equal(b64, Buffer.from(bytes).toString('base64'), `size ${size}`);
    const back = atob(b64);
    assert.equal(back.length, size);
    if (size) assert.equal(back.charCodeAt(size - 1), bytes[size - 1]);
  }
});

test('the resume filename has only the name, never the company, and matches the pdfSafe rule', () => {
  assert.equal(resumeFilename('Peter Olatunde'), 'Peter_Olatunde_Resume.pdf');
  assert.equal(resumeFilename('  Peter  O. Olatunde – Jr. '), 'Peter_O_Olatunde_Jr_Resume.pdf');
  assert.equal(resumeFilename(''), 'Resume.pdf');
  assert.equal(resumeFilename(' ✅ '), 'Resume.pdf');
  assert.ok(!/[/\\]/.test(resumeFilename('a/b\\c')));
  assert.ok(resumeFilename('x'.repeat(500)).length <= 200);
  const viaPdfSafe = (n: string) => pdfSafe(n).replace(/[^\w]+/g, '_').replace(/^_|_$/g, '') + '_Resume.pdf';
  for (const name of ['Peter Olatunde', 'José Martínez', 'José Martínez', 'Anne-Marie  O’Neil', '李 Wei', ' _x_ ', 'Zoë ✅ Smith']) {
    assert.equal(resumeFilename(name), viaPdfSafe(name), name);
  }
});

test('tailoredAt reads ISO and zoneless timestamps as UTC', () => {
  assert.equal(tailoredDate('2026-10-25T09:30:00.000Z')?.toISOString(), '2026-10-25T09:30:00.000Z');
  assert.equal(tailoredDate('2026-10-25 09:30:00')?.toISOString(), '2026-10-25T09:30:00.000Z');
  assert.equal(tailoredDate(null), null);
  assert.equal(tailoredDate('not a date'), null);
});

test('skip rules: missing job, changed resume, not tailored, changed profile, expired', async () => {
  const hash = await profileHash(buildAutofillProfile(savedProfile));
  const ok = await item('1');
  assert.equal(batchSkip(ok, app('1'), hash, NOW), null);
  assert.equal(batchSkip(ok, undefined, hash, NOW)?.code, 'not_found');
  assert.equal(batchSkip(ok, app('1', { tailoredRevision: 3 }), hash, NOW)?.code, 'resume_changed');
  assert.equal(batchSkip(ok, app('1', { tailoredJson: null }), hash, NOW)?.code, 'not_tailored');
  assert.equal(batchSkip(ok, app('1', { tailoredJson: '{bad' }), hash, NOW)?.code, 'not_tailored');
  assert.equal(batchSkip(ok, app('1', { tailoredAt: null }), hash, NOW)?.code, 'not_tailored');
  const changed = await profileHash(buildAutofillProfile({ ...savedProfile, phone: '404-111-1111' }));
  assert.deepEqual(batchSkip(ok, app('1'), changed, NOW), { code: 'profile_changed', reason: 'Your profile changed after you approved. Approve again.' });
  assert.equal(batchSkip(await item('1', { expiresAt: '2026-10-26T12:00:00.000Z' }), app('1'), hash, NOW)?.code, 'expired');
});

test('buildBatch carries each job its own verifiable PDF, the saved profile and the cover letter', async () => {
  const first = await item('1');
  const second = await item('2', { includeCoverLetter: false });
  const stale = await item('3', { revision: 1 });
  const { batch, skipped } = await buildBatch(
    { approved: [first, second, stale], applications: [app('1'), app('2', { tailoredAt: '2026-10-24T08:00:00.000Z' }), app('3')], savedProfile, settings },
    { now: NOW },
  );
  assert.deepEqual(skipped, [{ applicationId: '3', code: 'resume_changed', reason: 'The resume changed. Review it again.' }]);
  assert.equal(batch.jobs.length, 2);
  assert.match(batch.batchId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(batch.settings, settings);
  const [a, b] = batch.jobs;
  for (const job of batch.jobs) {
    const bytes = Uint8Array.from(atob(job.resume.b64), (ch) => ch.charCodeAt(0));
    assert.equal(String.fromCharCode(...bytes.subarray(0, 5)), '%PDF-');
    assert.equal(bytes.length, job.resume.size);
    assert.equal(await sha256Hex(bytes), job.resume.sha256);
    assert.equal(job.resume.type, 'application/pdf');
    assert.equal(job.resume.name, 'Peter_Olatunde_Resume.pdf');
    assert.ok(!job.resume.name.includes('Acme'));
    assert.deepEqual(job.profile, buildAutofillProfile(savedProfile));
    assert.equal(job.profileHash, first.profileHash);
  }
  assert.equal(a.approvalId, first.approvalId);
  assert.equal(a.jobKey, 'lever:acme:1');
  assert.deepEqual(a.applyUrls, ['https://jobs.lever.co/acme/1/apply']);
  assert.equal(a.company, 'Acme Health');
  assert.equal(a.role, 'Help Desk Technician');
  assert.equal(a.coverLetter, 'Dear hiring team,\n\nI would like to apply.');
  assert.equal(b.coverLetter, '');
  // Same resume, different revision date: a different file.
  assert.notEqual(a.resume.sha256, b.resume.sha256);
});

test('the same revision always gives the same bytes, so the hash checks hold on every rebuild', async () => {
  const one = await item('1');
  const build = () => buildBatch({ approved: [one], applications: [app('1')], savedProfile, settings }, { now: NOW });
  const x = (await build()).batch.jobs[0];
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const y = (await build()).batch.jobs[0];
  assert.equal(x.resume.sha256, y.resume.sha256);
  assert.equal(x.resume.b64, y.resume.b64);
});

test('unsaved profile edits or a long cover letter never leak into the batch', async () => {
  const one = await item('1');
  const edited = { ...savedProfile, phone: '404-999-9999' };
  const { batch, skipped } = await buildBatch({ approved: [one], applications: [app('1')], savedProfile: edited, settings }, { now: NOW });
  assert.equal(batch.jobs.length, 0);
  assert.equal(skipped[0].code, 'profile_changed');
  const long = app('1', { tailoredJson: JSON.stringify({ ...tailored, coverLetter: 'x'.repeat(5000) }) });
  const built = await buildBatch({ approved: [one], applications: [long], savedProfile, settings }, { now: NOW });
  assert.equal(built.batch.jobs[0].coverLetter.length, 4000);
});

test('at most 20 jobs go to Chrome at once', async () => {
  const approved = await Promise.all(Array.from({ length: MAX_BATCH + 2 }, (_, n) => item(String(n), { revision: 9 })));
  const { batch, skipped } = await buildBatch({ approved, applications: [], savedProfile, settings }, { now: NOW });
  assert.equal(batch.jobs.length, 0);
  assert.equal(skipped.length, MAX_BATCH + 2);
  assert.deepEqual(skipped.slice(MAX_BATCH).map((s) => s.code), ['too_many', 'too_many']);
});

test('a posting counts as in the U.S. only when every place it names is, so work-authorization answers wait for you elsewhere', async () => {
  for (const place of ['Atlanta, GA', 'Remote - US', 'Remote (United States)', 'Austin, TX 78701', 'New York', 'Hybrid - Atlanta, GA',
    'Atlanta, GA · Remote', 'San Francisco or Remote', 'Portland, OR', 'Washington, D.C.', 'Grayson, Georgia, United States']) {
    assert.equal(usPosting(place), true, place);
  }
  for (const place of ['', 'Remote', 'London, UK', 'Toronto, Ontario, Canada', 'Remote, Canada', 'US or Canada', 'Remote - EMEA',
    'Berlin, Germany; New York, NY', 'Dublin, Ireland', null, undefined]) {
    assert.equal(usPosting(place), false, String(place));
  }
  const us = await item('1');
  const uk = await item('2');
  const unknown = await item('3');
  const { batch } = await buildBatch(
    { approved: [us, uk, unknown], applications: [app('1', { location: 'Atlanta, GA' }), app('2', { location: 'London, UK' }), app('3')], savedProfile, settings },
    { now: NOW },
  );
  assert.deepEqual(batch.jobs.map((job) => job.usPosting), [true, false, false]);
});
