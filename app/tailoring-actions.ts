export type ApplicationForTailoring = { id: string; jobDescription: string; tailoredRevision: number };
export type JsonRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

// Keep the save/generate sequence in one place: the visible draft is the input.
export async function tailorWithLatestDescription<T extends ApplicationForTailoring>(
  api: JsonRequest, application: T, draftDescription: string, instructions: string, onUpdated: (app: T) => void,
) {
  const description = draftDescription.trim();
  if (description.length < 100 || description.length > 20000) throw new Error('Use a job description between 100 and 20,000 characters.');
  let current = application;
  if (description !== application.jobDescription) {
    const saved = await api<{ application: T }>('/api/applications', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: application.id, jobDescription: description }),
    });
    current = saved.application;
    onUpdated(current);
  }
  return api<{ application: T }>('/api/tailor', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ applicationId: current.id, instructions, revision: current.tailoredRevision, jobDescription: description }),
  });
}
