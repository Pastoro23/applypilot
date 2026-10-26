import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fetchBoardJobs, parseBoard, scoreJob } from '../app/job-discovery.ts';
import { queueFoundJob, refreshAll, setFoundJobStatus } from '../app/discovery-store.ts';
import { testDatabase } from './sqlite-helper.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
function stubFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input); calls.push(url);
    return routes[url] === undefined ? new Response('missing', { status: 404 }) : Response.json(routes[url]);
  }) as typeof fetch;
  return calls;
}
const NOW = Date.parse('2026-10-26T12:00:00Z');
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const search = { titleWords: 'help desk, IT support, desktop support', locations: 'Atlanta, GA', excludeWords: 'senior, manager', remoteOk: 'yes' };

test('reads board and job links in every supported form', () => {
  assert.deepEqual(parseBoard('https://boards.greenhouse.io/acme'), { kind: 'greenhouse', token: 'acme' });
  assert.deepEqual(parseBoard('job-boards.greenhouse.io/acme/jobs/123'), { kind: 'greenhouse', token: 'acme' });
  assert.deepEqual(parseBoard('https://boards.greenhouse.io/embed/job_board?for=acme'), { kind: 'greenhouse', token: 'acme' });
  assert.deepEqual(parseBoard('https://jobs.lever.co/acme/5a1b-22'), { kind: 'lever', token: 'acme' });
  assert.deepEqual(parseBoard('https://jobs.ashbyhq.com/acme'), { kind: 'ashby', token: 'acme' });
  assert.deepEqual(parseBoard('Lever: acme'), { kind: 'lever', token: 'acme' });
  assert.equal(parseBoard('https://example.com/acme'), null);
  assert.equal(parseBoard('https://jobs.lever.co/'), null);
  assert.equal(parseBoard('greenhouse:../etc'), null);
});

test('reads Greenhouse, Lever and Ashby job lists', async () => {
  stubFetch({
    'https://boards-api.greenhouse.io/v1/boards/acme/jobs': { jobs: [
      { id: 11, title: 'IT Support Specialist', location: { name: 'Atlanta, GA' }, absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/11', updated_at: day(2), company_name: 'Acme Health' },
      { id: 12, title: 'No link', location: { name: 'x' }, absolute_url: 'javascript:alert(1)' },
    ] },
    'https://api.lever.co/v0/postings/beta?mode=json&limit=100&skip=0': [
      { id: 'lv1', text: 'Help Desk Technician', categories: { location: 'Remote' }, hostedUrl: 'https://jobs.lever.co/beta/lv1', createdAt: NOW - 86_400_000,
        descriptionPlain: 'Support users.', lists: [{ text: 'Requirements', content: '<li>Windows</li>' }] },
    ],
    'https://api.ashbyhq.com/posting-api/job-board/gamma': { jobs: [
      { id: 'ab1', title: 'Desktop Support', location: 'Atlanta', isRemote: false, jobUrl: 'https://jobs.ashbyhq.com/gamma/ab1', publishedAt: day(40), descriptionPlain: 'Fix laptops.' },
      { id: 'ab2', title: 'Hidden', jobUrl: 'https://jobs.ashbyhq.com/gamma/ab2', isListed: false },
    ] },
  });
  const gh = await fetchBoardJobs({ kind: 'greenhouse', token: 'acme' });
  assert.deepEqual(gh.map((j) => [j.externalId, j.company, j.location]), [['11', 'Acme Health', 'Atlanta, GA']]);
  const lv = await fetchBoardJobs({ kind: 'lever', token: 'beta' }, 'Beta Corp');
  assert.equal(lv[0].company, 'Beta Corp');
  assert.match(lv[0].description, /Support users\.[\s\S]*Requirements[\s\S]*Windows/);
  const ab = await fetchBoardJobs({ kind: 'ashby', token: 'gamma' });
  assert.deepEqual(ab.map((j) => [j.externalId, j.company, j.description]), [['ab1', 'Gamma', 'Fix laptops.']]);
});

test('reads a big Lever board in pages and stops at the last one', async () => {
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({
    id: `p${from + i}`, text: 'Help Desk Technician', categories: { location: 'Remote' }, hostedUrl: `https://jobs.lever.co/big/p${from + i}`, createdAt: NOW,
  }));
  stubFetch({
    'https://api.lever.co/v0/postings/big?mode=json&limit=100&skip=0': page(0, 100),
    'https://api.lever.co/v0/postings/big?mode=json&limit=100&skip=100': page(100, 100),
    'https://api.lever.co/v0/postings/big?mode=json&limit=100&skip=200': page(200, 37),
  });
  const jobs = await fetchBoardJobs({ kind: 'lever', token: 'big' });
  assert.equal(jobs.length, 237);
  assert.equal(new Set(jobs.map((j) => j.externalId)).size, 237);
});

