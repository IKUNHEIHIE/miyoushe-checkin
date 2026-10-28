import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { buildApp } from '../src/app.js';
import { Fault, Vault, day, iso, nextSchedule } from '../src/core.js';
import type { Api, Config, Credentials, Device } from '../src/core.js';
import type { LoginToken, MissionState, Upstream } from '../src/upstream.js';
import { MihoyoUpstream, NeedCaptcha } from '../src/upstream.js';
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { DatabaseSync } from 'node:sqlite';
import { MihoyoGames, roleId } from '../src/games.js';
import type { BoundRole, GameInfo, GameUpstream } from '../src/games.js';

const spec = JSON.parse(readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8'));
const responseAjv = new Ajv({ strict: false }); (addFormats as unknown as (a: Ajv) => void)(responseAjv);
responseAjv.addSchema({ ...spec, $id: 'https://contract.invalid/openapi' });
const observedOperations = new Set<string>();
function checkResponse(method: string, path: string, status: number, data: unknown) {
  const url = path.split('?')[0]!;
  for (const [template, methods] of Object.entries(spec.paths) as [string, any][]) {
    if (!new RegExp('^' + template.replace(/\{[^}]+\}/g, '[^/]+') + '$').test(url)) continue;
    const operation = methods[method.toLowerCase()]; if (!operation) continue; observedOperations.add(operation.operationId);
    const response = operation.responses[String(status)] ?? operation.responses.default;
    const reference = response.content['application/json'].schema.$ref;
    const validate = responseAjv.getSchema('https://contract.invalid/openapi' + reference);
    assert.ok(validate, reference); assert.ok(validate(data), operation.operationId + ': ' + JSON.stringify(validate.errors)); return;
  }
  assert.fail('Unrecognized route in test: ' + method + ' ' + path);
}

