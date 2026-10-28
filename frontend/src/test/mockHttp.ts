import contract from '../../../docs/openapi.json';
import { executeMockRequest, MockHttpError } from './mockEngine';

let rejectCaptcha = false;
export function setCaptchaRejection(value: boolean) { rejectCaptcha = value; }
export function testCaptchaResult() { return { lot_number: rejectCaptcha ? 'mock-old-lot' : 'mock-lot', captcha_output: 'mock-output', pass_token: 'mock-pass', gen_time: '1792756800' }; }

// Exercise the production HTTP client against synthetic responses, without a runtime app mode.
export async function mockFetch(input: RequestInfo | URL, options: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input), 'http://localhost'), path = url.pathname.replace(/^\/api\/v1/, '');
  const method = (options.method ?? 'GET').toUpperCase();
  for (const [template, methods] of Object.entries(contract.paths)) {
    const keys: string[] = [];
    const pattern = template.replace(/\{([^}]+)\}/g, (_match, key: string) => { keys.push(key); return '([^/]+)'; });
    const match = new RegExp('^' + pattern + '$').exec(path);
    const operation = (methods as Record<string, { operationId: string }>)[method.toLowerCase()];
    if (!match || !operation) continue;
    try {
      const result = await executeMockRequest({ operationId: operation.operationId, method: method as 'GET' | 'POST' | 'PATCH' | 'DELETE', path,
        pathParams: Object.fromEntries(keys.map((key, index) => [key, decodeURIComponent(match[index + 1]!)])),
        query: Object.fromEntries(url.searchParams), headers: Object.fromEntries(new Headers(options.headers)),
        ...(options.body ? { body: JSON.parse(String(options.body)) } : {}) });
      const payload = result.data as { data?: { config?: { captchaId: string } } };
      if (payload.data?.config?.captchaId.startsWith('mock-')) payload.data.config.captchaId = 'synthetic-test-captcha';
      return Response.json(result.data, { status: result.status });
    } catch (error) {
      if (error instanceof MockHttpError) return Response.json(error.envelope, { status: error.status, headers: error.headers });
      throw error;
    }
  }
  throw new Error('Unmatched test HTTP request: ' + method + ' ' + path);
}