test('matches whole words in the title and the chosen places', () => {
  const job = (title: string, location: string, age = 1) => scoreJob({ title, location, postedAt: day(age) }, search, NOW);
  assert.ok((job('Help Desk Technician', 'Atlanta, GA') ?? 0) > (job('Help Desk Technician', 'Remote') ?? 0));
  assert.ok(job('Help Desk Technician', 'Remote - US'));
  assert.ok(job('Help Desk Technician', 'Remote (USA or Canada)'));
  assert.equal(job('Help Desk Technician', 'Remote - UK'), null);
  assert.equal(job('Help Desk Technician', 'Remote, EMEA'), null);
  assert.equal(job('Help Desk Technician', 'Toronto, Canada · Remote'), null);
  assert.equal(scoreJob({ title: 'Help Desk Technician', location: 'Remote - India', postedAt: day(1) }, { ...search, locations: 'Remote' }, NOW), null);
  assert.ok(scoreJob({ title: 'Help Desk Technician', location: 'Remote', postedAt: day(1) }, { ...search, locations: 'Remote' }, NOW));
  assert.equal(job('Senior Help Desk Analyst', 'Atlanta, GA'), null);
  assert.equal(job('Help Desk Technician', 'Denver, CO'), null);
  assert.equal(job('Software Engineer', 'Atlanta, GA'), null);
  assert.equal(scoreJob({ title: 'Technology Lead', location: '', postedAt: '' }, { ...search, titleWords: 'tech' }, NOW), null);
  assert.equal(job('Help Desk Technician', 'Remote', 1) !== null && scoreJob({ title: 'Help Desk Technician', location: 'Remote', postedAt: day(1) }, { ...search, remoteOk: 'no' }, NOW), null);
  assert.ok((job('Help Desk Technician', 'Atlanta, GA', 1) ?? 0) > (job('Help Desk Technician', 'Atlanta, GA', 60) ?? 0));
});

