import { Fault, fault, id, iso, maskPhone } from './core.js';
import type { Api, Device } from './core.js';
import { Accounts } from './accounts.js';
import { NeedCaptcha } from './upstream.js';
import type { CaptchaSpec, LoginToken, Upstream } from './upstream.js';

type ChallengeRecord = { view: Api['Challenge']; spec: CaptchaSpec; resume: (proof: string) => Promise<void>; active: () => boolean; onRenew: (challengeId: string, ready?: boolean) => void; onExpire: () => void; busy: boolean };
export class Challenges {
  private records = new Map<string, ChallengeRecord>();
  create(ownerType: Api['Challenge']['ownerType'], ownerId: string, purpose: Api['Challenge']['purpose'], spec: CaptchaSpec, resume: ChallengeRecord['resume'], active: ChallengeRecord['active'], onRenew: ChallengeRecord['onRenew'], onExpire: ChallengeRecord['onExpire'], maxExpiry = Date.now() + 300000) {
    const view: Api['Challenge'] = { id: id(), ownerType, ownerId, purpose, provider: 'geetest', version: spec.version, state: 'pending', expiresAt: iso(Math.min(Date.now() + 300000, maxExpiry)), config: spec.config };
    this.records.set(view.id, { view, spec, resume, active, onRenew, onExpire, busy: false }); return view;
  }
  private record(challengeId: string) { const r = this.records.get(challengeId); if (!r) throw new Fault(410, 'CHALLENGE_EXPIRED', '验证会话已失效，请重新开始'); return r; }
  get(challengeId: string) { const r = this.record(challengeId); if (Date.parse(r.view.expiresAt) <= Date.now()) { r.view.state = 'expired'; throw new Fault(410, 'CHALLENGE_EXPIRED', '验证会话已过期'); } return r.view; }
  async submit(challengeId: string, submission: Api['ChallengeSubmission']): Promise<Api['ChallengeReceipt']> {
    const r = this.record(challengeId); this.get(challengeId);
    if (r.view.state !== 'pending' || !r.active() || r.busy) throw new Fault(409, 'FLOW_STATE_CONFLICT', '验证会话已被处理，请刷新操作状态');
    if (r.view.version !== submission.version) throw new Fault(422, 'CHALLENGE_UNSUPPORTED', '验证版本不匹配');
    r.busy = true;
    try {
      const proof = await r.spec.verify(submission); await r.resume(proof); r.view.state = 'accepted';
      return { challengeId, accepted: true, ownerType: r.view.ownerType, ownerId: r.view.ownerId, nextAction: 'poll_owner', message: '验证结果已处理，请检查操作状态' };
    } catch (e) { r.view.state = 'failed'; r.onRenew(challengeId); throw e; }
    finally { r.busy = false; }
  }
  renew(challengeId: string) {
    const r = this.record(challengeId);
    if (!r.active() || r.busy || r.view.state === 'accepted') throw new Fault(409, 'FLOW_STATE_CONFLICT', '此操作不再等待验证');
    // A new local challenge must not silently send another SMS or extend an upstream session.
    if (Date.parse(r.view.expiresAt) <= Date.now()) throw new Fault(410, 'CHALLENGE_EXPIRED', '官方验证会话可能已过期，请重新开始原操作');
    r.view.state = 'expired';
    const next = this.create(r.view.ownerType, r.view.ownerId, r.view.purpose, r.spec, r.resume, r.active, r.onRenew, r.onExpire, Date.parse(r.view.expiresAt));
    r.onRenew(next.id, true); return next;
  }
  expire() {
    for (const [key, r] of this.records) if (Date.parse(r.view.expiresAt) <= Date.now() && !r.busy) {
      if (r.view.state === 'pending' && r.active()) r.onExpire();
      this.records.delete(key);
    }
  }
}
type FlowRecord = { view: Api['LoginFlow']; phone: string; device: Device; actionType?: string; code?: string; token?: LoginToken; checkpoint: 'sms' | 'login' | 'exchange'; busy: boolean; tries: number };
const terminal = new Set(['completed', 'failed', 'canceled', 'expired']);
export class Logins {
  private flows = new Map<string, FlowRecord>();
  constructor(private accounts: Accounts, private upstream: Upstream, readonly challenges: Challenges) {}
  create(input: Api['CreateFlowRequest']) {
    if (input.targetAccountId) this.accounts.requireIdle(input.targetAccountId);
    this.expire(); if (this.flows.size >= 100) throw new Fault(429, 'RATE_LIMITED', '登录流程过多，请关闭旧流程', true);
    const now = iso(), view: Api['LoginFlow'] = { id: id(), state: 'created', phoneMasked: maskPhone(input.phone), targetAccountId: input.targetAccountId ?? null, accountId: null, expiresAt: iso(Date.now() + 600000), resendAfter: null, nextAction: 'send_sms', challengeId: null, lastError: null, createdAt: now, updatedAt: now };
    this.flows.set(view.id, { view, phone: input.phone, device: { id: id() }, checkpoint: 'sms', busy: false, tries: 0 }); return view;
  }
  private record(flowId: string) { const r = this.flows.get(flowId); if (!r || Date.parse(r.view.expiresAt) <= Date.now()) throw new Fault(410, 'FLOW_EXPIRED', '登录流程已过期，请重新开始'); return r; }
  get(flowId: string) { return this.record(flowId).view; }
  cancel(flowId: string) { const r = this.record(flowId); if (r.view.state === 'completed') throw new Fault(409, 'FLOW_STATE_CONFLICT', '账号已绑定，不能取消'); r.view.state = 'canceled'; r.view.nextAction = 'none'; r.code = undefined; r.token = undefined; r.view.updatedAt = iso(); return r.view; }
  private ensureActive(r: FlowRecord) { if (terminal.has(r.view.state) || Date.parse(r.view.expiresAt) <= Date.now()) throw new Fault(410, 'FLOW_EXPIRED', '登录流程已结束'); }
  async send(flowId: string) {
    const r = this.record(flowId);
    if (!['created', 'awaiting_sms_code'].includes(r.view.state) || r.busy) throw new Fault(409, 'FLOW_STATE_CONFLICT', '当前不能发送短信');
    if (r.view.resendAfter && Date.parse(r.view.resendAfter) > Date.now()) throw new Fault(429, 'RATE_LIMITED', '请等待短信冷却结束', true, { retryAfterSeconds: Math.ceil((Date.parse(r.view.resendAfter) - Date.now()) / 1000) });
    this.accounts.store.limit('sms-hour:' + r.phone, 5, 3600000); this.accounts.store.limit('sms-minute:' + r.phone, 1, 60000);
    r.checkpoint = 'sms'; r.code = undefined; await this.process(r); return r.view;
  }
  async code(flowId: string, code: string) {
    const r = this.record(flowId);
    if (r.view.state !== 'awaiting_sms_code' || r.busy || !r.actionType) throw new Fault(409, 'FLOW_STATE_CONFLICT', '请先获取短信验证码');
    if (++r.tries > 5) { r.view.state = 'failed'; r.view.nextAction = 'restart'; throw new Fault(429, 'RATE_LIMITED', '尝试次数过多，请重新开始'); }
    r.code = code; r.checkpoint = 'login'; await this.process(r); return r.view;
  }
  private async process(r: FlowRecord, proof?: string) {
    this.ensureActive(r); if (r.busy) throw new Fault(409, 'FLOW_STATE_CONFLICT', '登录请求处理中'); r.busy = true;
    try {
      r.view.lastError = null;
      if (r.checkpoint === 'sms') {
        const sms = await this.upstream.sendSms(r.phone, r.device, proof); this.ensureActive(r);
        r.actionType = sms.actionType; r.view.resendAfter = iso(Date.now() + sms.countdown * 1000); r.view.state = 'awaiting_sms_code'; r.view.nextAction = 'submit_code'; r.view.challengeId = null; return;
      }
      if (r.checkpoint === 'login') {
        r.token = await this.upstream.login(r.phone, r.code!, r.actionType!, r.device, proof); this.ensureActive(r); r.code = undefined; r.checkpoint = 'exchange'; proof = undefined;
      }
      r.view.state = 'exchanging'; r.view.nextAction = 'poll';
      const credentials = await this.upstream.exchange(r.token!, r.device, proof); this.ensureActive(r);
      const state = await this.upstream.missions(credentials, r.device); this.ensureActive(r);
      const a = this.accounts.bind(r.phone, r.device, credentials, r.view.targetAccountId ?? undefined); this.accounts.cache(a.id, state);
      r.view.state = 'completed'; r.view.accountId = a.id; r.view.nextAction = 'none'; r.view.challengeId = null; r.token = undefined; r.phone = '';
    } catch (e) {
      if (e instanceof NeedCaptcha) {
        const c = this.challenges.create('login_flow', r.view.id, r.checkpoint === 'sms' ? 'send_sms' : r.checkpoint === 'login' ? 'login' : 'credential_refresh', e.spec,
          p => this.process(r, p), () => r.view.state === 'awaiting_captcha', (challengeId, ready) => { r.view.challengeId = challengeId; r.view.nextAction = ready ? 'solve_challenge' : 'renew_challenge'; }, () => { r.view.state = 'expired'; r.view.nextAction = 'restart'; r.code = undefined; r.token = undefined; }, Date.parse(r.view.expiresAt));
        r.view.state = 'awaiting_captcha'; r.view.challengeId = c.id; r.view.nextAction = 'solve_challenge'; return;
      }
      const f = fault(e); r.view.lastError = f.view();
      if (f.code === 'SMS_CODE_INVALID') { r.code = undefined; r.view.state = 'awaiting_sms_code'; r.view.nextAction = 'submit_code'; }
      else if (f.code === 'CHALLENGE_FAILED' && r.view.challengeId) { r.view.state = 'awaiting_captcha'; r.view.nextAction = 'renew_challenge'; }
      else if (f.code === 'RATE_LIMITED' && r.checkpoint === 'sms') { r.view.state = 'created'; r.view.nextAction = 'send_sms'; r.view.resendAfter = iso(Date.now() + (f.details?.retryAfterSeconds ?? 60) * 1000); }
      else { r.view.state = 'failed'; r.view.nextAction = 'restart'; r.code = undefined; r.token = undefined; }
      throw f;
    } finally { r.busy = false; r.view.updatedAt = iso(); }
  }
  expire() { for (const [key, r] of this.flows) if (Date.parse(r.view.expiresAt) < Date.now() && !r.busy) { r.code = undefined; r.token = undefined; this.flows.delete(key); } }
}
