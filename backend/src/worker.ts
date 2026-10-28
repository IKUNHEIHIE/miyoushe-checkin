import { Fault, day, fault, id, iso, nextSchedule } from './core.js';
import type { Api, Credentials, Run } from './core.js';
import { Accounts, terminalOperations, terminalRuns } from './accounts.js';
import { Challenges } from './login.js';
import { NeedCaptcha } from './upstream.js';
import type { MissionState, Upstream } from './upstream.js';
import { Notifications } from './notifications.js';
import { Games } from './games.js';

const signed = (s: MissionState) => s.states.some(m => m.mission_key === 'continuous_sign' && m.is_get_award);
export class Worker {
  readonly locks = new Set<string>();
  private ticking = false;
  private timer?: ReturnType<typeof setInterval>;
  private nextScheduleCheck = 0;
  constructor(readonly accounts: Accounts, private upstream: Upstream, private challenges: Challenges, private notifications: Notifications, private games: Games, private expireFlows: () => void = () => {}) { this.recover(); }
  get store() { return this.accounts.store; }
  run(runId: string) { const r = this.store.get<Run>('run', runId); if (!r) throw new Fault(404, 'NOT_FOUND', '运行记录不存在'); return r; }
  operation(operationId: string): Api['CredentialOperation'] { const o = this.store.get<Api['CredentialOperation']>('credential_operation', operationId); if (!o) throw new Fault(404, 'NOT_FOUND', '凭据操作不存在'); return { ...o, account: this.accounts.get(o.accountId) }; }
  event(run: Run, message: string, level: Api['RunEvent']['level'] = 'info', stepId: string | null = null) { const e: Api['RunEvent'] = { id: id(), runId: run.id, level, message, stepId, createdAt: iso() }; this.store.put('event', e.id, e); }
  create(accountId: string, input: Api['RunRequest'], source: Run['source'] = 'manual', parentRunId: string | null = null) {
    const a = this.accounts.get(accountId); this.accounts.validatePreferences(input.communityIds, input.taskKinds);
    if (!a.enabled) throw new Fault(409, 'ACCOUNT_DISABLED', '账号已停用');
    if ((input.taskKinds.some(k => k !== 'game_sign') && input.communityIds.some(x => !a.communityIds.includes(x))) || input.taskKinds.some(x => !a.taskKinds.includes(x))) throw new Fault(422, 'CAPABILITY_UNAVAILABLE', '请先在账号偏好中启用所选任务');
    const gameRoleIds = input.gameRoleIds ?? a.gameRoleIds ?? [];
    const same = (r: Run) => r.accountId === accountId && r.businessDate === day() && r.state !== 'canceled' && [...r.communityIds].sort().join() === [...input.communityIds].sort().join() && [...r.taskKinds].sort().join() === [...input.taskKinds].sort().join() && [...(r.gameRoleIds ?? [])].sort().join() === [...gameRoleIds].sort().join();
    const existing = this.store.all<Run>('run').find(same); if (existing && source !== 'retry') return existing;
    if (a.activeCredentialOperationId || this.locks.has(accountId)) throw new Fault(409, 'ACCOUNT_BUSY', '账号正在执行其他操作');
    const r: Run = { id: id(), accountId, source, parentRunId, businessDate: day(), state: 'queued', communityIds: input.communityIds, taskKinds: input.taskKinds, gameRoleIds, challengeId: null, steps: input.communityIds.flatMap(communityId => input.taskKinds.filter(k => k !== 'game_sign').map(taskKind => ({ id: id(), communityId, taskKind, state: 'pending' as const, message: '等待执行', rewardPoints: null, upstreamRetcode: null, startedAt: null, finishedAt: null }))), confirmedRewardPoints: 0, cancelRequestedAt: null, createdAt: iso(), startedAt: null, finishedAt: null, error: null };
    this.store.put('run', r.id, r); this.event(r, '任务已进入队列'); return r;
  }
  retry(runId: string) { const old = this.run(runId); if (!['failed', 'partially_succeeded', 'outcome_unknown'].includes(old.state) || old.businessDate !== day()) throw new Fault(409, 'RUN_STATE_CONFLICT', '此运行不能重试，请创建今日任务'); this.accounts.requireIdle(old.accountId); return this.create(old.accountId, { communityIds: old.communityIds, taskKinds: old.taskKinds, gameRoleIds: old.gameRoleIds ?? [] }, 'retry', old.id); }
  cancel(runId: string) {
    const r = this.run(runId); if (terminalRuns.has(r.state)) throw new Fault(409, 'RUN_STATE_CONFLICT', '运行已结束');
    r.cancelRequestedAt = iso(); this.store.put('run', r.id, r);
    if (!this.locks.has(r.accountId)) { for (const s of r.steps) if (!['succeeded', 'already_completed'].includes(s.state)) { s.state = 'canceled'; s.message = '已停止尚未完成的步骤'; s.finishedAt = iso(); } this.finish(r); }
    return this.run(runId);
  }
  startOperation(accountId: string, kind: Api['CredentialOperationRequest']['kind']) {
    this.accounts.requireIdle(accountId); if (this.locks.has(accountId)) throw new Fault(409, 'ACCOUNT_BUSY', '账号忙碌');
    const o: Api['CredentialOperation'] = { id: id(), accountId, kind, state: 'queued', challengeId: null, account: this.accounts.get(accountId), error: null, createdAt: iso(), updatedAt: iso() };
    this.store.put('credential_operation', o.id, o); return this.operation(o.id);
  }
  async refreshMissions(accountId: string) {
    this.accounts.requireIdle(accountId); if (this.locks.has(accountId)) throw new Fault(409, 'ACCOUNT_BUSY', '账号忙碌'); this.locks.add(accountId);
    try { const p = this.accounts.private(accountId); const s = await this.upstream.missions(p.credentials, p.device); this.accounts.mark(accountId, 'active'); return this.accounts.cache(accountId, s); }
    catch (e) { if (e instanceof Fault && e.code === 'ACCOUNT_REAUTH_REQUIRED') this.accounts.mark(accountId, 'reauth_required'); throw e; }
    finally { this.locks.delete(accountId); }
  }
  async refreshGameRoles(accountId: string) {
    this.accounts.requireIdle(accountId); if (this.locks.has(accountId)) throw new Fault(409, 'ACCOUNT_BUSY', '账号忙碌'); this.locks.add(accountId);
    try { return await this.games.refresh(accountId); }
    catch (e) { if (e instanceof Fault && e.code === 'ACCOUNT_REAUTH_REQUIRED') this.accounts.mark(accountId, 'reauth_required'); if (e instanceof NeedCaptcha) throw new Fault(422, 'CAPABILITY_UNAVAILABLE', '角色查询需要先在官方页面完成验证后重试'); throw e; }
    finally { this.locks.delete(accountId); }
  }
  private async checkCredentials(accountId: string, forceRefresh = false, proof?: string) {
    const p = this.accounts.private(accountId), version = this.accounts.row(accountId).credential_version;
    let state: MissionState | undefined;
    if (!forceRefresh) {
      try { state = await this.upstream.missions(p.credentials, p.device); }
      catch (e) { if (!(e instanceof Fault) || e.code !== 'ACCOUNT_REAUTH_REQUIRED' || !this.accounts.get(accountId).autoRefresh) throw e; }
    }
    const expires = p.credentials.cookieExpiresAt;
    if (forceRefresh || !state || (this.accounts.get(accountId).autoRefresh && expires && Date.parse(expires) < Date.now() + 21600000)) {
      const credentials = await this.upstream.exchange(p.credentials, p.device, proof);
      state = await this.upstream.missions(credentials, p.device);
      this.accounts.replaceCredentials(accountId, { ...p, credentials }, version);
    }
    this.accounts.mark(accountId, 'active'); this.accounts.cache(accountId, state!); return state!;
  }
  private async checkGameCredentials(accountId: string, proof?: string) {
    const p = this.accounts.private(accountId), a = this.accounts.get(accountId);
    const renew = async () => { const version = this.accounts.row(accountId).credential_version; const credentials = await this.upstream.exchange(p.credentials, p.device, proof); this.accounts.replaceCredentials(accountId, { ...p, credentials }, version); };
    if (a.autoRefresh && p.credentials.cookieExpiresAt && Date.parse(p.credentials.cookieExpiresAt) < Date.now() + 21600000) await renew();
    const query = async () => { try { return await this.games.refresh(accountId); } catch (e) { if (e instanceof NeedCaptcha) throw new Fault(422, 'CAPABILITY_UNAVAILABLE', '角色查询需要先在官方页面完成验证后重试'); throw e; } };
    let snapshot;
    try { snapshot = await query(); }
    catch (e) { if (!(e instanceof Fault) || e.code !== 'ACCOUNT_REAUTH_REQUIRED' || !a.autoRefresh) throw e; await renew(); snapshot = await query(); }
    this.accounts.mark(accountId, 'active'); return snapshot;
  }
  private async executeOperation(operationId: string, proof?: string) {
    let o = this.operation(operationId); if (terminalOperations.has(o.state) || this.locks.has(o.accountId)) return;
    this.locks.add(o.accountId); o.state = 'running'; o.updatedAt = iso(); this.store.put('credential_operation', o.id, o);
    try { await this.checkCredentials(o.accountId, o.kind === 'refresh_cookie', proof); o.state = 'succeeded'; o.challengeId = null; o.error = null; }
    catch (e) {
      if (e instanceof NeedCaptcha) {
        const c = this.challenges.create('credential_operation', o.id, 'credential_refresh', e.spec, p => this.executeOperation(o.id, p), () => this.operation(o.id).state === 'awaiting_verification', challengeId => { const x = this.operation(o.id); x.challengeId = challengeId; this.store.put('credential_operation', x.id, x); }, () => { const x = this.operation(o.id); x.state = 'failed'; x.error = new Fault(410, 'CHALLENGE_EXPIRED', '人工验证已过期，请重新发起凭据操作').view(); this.store.put('credential_operation', x.id, x); this.accounts.mark(x.accountId, 'unknown'); });
        o.state = 'awaiting_verification'; o.challengeId = c.id; this.accounts.mark(o.accountId, 'verification_required'); this.notifications.queue('credential-action:' + o.id, '米游社账号需要人工验证', `账号操作 ${o.id} 正在等待你进入面板完成验证。`);
      } else {
        const f = fault(e); if (f.code === 'CHALLENGE_FAILED' && o.challengeId) { o.state = 'awaiting_verification'; o.error = f.view(); throw f; }
        o.state = 'failed'; o.error = f.view(); if (f.code === 'ACCOUNT_REAUTH_REQUIRED') this.accounts.mark(o.accountId, 'reauth_required'); this.notifications.queue('credential-failed:' + o.id, '米游社凭据检查失败', `操作 ${o.id} 未完成，请进入面板查看安全摘要。`);
      }
    } finally { o.account = this.accounts.get(o.accountId); o.updatedAt = iso(); this.store.put('credential_operation', o.id, o); this.locks.delete(o.accountId); }
  }
  private finish(r: Run) {
    const cancel = r.cancelRequestedAt !== null;
    const good = r.steps.filter(s => ['succeeded', 'already_completed'].includes(s.state)).length;
    r.state = r.steps.some(s => s.state === 'outcome_unknown') ? 'outcome_unknown' : cancel ? 'canceled' : good > 0 && good === r.steps.length ? 'succeeded' : good > 0 ? 'partially_succeeded' : 'failed';
    r.finishedAt = iso(); r.challengeId = null; r.confirmedRewardPoints = r.steps.reduce((n, s) => n + (s.rewardPoints ?? 0), 0); this.store.put('run', r.id, r); this.event(r, `运行结束：${r.state}`, r.state === 'failed' || r.state === 'outcome_unknown' ? 'warning' : 'info');
    const games = r.steps.filter(s => s.taskKind === 'game_sign').map(s => `${s.gameName} ${s.roleLabel}：${s.message}${s.rewards?.length ? '（' + s.rewards.map(a => a.name + ' × ' + a.count).join('、') + '）' : ''}`).join('\n');
    this.notifications.queue('run:' + r.id, '米游社任务执行结果', `运行 ${r.id}：${r.state}，本次已确认收益 ${r.confirmedRewardPoints} 米游币。${games ? '\n签到福利：\n' + games : ''}`, r.state === 'succeeded');
  }
  private claimKey(step: Api['RunStep']) { return step.gameRoleId ? `${step.taskKind}:${step.gameRoleId}` : step.taskKind; }
  private previousClaim(r: Run, step: Api['RunStep']) { return this.store.db.prepare('SELECT state FROM daily_claims WHERE account_id=? AND business_date=? AND community_id=? AND task_kind=?').get(r.accountId, r.businessDate, step.communityId, this.claimKey(step)) as { state: string } | undefined; }
  private claim(r: Run, step: Api['RunStep'], state: string) { this.store.db.prepare('INSERT INTO daily_claims VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,business_date,community_id,task_kind) DO UPDATE SET state=excluded.state,run_id=excluded.run_id').run(r.accountId, r.businessDate, step.communityId, this.claimKey(step), state, r.id); }
  private async executeGameStep(r: Run, step: Api['RunStep'], proof?: string) {
    let submitted = false;
    const role = this.games.role(r.accountId, step.gameRoleId!);
    const confirm = (after: Awaited<ReturnType<Games['info']>>, already = false) => {
      this.games.cacheState(r.accountId, role.id, after);
      step.state = already ? 'already_completed' : 'succeeded'; step.rewardPoints = 0;
      step.rewards = !already && after.reward ? [after.reward] : [];
      step.message = already ? '已核对今日游戏签到已完成' : '签到福利完成并已核对游戏签到状态'; this.claim(r, step, 'confirmed');
    };
    try {
      const before = await this.games.info(r.accountId, role); this.games.cacheState(r.accountId, role.id, before);
      r.cancelRequestedAt = this.run(r.id).cancelRequestedAt ?? r.cancelRequestedAt;
      if (r.cancelRequestedAt) { step.state = 'canceled'; step.message = '已取消尚未提交的游戏签到'; return; }
      if (r.businessDate !== day()) throw new Fault(409, 'RUN_STATE_CONFLICT', '任务已跨过北京时间零点，请创建今日任务');
      if (before.signed) { confirm(before, true); return; }
      if (before.firstBind) throw new Fault(422, 'CAPABILITY_UNAVAILABLE', '首次绑定需先在官方页面手动签到一次');
      const claim = this.previousClaim(r, step);
      if (['unknown', 'confirmed'].includes(claim?.state ?? '') || step.state === 'outcome_unknown') { step.state = 'outcome_unknown'; step.message = '先前游戏签到结果无法确认，不重复提交'; step.rewardPoints = 0; return; }
      step.state = 'running'; step.upstreamRetcode = null; step.startedAt ??= iso(); this.store.put('run', r.id, r); this.claim(r, step, 'running');
      submitted = true;
      const result = await this.games.sign(r.accountId, role, proof); step.upstreamRetcode = result.retcode;
      if (r.businessDate !== day()) throw new Fault(502, 'UPSTREAM_OUTCOME_UNKNOWN', '游戏签到请求跨过北京时间零点，需核对对应日期结果');
      const after = await this.games.info(r.accountId, role);
      if (!after.signed) throw new Fault(502, 'UPSTREAM_OUTCOME_UNKNOWN', '官方响应后仍无法确认游戏签到完成');
      confirm(after, result.retcode === -5003);
    } catch (e) {
      if (e instanceof NeedCaptcha && submitted && step.upstreamRetcode === null) throw e;
      const f = e instanceof NeedCaptcha ? new Fault(502, 'UPSTREAM_ERROR', '游戏签到状态查询需要先在官方页面完成验证') : fault(e); if (f.code === 'CHALLENGE_FAILED' && r.challengeId) throw f;
      if (submitted && ['UPSTREAM_OUTCOME_UNKNOWN', 'UPSTREAM_TIMEOUT', 'UPSTREAM_ERROR'].includes(f.code)) {
        try { if (r.businessDate !== day()) throw f; const after = await this.games.info(r.accountId, role); if (!after.signed) throw f; confirm(after, step.upstreamRetcode === -5003); }
        catch { step.state = 'outcome_unknown'; step.message = '游戏签到写入结果待核对，不自动重放'; step.rewardPoints = 0; step.rewards = []; this.claim(r, step, 'unknown'); r.error = new Fault(502, 'UPSTREAM_OUTCOME_UNKNOWN', step.message).view(); }
      } else { step.state = 'failed'; step.message = f.message; step.rewardPoints = 0; r.error = f.view(); this.claim(r, step, 'retryable'); if (f.code === 'ACCOUNT_REAUTH_REQUIRED') this.accounts.mark(r.accountId, 'reauth_required'); }
    } finally { if (!['running', 'awaiting_verification'].includes(step.state)) step.finishedAt = iso(); }
  }
  private async executeRun(runId: string, proof?: string, proofPurpose: 'sign' | 'credentials' = 'sign') {
    const r = this.run(runId); if (terminalRuns.has(r.state) || this.locks.has(r.accountId)) return;
    if (this.store.all<Run>('run').some(x => x.id !== r.id && x.accountId === r.accountId && ['running', 'awaiting_verification'].includes(x.state))) return;
    this.locks.add(r.accountId); r.state = 'running'; r.startedAt ??= iso(); this.store.put('run', r.id, r);
    try {
      if (!this.accounts.get(r.accountId).enabled || r.businessDate !== day()) throw new Fault(409, 'ACCOUNT_DISABLED', '账号停用或任务不属于今日');
      let baseline = r.taskKinds.some(k => k !== 'game_sign') ? await this.checkCredentials(r.accountId, false, proofPurpose === 'credentials' ? proof : undefined) : undefined;
      const gameSnapshot = r.taskKinds.includes('game_sign') ? await this.checkGameCredentials(r.accountId, proofPurpose === 'credentials' ? proof : undefined) : undefined;
      if (proofPurpose === 'credentials') proof = undefined;
      if (r.taskKinds.includes('game_sign') && !this.store.get('game_run_resolution', r.id)) {
        const snapshot = gameSnapshot!;
        const selected = r.gameRoleIds ?? [];
        if (selected.some(key => !snapshot.roles.some(x => x.id === key && x.executable))) throw new Fault(422, 'CAPABILITY_UNAVAILABLE', '所选角色未绑定此账号或无法自动签到，请刷新角色列表');
        const roles = snapshot.roles.filter(x => x.executable && (!selected.length || selected.includes(x.id)));
        if (!roles.length) throw new Fault(422, 'CAPABILITY_UNAVAILABLE', '该账号没有可执行签到福利的游戏角色');
        r.steps.push(...roles.map(role => ({ id: id(), communityId: role.communityId!, taskKind: 'game_sign' as const, gameRoleId: role.id, gameName: role.gameName, roleLabel: `${role.nickname} (${role.uid} / ${role.regionName})`, rewards: [], state: 'pending' as const, message: '等待游戏签到', rewardPoints: 0, upstreamRetcode: null, startedAt: null, finishedAt: null })));
        r.cancelRequestedAt = this.run(r.id).cancelRequestedAt ?? r.cancelRequestedAt;
        this.store.tx(() => { this.store.put('run', r.id, r); this.store.put('game_run_resolution', r.id, { resolved: true }); });
      }
      for (const step of r.steps) {
        if (['succeeded', 'already_completed', 'skipped', 'canceled'].includes(step.state)) continue;
        const current = this.run(r.id); if (current.cancelRequestedAt) { r.cancelRequestedAt = current.cancelRequestedAt; step.state = 'canceled'; step.message = '已停止后续步骤'; continue; }
        if (step.taskKind === 'game_sign') {
          await this.executeGameStep(r, step, proof); proof = undefined;
          r.cancelRequestedAt = this.run(r.id).cancelRequestedAt ?? r.cancelRequestedAt; this.store.put('run', r.id, r); this.event(r, step.message, ['failed', 'outcome_unknown'].includes(step.state) ? 'warning' : 'info', step.id); continue;
        }
        const claim = this.previousClaim(r, step);
        if (signed(baseline!)) { step.state = 'already_completed'; step.message = '已核对今日签到完成'; step.rewardPoints = 0; step.finishedAt = iso(); this.claim(r, step, 'confirmed'); continue; }
        if (claim?.state === 'unknown' || claim?.state === 'confirmed' || step.state === 'outcome_unknown') { step.state = 'outcome_unknown'; step.message = '先前请求结果无法确认，不重复提交'; step.finishedAt = iso(); continue; }
        step.state = 'running'; step.startedAt ??= iso(); this.store.put('run', r.id, r); this.claim(r, step, 'running');
        const p = this.accounts.private(r.accountId);
        try {
          const result = await this.upstream.sign(p.credentials, p.device, step.communityId, proof);
          const after = await this.upstream.missions(p.credentials, p.device); this.accounts.cache(r.accountId, after);
          step.upstreamRetcode = result.retcode;
          if (!signed(after)) throw new Fault(502, 'UPSTREAM_OUTCOME_UNKNOWN', '官方返回后仍无法确认签到状态');
          step.state = result.retcode === 1008 ? 'already_completed' : 'succeeded'; step.message = result.retcode === 1008 ? '已核对今日签到已完成' : '签到完成并已核对任务状态';
          step.rewardPoints = result.retcode === 0 ? Math.max(0, Math.min(result.points, after.total - baseline!.total, after.received - baseline!.received)) : 0;
          this.claim(r, step, 'confirmed'); baseline = after; proof = undefined;
        } catch (e) {
          if (e instanceof NeedCaptcha) throw e;
          const f = fault(e);
          if (f.code === 'CHALLENGE_FAILED' && r.challengeId) throw f;
          if (['UPSTREAM_OUTCOME_UNKNOWN', 'UPSTREAM_TIMEOUT'].includes(f.code)) {
            try { const after = await this.upstream.missions(p.credentials, p.device); this.accounts.cache(r.accountId, after); if (signed(after)) { step.state = 'succeeded'; step.message = '请求超时后通过状态查询确认完成'; step.rewardPoints = Math.max(0, Math.min(after.total - baseline!.total, after.received - baseline!.received)); this.claim(r, step, 'confirmed'); baseline = after; } else throw f; }
            catch { step.state = 'outcome_unknown'; step.message = '写入结果待核对，不自动重放'; step.rewardPoints = 0; this.claim(r, step, 'unknown'); r.error = new Fault(502, 'UPSTREAM_OUTCOME_UNKNOWN', step.message).view(); }
          } else { step.state = 'failed'; step.message = f.message; r.error = f.view(); this.claim(r, step, 'retryable'); if (f.code === 'ACCOUNT_REAUTH_REQUIRED') this.accounts.mark(r.accountId, 'reauth_required'); }
        }
        step.finishedAt = iso(); r.cancelRequestedAt = this.run(r.id).cancelRequestedAt ?? r.cancelRequestedAt; this.store.put('run', r.id, r); this.event(r, step.message, step.state === 'failed' || step.state === 'outcome_unknown' ? 'warning' : 'info', step.id);
      }
      r.cancelRequestedAt = this.run(r.id).cancelRequestedAt; this.finish(r);
    } catch (e) {
      if (e instanceof NeedCaptcha) {
        r.cancelRequestedAt = this.run(r.id).cancelRequestedAt ?? r.cancelRequestedAt;
        if (r.cancelRequestedAt) { for (const s of r.steps) if (!['succeeded', 'already_completed'].includes(s.state)) { s.state = 'canceled'; s.message = '已取消待验证步骤'; this.claim(r, s, 'retryable'); } this.finish(r); return; }
        const purpose = r.steps.some(s => s.state === 'running') ? 'sign' : 'credentials';
        const c = this.challenges.create('run', r.id, purpose === 'sign' ? (r.steps.some(s => s.state === 'running' && s.taskKind === 'game_sign') ? 'game_sign' : 'community_sign') : 'credential_refresh', e.spec, p => this.executeRun(r.id, p, purpose), () => this.run(r.id).state === 'awaiting_verification', challengeId => { const x = this.run(r.id); x.challengeId = challengeId; this.store.put('run', x.id, x); }, () => { const x = this.run(r.id); for (const s of x.steps) if (s.state === 'awaiting_verification') { s.state = 'failed'; s.message = '人工验证已过期'; s.finishedAt = iso(); this.claim(x, s, 'retryable'); } x.error = new Fault(410, 'CHALLENGE_EXPIRED', '人工验证会话已过期').view(); this.finish(x); });
        const step = r.steps.find(s => s.state === 'running' || s.state === 'pending'); if (step) { step.state = 'awaiting_verification'; step.message = '等待用户手动完成验证'; }
        r.state = 'awaiting_verification'; r.challengeId = c.id; this.store.put('run', r.id, r); this.notifications.queue('run-action:' + r.id, '米游社任务需要人工验证', `运行 ${r.id} 等待你进入面板完成验证。`);
      } else {
        const f = fault(e); if (f.code === 'CHALLENGE_FAILED' && r.challengeId) { r.state = 'awaiting_verification'; for (const s of r.steps) if (s.state === 'running') s.state = 'awaiting_verification'; this.store.put('run', r.id, r); throw f; }
        r.error = f.view(); for (const s of r.steps) if (!['succeeded', 'already_completed'].includes(s.state)) { s.state = 'failed'; s.message = f.message; s.finishedAt = iso(); }
        if (f.code === 'ACCOUNT_REAUTH_REQUIRED') this.accounts.mark(r.accountId, 'reauth_required'); this.finish(r);
      }
    } finally { this.locks.delete(r.accountId); }
  }
  private recover() {
    for (const r of this.store.all<Run>('run')) {
      if (r.state === 'running') { r.state = 'queued'; for (const s of r.steps) if (s.state === 'running') { s.state = 'outcome_unknown'; this.claim(r, s, 'unknown'); } this.store.put('run', r.id, r); }
      if (r.state === 'awaiting_verification') { for (const s of r.steps) if (s.state === 'awaiting_verification') { s.state = 'failed'; s.message = '服务重启，人工验证已失效'; this.claim(r, s, 'retryable'); } r.error = new Fault(410, 'CHALLENGE_EXPIRED', '服务重启，请重新发起验证操作').view(); this.finish(r); }
    }
    for (const o of this.store.all<Api['CredentialOperation']>('credential_operation')) if (o.state === 'running' || o.state === 'awaiting_verification') { o.state = o.state === 'running' ? 'queued' : 'failed'; if (o.state === 'failed') o.error = new Fault(410, 'CHALLENGE_EXPIRED', '服务重启，验证已失效').view(); this.store.put('credential_operation', o.id, o); }
  }
  private schedule() {
    if (this.accounts.settings().pauseScheduler) return;
    for (const a of this.accounts.all()) {
      if (!a.enabled) continue; const s = this.store.get<Api['Schedule']>('schedule', a.id); if (!s?.enabled) continue;
      if (!s.nextRunAt) s.nextRunAt = nextSchedule(s.hour, s.minute);
      if (day(Date.parse(s.nextRunAt)) < day()) { s.nextRunAt = `${day()}T${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}:00+08:00`; this.store.put('schedule', a.id, s); }
      const due = Date.parse(s.nextRunAt), jitter = parseInt(this.store.vault.mac('schedule', `${a.id}:${day()}`).slice(0, 6), 16) % 600001;
      const dayEnd = Date.parse(`${day(due)}T23:59:59.999+08:00`);
      if (Math.min(due + jitter, dayEnd) > Date.now()) continue;
      try { this.create(a.id, { communityIds: a.communityIds, taskKinds: a.taskKinds }, 'scheduled'); s.nextRunAt = nextSchedule(s.hour, s.minute); this.store.put('schedule', a.id, s); }
      catch (e) { if (!(e instanceof Fault)) throw e; }
    }
  }
  private healthChecks() {
    if (this.accounts.settings().pauseScheduler) return;
    for (const a of this.accounts.all()) {
      if (!a.enabled || !a.autoRefresh || ['reauth_required', 'verification_required'].includes(a.status) || this.accounts.busy(a.id) || this.locks.has(a.id)) continue;
      const next = this.store.get<{ at: number }>('credential_scan', a.id)?.at ?? 0;
      if (next > Date.now() || (a.credential.lastCheckedAt && Date.parse(a.credential.lastCheckedAt) > Date.now() - 21600000)) continue;
      this.startOperation(a.id, 'check'); this.store.put('credential_scan', a.id, { at: Date.now() + 21600000 });
    }
  }
  async tick() {
    if (this.ticking) return; this.ticking = true;
    try {
      this.challenges.expire(); this.expireFlows();
      if (Date.now() >= this.nextScheduleCheck) { this.schedule(); this.healthChecks(); this.nextScheduleCheck = Date.now() + 30000; this.cleanup(); }
      const operations = this.store.all<Api['CredentialOperation']>('credential_operation').filter(o => o.state === 'queued');
      const runs = this.store.all<Run>('run').filter(r => r.state === 'queued').reverse();
      const selected = new Set<string>(), tasks: Promise<void>[] = [];
      for (const o of operations) if (selected.size < 2 && !selected.has(o.accountId)) { selected.add(o.accountId); tasks.push(this.executeOperation(o.id)); }
      for (const r of runs) if (selected.size < 2 && !selected.has(r.accountId)) { selected.add(r.accountId); tasks.push(this.executeRun(r.id)); }
      await Promise.allSettled(tasks); await this.notifications.tick();
    } finally { this.ticking = false; }
  }
  private cleanup() {
    const cutoff = iso(Date.now() - this.accounts.settings().logRetentionDays * 86400000);
    this.store.db.prepare("DELETE FROM documents WHERE kind='event' AND created_at<?").run(cutoff);
    this.store.db.prepare('DELETE FROM rate_limits WHERE expires_at<?').run(Date.now());
    this.store.db.prepare('DELETE FROM idempotency WHERE expires_at<?').run(Date.now());
  }
  start() { this.timer = setInterval(() => { void this.tick().catch(() => { /* Route responses and persisted jobs carry safe errors. */ }); }, 1000); this.timer.unref(); }
  async stop() { if (this.timer) clearInterval(this.timer); while (this.ticking || this.locks.size) await new Promise(r => setTimeout(r, 25)); }
}
