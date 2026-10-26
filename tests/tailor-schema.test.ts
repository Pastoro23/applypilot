import test from 'node:test';
import assert from 'node:assert/strict';
import { TailorOutputSchema, TailoredResumeSchema } from '../app/tailor-schema.ts';

const saved = {
  fitScore: 82, fitSummary: 'Good fit.', requirements: [], changes: [], gaps: [], coverLetter: 'Hello.',
  resume: { name: 'A', contactLine: '', headline: '', summary: '', skills: [], experience: [], education: [], certifications: [] },
};
const review = {
  originalScore: 60,
  missingKeywords: [{ keyword: 'Tier 1 support', kind: 'wording', note: 'Used in the summary.' }],
  atsNotes: ['Standard headings.'], questions: ['How many tickets a week?'],
};

test('versions saved before the recruiter review still load and save', () => {
  assert.equal(TailoredResumeSchema.safeParse(saved).success, true);
  assert.equal(TailoredResumeSchema.safeParse({ ...saved, ...review }).success, true);
});

test('the AI must return the before score, missing keywords, ATS notes and questions', () => {
  assert.equal(TailorOutputSchema.safeParse(saved).success, false);
  assert.equal(TailorOutputSchema.safeParse({ ...saved, ...review }).success, true);
  assert.equal(TailorOutputSchema.safeParse({ ...saved, ...review, missingKeywords: [{ keyword: 'x', kind: 'maybe', note: '' }] }).success, false);
});