test('refresh adds matches, keeps added or dismissed jobs, and drops closed postings', async () => {
  const { db, sqlite } = testDatabase();
  sqlite.prepare("INSERT INTO job_searches (owner_email, title_words, locations, exclude_words, remote_ok) VALUES ('p', ?, ?, ?, ?)")
    .run(search.titleWords, search.locations, search.excludeWords, search.remoteOk);
  sqlite.prepare("INSERT INTO job_sources (id, owner_email, kind, token, label) VALUES ('s1', 'p', 'lever', 'beta', 'Beta Corp')").run();
  sqlite.prepare("INSERT INTO job_sources (id, owner_email, kind, token, label) VALUES ('s2', 'p', 'ashby', 'broken', '')").run();
  let open = [
    { externalId: 'a', company: 'Beta Corp', title: 'Help Desk Technician', location: 'Atlanta, GA', url: 'https://jobs.lever.co/beta/a', postedAt: day(1), description: 'Support users. '.repeat(10) },
    { externalId: 'b', company: 'Beta Corp', title: 'IT Support Specialist', location: 'Remote', url: 'https://jobs.lever.co/beta/b', postedAt: day(1), description: '' },
    { externalId: 'c', company: 'Beta Corp', title: 'Sales Manager', location: 'Atlanta, GA', url: 'https://jobs.lever.co/beta/c', postedAt: day(1), description: '' },
  ];
  const read = async (board: { token: string }) => { if (board.token === 'broken') throw new Error('boom'); return open; };
  const first = await refreshAll(db, 'p', read, NOW);
  assert.deepEqual(first, { checked: 2, remaining: 0, matched: 2, added: 2, failed: 1 });
  assert.equal((sqlite.prepare("SELECT last_error FROM job_sources WHERE id = 's2'").get() as { last_error: string }).last_error, "This job board couldn't be read. ApplyPilot will try again next time.");
  const rows = () => (sqlite.prepare("SELECT external_id, status FROM found_jobs ORDER BY external_id").all() as { external_id: string; status: string }[]).map((r) => ({ ...r }));
  assert.deepEqual(rows().map((r) => r.external_id), ['a', 'b']);
  const a = sqlite.prepare("SELECT id FROM found_jobs WHERE external_id = 'a'").get() as { id: string };
  const b = sqlite.prepare("SELECT id FROM found_jobs WHERE external_id = 'b'").get() as { id: string };
  await queueFoundJob(db, 'p', a.id, async () => 'unused');
  await setFoundJobStatus(db, 'p', b.id, 'dismissed');
  // Both postings close. The added and dismissed jobs stay; nothing is re-added.
  open = [];
  assert.equal((await refreshAll(db, 'p', read, NOW + 120_000)).added, 0);
  assert.deepEqual(rows(), [{ external_id: 'a', status: 'queued' }, { external_id: 'b', status: 'dismissed' }]);
  // A board checked under a minute ago is skipped.
  for (let n = 0; n < 14; n++) sqlite.prepare("INSERT INTO job_sources (id, owner_email, kind, token, label) VALUES (?, 'p', 'lever', ?, '')").run('x' + n, 'co' + n);
  const sliced = await refreshAll(db, 'p', read, NOW + 125_000);
  assert.deepEqual([sliced.checked, sliced.remaining], [12, 2]);
  assert.equal((await refreshAll(db, 'p', read, NOW + 126_000)).checked, 2);
  assert.equal((await refreshAll(db, 'p', read, NOW + 130_000)).checked, 0);
});

test('adding a found job creates one application, reading the description when the list had none', async () => {
  const { db, sqlite } = testDatabase();
  sqlite.prepare(`INSERT INTO found_jobs (id, owner_email, source_id, kind, external_id, company, title, location, url, description)
    VALUES ('f1', 'p', 's1', 'greenhouse', '11', 'Acme', 'IT Support', 'Atlanta, GA', 'https://job-boards.greenhouse.io/acme/jobs/11', '')`).run();
  let reads = 0;
  const readDescription = async () => { reads++; return 'Responsibilities: support staff. '.repeat(10); };
  const [one, two] = await Promise.all([queueFoundJob(db, 'p', 'f1', readDescription), queueFoundJob(db, 'p', 'f1', readDescription)]);
  assert.equal(one.applicationId, two.applicationId);
  assert.equal(reads, 1);
  const apps = sqlite.prepare("SELECT company, role, status, length(job_description) AS len FROM applications").all() as { company: string; len: number }[];
  assert.equal(apps.length, 1);
  assert.equal(apps[0].company, 'Acme');
  assert.ok(apps[0].len > 100);
  assert.equal(one.descriptionMissing, false);
  await assert.rejects(queueFoundJob(db, 'other', 'f1', readDescription), /no longer in your list/);
});

test('a job whose description cannot be read is still added, flagged for you to paste it', async () => {
  const { db, sqlite } = testDatabase();
  sqlite.prepare(`INSERT INTO found_jobs (id, owner_email, source_id, kind, external_id, company, title, url)
    VALUES ('f1', 'p', 's1', 'greenhouse', '11', 'Acme', 'IT Support', 'https://job-boards.greenhouse.io/acme/jobs/11')`).run();
  const result = await queueFoundJob(db, 'p', 'f1', async () => { throw new Error('offline'); });
  assert.equal(result.descriptionMissing, true);
  assert.equal((sqlite.prepare('SELECT count(*) AS n FROM applications').get() as { n: number }).n, 1);
});
