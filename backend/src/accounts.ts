import { Fault, day, emptyPage, id, iso, maskPhone, nextSchedule } from './core.js';
import type { Account, Api, Credentials, Device } from './core.js';
import type { MissionState } from './upstream.js';
import { Storage } from './storage.js';
import { gameProfiles } from './games.js';

export type PrivateAccount = { phone: string; device: Device; credentials: Credentials };
type AccountRow = { id: string; aid: string; public_json: string; private_json: string; credential_version: number };
export const capabilities: Api['Capabilities'] = {
  contractVersion: '0.2.0', rootCredentialRenewal: false, captchaVersions: ['gt4', 'gt3'],
  games: gameProfiles.map(({ gameBiz, name, communityId }) => ({ gameBiz, name, communityId, executable: true })),
  communities: [{ id: 2, name: '原神', executable: true, verification: 'verified', blockedReason: null }, { id: 6, name: '崩坏：星穹铁道', executable: false, verification: 'unverified', blockedReason: '尚未完成该社区实测' }],
  tasks: [
    { kind: 'community_sign', label: '社区签到', executable: true, verification: 'verified', blockedReason: null, rewardMode: 'automatic', requiresExplicitOptIn: false },
    { kind: 'game_sign', label: '签到福利（游戏奖励）', executable: true, verification: 'unverified', blockedReason: null, rewardMode: 'automatic', requiresExplicitOptIn: false },
    ...(['claim_rewards', 'browse_posts', 'like_posts', 'share_posts'] as const).map(kind => ({ kind, label: { claim_rewards: '独立领奖', browse_posts: '浏览帖子', like_posts: '点赞任务', share_posts: '分享任务' }[kind], executable: false, verification: 'unverified' as const, blockedReason: '上游规则与接口尚未完成验证', rewardMode: 'unknown' as const, requiresExplicitOptIn: true }))
  ]
};
export const terminalRuns = new Set(['succeeded', 'partially_succeeded', 'failed', 'outcome_unknown', 'canceled']);
export const terminalOperations = new Set(['succeeded', 'failed', 'canceled']);
export class Accounts {
  constructor(readonly store: Storage) {}
  row(accountId: string): AccountRow { const row = this.store.db.prepare('SELECT * FROM accounts WHERE id=?').get(accountId) as AccountRow | undefined; if (!row) throw new Fault(404, 'NOT_FOUND', '账号不存在'); return row; }
  get(accountId: string): Account {
    const view = JSON.parse(this.row(accountId).public_json) as Account;
    view.gameRoleIds ??= [];
    view.activeRunId = this.store.all<Api['Run']>('run').find(r => r.accountId === accountId && !terminalRuns.has(r.state))?.id ?? null;
    view.activeCredentialOperationId = this.store.all<Api['CredentialOperation']>('credential_operation').find(o => o.accountId === accountId && !terminalOperations.has(o.state))?.id ?? null;
    return view;
  }
  all() { return (this.store.db.prepare('SELECT id FROM accounts ORDER BY id').all() as { id: string }[]).map(r => this.get(r.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)); }
  private(accountId: string): PrivateAccount { const row = this.row(accountId); const data = this.store.vault.open<PrivateAccount>(row.private_json, `account:${accountId}:${row.credential_version}`); if (data.credentials.aid !== row.aid) throw new Fault(500, 'INTERNAL_ERROR', '凭据账号校验失败'); return data; }
  saveView(view: Account) { this.store.db.prepare('UPDATE accounts SET public_json=? WHERE id=?').run(JSON.stringify({ ...view, updatedAt: iso() }), view.id); }
  busy(accountId: string, except?: string) {
    const a = this.get(accountId); return (a.activeRunId !== null && a.activeRunId !== except) || (a.activeCredentialOperationId !== null && a.activeCredentialOperationId !== except);
  }
  requireIdle(accountId: string) { if (this.busy(accountId)) throw new Fault(409, 'ACCOUNT_BUSY', '此账号有尚未结束的操作'); }
  validatePreferences(communityIds: number[], taskKinds: Api['TaskKind'][]) {
    const hasCommunityTasks = taskKinds.some(k => k !== 'game_sign');
    if ((hasCommunityTasks && (!communityIds.length || communityIds.some(c => !capabilities.communities.some(x => x.id === c && x.executable)))) || taskKinds.some(k => !capabilities.tasks.some(x => x.kind === k && x.executable))) throw new Fault(422, 'CAPABILITY_UNAVAILABLE', '所选社区或任务尚未开放执行');
  }
  bind(phone: string, device: Device, credentials: Credentials, target?: string): Account {
    return this.store.tx(() => {
      const existing = this.store.db.prepare('SELECT id FROM accounts WHERE aid=?').get(credentials.aid) as { id: string } | undefined;
      if (target) {
        const old = this.row(target);
        if (old.aid !== credentials.aid) throw new Fault(409, 'ACCOUNT_IDENTITY_MISMATCH', '登录账号与重新登录目标不一致');
        this.requireIdle(target); this.replaceCredentials(target, { phone, device, credentials }, old.credential_version); return this.get(target);
      }
      if (existing) throw new Fault(409, 'ACCOUNT_EXISTS', '该米游社账号已添加，请使用重新登录');
      const accountId = id(), now = iso();
      const view: Account = { id: accountId, uid: credentials.aid, nickname: `米游社 ${credentials.aid}`, phoneMasked: maskPhone(phone), remark: '', enabled: true, status: 'active', communityIds: [2], taskKinds: ['community_sign'], autoRefresh: true, credential: { status: 'valid', lastCheckedAt: now, lastCookieIssuedAt: now, cookieStorageExpiresAt: credentials.cookieExpiresAt, rootExpiresAt: null, expirySource: credentials.cookieExpiresAt ? 'cookie_max_age' : 'unknown' }, activeCredentialOperationId: null, activeRunId: null, version: 1, createdAt: now, updatedAt: now };
      this.store.db.prepare('INSERT INTO accounts VALUES(?,?,?,?,?)').run(accountId, credentials.aid, JSON.stringify(view), this.store.vault.seal({ phone, device, credentials }, `account:${accountId}:1`), 1);
      this.store.put('schedule', accountId, { accountId, enabled: false, hour: 6, minute: 0, timezone: 'Asia/Shanghai', jitterMaxMinutes: 10, nextRunAt: null, version: 1 } satisfies Api['Schedule']);
      return view;
    });
  }
  replaceCredentials(accountId: string, value: PrivateAccount, expectedVersion: number) {
    const current = this.row(accountId); if (current.credential_version !== expectedVersion) throw new Fault(409, 'VERSION_CONFLICT', '凭据已被另一操作更新');
    if (current.aid !== value.credentials.aid) throw new Fault(409, 'ACCOUNT_IDENTITY_MISMATCH', '凭据账号不一致');
    const next = expectedVersion + 1;
    const result = this.store.db.prepare('UPDATE accounts SET private_json=?,credential_version=? WHERE id=? AND credential_version=?').run(this.store.vault.seal(value, `account:${accountId}:${next}`), next, accountId, expectedVersion);
    if (!result.changes) throw new Fault(409, 'VERSION_CONFLICT', '凭据版本冲突');
    const a = this.get(accountId); a.phoneMasked = maskPhone(value.phone); a.status = 'active'; a.version++;
    a.credential = { status: 'valid', lastCheckedAt: iso(), lastCookieIssuedAt: iso(), cookieStorageExpiresAt: value.credentials.cookieExpiresAt, rootExpiresAt: null, expirySource: value.credentials.cookieExpiresAt ? 'cookie_max_age' : 'unknown' }; this.saveView(a);
  }
  mark(accountId: string, status: Account['status']) { const a = this.get(accountId); a.status = status; a.credential.status = status === 'active' ? 'valid' : status; if (status === 'active') a.credential.lastCheckedAt = iso(); this.saveView(a); }
  patch(accountId: string, input: Api['AccountPatch']) {
    return this.store.tx(() => { const a = this.get(accountId); if (a.version !== input.version) throw new Fault(409, 'VERSION_CONFLICT', '配置已更新，请刷新后重试'); this.requireIdle(accountId); this.validatePreferences(input.communityIds ?? a.communityIds, input.taskKinds ?? a.taskKinds); Object.assign(a, input, { version: a.version + 1 }); this.saveView(a); return this.get(accountId); });
  }
  delete(accountId: string) {
    this.store.tx(() => { this.requireIdle(accountId); this.store.db.prepare('DELETE FROM accounts WHERE id=?').run(accountId); this.store.remove('schedule', accountId); this.store.remove('missions', accountId); this.store.remove('game_roles', accountId); for (const o of this.store.all<Api['CredentialOperation']>('credential_operation')) if (o.accountId === accountId) this.store.remove('credential_operation', o.id); this.store.db.prepare('DELETE FROM daily_claims WHERE account_id=?').run(accountId); });
  }
  snapshot(accountId: string): Api['MissionSnapshot'] {
    this.row(accountId);
    const s = this.store.get<Api['MissionSnapshot']>('missions', accountId);
    if (!s) return { accountId, businessDate: day(), fetchedAt: null, stale: true, totalPoints: null, todayReceivedPoints: null, upstreamCanGetPoints: null, missions: [], warnings: ['尚未获取任务'] };
    return { ...s, stale: s.businessDate !== day() || !s.fetchedAt || Date.parse(s.fetchedAt) < Date.now() - 15 * 60000 };
  }
  cache(accountId: string, raw: MissionState): Api['MissionSnapshot'] {
    const s: Api['MissionSnapshot'] = { accountId, businessDate: day(), fetchedAt: iso(), stale: false, totalPoints: raw.total, todayReceivedPoints: raw.received, upstreamCanGetPoints: raw.canGet, warnings: [], missions: raw.states.map(m => {
      const sign = m.mission_key === 'continuous_sign';
      return { id: `${m.mission_key}:${m.mission_id}`, upstreamMissionId: m.mission_id, key: m.mission_key, label: sign ? '社区签到' : '其他官方任务', kind: sign ? 'community_sign' : 'other', communityId: sign ? 2 : null, progress: m.happened_times, target: sign ? 1 : null, completed: m.process >= 1, rewardClaimed: m.is_get_award, rewardPoints: null, executable: sign, blockedReason: sign ? null : '该任务尚未开放自动执行', rewardMode: sign ? 'automatic' : 'unknown' };
    }) };
    this.store.put('missions', accountId, s); return s;
  }
  schedule(accountId: string): Api['Schedule'] { const a = this.get(accountId), s = this.store.get<Api['Schedule']>('schedule', accountId)!; return { ...s, nextRunAt: s.enabled && a.enabled && !this.settings().pauseScheduler ? s.nextRunAt : null }; }
  recomputeSchedule(accountId: string) { const s = this.store.get<Api['Schedule']>('schedule', accountId); if (s) { s.nextRunAt = s.enabled ? nextSchedule(s.hour, s.minute) : null; this.store.put('schedule', accountId, s); } }
  patchSchedule(accountId: string, input: Api['SchedulePatch']) { return this.store.tx(() => { const s = this.schedule(accountId); if (s.version !== input.version) throw new Fault(409, 'VERSION_CONFLICT', '计划已更新'); Object.assign(s, input, { version: s.version + 1 }); s.nextRunAt = s.enabled ? nextSchedule(s.hour, s.minute) : null; this.store.put('schedule', accountId, s); return this.schedule(accountId); }); }
  settings(): Api['SystemSettings'] { return this.store.get('settings', 'system') ?? { timezone: 'Asia/Shanghai', pauseScheduler: false, logRetentionDays: 90, version: 1 }; }
  patchSettings(input: Api['SystemSettingsPatch']) { return this.store.tx(() => { const s = this.settings(); if (s.version !== input.version) throw new Fault(409, 'VERSION_CONFLICT', '系统配置已更新'); Object.assign(s, input, { version: s.version + 1 }); this.store.put('settings', 'system', s); return s; }); }
}
export function paginate<T extends { id: string }>(items: T[], query: { cursor?: string; limit?: number }) {
  const limit = query.limit ?? 20; let start = 0;
  if (query.cursor) { let key: string; try { key = Buffer.from(query.cursor, 'base64url').toString(); } catch { throw new Fault(400, 'VALIDATION_ERROR', '分页游标无效'); } const index = items.findIndex(x => x.id === key); if (index < 0) throw new Fault(400, 'VALIDATION_ERROR', '分页游标已失效，请重新查询'); start = index + 1; }
  const result = items.slice(start, start + limit); return emptyPage(result, start + result.length < items.length ? Buffer.from(result.at(-1)!.id).toString('base64url') : null);
}
