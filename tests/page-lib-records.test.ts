import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// page-lib.js is a classic script that keeps its helpers private; run it in a bare context and lift the ones that read
// your education records and your country, and the wording of a privacy-policy box, out.
type Lifted = {
  degreeKind: (credential: string) => RegExp | null;
  studyField: (record: { degree?: string; field?: string }) => string;
  inUS: (country: string) => boolean;
  countryName: (country: string) => string;
  privacyAckPart: (text: string, company: string) => number;
};
function lift(): Lifted {
  const source = readFileSync(new URL('../extension/page-lib.js', import.meta.url), 'utf8');
  const anchor = 'globalThis.__applypilot = api;';
  assert.ok(source.includes(anchor), 'page-lib.js still installs itself the way this test expects');
  const context: Record<string, unknown> = { URL, console };
  context.globalThis = context;
  vm.runInNewContext(source.replace(anchor, `${anchor} globalThis.__lifted = { degreeKind, studyField, inUS, countryName, privacyAckPart };`), context);
  return context.__lifted as Lifted;
}
const { degreeKind, studyField, inUS, countryName, privacyAckPart } = lift();
// The option a degree dropdown would take, from Greenhouse's own list.
const OPTIONS = ['High School', "Associate's Degree", "Bachelor's Degree", "Master's Degree", 'Master of Business Administration (M.B.A.)',
  'Juris Doctor (J.D.)', 'Doctor of Medicine (M.D.)', 'Doctor of Philosophy (Ph.D.)', "Engineer's Degree", 'Other'];
const option = (credential: string) => {
  const kind = degreeKind(credential);
  const hits = kind ? OPTIONS.filter((o) => kind.test(o.toLowerCase())) : [];
  return hits.length === 1 ? hits[0] : null;
};

test('a degree dropdown takes the degree your credential names', () => {
  for (const [credential, want] of [
    ['A.A.S. Information Technology', "Associate's Degree"], ['Associate of Applied Science', "Associate's Degree"],
    ['Associate in Science', "Associate's Degree"], ['Bachelor of Science in Computer Science', "Bachelor's Degree"],
    ['B.S.', "Bachelor's Degree"], ['BBA', "Bachelor's Degree"], ['Master of Science in Cybersecurity', "Master's Degree"],
    ["Master's", "Master's Degree"], ['M.S. Information Systems', "Master's Degree"], ['MBA', 'Master of Business Administration (M.B.A.)'],
    ['M.B.A.', 'Master of Business Administration (M.B.A.)'], ['Ph.D.', 'Doctor of Philosophy (Ph.D.)'], ['High School Diploma', 'High School'],
    ['GED', 'High School'],
  ]) assert.equal(option(credential), want, credential);
});

test('a certificate, a licence, unfinished study or another doctorate is never sent as a degree', () => {
  for (const credential of [
    'Cisco Certified Network Associate (CCNA)', 'AWS Certified Solutions Architect - Associate', 'Microsoft Certified: Azure Administrator Associate',
    'Associate Certified Coach', 'Certified Scrum Master (CSM)', 'MS Office Specialist Certification', 'MS Excel Expert', 'Master Electrician License',
    "Professional Certificate, Master's level", 'Post-secondary school certificate', 'Some college coursework towards B.S.', "Bachelor's (incomplete)",
    'PhD (ABD)', 'PhD Candidate', 'Doctor of Business Administration (D.B.A.)', 'D.B.A.', 'D.M.A.', 'Certificate in Welding',
  ]) assert.equal(option(credential), null, credential);
});

test('the field of study is read from the degree only when it names just the major', () => {
  for (const [degree, want] of [
    ['A.A.S. Information Technology', 'Information Technology'], ['Bachelor of Science in Computer Science', 'Computer Science'],
    ['Associate in Applied Science in Information Technology', 'Information Technology'], ['B.S. in Information Systems', 'Information Systems'],
    ['MBA in Finance', 'Finance'], ['Associate in Science', ''], ['BBA, minor in Accounting', ''],
    ['B.S. Information Systems, minor in Computer Science', ''], ['B.S. Biology, concentration in Computer Science', ''],
    ['Certificate in Welding', ''], ['MS Excel Expert', ''], ['Cert. Welding', ''],
  ]) assert.equal(studyField({ degree, field: '' }), want, degree);
  assert.equal(studyField({ degree: 'BBA, minor in Accounting', field: 'Business Administration' }), 'Business Administration');
});

test('your country as typed: the U.S. in any common spelling, and the name a country list is searched by', () => {
  for (const country of ['United States', 'USA', 'US', 'U.S.', 'U.S', 'U.S.A', 'u.s.a.', 'America', 'United States of America', 'The United States.', 'United States (US)'])
    assert.ok(inUS(country), country);
  for (const country of ['Canada', 'United Kingdom', 'Untied Staets', 'Australia', '']) assert.ok(!inUS(country), country);
  assert.deepEqual(['USA', 'U.S.', 'America', 'UK', 'Canada'].map(countryName), ['United States', 'United States', 'United States', 'United Kingdom', 'Canada']);
});

test('privacy-box wording: only privacy policies and notices, and nothing else, may be named', () => {
  for (const [text, docs] of [
    ['Please acknowledge that you have read and agree to our Privacy Policy.', 1],
    [`By clicking "Submit Application", you agree to Invisible's Privacy Policy.`, 1],
    ['By clicking \u201cSubmit Application\u201d, you agree to the company\u2019s Privacy Policy.', 1],
    ["I agree to Acme Example's Privacy Policy", 1],
    ['I confirm that I have read and understood the Candidate Privacy Notice', 1],
    ['By checking this box, I acknowledge that I have read the Privacy Policy *', 1],
    ['I have read and agree to the Privacy Notice and the Applicant Privacy Notice', 2],
    ['Privacy Policy Acknowledgement', 1],
    ['Yes', 0],
  ] as const) assert.equal(privacyAckPart(text, 'Acme Example'), docs, text);
  for (const text of [
    'I have read and agree to the Privacy Notice and the Applicant Statement.', 'I have read and agree to the Privacy Policy and the Recruitment Policy.',
    'Applicant Statement', 'I agree to this statement', 'I agree to this', 'I have read and agree to the Privacy Policy and Terms of Service.',
    'I agree to the Privacy Policy and consent to be contacted by SMS.', 'I acknowledge the Privacy Policy and agree that my data may be shared with third parties.',
    'By clicking "Submit Application", you certify that your answers are true and agree to the Privacy Policy.',
    'Ticking this box also means we may keep your details for 24 months.', 'I have read the privacy practices',
  ]) assert.equal(privacyAckPart(text, 'Acme Example'), -1, text);
});
