import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Accounts, capabilities, paginate, terminalRuns } from './accounts.js';
import { Fault, constantEqual, day, fault, hash, id, iso, passwordHash, passwordMatches } from './core.js';
import type { Api, Config } from './core.js';
import { Challenges, Logins } from './login.js';
import { Notifications } from './notifications.js';
import type { MailSender } from './notifications.js';
import { Storage } from './storage.js';
import { MihoyoUpstream } from './upstream.js';
import type { Upstream } from './upstream.js';
import { Worker } from './worker.js';
import { Games, MihoyoGames } from './games.js';
import type { GameUpstream } from './games.js';
import type { FastifyRequest } from 'fastify';

type Schema = Record<string, any>;
type Contract = { components: { schemas: Record<string, Schema>; parameters: Record<string, Schema> }; paths: Record<string, Record<string, Schema>> };
const contractPath = [resolve(import.meta.dirname, '../../docs/openapi.json'), resolve(import.meta.dirname, '../../../docs/openapi.json')].find(existsSync);
if (!contractPath) throw Error('Shared docs/openapi.json is required');
const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as Contract;
function rewrite(value: any): any {
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !['discriminator', 'example', 'writeOnly', 'readOnly'].includes(k)).map(([k, v]) => [k, k === '$ref' && typeof v === 'string' ? v.replace('#/components/schemas/', '') + '#' : rewrite(v)]));
  return value;
}
function stable(value: unknown): string { if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'; if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}'; return JSON.stringify(value) ?? 'null'; }
type AdminRow = { id: string; username: string; password_hash: string };
type StoredResponse = { status: number; payload: unknown };
type AuthContext = { admin: AdminRow; token: string; expiresAt: string };

