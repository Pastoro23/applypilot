import { UserFacingError } from './errors.ts';

export class JobReadError extends UserFacingError {
  constructor(message: string) { super(message, 422); }
}
const APPROVED_DOMAINS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com',
  'myworkdaysite.com', 'icims.com', 'smartrecruiters.com', 'jobvite.com', 'taleo.net',
];
export const MAX_JOB_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12_000;

export function checkedJobUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new JobReadError('Paste a full HTTPS job link.'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !APPROVED_DOMAINS.some(domain => host === domain || host.endsWith('.' + domain))) {
    throw new JobReadError('Automatic reading supports Greenhouse, Lever, Ashby, Workday, iCIMS, SmartRecruiters, Jobvite and Taleo HTTPS links. For another employer site, paste the description.');
  }
  return url;
}

export async function fetchJobText(raw: string, accept: 'json' | 'html', timeoutMs = TIMEOUT_MS, maxBytes = MAX_JOB_BYTES) {
  let url = checkedJobUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let redirect = 0; redirect <= 3; redirect++) {
      const response = await fetch(url.href, {
        redirect: 'manual', signal: controller.signal,
        headers: { accept: accept === 'json' ? 'application/json' : 'text/html,application/xhtml+xml' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirect === 3) throw new JobReadError('The job page redirected too many times. Paste its description instead.');
        url = checkedJobUrl(new URL(location, url).href);
        continue;
      }
      if (response.status === 404) throw new JobReadError('That job is no longer posted.');
      if (!response.ok) throw new JobReadError(`The job page answered ${response.status}. Paste the description instead.`);
      const mime = (response.headers.get('content-type') || '').toLowerCase();
      if (accept === 'json' ? !mime.includes('json') : !/text\/html|application\/xhtml\+xml/.test(mime)) {
        await response.body?.cancel();
        throw new JobReadError('That link did not return a readable job posting. Paste the description instead.');
      }
      if (Number(response.headers.get('content-length') || 0) > maxBytes) {
        await response.body?.cancel();
        throw new JobReadError('The job page is too large. Paste the description instead.');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new JobReadError('The job page was empty. Paste its description instead.');
      const decoder = new TextDecoder(); let size = 0; let body = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBytes) throw new JobReadError('The job page is too large. Paste the description instead.');
          body += decoder.decode(chunk.value, { stream: true });
        }
      } catch (error) { await reader.cancel(); throw error; }
      return body + decoder.decode();
    }
    throw new JobReadError('Could not read that job link.');
  } catch (error) {
    if (error instanceof JobReadError) throw error;
    throw new JobReadError(controller.signal.aborted
      ? 'The job page took too long. Paste its description instead.'
      : "ApplyPilot couldn't reach that job site. Paste the description instead.");
  } finally { clearTimeout(timer); }
}