class FakeUpstream implements Upstream {
  smsCalls = 0; loginCalls = 0; signCalls: string[] = []; reads: string[] = []; exchanges: string[] = [];
  requireCaptcha = false; signCaptcha = false; signedAccounts = new Set<string>(); unknownWrite = false; expiredRoot = false; verifyFails = false;
  balances = new Map<string, number>();
  challenge(): NeedCaptcha { return new NeedCaptcha({ version: 'gt4', config: { captchaId: 'synthetic-not-official', challenge: null, newCaptcha: null, offline: false, product: 'bind', language: 'zho', riskType: 'slide', userInfo: null }, verify: async value => { if (value.version !== 'gt4' || value.result.pass_token !== 'synthetic-proof') throw new Fault(422, 'CHALLENGE_FAILED', '模拟验证结果无效'); return 'verified'; } }); }
  async sendSms(_phone: string, _device: Device, proof?: string) { this.smsCalls++; if (this.requireCaptcha && proof !== 'verified') throw this.challenge(); return { actionType: 'login', countdown: 60 }; }
  async login(phone: string, code: string) { this.loginCalls++; if (code !== '012345') throw new Fault(422, 'SMS_CODE_INVALID', '验证码无效'); const aid = phone.endsWith('2') ? '200000002' : '100000001'; return { aid, mid: 'mid-' + aid, stoken: 'v2_synthetic-' + aid }; }
  async exchange(token: LoginToken): Promise<Credentials> { this.exchanges.push(token.aid); if (this.expiredRoot) throw new Fault(409, 'ACCOUNT_REAUTH_REQUIRED', '模拟根凭据失效'); return { ...token, ltoken: 'synthetic-l-' + token.aid, cookieToken: 'synthetic-cookie-' + token.aid, cookieExpiresAt: iso(Date.now() + 172800000) }; }
  async missions(c: Credentials): Promise<MissionState> { this.reads.push(c.aid); assert.equal(c.cookieToken, 'synthetic-cookie-' + c.aid); assert.equal(c.stoken, 'v2_synthetic-' + c.aid); if (this.verifyFails) throw new Fault(504, 'UPSTREAM_TIMEOUT', '模拟查询超时'); const completed = this.signedAccounts.has(c.aid); return { total: this.balances.get(c.aid) ?? 1000, received: completed ? 30 : 0, canGet: completed ? 0 : 30, states: completed ? [{ mission_id: 58, mission_key: 'continuous_sign', happened_times: 1, process: 1, is_get_award: true }] : [] }; }
  async sign(c: Credentials, _d: Device, _community: number, proof?: string) { this.signCalls.push(c.aid); if (this.signCaptcha && proof !== 'verified') throw this.challenge(); if (this.unknownWrite) throw new Fault(502, 'UPSTREAM_OUTCOME_UNKNOWN', '模拟写入超时'); if (this.signedAccounts.has(c.aid)) return { retcode: 1008, points: 0 }; this.signedAccounts.add(c.aid); this.balances.set(c.aid, 1030); return { retcode: 0, points: 30 }; }
}
const origin = 'http://localhost:5173';
const config = (path = ':memory:', key = randomBytes(32)): Config => ({ databasePath: path, key, bootstrapToken: 'synthetic-bootstrap-token-000000000000000', origins: [origin], secureCookie: false, timeoutMs: 1000, host: '127.0.0.1', port: 3000 });
async function harness(t: test.TestContext, fake = new FakeUpstream(), cfg = config(), gamesUpstream?: GameUpstream) {
  const sentMail: unknown[] = [];
  const ctx = await buildApp(cfg, { upstream: fake, gamesUpstream, startWorker: false, mailSender: async (...args) => { sentMail.push(args); } }); t.after(() => ctx.app.close());
  const setup = await ctx.app.inject({ method: 'POST', url: '/api/v1/setup', headers: { origin, 'x-setup-token': cfg.bootstrapToken }, payload: { username: 'admin', password: 'synthetic-admin-password' } }); assert.equal(setup.statusCode, 201, setup.body);
  const login = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { username: 'admin', password: 'synthetic-admin-password' } }); assert.equal(login.statusCode, 200, login.body);
  checkResponse('POST', '/setup', setup.statusCode, setup.json()); checkResponse('POST', '/auth/login', login.statusCode, login.json());
  const cookie = login.headers['set-cookie']!.toString().split(';')[0]!, csrf = login.json().data.csrfToken;
  async function api(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, key = randomUUID()) { const r = await ctx.app.inject({ method, url: '/api/v1' + path, headers: { origin, cookie, 'x-csrf-token': csrf, 'idempotency-key': key }, ...(body !== undefined ? { payload: body as any } : {}) }); checkResponse(method, path, r.statusCode, r.json()); return r; }
  async function bind(phone = '13900000001') { const token = await fake.login(phone, '012345'); const c = await fake.exchange(token); return ctx.accounts.bind(phone, { id: randomUUID() }, c); }
  return { ...ctx, fake, cfg, api, bind, cookie, csrf, sentMail };
}
test('contract routes build; initialization, auth, CSRF, origin and unknown fields are enforced', async t => {
  const h = await harness(t);
  assert.equal((await h.api('GET', '/health')).json().data.status, 'ok');
  assert.equal((await h.api('GET', '/setup/status')).json().data.initialized, true);
  assert.equal((await h.api('GET', '/auth/session')).json().data.admin.username, 'admin');
  const unauth = await h.app.inject('/api/v1/accounts'); assert.equal(unauth.statusCode, 401);
  const noCsrf = await h.app.inject({ method: 'POST', url: '/api/v1/login-flows', headers: { origin, cookie: h.cookie, 'idempotency-key': randomUUID() }, payload: { phone: '13900000001', countryCode: '+86' } }); assert.equal(noCsrf.statusCode, 403);
  const evil = await h.app.inject({ method: 'GET', url: '/api/v1/accounts', headers: { origin: 'https://evil.invalid', cookie: h.cookie } }); assert.equal(evil.statusCode, 403);
  const extra = await h.api('POST', '/login-flows', { phone: '13900000001', countryCode: '+86', stoken: 'must-not-accept' }); assert.equal(extra.statusCode, 400);
  const cookieConfig = (await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin }, payload: { username: 'admin', password: 'synthetic-admin-password' } })).headers['set-cookie']!.toString(); assert.match(cookieConfig, /HttpOnly/); assert.match(cookieConfig, /SameSite=Lax/);
  assert.equal((await h.api('POST', '/auth/logout')).statusCode, 200);
  assert.equal((await h.api('GET', '/auth/session')).statusCode, 401);
});
test('new-device SMS login, manual challenge, leading-zero code and duplicate account protection', async t => {
  const h = await harness(t); h.fake.requireCaptcha = true;
  const create = await h.api('POST', '/login-flows', { phone: '13900000001', countryCode: '+86' }); assert.equal(create.statusCode, 201, create.body); const flow = create.json().data;
  assert.equal(h.fake.smsCalls, 0);
  const sms = await h.api('POST', `/login-flows/${flow.id}/send-sms`); assert.equal(sms.statusCode, 200, sms.body); assert.equal(sms.json().data.state, 'awaiting_captcha');
  const cid = sms.json().data.challengeId, c = await h.api('GET', `/challenges/${cid}`); assert.equal(c.json().data.version, 'gt4');
  const bad = await h.api('POST', `/challenges/${cid}/submit`, { version: 'gt4', result: { lot_number: 'synthetic-lot', captcha_output: 'synthetic-output', pass_token: 'bad', gen_time: '1' } }); assert.equal(bad.statusCode, 422);
  const renewed = await h.api('POST', `/challenges/${cid}/renew`); assert.equal(renewed.statusCode, 200, renewed.body);
  assert.equal((await h.api('GET', `/login-flows/${flow.id}`)).json().data.nextAction, 'solve_challenge');
  const proof = await h.api('POST', `/challenges/${renewed.json().data.id}/submit`, { version: 'gt4', result: { lot_number: 'synthetic-lot', captcha_output: 'synthetic-output', pass_token: 'synthetic-proof', gen_time: '1' } }); assert.equal(proof.statusCode, 200, proof.body);
  assert.equal((await h.api('GET', `/login-flows/${flow.id}`)).json().data.state, 'awaiting_sms_code');
  assert.equal((await h.api('POST', `/login-flows/${flow.id}/submit-code`, { code: 12345 })).statusCode, 400);
  const done = await h.api('POST', `/login-flows/${flow.id}/submit-code`, { code: '012345' }); assert.equal(done.statusCode, 202, done.body); assert.equal(done.json().data.state, 'completed');
  const account = await h.api('GET', '/accounts/' + done.json().data.accountId); assert.equal(account.json().data.credential.rootExpiresAt, null); assert.equal(account.json().data.phoneMasked, '139****0001');
  assert.doesNotMatch(account.body, /v2_synthetic|synthetic-cookie|13900000001/);
  assert.equal(h.fake.loginCalls, 1);
});
test('idempotency coalesces concurrent SMS; body changes conflict; cooldown survives new keys', async t => {
  const h = await harness(t), key = randomUUID();
  const created = await h.api('POST', '/login-flows', { phone: '13900000001', countryCode: '+86' }, key); const fid = created.json().data.id;
  assert.equal((await h.api('POST', '/login-flows', { phone: '13900000002', countryCode: '+86' }, key)).statusCode, 409);
  const smsKey = randomUUID(); const [a, b] = await Promise.all([h.api('POST', `/login-flows/${fid}/send-sms`, undefined, smsKey), h.api('POST', `/login-flows/${fid}/send-sms`, undefined, smsKey)]); assert.equal(a.statusCode, 200, a.body); assert.equal(b.statusCode, 200); assert.equal(h.fake.smsCalls, 1);
  assert.equal((await h.api('POST', `/login-flows/${fid}/send-sms`)).statusCode, 429);
});
test('account A/B encryption and runs are isolated; success is reconciled and not repeated', async t => {
  const h = await harness(t), a = await h.bind(), b = await h.bind('13900000002');
  const body = { communityIds: [2], taskKinds: ['community_sign'] };
  const ra = await h.api('POST', `/accounts/${a.id}/runs`, body), rb = await h.api('POST', `/accounts/${b.id}/runs`, body); assert.equal(ra.statusCode, 202, ra.body); assert.equal(rb.statusCode, 202, rb.body);
  await h.worker.tick();
  const ar = (await h.api('GET', '/runs/' + ra.json().data.id)).json().data, br = (await h.api('GET', '/runs/' + rb.json().data.id)).json().data;
  assert.equal(ar.state, 'succeeded'); assert.equal(br.state, 'succeeded'); assert.equal(ar.confirmedRewardPoints, 30); assert.deepEqual(new Set(h.fake.signCalls), new Set([a.uid, b.uid]));
  const duplicate = await h.api('POST', `/accounts/${a.id}/runs`, body); assert.equal(duplicate.json().data.id, ar.id); await h.worker.tick(); assert.equal(h.fake.signCalls.length, 2);
  const storageText = JSON.stringify(h.store.db.prepare('SELECT * FROM accounts').all()); assert.doesNotMatch(storageText, /v2_synthetic|synthetic-cookie|13900000001|13900000002/);
  const rowA = h.accounts.row(a.id), rowB = h.accounts.row(b.id); assert.throws(() => h.store.vault.open(rowA.private_json, `account:${b.id}:${rowB.credential_version}`));
  const missions = await h.api('GET', `/accounts/${a.id}/missions`); assert.equal(missions.json().data.totalPoints, 1030);
  assert.equal((await h.api('GET', '/dashboard')).json().data.todayConfirmedRewardPoints, 60);
  assert.equal((await h.api('GET', `/runs/${ar.id}/events?limit=1`)).json().data.items.length, 1);
});
test('unknown write result never retries blindly, even on explicit retry', async t => {
  const h = await harness(t), a = await h.bind(); h.fake.unknownWrite = true;
  const run = await h.api('POST', `/accounts/${a.id}/runs`, { communityIds: [2], taskKinds: ['community_sign'] }); await h.worker.tick();
  const first = h.worker.run(run.json().data.id); assert.equal(first.state, 'outcome_unknown'); assert.equal(h.fake.signCalls.length, 1);
  const retry = await h.api('POST', `/runs/${first.id}/retry`); assert.equal(retry.statusCode, 202, retry.body); await h.worker.tick(); assert.equal(h.worker.run(retry.json().data.id).state, 'outcome_unknown'); assert.equal(h.fake.signCalls.length, 1);
});
test('sign verification suspends only its account and resumes after synthetic human proof', async t => {
  const h = await harness(t), a = await h.bind(); h.fake.signCaptcha = true;
  const run = await h.api('POST', `/accounts/${a.id}/runs`, { communityIds: [2], taskKinds: ['community_sign'] }); await h.worker.tick();
  const waiting = h.worker.run(run.json().data.id); assert.equal(waiting.state, 'awaiting_verification');
  const challenge = await h.api('POST', `/challenges/${waiting.challengeId}/submit`, { version: 'gt4', result: { lot_number: 'synthetic-lot', captcha_output: 'synthetic-output', pass_token: 'synthetic-proof', gen_time: '1' } }); assert.equal(challenge.statusCode, 200, challenge.body);
  assert.equal(h.worker.run(waiting.id).state, 'succeeded');
});
test('credential updates, versions, preferences, schedules and cancellation follow the contract', async t => {
  const h = await harness(t), a = await h.bind();
  const op = await h.api('POST', `/accounts/${a.id}/credential-operations`, { kind: 'refresh_cookie' }); assert.equal(op.statusCode, 202, op.body); await h.worker.tick(); assert.equal((await h.api('GET', '/credential-operations/' + op.json().data.id)).json().data.state, 'succeeded');
  const view = h.accounts.get(a.id); assert.equal((await h.api('PATCH', `/accounts/${a.id}`, { version: view.version - 1, remark: 'conflict' })).statusCode, 409);
  assert.equal((await h.api('PATCH', `/accounts/${a.id}`, { version: view.version, taskKinds: ['like_posts'] })).statusCode, 422);
  assert.equal((await h.api('PATCH', `/accounts/${a.id}`, { version: view.version, remark: 'demo' })).statusCode, 200);
  const schedule = await h.api('GET', `/accounts/${a.id}/schedule`); assert.equal(schedule.json().data.enabled, false);
  const updated = await h.api('PATCH', `/accounts/${a.id}/schedule`, { version: 1, enabled: true, hour: 6, minute: 30 }); assert.equal(updated.statusCode, 200, updated.body);
  const r = await h.api('POST', `/accounts/${a.id}/runs`, { communityIds: [2], taskKinds: ['community_sign'] }); const canceled = await h.api('POST', '/runs/' + r.json().data.id + '/cancel'); assert.equal(canceled.json().data.state, 'canceled');
  assert.equal((await h.api('POST', `/accounts/${a.id}/missions/refresh`)).statusCode, 200);
  const settings = await h.api('PATCH', '/settings/system', { version: 1, pauseScheduler: true }); assert.equal(settings.statusCode, 200); assert.equal((await h.api('GET', `/accounts/${a.id}/schedule`)).json().data.nextRunAt, null);
  assert.equal((await h.api('GET', '/capabilities')).json().data.rootCredentialRenewal, false);
  assert.equal((await h.api('DELETE', '/accounts/' + a.id)).statusCode, 200);
  assert.equal((await h.api('GET', '/accounts/' + a.id)).statusCode, 404);
});
test('SMTP secret is write-only; explicit test uses saved config and notification event deduplication', async t => {
  const h = await harness(t);
  assert.equal((await h.api('POST', '/notifications/tests')).statusCode, 409);
  const settings = await h.api('PATCH', '/settings/notifications', { version: 1, enabled: true, smtpHost: 'smtp.example.invalid', smtpPort: 465, smtpSecurity: 'ssl', smtpUsername: 'demo@example.invalid', smtpPassword: 'synthetic-smtp-password', fromAddress: 'demo@example.invalid', toAddress: 'owner@example.invalid' }); assert.equal(settings.statusCode, 200, settings.body); assert.doesNotMatch(settings.body, /synthetic-smtp-password/);
  const keep = await h.api('PATCH', '/settings/notifications', { version: 2, smtpPassword: null, policy: 'every_run' }); assert.equal(keep.json().data.smtpPasswordConfigured, true);
  const mail = await h.api('POST', '/notifications/tests'); assert.equal(mail.statusCode, 202, mail.body); await h.worker.tick(); const done = await h.api('GET', '/notifications/tests/' + mail.json().data.id); assert.equal(done.json().data.state, 'succeeded'); assert.equal(h.sentMail.length, 1);
  h.notifications.queue('one-event', 'subject', 'message'); h.notifications.queue('one-event', 'subject', 'message'); await h.worker.tick(); assert.equal(h.sentMail.length, 2);
});
test('durable data survives restart, root key mismatch fails closed, unresolved jobs reconcile', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'miyoushe-backend-test-')); let second: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => { await second?.app.close(); const target = resolve(dir); assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('miyoushe-backend-test-')); rmSync(target, { recursive: true, force: true }); }); const cfg = config(join(dir, 'app.sqlite'));
  const fake = new FakeUpstream(), first = await buildApp(cfg, { upstream: fake, startWorker: false });
  const c = await fake.exchange(await fake.login('13900000001', '012345')); const a = first.accounts.bind('13900000001', { id: randomUUID() }, c);
  const run = first.worker.create(a.id, { communityIds: [2], taskKinds: ['community_sign'] }); run.state = 'running'; run.steps[0]!.state = 'running'; first.store.put('run', run.id, run); await first.app.close();
  assert.doesNotMatch(readFileSync(cfg.databasePath).toString(), /synthetic-cookie|v2_synthetic/);
  await assert.rejects(buildApp({ ...cfg, key: randomBytes(32) }, { startWorker: false }), /key/);
  second = await buildApp(cfg, { upstream: fake, startWorker: false }); assert.equal(second.accounts.get(a.id).uid, a.uid); await second.worker.tick(); assert.equal(second.worker.run(run.id).state, 'outcome_unknown'); assert.equal(fake.signCalls.length, 0);
});
test('Shanghai day boundaries and schedule generation are independent of host timezone', () => {
  assert.equal(day(Date.parse('2026-10-23T16:00:00Z')), '2026-10-24');
  assert.equal(nextSchedule(6, 0, Date.parse('2026-10-23T23:00:00+08:00')), '2026-10-23T22:00:00.000Z');
});
test('production adapter detects aigis, restricts identity, and does not follow redirects or leak raw messages', async () => {
  let seen: RequestInit | undefined;
  const transport = (async (_url: string | URL | Request, init?: RequestInit) => { seen = init; return new Response(JSON.stringify({ retcode: -3101, message: 'sensitive-upstream-text', data: null }), { headers: { 'x-rpc-aigis': JSON.stringify({ session_id: 'synthetic-session', data: JSON.stringify({ gt: 'synthetic-captcha', use_v4: true, risk_type: 'slide', success: 1 }) }) } }); }) as typeof fetch;
  const u = new MihoyoUpstream(1000, transport);
  await assert.rejects(u.sendSms('13900000001', { id: randomUUID() }), NeedCaptcha); assert.equal(seen!.redirect, 'error'); assert.doesNotMatch(String(seen!.body), /13900000001/);
});
test('root expiry stops automatic recovery; relogin identity mismatch cannot replace credentials', async t => {
  const h = await harness(t), a = await h.bind(); h.fake.expiredRoot = true;
  const op = await h.api('POST', `/accounts/${a.id}/credential-operations`, { kind: 'refresh_cookie' }); await h.worker.tick();
  assert.equal(h.worker.operation(op.json().data.id).state, 'failed'); assert.equal(h.accounts.get(a.id).status, 'reauth_required');
  assert.equal(h.accounts.get(a.id).credential.rootExpiresAt, null); const exchanges = h.fake.exchanges.length; await h.worker.tick(); assert.equal(h.fake.exchanges.length, exchanges);
  h.fake.expiredRoot = false;
  const created = await h.api('POST', '/login-flows', { phone: '13900000002', countryCode: '+86', targetAccountId: a.id }); const fid = created.json().data.id;
  await h.api('POST', `/login-flows/${fid}/send-sms`); const mismatch = await h.api('POST', `/login-flows/${fid}/submit-code`, { code: '012345' }); assert.equal(mismatch.statusCode, 409); assert.equal(mismatch.json().error.code, 'ACCOUNT_IDENTITY_MISMATCH'); assert.equal(h.accounts.private(a.id).credentials.aid, a.uid);
});
test('durable schedules do not run yesterday tasks early; overdue today schedule fires once', async t => {
  const h = await harness(t), a = await h.bind(); let now = Date.parse('2026-10-23T12:00:00Z'); t.mock.method(Date, 'now', () => now);
  h.store.put('schedule', a.id, { accountId: a.id, enabled: true, hour: 21, minute: 0, timezone: 'Asia/Shanghai', jitterMaxMinutes: 10, nextRunAt: '2026-10-22T13:00:00Z', version: 2 });
  await h.worker.tick(); assert.equal(h.fake.signCalls.length, 0);
  assert.equal(day(Date.parse(h.store.get<Api['Schedule']>('schedule', a.id)!.nextRunAt!)), '2026-10-23');
  now = Date.parse('2026-10-23T13:20:00Z'); await h.worker.tick(); assert.equal(h.fake.signCalls.length, 1); now += 60000; await h.worker.tick(); assert.equal(h.fake.signCalls.length, 1);
  assert.equal(h.store.all<Api['Run']>('run')[0]!.source, 'scheduled');
});
test('flow cancellation and expiry, snapshot GET purity, list pagination and saved config queries', async t => {
  const h = await harness(t), a = await h.bind(); const before = h.fake.reads.length;
  const snapshot = await h.api('GET', `/accounts/${a.id}/missions`); assert.equal(snapshot.json().data.fetchedAt, null); assert.equal(h.fake.reads.length, before);
  const list = await h.api('GET', '/accounts?limit=1&enabled=true'); assert.equal(list.statusCode, 200, list.body); assert.equal(list.json().data.items[0].id, a.id);
  const f = await h.api('POST', '/login-flows', { phone: '13900000001', countryCode: '+86' }); const fid = f.json().data.id;
  assert.equal((await h.api('DELETE', '/login-flows/' + fid)).json().data.state, 'canceled'); assert.equal((await h.api('POST', `/login-flows/${fid}/send-sms`)).statusCode, 409);
  assert.equal((await h.api('GET', '/runs?limit=1')).statusCode, 200); assert.equal((await h.api('GET', '/settings/system')).statusCode, 200); assert.equal((await h.api('GET', '/settings/notifications')).statusCode, 200);
  const expired = await h.api('POST', '/login-flows', { phone: '13900000002', countryCode: '+86' }); const advance = Date.now() + 660000; t.mock.method(Date, 'now', () => advance); assert.equal((await h.api('GET', '/login-flows/' + expired.json().data.id)).statusCode, 410);
});
test('online backup is consistent and second backend is refused while the first owns the database', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'miyoushe-backend-test-')), cfg = config(join(dir, 'main.sqlite'));
  const h = await buildApp(cfg, { upstream: new FakeUpstream(), startWorker: false });
  t.after(async () => { await h.app.close(); const target = resolve(dir); assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('miyoushe-backend-test-')); rmSync(target, { recursive: true, force: true }); });
  await assert.rejects(buildApp(cfg, { startWorker: false }), /Another backend/);
  const backupPath = join(dir, 'snapshot.sqlite'); await h.store.backup(backupPath);
  const db = new DatabaseSync(backupPath, { readOnly: true }); try { assert.equal((db.prepare('SELECT count(*) AS n FROM schema_migrations').get() as { n: number }).n, 1); } finally { db.close(); }
});
class FakeGames implements GameUpstream {
  calls: string[] = []; reads: string[] = []; signed = new Set<string>(); unknown = false; captcha = false; failUid = ''; roles: BoundRole[] = [
    { gameBiz: 'hk4e_cn', uid: '100000011', region: 'cn_gf01', regionName: '天空岛', nickname: '测试角色一', level: 60 },
    { gameBiz: 'hk4e_cn', uid: '100000012', region: 'cn_gf01', regionName: '天空岛', nickname: '测试角色二', level: 50 },
    { gameBiz: 'hkrpg_cn', uid: '100000013', region: 'prod_gf_cn', regionName: '星穹列车', nickname: '测试角色三', level: 70 }
  ];
  async gameRoles(c: Credentials) { this.reads.push(c.aid); return this.roles; }
  async gameInfo(c: Credentials, _d: Device, r: BoundRole): Promise<GameInfo> { this.reads.push(c.aid); return { signed: this.signed.has(c.aid + ':' + roleId(r)), totalSignDays: this.signed.has(c.aid + ':' + roleId(r)) ? 5 : 4, firstBind: false, reward: { name: '游戏材料', count: 3, icon: null } }; }
  async gameSign(c: Credentials, _d: Device, r: BoundRole, proof?: string) {
    this.calls.push(c.aid + ':' + roleId(r));
    if (this.captcha && proof !== 'game-verified') throw new NeedCaptcha({ version: 'gt3', config: { captchaId: 'synthetic-game-gt', challenge: 'synthetic-game-challenge', newCaptcha: true, offline: false, product: 'bind', language: 'zho', riskType: null, userInfo: null }, verify: async () => 'game-verified' });
    if (this.unknown) throw new Fault(502, 'UPSTREAM_OUTCOME_UNKNOWN', '模拟游戏签到写入超时');
    if (r.uid === this.failUid) throw new Fault(502, 'UPSTREAM_ERROR', '模拟单角色失败');
    this.signed.add(c.aid + ':' + roleId(r)); return { retcode: 0 };
  }
}
async function gameHarness(t: test.TestContext) { const games = new FakeGames(), h = await harness(t, new FakeUpstream(), config(), games), a = await h.bind(); const patched = await h.api('PATCH', `/accounts/${a.id}`, { version: a.version, taskKinds: ['community_sign', 'game_sign'] }); assert.equal(patched.statusCode, 200, patched.body); return { ...h, gamesFake: games, a }; }

