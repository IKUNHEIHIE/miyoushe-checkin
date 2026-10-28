import { createHash, randomBytes } from 'node:crypto';
import { Fault, day, hash, iso } from './core.js';
import type { Api, Credentials, Device } from './core.js';
import type { Accounts } from './accounts.js';
import { MihoyoUpstream, NeedCaptcha, record, text, numeric, workingCookie } from './upstream.js';

export type BoundRole = { gameBiz: string; uid: string; region: string; regionName: string; nickname: string; level: number };
export type GameInfo = { signed: boolean; totalSignDays: number; firstBind: boolean; reward: Api['GameReward'] | null };
export type GameProfile = { gameBiz: string; name: string; communityId: number; actId: string; api: string; signgame?: string };
export const gameProfiles: GameProfile[] = [
  { gameBiz: 'hk4e_cn', name: '原神', communityId: 2, actId: 'e202311201442471', api: 'https://api-takumi.mihoyo.com/event/luna', signgame: 'hk4e' },
  { gameBiz: 'hkrpg_cn', name: '崩坏：星穹铁道', communityId: 6, actId: 'e202304121516551', api: 'https://api-takumi.mihoyo.com/event/luna' },
  { gameBiz: 'nap_cn', name: '绝区零', communityId: 8, actId: 'e202406242138391', api: 'https://act-nap-api.mihoyo.com/event/luna/zzz', signgame: 'zzz' },
  { gameBiz: 'bh3_cn', name: '崩坏3', communityId: 1, actId: 'e202306201626331', api: 'https://api-takumi.mihoyo.com/event/luna' },
  { gameBiz: 'bh2_cn', name: '崩坏学园2', communityId: 3, actId: 'e202203291431091', api: 'https://api-takumi.mihoyo.com/event/luna' },
  { gameBiz: 'nxx_cn', name: '未定事件簿', communityId: 4, actId: 'e202202251749321', api: 'https://api-takumi.mihoyo.com/event/luna' }
];
export const profileFor = (biz: string) => gameProfiles.find(g => g.gameBiz === biz || (biz.endsWith('_bilibili') && g.gameBiz === biz.replace(/_bilibili$/, '_cn')));
export const roleId = (r: BoundRole) => 'game_' + hash(`${r.gameBiz}:${r.region}:${r.uid}`).slice(0, 24);
export interface GameUpstream {
  gameRoles(c: Credentials, d: Device): Promise<BoundRole[]>;
  gameInfo(c: Credentials, d: Device, r: BoundRole): Promise<GameInfo>;
  gameSign(c: Credentials, d: Device, r: BoundRole, proof?: string): Promise<{ retcode: number }>;
}
export class MihoyoGames extends MihoyoUpstream implements GameUpstream {
  private gameHeaders(c: Credentials, d: Device, game?: GameProfile): Record<string, string> {
    const t = Math.floor(Date.now() / 1000), r = randomBytes(6).toString('hex').slice(0, 6);
    const ds = `${t},${r},${createHash('md5').update(`salt=d9200c846b10886e8c874fc33c8f308b&t=${t}&r=${r}`).digest('hex')}`;
    return { 'Content-Type': 'application/json', Cookie: workingCookie(c), DS: ds, 'x-rpc-app_version': '2.116.0', 'x-rpc-client_type': '5', 'x-rpc-device_id': d.id, 'User-Agent': 'Mozilla/5.0 miHoYoBBS/2.116.0', Origin: 'https://act.mihoyo.com', Referer: 'https://act.mihoyo.com/', 'X-Requested-With': 'com.mihoyo.hyperion', ...(d.fp ? { 'x-rpc-device_fp': d.fp } : {}), ...(game?.signgame ? { 'x-rpc-signgame': game.signgame } : {}) };
  }
  async gameRoles(c: Credentials, d: Device): Promise<BoundRole[]> {
    const result = await this.call('https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie', 'GET', this.gameHeaders(c, d));
    const data = this.ok(result.json); if (!Array.isArray(data.list)) throw new Fault(502, 'UPSTREAM_ERROR', '游戏角色列表格式发生变化');
    return data.list.map(x => { const r = record(x); return { gameBiz: text(r.game_biz), uid: text(r.game_uid), region: text(r.region), regionName: typeof r.region_name === 'string' ? r.region_name : text(r.region), nickname: text(r.nickname), level: Math.max(0, Number(r.level) || 0) }; });
  }
  private profile(r: BoundRole) { const p = profileFor(r.gameBiz); if (!p) throw new Fault(422, 'CAPABILITY_UNAVAILABLE', '此游戏或渠道尚未适配签到福利'); return p; }
  async gameInfo(c: Credentials, d: Device, r: BoundRole): Promise<GameInfo> {
    const g = this.profile(r), query = new URLSearchParams({ lang: 'zh-cn', act_id: g.actId, region: r.region, uid: r.uid });
    const response = await this.call(g.api + '/info?' + query, 'GET', this.gameHeaders(c, d, g)); const data = this.ok(response.json);
    if (typeof data.is_sign !== 'boolean') throw new Fault(502, 'UPSTREAM_ERROR', '游戏签到状态格式发生变化');
    const days = numeric(data.total_sign_day); let reward: Api['GameReward'] | null = null;
    const rewards = await this.call(g.api + '/home?' + new URLSearchParams({ lang: 'zh-cn', act_id: g.actId }), 'GET', this.gameHeaders(c, d, g));
    const home = this.ok(rewards.json);
    if (Array.isArray(home.awards)) { const award = home.awards[Math.max(0, data.is_sign ? days - 1 : days)]; if (award) { const a = record(award); reward = { name: text(a.name), count: numeric(a.cnt), icon: typeof a.icon === 'string' ? a.icon : null }; } }
    return { signed: data.is_sign, totalSignDays: days, firstBind: data.first_bind === true, reward };
  }
  async gameSign(c: Credentials, d: Device, r: BoundRole, proof?: string) {
    const g = this.profile(r), h = this.gameHeaders(c, d, g);
    if (proof?.startsWith('{')) { const result = JSON.parse(proof) as Api['Gt3Result']; Object.assign(h, { 'x-rpc-challenge': result.geetest_challenge, 'x-rpc-validate': result.geetest_validate, 'x-rpc-seccode': result.geetest_seccode }); }
    else if (proof) h['x-rpc-aigis'] = proof;
    const response = await this.call(g.api + '/sign', 'POST', h, { act_id: g.actId, region: r.region, uid: r.uid }); const code = numeric(response.json.retcode);
    if (code === -5003) return { retcode: code };
    const data = this.ok(response.json);
    if (data.success === 1 && typeof data.gt === 'string' && typeof data.challenge === 'string') {
      throw new NeedCaptcha({ version: 'gt3', config: { captchaId: data.gt, challenge: data.challenge, newCaptcha: true, offline: false, product: 'bind', language: 'zho', riskType: null, userInfo: null }, verify: async submission => { if (submission.version !== 'gt3') throw new Fault(422, 'CHALLENGE_UNSUPPORTED', '游戏签到需要此版本的人工验证'); return JSON.stringify(submission.result); } });
    }
    if (data.success !== undefined && data.success !== 0) throw new Fault(502, 'UPSTREAM_OUTCOME_UNKNOWN', '游戏签到响应无法确认，请查询角色签到状态');
    return { retcode: 0 };
  }
}
export class Games {
  constructor(private accounts: Accounts, private upstream: Partial<GameUpstream>) {}
  snapshot(accountId: string): Api['GameRolesSnapshot'] { this.accounts.row(accountId); const s = this.accounts.store.get<Api['GameRolesSnapshot']>('game_roles', accountId); return s ? { ...s, stale: !s.fetchedAt || day(Date.parse(s.fetchedAt)) !== day() || Date.parse(s.fetchedAt) < Date.now() - 900000 } : { accountId, fetchedAt: null, stale: true, roles: [] }; }
  async refresh(accountId: string) {
    if (!this.upstream.gameRoles || !this.upstream.gameInfo) throw new Fault(422, 'CAPABILITY_UNAVAILABLE', '游戏签到适配器不可用');
    const p = this.accounts.private(accountId), list = await this.upstream.gameRoles(p.credentials, p.device), seen = new Set<string>(), roles: Api['GameRole'][] = [];
    for (const r of list) {
      if (seen.has(roleId(r))) continue; seen.add(roleId(r)); const g = profileFor(r.gameBiz);
      const role: Api['GameRole'] = { id: roleId(r), ...r, gameName: g?.name ?? r.gameBiz, communityId: g?.communityId ?? null, executable: !!g, blockedReason: g ? null : '此游戏或渠道暂未适配', status: g ? 'unknown' : 'unavailable', totalSignDays: null, reward: null, lastCheckedAt: null };
      if (g) { try { const state = await this.upstream.gameInfo(p.credentials, p.device, r); Object.assign(role, { status: state.signed ? 'signed' : 'not_signed', totalSignDays: state.totalSignDays, reward: state.reward, lastCheckedAt: iso(), executable: !state.firstBind, blockedReason: state.firstBind ? '首次绑定需先在官方页面手动签到一次' : null }); } catch (e) { if (e instanceof NeedCaptcha || (e instanceof Fault && e.code === 'ACCOUNT_REAUTH_REQUIRED')) throw e; role.blockedReason = e instanceof Fault ? e.message : '游戏签到状态暂不可用'; } }
      roles.push(role);
    }
    const snapshot: Api['GameRolesSnapshot'] = { accountId, fetchedAt: iso(), stale: false, roles }; this.accounts.store.put('game_roles', accountId, snapshot); return snapshot;
  }
  role(accountId: string, roleKey: string): Api['GameRole'] { const r = this.snapshot(accountId).roles.find(r => r.id === roleKey); if (!r) throw new Fault(422, 'CAPABILITY_UNAVAILABLE', '角色已不在该账号绑定列表中，请刷新'); return r; }
  cacheState(accountId: string, roleKey: string, state: GameInfo) { const snapshot = this.snapshot(accountId), role = snapshot.roles.find(r => r.id === roleKey); if (role) { Object.assign(role, { status: state.signed ? 'signed' : 'not_signed', totalSignDays: state.totalSignDays, reward: state.reward, lastCheckedAt: iso() }); this.accounts.store.put('game_roles', accountId, snapshot); } }
  async info(accountId: string, role: BoundRole) { if (!this.upstream.gameInfo) throw new Fault(422, 'CAPABILITY_UNAVAILABLE', '游戏签到适配器不可用'); const p = this.accounts.private(accountId); return this.upstream.gameInfo(p.credentials, p.device, role); }
  async sign(accountId: string, role: BoundRole, proof?: string) { if (!this.upstream.gameSign) throw new Fault(422, 'CAPABILITY_UNAVAILABLE', '游戏签到适配器不可用'); const p = this.accounts.private(accountId); return this.upstream.gameSign(p.credentials, p.device, role, proof); }
}
