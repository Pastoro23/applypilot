// Work history, education and eligibility answers shared by the dashboard, the profile API and the
// Application Assistant export. Records are stored as JSON text on the profile row.

export const workFields = [
  ["company", "Company"],
  ["title", "Job title"],
  ["city", "City"],
  ["state", "State"],
  ["startMonth", "Start month"],
  ["startYear", "Start year"],
  ["endMonth", "End month"],
  ["endYear", "End year"],
  ["description", "What you did"],
] as const;

export const educationFields = [
  ["school", "School"],
  ["degree", "Degree"],
  ["field", "Field of study"],
  ["city", "City"],
  ["state", "State"],
  ["startYear", "Start year"],
  ["endYear", "End year"],
] as const;

type Key<T extends readonly (readonly [string, string])[]> = T[number][0];
export type WorkRecord = Partial<Record<Key<typeof workFields>, string>> & { current?: boolean };
export type EducationRecord = Partial<Record<Key<typeof educationFields>, string>> & { current?: boolean };

const MAX_RECORDS = 15;

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

// Accepts untrusted JSON text or an array; keeps only known keys, drops empty records.
export function cleanRecords<T extends WorkRecord | EducationRecord>(
  value: unknown,
  fields: readonly (readonly [string, string])[],
): T[] {
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const out: T[] = [];
  for (const item of list.slice(0, MAX_RECORDS)) {
    if (!item || typeof item !== "object") continue;
    const source = item as Record<string, unknown>;
    const record: Record<string, string | boolean> = {};
    for (const [key] of fields) {
      const text = cleanText(source[key], key === "description" ? 2000 : 200);
      if (text) record[key] = text;
    }
    if (source.current === true) record.current = true;
    if (Object.keys(record).some((key) => key !== "current")) out.push(record as T);
  }
  return out;
}

// "yes" / "no" / "" (ask me every time).
export function cleanYesNo(value: unknown) {
  return value === "yes" || value === "no" ? value : "";
}

export type ProfileForExport = {
  firstName: string;
  lastName: string;
  legalName: string;
  profileEmail: string;
  phone: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  linkedIn: string;
  workAuthorization: string;
  sponsorship: string;
  workAuthorized: string;
  requiresSponsorship: string;
  skills: string;
  workHistory: string;
  education: string;
};

// The JSON file the Application Assistant imports. Eligibility is only sent as a yes/no once the user
// picked one; otherwise the assistant leaves those questions for the user.
export function buildAutofillProfile(profile: ProfileForExport) {
  const yesNo = (value: string) => (value === "yes" ? true : value === "no" ? false : undefined);
  return {
    schemaVersion: 2,
    firstName: profile.firstName,
    lastName: profile.lastName,
    fullName: `${profile.firstName} ${profile.lastName}`.trim(),
    legalName: profile.legalName,
    email: profile.profileEmail,
    phone: profile.phone,
    city: profile.city,
    state: profile.state,
    postalCode: profile.postalCode,
    country: profile.country,
    linkedIn: profile.linkedIn,
    workAuthorized: yesNo(profile.workAuthorized),
    requiresSponsorship: yesNo(profile.requiresSponsorship),
    workAuthorization: profile.workAuthorization,
    sponsorship: profile.sponsorship,
    skills: profile.skills
      .split(/[,\n]/)
      .map((skill) => skill.trim())
      .filter(Boolean),
    workHistory: cleanRecords<WorkRecord>(profile.workHistory, workFields),
    education: cleanRecords<EducationRecord>(profile.education, educationFields),
  };
}
