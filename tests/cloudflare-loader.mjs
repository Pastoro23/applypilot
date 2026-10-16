// In-process Worker tests only; no public server or authentication bypass route.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') {
    return { url: 'data:text/javascript,export const env = globalThis.__APPLYPILOT_TEST_ENV__ ?? {};', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