export async function buildApp(config: Config, options: { upstream?: Upstream; gamesUpstream?: Partial<GameUpstream>; mailSender?: MailSender; startWorker?: boolean } = {}) {
  const store = new Storage(config), accounts = new Accounts(store), challenges = new Challenges();
  const upstream = options.upstream ?? new MihoyoUpstream(config.timeoutMs);
  const games = new Games(accounts, options.gamesUpstream ?? (options.upstream ? {} : new MihoyoGames(config.timeoutMs)));
  const notifications = new Notifications(store, options.mailSender), logins = new Logins(accounts, upstream, challenges), worker = new Worker(accounts, upstream, challenges, notifications, games, () => logins.expire());
  const app = Fastify({ logger: false, genReqId: () => id(), bodyLimit: 32768, requestTimeout: 60000, connectionTimeout: 65000 });
  await app.register(cookie);
  await app.register(cors, { origin: config.origins, credentials: true, methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'X-Setup-Token'], exposedHeaders: ['Retry-After'] });
  const makeAjv = (coerce: boolean) => { const a = new Ajv({ removeAdditional: false, coerceTypes: coerce, strict: false, allErrors: false }); (addFormats as unknown as (a: Ajv) => void)(a); for (const [name, schema] of Object.entries(contract.components.schemas)) a.addSchema({ ...rewrite(schema), $id: name }); return a; };
  const bodyAjv = makeAjv(false), queryAjv = makeAjv(true);
  app.setValidatorCompiler(({ schema, httpPart }) => (httpPart === 'querystring' || httpPart === 'params' ? queryAjv : bodyAjv).compile(schema));
  for (const [name, schema] of Object.entries(contract.components.schemas)) app.addSchema({ ...rewrite(schema), $id: name });
  const contexts = new WeakMap<FastifyRequest, AuthContext>();
  const publicRoutes = new Set(['/api/v1/health', '/api/v1/setup/status', '/api/v1/setup', '/api/v1/auth/login']);
  app.addHook('onRequest', async request => {
    if (request.method === 'OPTIONS') return;
    const origin = request.headers.origin;
    if ((origin && !config.origins.includes(origin)) || (request.method !== 'GET' && !origin)) throw new Fault(403, 'FORBIDDEN', '请求来源不被允许');
    if (publicRoutes.has(request.routeOptions.url ?? '')) return;
    if (!store.db.prepare('SELECT id FROM administrators LIMIT 1').get()) throw new Fault(409, 'SETUP_REQUIRED', '请先初始化实例管理员');
    const token = request.cookies.mys_session;
    const row = token ? store.db.prepare('SELECT a.*,s.expires_at FROM sessions s JOIN administrators a ON a.id=s.admin_id WHERE s.token_hash=? AND s.expires_at>?').get(hash(token), iso()) as (AdminRow & { expires_at: string }) | undefined : undefined;
    if (!row || !token) throw new Fault(401, 'UNAUTHENTICATED', '面板登录已过期，请重新登录');
    contexts.set(request, { admin: row, token, expiresAt: row.expires_at });
    if (request.method !== 'GET' && !constantEqual(String(request.headers['x-csrf-token'] ?? ''), store.vault.mac('csrf', token))) throw new Fault(403, 'CSRF_INVALID', '会话验证已失效，请刷新页面');
  });
  app.setErrorHandler((error, request, reply) => {
    const f = error instanceof Fault ? error : (error as { validation?: unknown; statusCode?: number }).validation || (error as { statusCode?: number }).statusCode === 400 ? new Fault(400, 'VALIDATION_ERROR', '请求字段无效，请检查输入') : fault(error);
    if (f.details?.retryAfterSeconds) reply.header('Retry-After', f.details.retryAfterSeconds);
    reply.code(f.status).send({ error: f.view(), requestId: request.id });
  });
  app.setNotFoundHandler((request, reply) => { reply.code(404).send({ error: new Fault(404, 'NOT_FOUND', '接口不存在').view(), requestId: request.id }); });
  const inflight = new Map<string, Promise<StoredResponse>>();
  async function executeIdempotent(key: string, fingerprint: string, execute: () => Promise<StoredResponse>): Promise<StoredResponse> {
    const now = Date.now();
    const stored = store.db.prepare('SELECT fingerprint,response,expires_at FROM idempotency WHERE key=?').get(key) as { fingerprint: string; response: string | null; expires_at: number } | undefined;
    if (stored && stored.expires_at > now) {
      if (!constantEqual(stored.fingerprint, fingerprint)) throw new Fault(409, 'IDEMPOTENCY_CONFLICT', '同一幂等标识不能用于不同请求');
      if (inflight.has(key)) return inflight.get(key)!;
      if (!stored.response) throw new Fault(502, 'UPSTREAM_OUTCOME_UNKNOWN', '之前的请求结果待确认，请刷新业务状态');
      return JSON.parse(stored.response) as StoredResponse;
    }
    store.db.prepare('INSERT OR REPLACE INTO idempotency VALUES(?,?,NULL,?)').run(key, fingerprint, now + 86400000);
    const promise = execute(); inflight.set(key, promise);
    try { const result = await promise; store.db.prepare('UPDATE idempotency SET response=? WHERE key=?').run(JSON.stringify(result), key); return result; }
    finally { inflight.delete(key); }
  }
  type Context = { request: FastifyRequest; params: Record<string, string>; query: any; body: any };
  const methods: Record<string, (c: Context) => unknown | Promise<unknown>> = {
    getHealth: () => ({ status: 'ok', version: '0.2.0', database: 'ok', serverTime: iso() }),
    getSetupStatus: () => ({ initialized: !!store.db.prepare('SELECT id FROM administrators LIMIT 1').get(), contractVersion: '0.1.0' }),
    initializeAdmin: async ({ request, body }) => {
      store.limit('setup:' + request.ip, 5, 60000);
      if (!constantEqual(String(request.headers['x-setup-token'] ?? ''), config.bootstrapToken)) throw new Fault(403, 'SETUP_TOKEN_INVALID', '初始化 token 无效');
      if (store.db.prepare('SELECT id FROM administrators LIMIT 1').get()) throw new Fault(409, 'ALREADY_INITIALIZED', '实例已完成初始化');
      const pass = await passwordHash(body.password);
      return store.tx(() => { if (store.db.prepare('SELECT id FROM administrators LIMIT 1').get()) throw new Fault(409, 'ALREADY_INITIALIZED', '实例已完成初始化'); const admin = { id: id(), username: body.username }; store.db.prepare('INSERT INTO administrators(id,username,password_hash) VALUES(?,?,?)').run(admin.id, admin.username, pass); return admin; });
    },
    loginAdmin: async ({ request, body }) => {
      store.limit('admin-login:' + request.ip, 5, 60000);
      const admin = store.db.prepare('SELECT * FROM administrators LIMIT 1').get() as AdminRow | undefined;
      if (!admin) throw new Fault(409, 'SETUP_REQUIRED', '请先初始化管理员');
      const passwordOk = await passwordMatches(body.password, admin.password_hash);
      if (!passwordOk || admin.username !== body.username) throw new Fault(401, 'AUTH_INVALID', '用户名或密码无效');
      const token = randomBytes(32).toString('base64url'), expiresAt = iso(Date.now() + 43200000);
      store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), admin.id, expiresAt);
      return { admin: { id: admin.id, username: admin.username }, expiresAt, csrfToken: store.vault.mac('csrf', token), _cookieToken: token };
    },
    getAdminSession: ({ request }) => { const c = contexts.get(request)!; return { admin: { id: c.admin.id, username: c.admin.username }, expiresAt: c.expiresAt, csrfToken: store.vault.mac('csrf', c.token) }; },
    logoutAdmin: ({ request }) => { store.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(contexts.get(request)!.token)); return { accepted: true }; },
    getCapabilities: () => capabilities,
    getDashboard: () => { const all = accounts.all(), runs = store.all<Api['Run']>('run'), today = runs.filter(r => r.businessDate === day()); return { businessDate: day(), accountCount: all.length, activeAccountCount: all.filter(a => a.enabled && a.status === 'active').length, actionRequiredCount: all.filter(a => ['reauth_required', 'verification_required'].includes(a.status)).length, todaySucceededRuns: today.filter(r => r.state === 'succeeded').length, todayFailedRuns: today.filter(r => ['failed', 'partially_succeeded', 'outcome_unknown'].includes(r.state)).length, todayConfirmedRewardPoints: today.reduce((n, r) => n + r.confirmedRewardPoints, 0), activeRuns: runs.filter(r => !terminalRuns.has(r.state)) }; },
    listAccounts: ({ query }) => paginate(accounts.all().filter(a => (!query.status || a.status === query.status) && (query.enabled === undefined || a.enabled === query.enabled)), query),
    getAccount: ({ params }) => accounts.get(params.accountId!),
    updateAccount: ({ params, body }) => accounts.patch(params.accountId!, body),
    deleteAccount: ({ params }) => { accounts.delete(params.accountId!); return { accepted: true }; },
    createLoginFlow: ({ body }) => logins.create(body),
    getLoginFlow: ({ params }) => logins.get(params.flowId!),
    cancelLoginFlow: ({ params }) => logins.cancel(params.flowId!),
    sendLoginSms: ({ params }) => logins.send(params.flowId!),
    submitLoginCode: ({ params, body }) => logins.code(params.flowId!, body.code),
    getChallenge: ({ params }) => challenges.get(params.challengeId!),
    submitChallenge: ({ params, body }) => challenges.submit(params.challengeId!, body),
    renewChallenge: ({ params }) => challenges.renew(params.challengeId!),
    startCredentialOperation: ({ params, body }) => worker.startOperation(params.accountId!, body.kind),
    getCredentialOperation: ({ params }) => worker.operation(params.operationId!),
    getAccountMissions: ({ params }) => accounts.snapshot(params.accountId!),
    refreshAccountMissions: ({ params }) => worker.refreshMissions(params.accountId!),
    getGameRoles: ({ params }) => games.snapshot(params.accountId!),
    refreshGameRoles: ({ params }) => worker.refreshGameRoles(params.accountId!),
    getAccountSchedule: ({ params }) => accounts.schedule(params.accountId!),
    updateAccountSchedule: ({ params, body }) => accounts.patchSchedule(params.accountId!, body),
    createAccountRun: ({ params, body }) => worker.create(params.accountId!, body),
    listRuns: ({ query }) => { if (query.dateFrom && query.dateTo && query.dateFrom > query.dateTo) throw new Fault(400, 'VALIDATION_ERROR', '日期范围无效'); return paginate(store.all<Api['Run']>('run').filter(r => (!query.accountId || r.accountId === query.accountId) && (!query.state || r.state === query.state) && (!query.dateFrom || r.businessDate >= query.dateFrom) && (!query.dateTo || r.businessDate <= query.dateTo)), query); },
    getRun: ({ params }) => worker.run(params.runId!),
    listRunEvents: ({ params, query }) => { worker.run(params.runId!); return paginate(store.all<Api['RunEvent']>('event').filter(e => e.runId === params.runId), query); },
    retryRun: ({ params }) => worker.retry(params.runId!),
    cancelRun: ({ params }) => worker.cancel(params.runId!),
    getSystemSettings: () => accounts.settings(),
    updateSystemSettings: ({ body }) => accounts.patchSettings(body),
    getNotificationSettings: () => notifications.settings(),
    updateNotificationSettings: ({ body }) => notifications.patch(body),
    createNotificationTest: () => notifications.test(),
    getNotificationTest: ({ params }) => notifications.getTest(params.testId!)
  };
  for (const [path, pathMethods] of Object.entries(contract.paths)) for (const [method, operation] of Object.entries(pathMethods)) {
    const operationId = operation.operationId as string, implementation = methods[operationId]; if (!implementation) throw Error(`Unimplemented operation: ${operationId}`);
    const parameters = (operation.parameters ?? []).map((p: Schema) => p.$ref ? contract.components.parameters[p.$ref.split('/').at(-1)!]! : p) as Schema[];
    const schema: Record<string, unknown> = { response: Object.fromEntries(Object.entries(operation.responses).map(([status, r]: [string, any]) => [status, rewrite(r.content['application/json'].schema)])) };
    if (operation.requestBody) schema.body = rewrite(operation.requestBody.content['application/json'].schema);
    for (const [location, field] of [['path', 'params'], ['query', 'querystring'], ['header', 'headers']]) {
      const subset = parameters.filter(p => p.in === location); if (subset.length) schema[field!] = { type: 'object', properties: Object.fromEntries(subset.map(p => [location === 'header' ? p.name.toLowerCase() : p.name, rewrite(p.schema)])), required: subset.filter(p => p.required).map(p => location === 'header' ? p.name.toLowerCase() : p.name), additionalProperties: location === 'header' };
    }
    const status = Number(Object.keys(operation.responses).find(x => x !== 'default'));
    app.route({ method: method.toUpperCase() as 'GET' | 'POST' | 'PATCH' | 'DELETE', url: '/api/v1' + path.replace(/\{([^}]+)\}/g, ':$1'), schema,
      preValidation: async request => { if (!operation.requestBody && request.body !== undefined && (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body) || Object.keys(request.body).length)) throw new Fault(400, 'VALIDATION_ERROR', '此接口不接受额外请求字段'); },
      handler: async (request, reply) => {
        const execute = async (): Promise<StoredResponse> => {
          try {
            const data = await implementation({ request, params: request.params as Record<string, string>, query: request.query, body: request.body });
            if (operationId === 'loginAdmin') { const session = data as Api['Session'] & { _cookieToken: string }; reply.setCookie('mys_session', session._cookieToken, { httpOnly: true, secure: config.secureCookie, sameSite: 'lax', path: '/api/v1', maxAge: 43200 }); delete (session as Partial<typeof session>)._cookieToken; }
            if (operationId === 'logoutAdmin') reply.clearCookie('mys_session', { path: '/api/v1', secure: config.secureCookie, sameSite: 'lax', httpOnly: true });
            return { status, payload: { data, requestId: request.id } };
          } catch (e) { const f = fault(e); return { status: f.status, payload: { error: f.view(), requestId: request.id } }; }
        };
        let result: StoredResponse;
        if (parameters.some(p => p.name === 'Idempotency-Key')) {
          const identity = contexts.get(request)!.admin.id, supplied = String(request.headers['idempotency-key']);
          const key = hash(identity + ':' + operationId + ':' + supplied), fingerprint = store.vault.mac('idempotency', stable({ path, params: request.params, body: request.body }));
          result = await executeIdempotent(key, fingerprint, execute);
          // Ephemeral flows never revive from a persisted replay after a restart.
          const data = (result.payload as { data?: { id?: string } }).data;
          if (['createLoginFlow', 'sendLoginSms', 'submitLoginCode', 'cancelLoginFlow'].includes(operationId) && data?.id) logins.get(data.id);
        } else result = await execute();
        const retry = (result.payload as { error?: Api['Error'] }).error?.details?.retryAfterSeconds; if (retry) reply.header('Retry-After', retry);
        reply.header('Cache-Control', 'no-store'); return reply.code(result.status).send(result.payload);
      }
    });
  }
  app.addHook('onClose', async () => { await worker.stop(); store.close(); });
  await app.ready(); if (options.startWorker !== false) worker.start();
  return { app, store, accounts, logins, challenges, worker, notifications, games };
}