test('game roles cache GET is pure; same-game roles sign independently despite completed MiYouBi; rewards stay separate', async t => {
  const h = await gameHarness(t); h.fake.signedAccounts.add(h.a.uid);
  assert.deepEqual((await h.api('GET', `/accounts/${h.a.id}/game-roles`)).json().data.roles, []); assert.equal(h.gamesFake.reads.length, 0);
  const roles = await h.api('POST', `/accounts/${h.a.id}/game-roles/refresh`); assert.equal(roles.statusCode, 200, roles.body); assert.equal(roles.json().data.roles.length, 3);
  const create = await h.api('POST', `/accounts/${h.a.id}/runs`, { communityIds: [2], taskKinds: ['community_sign', 'game_sign'] }); assert.equal(create.statusCode, 202, create.body);
  await h.worker.tick(); const run = (await h.api('GET', '/runs/' + create.json().data.id)).json().data;
  assert.equal(run.state, 'succeeded'); assert.equal(run.steps.length, 4); assert.equal(run.confirmedRewardPoints, 0); assert.equal(h.fake.signCalls.length, 0); assert.equal(h.gamesFake.calls.length, 3);
  assert.equal(run.steps.filter((s: Api['RunStep']) => s.taskKind === 'game_sign' && s.rewards?.[0]?.count === 3).length, 3);
  assert.equal((h.store.db.prepare("SELECT count(*) AS n FROM daily_claims WHERE task_kind LIKE 'game_sign:%'").get() as any).n, 3);
  await h.api('POST', `/accounts/${h.a.id}/runs`, { communityIds: [], taskKinds: ['game_sign'] }); await h.worker.tick(); assert.equal(h.gamesFake.calls.length, 3);
});

