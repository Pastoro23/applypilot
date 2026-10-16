import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAutofillProfile, cleanRecords, cleanYesNo, workFields } from '../app/profile-records.ts';

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
