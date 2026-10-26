import { z } from "zod";

const ReviewFields = {
  originalScore: z.number().min(0).max(100).describe("0-100: how well the untouched source resume matches this posting, judged as a recruiter and ATS would"),
  missingKeywords: z
    .array(
      z.object({
        keyword: z.string().describe("A keyword or phrase from the posting"),
        kind: z.enum(["wording", "qualification"]).describe("wording: the candidate has it but the source resume uses other words; qualification: the candidate does not show it"),
        note: z.string().describe("One short line: where it was worked in, or why it was left out"),
      }),
    )
    .describe("The top 5 posting keywords the source resume was missing, most important first"),
  atsNotes: z.array(z.string()).describe("ATS readability review of the tailored resume: section headings, formatting, keyword placement, anything a parser could misread; one line each"),
  questions: z.array(z.string()).describe("Questions for the candidate whose answers (numbers, tools, scope, results) would make bullets stronger without guessing; at most 6"),
};

const TailoredCore = z.object({
  fitScore: z.number().min(0).max(100).describe("0-100: how well the tailored resume matches this job, using the same yardstick as originalScore"),
  fitSummary: z.string().describe("Two or three plain sentences on why the candidate fits and where they are thin"),
  requirements: z
    .array(
      z.object({
        requirement: z.string().describe("A responsibility or qualification from the posting, short"),
        evidence: z.string().describe("Where the source resume supports it, or an empty string if it does not"),
        covered: z.boolean(),
      }),
    )
    .describe("The 6-12 most important responsibilities and qualifications in the posting"),
  resume: z.object({
    name: z.string(),
    contactLine: z.string().describe("Email · phone · city, state · LinkedIn, as available in the source"),
    headline: z.string().describe("A one-line title aimed at this role, true to the source resume"),
    summary: z.string().describe("3-4 sentence professional summary aimed at this job"),
    skills: z.array(z.string()).describe("Skills from the source resume, most relevant to this job first"),
    experience: z.array(
      z.object({
        title: z.string(),
        company: z.string(),
        location: z.string(),
        dates: z.string(),
        bullets: z.array(z.string()),
      }),
    ),
    education: z.array(z.object({ credential: z.string(), school: z.string(), dates: z.string() })),
    certifications: z.array(z.string()),
  }),
  coverLetter: z.string().describe("A short cover letter (under 250 words) for this job, plain text with paragraph breaks"),
  changes: z.array(z.string()).describe("What was changed from the source resume and why, one line each"),
  gaps: z
    .array(z.string())
    .describe("Requirements the source resume does not support. Never paper over these by inventing experience."),
});

// What the AI must return. Saved versions from before the review fields still load through TailoredResumeSchema.
export const TailorOutputSchema = TailoredCore.extend(ReviewFields);
export const TailoredResumeSchema = TailoredCore.extend({
  originalScore: ReviewFields.originalScore.optional(),
  missingKeywords: ReviewFields.missingKeywords.optional(),
  atsNotes: ReviewFields.atsNotes.optional(),
  questions: ReviewFields.questions.optional(),
});

export type TailoredResume = z.infer<typeof TailoredResumeSchema>;