test('game-only schedules do not depend on community APIs; role selection and account ownership are enforced', async t => {
  const h = await gameHarness(t), b = await h.bind('13900000002'); h.fake.verifyFails = true;
  const a = h.accounts.get(h.a.id); h.accounts.patch(a.id, { version: a.version, taskKinds: ['game_sign'], communityIds: [], gameRoleIds: [roleId(h.gamesFake.roles[1]!)] });
  h.store.put('schedule', a.id, { ...h.accounts.schedule(a.id), enabled: true, nextRunAt: iso(Date.now() - 1200000) });
  await h.worker.tick(); const r = h.store.all<Api['Run']>('run').find(x => x.accountId === a.id)!; assert.equal(r.state, 'succeeded'); assert.equal(r.steps.length, 1); assert.equal(r.source, 'scheduled'); assert.equal(h.gamesFake.calls[0], a.uid + ':' + roleId(h.gamesFake.roles[1]!));
  assert.ok(!h.gamesFake.reads.includes(b.uid)); assert.equal(h.fake.signCalls.length, 0);
  const invalid = await h.api('POST', `/accounts/${a.id}/runs`, { communityIds: [], taskKinds: ['game_sign'], gameRoleIds: ['game_not_owned'] }); await h.worker.tick(); assert.equal(h.worker.run(invalid.json().data.id).state, 'failed'); assert.equal(h.gamesFake.calls.length, 1);
});

