import test from 'node:test';
import assert from 'node:assert/strict';
import { autofillProfileFromRow, buildAutofillProfile, cleanRecords, cleanYesNo, profileHash, sha256Hex, workFields } from '../app/profile-records.ts';

const base = {
  firstName: 'Peter', lastName: 'Olatunde', legalName: 'Peter Olatunde', profileEmail: 'p@example.com', phone: '1',
  city: 'Grayson', state: 'GA', postalCode: '30017', country: 'United States', linkedIn: '',
  workAuthorization: 'Authorized to work in the U.S. — confirm exact wording', sponsorship: 'No sponsorship expected — confirm',
  workAuthorized: '', requiresSponsorship: '', skills: '', workHistory: '[]', education: '[]',
};

test('records keep only known fields and drop empty or malformed entries', () => {
  const rows = cleanRecords(JSON.stringify([{ company: ' Acme ', title: 'Tech', password: 'x', current: true }, {}, 'junk', { current: true }]), workFields);
  assert.deepEqual(rows, [{ company: 'Acme', title: 'Tech', current: true }]);
  assert.deepEqual(cleanRecords('not json', workFields), []);
  assert.deepEqual(cleanRecords({ company: 'Acme' }, workFields), []);
});

test('yes/no answers only accept yes, no or blank', () => {
  assert.equal(cleanYesNo('yes'), 'yes');
  assert.equal(cleanYesNo('no'), 'no');
  assert.equal(cleanYesNo('maybe'), '');
  assert.equal(cleanYesNo(true), '');
});

test('export leaves eligibility unset until a yes/no is chosen', () => {
  const out = buildAutofillProfile(base);
  assert.equal(out.schemaVersion, 2);
  assert.equal(out.workAuthorized, undefined);
  assert.equal(out.requiresSponsorship, undefined);
});

test('export carries the v2.1 fields the assistant reads', () => {
  const out = buildAutofillProfile({
    ...base, workAuthorized: 'yes', requiresSponsorship: 'no', skills: 'Active Directory, Windows 11\nServiceNow',
    workHistory: JSON.stringify([{ company: 'Modern Technology', title: 'IT Support', current: true }]),
    education: JSON.stringify([{ school: 'Georgia State', degree: 'BS' }]),
  });
  assert.equal(out.workAuthorized, true);
  assert.equal(out.requiresSponsorship, false);
  assert.equal(out.legalName, 'Peter Olatunde');
  assert.deepEqual(out.skills, ['Active Directory', 'Windows 11', 'ServiceNow']);
  assert.deepEqual(out.workHistory, [{ company: 'Modern Technology', title: 'IT Support', current: true }]);
  assert.deepEqual(out.education, [{ school: 'Georgia State', degree: 'BS' }]);
});

test('profile hash is stable and changes when the phone changes', async () => {
  const first = await profileHash(buildAutofillProfile(base));
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(await profileHash(buildAutofillProfile({ ...base })), first);
  assert.notEqual(await profileHash(buildAutofillProfile({ ...base, phone: '2' })), first);
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('a D1 profile row hashes the same as the dashboard copy of it', async () => {
  const row = {
    owner_email: 'p@example.com', first_name: 'Peter', last_name: 'Olatunde', legal_name: 'Peter Olatunde', profile_email: 'p@example.com',
    phone: '1', city: 'Grayson', state: 'GA', postal_code: '30017', country: 'United States', linkedin: '',
    work_authorization: base.workAuthorization, sponsorship: base.sponsorship, work_authorized: '', requires_sponsorship: '',
    skills: '', work_history_json: '[]', education_json: '[]', identity_status: 'confirmed', apply_settings_json: '{}',
  };
  assert.deepEqual(autofillProfileFromRow(row), base);
  assert.equal(await profileHash(buildAutofillProfile(autofillProfileFromRow(row))), await profileHash(buildAutofillProfile(base)));
  assert.equal(autofillProfileFromRow({ first_name: null }).firstName, '');
});
