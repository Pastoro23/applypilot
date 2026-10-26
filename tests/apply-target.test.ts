import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALLOWED_HOSTS, applyTarget, isApplyTarget, jobKeyOf, parseAtsUrl } from '../app/apply-target.ts';

const LEVER_ID = '5a1b2c3d-1111-2222-3333-444455556666';
const ASHBY_ID = '0f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff';

test('found jobs open the hosted ATS form rebuilt from board token and job id', () => {
  assert.deepEqual(applyTarget({ url: 'https://acme.com/careers?gh_jid=4012345', kind: 'greenhouse', token: 'Acme', externalId: '4012345' }), {
    ats: 'greenhouse', board: 'Acme', jobId: '4012345', jobKey: 'greenhouse:acme:4012345',
    applyUrls: ['https://job-boards.greenhouse.io/Acme/jobs/4012345', 'https://job-boards.greenhouse.io/embed/job_app?for=Acme&token=4012345'],
  });
  assert.deepEqual(applyTarget({ url: `https://jobs.lever.co/beta/${LEVER_ID}`, kind: 'lever', token: 'beta', externalId: LEVER_ID }), {
    ats: 'lever', board: 'beta', jobId: LEVER_ID, jobKey: `lever:beta:${LEVER_ID}`, applyUrls: [`https://jobs.lever.co/beta/${LEVER_ID}/apply`],
  });
  assert.deepEqual(applyTarget({ url: `https://jobs.ashbyhq.com/gamma/${ASHBY_ID}`, kind: 'ashby', token: 'gamma', externalId: ASHBY_ID }), {
    ats: 'ashby', board: 'gamma', jobId: ASHBY_ID, jobKey: `ashby:gamma:${ASHBY_ID}`, applyUrls: [`https://jobs.ashbyhq.com/gamma/${ASHBY_ID}/application`],
  });
});

test('manual links: job-boards, boards, embed for/token and Lever EU', () => {
  const gh = (url: string) => {
    const target = applyTarget({ url });
    assert.ok(isApplyTarget(target), url);
    return target;
  };
  for (const url of ['https://job-boards.greenhouse.io/acme/jobs/4012345', 'https://boards.greenhouse.io/acme/jobs/4012345?gh_src=x',
    'https://boards.greenhouse.io/embed/job_app?for=acme&token=4012345', 'https://job-boards.greenhouse.io/embed/job_app?token=4012345&for=acme']) {
    assert.equal(gh(url).jobKey, 'greenhouse:acme:4012345', url);
    assert.equal(gh(url).applyUrls[0], 'https://job-boards.greenhouse.io/acme/jobs/4012345');
  }
  const eu = applyTarget({ url: `https://jobs.eu.lever.co/beta/${LEVER_ID}` });
  assert.ok(isApplyTarget(eu));
  assert.deepEqual(eu.applyUrls, [`https://jobs.eu.lever.co/beta/${LEVER_ID}/apply`]);
  // A found Lever job listed on the EU host keeps it.
  const found = applyTarget({ url: `https://jobs.eu.lever.co/beta/${LEVER_ID}`, kind: 'lever', token: 'beta', externalId: LEVER_ID });
  assert.ok(isApplyTarget(found));
  assert.equal(found.applyUrls[0], `https://jobs.eu.lever.co/beta/${LEVER_ID}/apply`);
  const ashby = applyTarget({ url: `https://jobs.ashbyhq.com/gamma/${ASHBY_ID}/application` });
  assert.ok(isApplyTarget(ashby));
  assert.equal(ashby.jobKey, `ashby:gamma:${ASHBY_ID}`);
});

test('a company-site gh_jid link without a known board is left for you', () => {
  assert.deepEqual(applyTarget({ url: 'https://acme.com/careers?gh_jid=4012345' }),
    { reason: 'Company site, not Greenhouse, Lever or Ashby: apply yourself' });
  // A found job whose board was unfollowed falls back to its link.
  assert.deepEqual(applyTarget({ url: 'https://acme.com/careers?gh_jid=4012345', kind: 'greenhouse', token: null, externalId: '4012345' }),
    { reason: 'Company site, not Greenhouse, Lever or Ashby: apply yourself' });
  assert.match((applyTarget({ url: '' }) as { reason: string }).reason, /apply yourself/);
  assert.match((applyTarget({ url: 'https://job-boards.greenhouse.io/acme' }) as { reason: string }).reason, /single/);
});

test('rejects http, lookalike hosts, other ports and bad tokens or ids', () => {
  assert.match((applyTarget({ url: 'http://job-boards.greenhouse.io/acme/jobs/1' }) as { reason: string }).reason, /https/);
  for (const url of ['https://greenhouse.io.evil.com/acme/jobs/1', `https://jobs.lever.co.evil.com/beta/${LEVER_ID}`,
    'https://evilgreenhouse.io/acme/jobs/1', 'https://example.com/jobs.lever.co/beta/x']) {
    assert.equal(isApplyTarget(applyTarget({ url })), false, url);
  }
  assert.equal(isApplyTarget(applyTarget({ url: 'https://job-boards.greenhouse.io:8443/acme/jobs/1' })), false);
  assert.equal(isApplyTarget(applyTarget({ url: 'https://job-boards.eu.greenhouse.io/acme/jobs/1' })), false);
  assert.equal(isApplyTarget(applyTarget({ url: '', kind: 'greenhouse', token: '../etc', externalId: '1' })), false);
  assert.equal(isApplyTarget(applyTarget({ url: '', kind: 'lever', token: 'beta', externalId: 'a/b' })), false);
  assert.equal(isApplyTarget(applyTarget({ url: '', kind: 'ashby', token: 'gamma', externalId: 'x'.repeat(65) })), false);
  assert.equal(parseAtsUrl('http://job-boards.greenhouse.io/acme/jobs/1'), null);
  assert.equal(parseAtsUrl('https://greenhouse.io.evil.com/acme/jobs/1'), null);
  assert.equal(parseAtsUrl('https://constructor/acme/jobs/1'), null);
});

test('job keys lowercase the board only', () => {
  assert.equal(jobKeyOf('greenhouse', 'AcMe', '123'), 'greenhouse:acme:123');
  assert.equal(jobKeyOf('lever', 'Beta', 'AbC-1'), 'lever:beta:AbC-1');
  assert.equal(parseAtsUrl('https://job-boards.greenhouse.io/AcMe/jobs/123')?.jobKey, 'greenhouse:acme:123');
});

test('every apply URL round-trips to its job key, and the shared fixtures hold', () => {
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/ats-urls.json', import.meta.url), 'utf8')) as {
    allowedHosts: string[]; parseAtsUrl: { url: string; expected: unknown }[];
  };
  assert.deepEqual(fixtures.allowedHosts, ALLOWED_HOSTS);
  for (const { url, expected } of fixtures.parseAtsUrl) assert.deepEqual(parseAtsUrl(url), expected, url);
  for (const input of [{ url: '', kind: 'greenhouse', token: 'Acme', externalId: '7' }, { url: `https://jobs.eu.lever.co/b/${LEVER_ID}` }]) {
    const target = applyTarget(input);
    assert.ok(isApplyTarget(target));
    for (const url of target.applyUrls) assert.equal(parseAtsUrl(url)?.jobKey, target.jobKey);
  }
});