test('unknown game writes are reconciled without replay; manual game captcha resumes only its role', async t => {
  const h = await gameHarness(t), selected = [roleId(h.gamesFake.roles[0]!)]; h.gamesFake.unknown = true;
  const input = { communityIds: [], taskKinds: ['game_sign'], gameRoleIds: selected };
  const response = await h.api('POST', `/accounts/${h.a.id}/runs`, input); await h.worker.tick(); const failed = h.worker.run(response.json().data.id); assert.equal(failed.state, 'outcome_unknown');
  const retry = await h.api('POST', '/runs/' + failed.id + '/retry'); await h.worker.tick(); assert.equal(h.worker.run(retry.json().data.id).state, 'outcome_unknown'); assert.equal(h.gamesFake.calls.length, 1);
  h.gamesFake.unknown = false; h.gamesFake.captcha = true;
  const second = await h.api('POST', `/accounts/${h.a.id}/runs`, { ...input, gameRoleIds: [roleId(h.gamesFake.roles[1]!)] }); await h.worker.tick(); const pending = h.worker.run(second.json().data.id); assert.equal(pending.state, 'awaiting_verification'); assert.equal(pending.confirmedRewardPoints, 0);
  const challenge = (await h.api('GET', '/challenges/' + pending.challengeId)).json().data; assert.equal(challenge.purpose, 'game_sign');
  const result = await h.api('POST', '/challenges/' + challenge.id + '/submit', { version: 'gt3', result: { geetest_challenge: 'synthetic-game-challenge', geetest_validate: 'synthetic-proof', geetest_seccode: 'synthetic-proof|jordan' } }); assert.equal(result.statusCode, 200, result.body);
  const done = h.worker.run(pending.id); assert.equal(done.state, 'succeeded'); assert.equal(done.steps[0]!.rewards?.[0]?.name, '游戏材料'); assert.equal(h.gamesFake.calls.length, 3);
});

