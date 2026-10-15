// Test process only: never load local credentials or contact an external service.
import http from 'node:http';
import https from 'node:https';
process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.AI_PROVIDER = 'gemini';
for (const name of Object.keys(process.env)) {
  if (/SUPABASE|API_KEY|ACCESS_TOKEN|SERVICE_ROLE|GOOGLE_APPLICATION_CREDENTIALS/u.test(name)) delete process.env[name];
}
const local = value => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(value);
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!local(url.hostname)) throw new Error('External network disabled for local validation');
  return originalFetch(input, options);
};
for (const transport of [http, https]) {
  const request = transport.request;
  transport.request = function (input, ...args) {
    const hostname = typeof input === 'string' || input instanceof URL ? new URL(input).hostname : input.hostname || input.host || 'localhost';
    if (!local(hostname)) throw new Error('External network disabled for local validation');
    return request.call(this, input, ...args);
  };
}
