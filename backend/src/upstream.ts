import { constants, createHash, publicEncrypt, randomInt, randomUUID } from 'node:crypto';
import { Fault, iso } from './core.js';
import type { Api, Credentials, Device } from './core.js';

export type CaptchaSpec = { version: 'gt3' | 'gt4'; config: Api['CaptchaConfig']; verify: (result: Api['ChallengeSubmission']) => Promise<string> };
export class NeedCaptcha extends Error { constructor(public spec: CaptchaSpec) { super('Manual verification required'); } }
export type LoginToken = { aid: string; mid: string; stoken: string };
export type MissionState = { total: number; received: number; canGet: number; states: { mission_id: number; mission_key: string; happened_times: number; process: number; is_get_award: boolean }[] };
export interface Upstream {
  sendSms(phone: string, device: Device, proof?: string): Promise<{ actionType: string; countdown: number }>;
  login(phone: string, code: string, actionType: string, device: Device, proof?: string): Promise<LoginToken>;
  exchange(token: LoginToken, device: Device, proof?: string): Promise<Credentials>;
  missions(credentials: Credentials, device: Device): Promise<MissionState>;
  sign(credentials: Credentials, device: Device, community: number, proof?: string): Promise<{ retcode: number; points: number }>;
}
const PASSPORT = 'https://passport-api.mihoyo.com';
const BBS = 'https://bbs-api.miyoushe.com';
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDDvekdPMHN3AYhm/vktJT+YJr7cI5DcsNKqdsx5DZX0gDuWFuIjzdwButrIYPNmRJ1G8ybDIF7oDW2eEpm5sMbL9zs
9ExXCdvqrn51qELbqj0XxtMTIpaCHFSI50PfPpTFV9Xt/hmyVwokoOXFlAEgCn+Q
CgGs52bFoYMtyi+xEQIDAQAB
-----END PUBLIC KEY-----`;
const record = (x: unknown): Record<string, unknown> => { if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Fault(502, 'UPSTREAM_ERROR', '官方接口响应格式发生变化'); return x as Record<string, unknown>; };
const text = (x: unknown): string => { if (typeof x !== 'string' || x.length > 32768) throw new Fault(502, 'UPSTREAM_ERROR', '官方接口响应字段无效'); return x; };
const numeric = (x: unknown): number => { if (typeof x !== 'number' || !Number.isFinite(x)) throw new Fault(502, 'UPSTREAM_ERROR', '官方接口响应字段无效'); return x; };
const encrypted = (s: string) => publicEncrypt({ key: PUBLIC_KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(s)).toString('base64');
const stCookie = (c: LoginToken) => `stuid=${c.aid}; stoken=${c.stoken}; mid=${c.mid}`;
const workingCookie = (c: Credentials) => `account_id=${c.aid}; cookie_token=${c.cookieToken}`;
function headers(device: Device): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-rpc-app_version': '2.116.0', 'x-rpc-client_type': '2', 'x-rpc-app_id': 'bll8iq97cem8', 'x-rpc-device_id': device.id,
    'x-rpc-device_name': 'Self-hosted WebUI', 'x-rpc-device_model': 'Windows', 'User-Agent': 'Mozilla/5.0 miHoYoBBS/2.116.0', Referer: 'https://user.miyoushe.com/', 'x-rpc-game_biz': 'bbs_cn', ...(device.fp ? { 'x-rpc-device_fp': device.fp } : {}) };
}
function upstreamError(code: number): never {
  if (code === -100) throw new Fault(409, 'ACCOUNT_REAUTH_REQUIRED', '登录凭据已失效，请重新登录', false, { upstreamRetcode: code });
  if (code === -3102) throw new Fault(422, 'CHALLENGE_FAILED', '人工验证未通过，请更新会话后重试', false, { upstreamRetcode: code });
  if ([-3202, -3207].includes(code)) throw new Fault(422, 'SMS_CODE_INVALID', '验证码无效或已过期', false, { upstreamRetcode: code });
  if (code === -3101) throw new Fault(429, 'RATE_LIMITED', '官方要求稍后重试', true, { upstreamRetcode: code, retryAfterSeconds: 60 });
  throw new Fault(502, 'UPSTREAM_ERROR', code === -5300 ? '官方要求重新登录或更新接口适配' : '官方暂时无法完成此操作', false, { upstreamRetcode: code });
}
export class MihoyoUpstream implements Upstream {
  constructor(private timeoutMs = 15000, private transport: typeof fetch = fetch) {}
  protected async call(url: string, method: 'GET' | 'POST', h: Record<string, string>, body?: unknown) {
    let response: Response;
    try { response = await this.transport(url, { method, headers: h, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' }); }
    catch { throw new Fault(method === 'POST' ? 502 : 504, method === 'POST' ? 'UPSTREAM_OUTCOME_UNKNOWN' : 'UPSTREAM_TIMEOUT', method === 'POST' ? '请求结果无法确认，请先检查状态，勿重复提交' : '官方查询超时，请稍后重试', method === 'GET'); }
    let json: Record<string, unknown>;
    try { json = record(await response.json()); } catch { throw new Fault(502, method === 'POST' ? 'UPSTREAM_OUTCOME_UNKNOWN' : 'UPSTREAM_ERROR', '官方响应无法确认，请稍后检查状态'); }
    const aigis = response.headers.get('x-rpc-aigis');
    if (aigis) {
      try {
        const challenge = record(JSON.parse(aigis)), data = record(JSON.parse(text(challenge.data))), session = text(challenge.session_id);
        const version = data.use_v4 === true ? 'gt4' : 'gt3';
        throw new NeedCaptcha({ version, config: { captchaId: text(data.gt), challenge: typeof data.challenge === 'string' ? data.challenge : null, newCaptcha: data.new_captcha === undefined ? null : Boolean(data.new_captcha), offline: data.success === 0, product: 'bind', language: 'zho', riskType: typeof data.risk_type === 'string' ? data.risk_type : null, userInfo: JSON.stringify({ session_id: session }) },
          verify: async result => session + ';' + Buffer.from(JSON.stringify(result.result)).toString('base64') });
      } catch (e) { if (e instanceof NeedCaptcha) throw e; throw new Fault(502, 'UPSTREAM_ERROR', '官方验证配置无法解析'); }
    }
    if (!response.ok) throw new Fault(502, method === 'POST' ? 'UPSTREAM_OUTCOME_UNKNOWN' : 'UPSTREAM_ERROR', '官方服务暂时不可用');
    return { json, response };
  }
  protected ok(json: Record<string, unknown>) { const code = numeric(json.retcode); if (code !== 0) upstreamError(code); return record(json.data); }
  async sendSms(phone: string, device: Device, proof?: string) {
    const { json } = await this.call(PASSPORT + '/account/ma-cn-verifier/verifier/createLoginCaptcha', 'POST', { ...headers(device), ...(proof ? { 'x-rpc-aigis': proof } : {}) }, { area_code: encrypted('+86'), mobile: encrypted(phone) });
    const data = this.ok(json); return { actionType: text(data.action_type), countdown: Math.max(60, numeric(data.countdown)) };
  }
  async login(phone: string, code: string, actionType: string, device: Device, proof?: string) {
    const { json } = await this.call(PASSPORT + '/account/ma-cn-passport/app/loginByMobileCaptcha', 'POST', { ...headers(device), ...(proof ? { 'x-rpc-aigis': proof } : {}) }, { area_code: encrypted('+86'), mobile: encrypted(phone), captcha: code, action_type: actionType });
    const data = this.ok(json), user = record(data.user_info), token = record(data.token);
    if (data.need_realperson || (data.realname_info && record(data.realname_info).required) || (data.reactivate_info && record(data.reactivate_info).required)) throw new Fault(422, 'CAPABILITY_UNAVAILABLE', '此账号需要先在官方页面完成额外验证');
    return { aid: text(user.aid), mid: text(user.mid), stoken: text(token.token) };
  }
  async exchange(token: LoginToken, device: Device, proof?: string): Promise<Credentials> {
    const h = { ...headers(device), Cookie: stCookie(token), ...(proof ? { 'x-rpc-aigis': proof } : {}) };
    const l = await this.call(PASSPORT + '/account/auth/api/getLTokenBySToken', 'GET', h);
    const ltoken = text(this.ok(l.json).ltoken);
    const c = await this.call(PASSPORT + '/account/auth/api/getCookieAccountInfoBySToken', 'GET', h);
    const data = this.ok(c.json);
    if (text(data.uid) !== token.aid) throw new Fault(502, 'ACCOUNT_IDENTITY_MISMATCH', '官方返回的凭据账号不一致');
    const raw = c.response.headers.getSetCookie().find(s => s.startsWith('cookie_token='));
    const maxAge = raw?.match(/(?:^|;)\s*Max-Age=(\d+)/i)?.[1];
    return { ...token, ltoken, cookieToken: text(data.cookie_token), cookieExpiresAt: maxAge ? iso(Date.now() + Number(maxAge) * 1000) : null };
  }
  async missions(credentials: Credentials, device: Device): Promise<MissionState> {
    const { json } = await this.call(BBS + '/apihub/wapi/getUserMissionsState?point_sn=myb', 'GET', { ...headers(device), Cookie: workingCookie(credentials) });
    const data = this.ok(json);
    if (!Array.isArray(data.states)) throw new Fault(502, 'UPSTREAM_ERROR', '官方任务格式发生变化');
    return { total: numeric(data.total_points), received: numeric(data.already_received_points), canGet: numeric(data.can_get_points), states: data.states.map(x => { const s = record(x); if (typeof s.is_get_award !== 'boolean') throw new Fault(502, 'UPSTREAM_ERROR', '官方任务格式发生变化'); return { mission_id: numeric(s.mission_id), mission_key: text(s.mission_key), happened_times: numeric(s.happened_times), process: numeric(s.process), is_get_award: s.is_get_award }; }) };
  }
  private bbsHeaders(credentials: Credentials, device: Device, body?: string) {
    const t = Math.floor(Date.now() / 1000), r = body === undefined ? randomUUID().replaceAll('-', '').slice(0, 6) : randomInt(100001, 200001).toString();
    const signing = body === undefined ? `salt=47f15f1b66bee46b816115d8e8e6ebb6&t=${t}&r=${r}` : `salt=t0qEgfub6cvueAPgR5m9aQWWVciEer7v&t=${t}&r=${r}&b=${body}&q=`;
    const ds = `${t},${r},${createHash('md5').update(signing).digest('hex')}`;
    return { ...headers(device), Cookie: stCookie(credentials), DS: ds, 'x-rpc-verify_key': 'bll8iq97cem8', 'x-rpc-channel': 'miyousheluodi', 'x-rpc-csm_source': 'discussion', Referer: 'https://app.mihoyo.com', 'User-Agent': 'okhttp/4.9.3' };
  }
  async sign(credentials: Credentials, device: Device, community: number, proof?: string) {
    const body = JSON.stringify({ gids: community });
    const { json } = await this.call(BBS + '/apihub/app/api/signIn', 'POST', { ...this.bbsHeaders(credentials, device, body), ...(proof ? { 'x-rpc-challenge': proof } : {}) }, body);
    const code = numeric(json.retcode);
    if (code === 1034) {
      const created = await this.call(BBS + '/misc/api/createVerification?is_high=true', 'GET', this.bbsHeaders(credentials, device));
      const data = this.ok(created.json);
      throw new NeedCaptcha({ version: 'gt3', config: { captchaId: text(data.gt), challenge: text(data.challenge), newCaptcha: true, offline: data.success === 0, product: 'bind', language: 'zho', riskType: null, userInfo: null },
        verify: async submission => {
          if (submission.version !== 'gt3') throw new Fault(422, 'CHALLENGE_UNSUPPORTED', '验证类型不匹配');
          const result = await this.call(BBS + '/misc/api/verifyVerification', 'POST', this.bbsHeaders(credentials, device), submission.result);
          return text(this.ok(result.json).challenge);
        } });
    }
    if (code !== 0 && code !== 1008) upstreamError(code);
    return { retcode: code, points: code === 0 ? numeric(record(json.data).points) : 0 };
  }
}
export { record, text, numeric, workingCookie };