test('game adapter does not mistake retcode 0 captcha for success and uses per-game official routes', async t => {
  const calls: { url: string; options: RequestInit }[] = []; let signed = false;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => { calls.push({ url: String(url), options }); return new Response(JSON.stringify({ retcode: 0, data: { success: signed ? 0 : 1, gt: 'synthetic-gt', challenge: 'synthetic-challenge' } }), { status: 200 }); });
  const client = new MihoyoGames(1000), credentials: Credentials = { aid: '100000001', mid: 'synthetic-mid', stoken: 'synthetic-st', ltoken: 'synthetic-lt', cookieToken: 'synthetic-cookie', cookieExpiresAt: null }, role: BoundRole = { gameBiz: 'nap_cn', uid: '100000011', region: 'prod_gf_cn', regionName: '新艾利都', nickname: '测试', level: 60 };
  await assert.rejects(client.gameSign(credentials, { id: 'synthetic-device' }, role), NeedCaptcha); assert.equal(calls.length, 1); assert.equal(calls[0]!.url, 'https://act-nap-api.mihoyo.com/event/luna/zzz/sign');
  assert.equal((calls[0]!.options.headers as any)['x-rpc-signgame'], 'zzz'); assert.deepEqual(JSON.parse(calls[0]!.options.body as string), { act_id: 'e202406242138391', region: role.region, uid: role.uid });
  signed = true; await client.gameSign(credentials, { id: 'synthetic-device' }, role, JSON.stringify({ geetest_challenge: 'synthetic-challenge', geetest_validate: 'synthetic-proof', geetest_seccode: 'synthetic-proof|jordan' })); assert.equal((calls[1]!.options.headers as any)['x-rpc-validate'], 'synthetic-proof');
});

test('cancel during role discovery prevents writes; cross-midnight game writes stay unconfirmed', async t => {
  const h = await gameHarness(t); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; });
  const list = h.gamesFake.gameRoles.bind(h.gamesFake);
  h.gamesFake.gameRoles = async c => { entered(); await held; return list(c); };
  const response = await h.api('POST', `/accounts/${h.a.id}/runs`, { communityIds: [], taskKinds: ['game_sign'] });
  const ticking = h.worker.tick(); await started; await h.api('POST', '/runs/' + response.json().data.id + '/cancel'); release(); await ticking;
  assert.equal(h.worker.run(response.json().data.id).state, 'canceled'); assert.equal(h.gamesFake.calls.length, 0);
  let now = Date.parse('2026-10-26T15:59:59.500Z'); t.mock.method(Date, 'now', () => now);
  const sign = h.gamesFake.gameSign.bind(h.gamesFake);
  h.gamesFake.gameSign = async (...args) => { const result = await sign(...args); now += 1000; return result; };
  const second = await h.api('POST', `/accounts/${h.a.id}/runs`, { communityIds: [], taskKinds: ['game_sign'], gameRoleIds: [roleId(h.gamesFake.roles[0]!)] });
  await h.worker.tick(); const r = h.worker.run(second.json().data.id);
  assert.equal(r.state, 'outcome_unknown'); assert.deepEqual(r.steps[0]!.rewards, []); assert.equal(h.games.snapshot(h.a.id).stale, true); assert.equal(h.gamesFake.calls.length, 1);
});

test('all 40 contract operations have been exercised with schema-valid HTTP responses', () => {
  const expected = Object.values(spec.paths).flatMap((m: any) => Object.values(m).map((o: any) => o.operationId));
  assert.deepEqual(expected.filter((id: string) => !observedOperations.has(id)), []);
});
test('cancel during an in-flight write preserves both the cancellation and confirmed reward', async t => {
  const h = await harness(t), a = await h.bind();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; });
  const original = h.fake.sign.bind(h.fake);
  h.fake.sign = async (...args) => { entered(); await held; return original(...args); };
  const response = await h.api('POST', `/accounts/${a.id}/runs`, { communityIds: [2], taskKinds: ['community_sign'] });
  const running = h.worker.tick(); await started;
  const canceled = await h.api('POST', '/runs/' + response.json().data.id + '/cancel'); assert.ok(canceled.json().data.cancelRequestedAt);
  release(); await running;
  const result = h.worker.run(response.json().data.id); assert.equal(result.state, 'canceled'); assert.equal(result.confirmedRewardPoints, 30); assert.ok(result.cancelRequestedAt); assert.equal(h.fake.signCalls.length, 1);
});
