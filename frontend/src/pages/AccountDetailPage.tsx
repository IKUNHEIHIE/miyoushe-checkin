import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  RefreshCw,
  ShieldAlert,
  KeyRound,
  Play,
  Save,
  Clock,
  Coins,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  Info
} from 'lucide-react';
import { apiClient, ApiClientError } from '../api/client';
import { useApp } from '../context/AppContext';
import { GameBenefitsPanel } from '../components/GameBenefitsPanel';
import {
  type Account,
  ACCOUNT_STATUS_LABELS,
  CREDENTIAL_STATUS_LABELS,
  type CredentialOperation,
  type CredentialOperationKind,
  type MissionSnapshot,
  type Run,
  type Schedule,
  type TaskKind
} from '../types/openapi';
import {
  formatPadTwo,
  formatRemainingDuration,
  formatShanghaiDateTime,
  generateIdempotencyKey,
  getNowMs
} from '../utils/format';

export const AccountDetailPage: React.FC = () => {
  const { accountId } = useParams<{ accountId: string }>();
  const navigate = useNavigate();
  const {
    capabilities,
    openReloginAccount,
    enqueueChallenge,
    pushToast,
    accountsVersionTrigger
  } = useApp();

  const [account, setAccount] = useState<Account | null>(null);
  const [missions, setMissions] = useState<MissionSnapshot | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [activeCredOp, setActiveCredOp] = useState<CredentialOperation | null>(null);
  const [activeRun, setActiveRun] = useState<Run | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiClientError | null>(null);

  // Editable Account Form State
  const [remarkDraft, setRemarkDraft] = useState('');
  const [enabledDraft, setEnabledDraft] = useState(true);
  const [autoRefreshDraft, setAutoRefreshDraft] = useState(true);
  const [communityIdsDraft, setCommunityIdsDraft] = useState<number[]>([2]);
  const [taskKindsDraft, setTaskKindsDraft] = useState<TaskKind[]>(['community_sign']);
  const [gameRoleIdsDraft, setGameRoleIdsDraft] = useState<string[]>([]);
  const [savingAccount, setSavingAccount] = useState(false);
  const [accountConflict, setAccountConflict] = useState<{
    latestServerAccount: Account;
  } | null>(null);

  // Editable Schedule Form State
  const [schedEnabledDraft, setSchedEnabledDraft] = useState(false);
  const [schedHourDraft, setSchedHourDraft] = useState(6);
  const [schedMinuteDraft, setSchedMinuteDraft] = useState(0);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleConflict, setScheduleConflict] = useState<{
    latestServerSchedule: Schedule;
  } | null>(null);

  // Action busy flags
  const [refreshingMissions, setRefreshingMissions] = useState(false);
  const [missionsError, setMissionsError] = useState<ApiClientError | null>(null);
  const [credOpBusy, setCredOpBusy] = useState<CredentialOperationKind | null>(null);
  const [startingRun, setStartingRun] = useState(false);
  const [nowMs, setNowMs] = useState(() => getNowMs());

  const refreshMissionsKeyRef = useRef<string>(generateIdempotencyKey());
  const createRunKeyRef = useRef<string>(generateIdempotencyKey());

  useEffect(() => {
    const t = setInterval(() => setNowMs(getNowMs()), 2000);
    return () => clearInterval(t);
  }, []);

  const syncAccountToDraft = useCallback((acc: Account) => {
    setAccount(acc);
    setRemarkDraft(acc.remark);
    setEnabledDraft(acc.enabled);
    setAutoRefreshDraft(acc.autoRefresh);
    setCommunityIdsDraft(acc.communityIds);
    setTaskKindsDraft(acc.taskKinds);
    setGameRoleIdsDraft(acc.gameRoleIds ?? []);
  }, []);

  const syncScheduleToDraft = useCallback((sched: Schedule) => {
    setSchedule(sched);
    setSchedEnabledDraft(sched.enabled);
    setSchedHourDraft(sched.hour);
    setSchedMinuteDraft(sched.minute);
  }, []);

  const loadAll = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError(null);
    try {
      const [accRes, misRes, schedRes] = await Promise.all([
        apiClient.getAccount(accountId),
        apiClient.getAccountMissions(accountId),
        apiClient.getAccountSchedule(accountId)
      ]);
      const acc = accRes.data;
      syncAccountToDraft(acc);
      setMissions(misRes.data);
      syncScheduleToDraft(schedRes.data);

      // Recover activeCredentialOperationId or activeRunId on page load
      if (acc.activeCredentialOperationId) {
        try {
          const opRes = await apiClient.getCredentialOperation(acc.activeCredentialOperationId);
          setActiveCredOp(opRes.data);
        } catch {
          setActiveCredOp(null);
        }
      } else {
        setActiveCredOp(null);
      }

      if (acc.activeRunId) {
        try {
          const rRes = await apiClient.getRun(acc.activeRunId);
          setActiveRun(rRes.data);
        } catch {
          setActiveRun(null);
        }
      } else {
        setActiveRun(null);
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err);
      }
    } finally {
      setLoading(false);
    }
  }, [accountId, syncAccountToDraft, syncScheduleToDraft]);

  useEffect(() => {
    void loadAll();
  }, [loadAll, accountsVersionTrigger]);

  // Poll active CredentialOperation if queued/running
  useEffect(() => {
    if (!activeCredOp) return;
    if (activeCredOp.state !== 'queued' && activeCredOp.state !== 'running') return;

    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void apiClient
        .getCredentialOperation(activeCredOp.id)
        .then((res) => {
          setActiveCredOp(res.data);
          setAccount(res.data.account);
          if (res.data.state === 'awaiting_verification' && res.data.challengeId) {
            enqueueChallenge({
              challengeId: res.data.challengeId,
              contextLabel: `${res.data.account.nickname} · 凭据操作`,
              onAccepted: () => {
                void apiClient.getCredentialOperation(res.data.id).then((updated) => {
                  setActiveCredOp(updated.data);
                  setAccount(updated.data.account);
                });
              }
            });
          } else if (res.data.state === 'succeeded') {
            pushToast({
              type: 'success',
              title:
                res.data.kind === 'check'
                  ? '登录状态检查完成'
                  : '已重新获取工作 Cookie',
              message: '账号状态快照已更新。'
            });
          }
        })
        .catch(() => {});
    }, 1200);

    return () => clearInterval(timer);
  }, [activeCredOp, enqueueChallenge, pushToast]);

  const handleStartCredOp = async (kind: CredentialOperationKind) => {
    if (!account || credOpBusy) return;
    setCredOpBusy(kind);
    try {
      const res = await apiClient.startCredentialOperation(
        account.id,
        { kind },
        generateIdempotencyKey()
      );
      setActiveCredOp(res.data);
      setAccount(res.data.account);
      // Immediately fetch once in case it settles quickly
      const pollRes = await apiClient.getCredentialOperation(res.data.id);
      setActiveCredOp(pollRes.data);
      setAccount(pollRes.data.account);

      if (pollRes.data.state === 'awaiting_verification' && pollRes.data.challengeId) {
        enqueueChallenge({
          challengeId: pollRes.data.challengeId,
          contextLabel: `${account.nickname} · ${kind === 'check' ? '检查登录状态' : '更新工作 Cookie'}`,
          onAccepted: () => {
            void apiClient.getCredentialOperation(pollRes.data.id).then((u) => {
              setActiveCredOp(u.data);
              setAccount(u.data.account);
            });
          }
        });
      } else if (pollRes.data.state === 'succeeded') {
        pushToast({
          type: 'success',
          title: kind === 'check' ? '登录状态检查通过' : '已重新获取工作 Cookie',
          message:
            kind === 'refresh_cookie'
              ? '工作 Cookie 已更新（注：不代表根凭据长期续期）。'
              : '最近检查时间已更新。'
        });
      } else if (pollRes.data.state === 'failed') {
        pushToast({
          type: 'error',
          title: '凭据操作未通过',
          message: pollRes.data.error?.message ?? '请重新登录该账号'
        });
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        pushToast({
          type: 'error',
          title: `凭据操作失败 (${err.code})`,
          message: err.message,
          requestId: err.requestId
        });
      }
    } finally {
      setCredOpBusy(null);
    }
  };

  const handleRefreshMissions = async () => {
    if (!account || refreshingMissions) return;
    setRefreshingMissions(true);
    setMissionsError(null);
    try {
      const res = await apiClient.refreshAccountMissions(
        account.id,
        refreshMissionsKeyRef.current
      );
      refreshMissionsKeyRef.current = generateIdempotencyKey();
      setMissions(res.data);
      pushToast({
        type: 'success',
        title: '米游币任务快照已刷新',
        message: '已从官方接口同步最新米游币余额与社区任务完成状态。'
      });
    } catch (err) {
      refreshMissionsKeyRef.current = generateIdempotencyKey();
      if (err instanceof ApiClientError) {
        setMissionsError(err);
      }
    } finally {
      setRefreshingMissions(false);
    }
  };

  const handleSaveAccountPreferences = async (overrideVersion?: number) => {
    if (!account || savingAccount) return;
    setSavingAccount(true);
    try {
      const res = await apiClient.updateAccount(account.id, {
        version: overrideVersion ?? account.version,
        remark: remarkDraft,
        enabled: enabledDraft,
        autoRefresh: autoRefreshDraft,
        communityIds: communityIdsDraft,
        taskKinds: taskKindsDraft,
        gameRoleIds: gameRoleIdsDraft
      });
      syncAccountToDraft(res.data);
      setAccountConflict(null);
      // Also refresh schedule so nextRunAt reflects account.enabled
      const schedRes = await apiClient.getAccountSchedule(account.id);
      syncScheduleToDraft(schedRes.data);

      pushToast({
        type: 'success',
        title: '账号备注与任务偏好已保存',
        message: `当前版本号已更新至 v${res.data.version}。`
      });
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === 'VERSION_CONFLICT') {
          const latest = await apiClient.getAccount(account.id);
          setAccount(latest.data);
          setAccountConflict({ latestServerAccount: latest.data });
        } else {
          pushToast({
            type: 'error',
            title: `保存失败 (${err.code})`,
            message: err.message,
            requestId: err.requestId
          });
        }
      }
    } finally {
      setSavingAccount(false);
    }
  };

  const handleSaveSchedule = async (overrideVersion?: number) => {
    if (!account || !schedule || savingSchedule) return;
    setSavingSchedule(true);
    try {
      const res = await apiClient.updateAccountSchedule(account.id, {
        version: overrideVersion ?? schedule.version,
        enabled: schedEnabledDraft,
        hour: schedHourDraft,
        minute: schedMinuteDraft,
        timezone: 'Asia/Shanghai'
      });
      syncScheduleToDraft(res.data);
      setScheduleConflict(null);
      pushToast({
        type: 'success',
        title: '每日定时计划已更新',
        message: res.data.enabled
          ? `已设置每日 ${formatPadTwo(res.data.hour)}:${formatPadTwo(res.data.minute)} (Asia/Shanghai，含 0–10 分钟错峰窗口)。`
          : '已关闭该账号的每日定时计划。'
      });
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === 'VERSION_CONFLICT') {
          const latest = await apiClient.getAccountSchedule(account.id);
          setSchedule(latest.data);
          setScheduleConflict({ latestServerSchedule: latest.data });
        } else {
          pushToast({
            type: 'error',
            title: `计划保存失败 (${err.code})`,
            message: err.message,
            requestId: err.requestId
          });
        }
      }
    } finally {
      setSavingSchedule(false);
    }
  };

  const handleImmediateRun = async () => {
    if (!account || startingRun) return;
    setStartingRun(true);
    try {
      const res = await apiClient.createAccountRun(
        account.id,
        {
          communityIds: communityIdsDraft.length > 0 ? communityIdsDraft : [2],
          taskKinds: taskKindsDraft.length > 0 ? taskKindsDraft : ['community_sign'],
          gameRoleIds: gameRoleIdsDraft
        },
        createRunKeyRef.current
      );
      createRunKeyRef.current = generateIdempotencyKey();
      pushToast({
        type: 'info',
        title: '已发起立即执行任务',
        message: `任务 (${res.data.id.slice(0, 8)}...) 已进入队列，正在跳转至执行详情监控进度。`
      });
      navigate(`/runs?runId=${res.data.id}`);
    } catch (err) {
      createRunKeyRef.current = generateIdempotencyKey();
      if (err instanceof ApiClientError) {
        pushToast({
          type: 'error',
          title: `无法启动任务 (${err.code})`,
          message: err.message,
          requestId: err.requestId
        });
      }
    } finally {
      setStartingRun(false);
    }
  };

  const handleImmediateGameRun = async () => {
    if (!account || startingRun || savingAccount) return;
    setStartingRun(true);
    try {
      const updated = await apiClient.updateAccount(account.id, { version: account.version, taskKinds: taskKindsDraft, gameRoleIds: gameRoleIdsDraft });
      syncAccountToDraft(updated.data);
      const run = await apiClient.createAccountRun(account.id, { communityIds: [], taskKinds: ['game_sign'], gameRoleIds: gameRoleIdsDraft });
      navigate(`/runs?runId=${run.data.id}`);
    } catch (err) { if (err instanceof ApiClientError) pushToast({ type: 'error', title: '签到福利未启动', message: err.message, requestId: err.requestId }); }
    finally { setStartingRun(false); }
  };

  const toggleCommunityDraft = (cid: number, executable: boolean) => {
    if (!executable) return;
    setCommunityIdsDraft((prev) => {
      if (prev.includes(cid)) {
        return prev.length > 1 ? prev.filter((id) => id !== cid) : prev;
      }
      return [...prev, cid];
    });
  };

  const toggleTaskDraft = (kind: TaskKind, executable: boolean) => {
    if (!executable) return;
    setTaskKindsDraft((prev) => {
      if (prev.includes(kind)) {
        return prev.length > 1 ? prev.filter((k) => k !== kind) : prev;
      }
      return [...prev, kind];
    });
  };

  if (loading && !account) {
    return (
      <div className="page-container">
        <div className="state-box">
          <RefreshCw className="spin" size={20} />
          <span>正在加载账号详情、任务快照与每日计划...</span>
        </div>
      </div>
    );
  }

  if (error || !account) {
    return (
      <div className="page-container">
        <Link to="/accounts" className="btn btn-ghost btn-sm mb-4">
          <ArrowLeft size={15} /> 返回账号列表
        </Link>
        <div className="alert-banner alert-danger" role="alert">
          <ShieldAlert size={18} />
          <div>
            <strong>无法加载账号详情 ({error?.code ?? 'NOT_FOUND'})</strong>
            <p>{error?.message ?? '未找到指定账号'}</p>
          </div>
        </div>
      </div>
    );
  }

  const communitiesList = capabilities?.communities ?? [
    { id: 2, name: '原神', executable: true, verification: 'verified', blockedReason: null },
    {
      id: 6,
      name: '崩坏：星穹铁道',
      executable: false,
      verification: 'unverified',
      blockedReason: '待完成官方接口实测'
    }
  ];

  const tasksList = capabilities?.tasks ?? [
    {
      kind: 'community_sign',
      label: '社区签到',
      executable: true,
      verification: 'verified',
      blockedReason: null,
      rewardMode: 'automatic',
      requiresExplicitOptIn: false
    }
  ];

  return (
    <div className="page-container">
      <div className="mb-3">
        <Link to="/accounts" className="btn btn-ghost btn-sm">
          <ArrowLeft size={15} /> 返回账号列表
        </Link>
      </div>

      {/* Top Account Header */}
      <div className="page-header">
        <div>
          <div className="eyebrow-row">
            <span className={`badge badge-status-${account.status}`}>
              登录状态：{ACCOUNT_STATUS_LABELS[account.status]}
            </span>
            <span className={`badge ${account.enabled ? 'badge-cobalt' : 'badge-slate'}`}>
              自动调度：{account.enabled ? '已开启' : '已暂停（不影响登录态）'}
            </span>
            <span className="badge badge-slate mono">v{account.version}</span>
          </div>
          <h1 className="page-title">{account.nickname}</h1>
          <p className="page-subtitle mono">
            脱敏手机号：{account.phoneMasked} · 米游社通行证 ID (aid)：{account.uid}
          </p>
        </div>

        <div className="button-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={startingRun}
            onClick={() => void loadAll()}
          >
            <RefreshCw size={15} /> 刷新页面数据
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={startingRun}
            onClick={() => void handleImmediateRun()}
          >
            <Play size={16} />
            {startingRun ? '正在提交签到任务...' : '立即执行选定任务'}
          </button>
        </div>
      </div>

      {/* Recovery Banner if Active Operation or Run Requires Human Verification */}
      {((activeCredOp && activeCredOp.state === 'awaiting_verification' && activeCredOp.challengeId) ||
        (activeRun && activeRun.state === 'awaiting_verification' && activeRun.challengeId)) && (
        <div className="alert-banner alert-warning mb-5" role="region" aria-label="活动操作等待人工验证">
          <ShieldAlert size={20} />
          <div className="flex-1">
            <strong>当前账号有正在等待人工验证的操作</strong>
            <p>
              {activeCredOp?.state === 'awaiting_verification'
                ? `凭据操作 (${activeCredOp.kind === 'check' ? '检查登录状态' : '重新获取工作 Cookie'}) 暂停等待你手动完成极验验证。`
                : `社区签到任务 (${activeRun?.id.slice(0, 8)}...) 暂停等待你手动完成极验验证。`}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              const chId = activeCredOp?.challengeId || activeRun?.challengeId;
              if (chId) {
                enqueueChallenge({
                  challengeId: chId,
                  contextLabel: `${account.nickname}`,
                  onAccepted: () => void loadAll()
                });
              }
            }}
          >
            立即完成人工验证
          </button>
        </div>
      )}

      {/* Re-auth Required Warning Banner */}
      {account.status === 'reauth_required' && (
        <div className="alert-banner alert-danger mb-5" role="alert">
          <KeyRound size={20} />
          <div className="flex-1">
            <strong>该账号根凭据已失效 (status = reauth_required)</strong>
            <p>
              系统已停止对该账号的自动连续重试。你可以先尝试点击「重新获取工作 Cookie」，或直接点击「重新登录账号」通过短信验证更新根凭据。
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => openReloginAccount(account)}
          >
            <KeyRound size={14} /> 重新登录账号
          </button>
        </div>
      )}

      {/* SECTION 1: Credential Status & Operations */}
      <section className="panel-card mb-6">
        <div className="panel-header">
          <div>
            <h2 className="panel-title">凭据状态与有效期核对</h2>
            <p className="panel-desc">
              严格区分工作 Cookie 本地保存期限与根凭据有效期；
              {capabilities?.rootCredentialRenewal === false && (
                <strong>当前不支持根凭据长期自动续期，不承诺永久登录或永不掉号。</strong>
              )}
            </p>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={credOpBusy !== null}
              onClick={() => void handleStartCredOp('check')}
            >
              <RefreshCw size={14} className={credOpBusy === 'check' ? 'spin' : ''} />
              检查登录状态
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={credOpBusy !== null}
              onClick={() => void handleStartCredOp('refresh_cookie')}
            >
              <RefreshCw size={14} className={credOpBusy === 'refresh_cookie' ? 'spin' : ''} />
              重新获取工作 Cookie
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => openReloginAccount(account)}
            >
              <KeyRound size={14} /> 重新登录
            </button>
          </div>
        </div>

        <div className="telemetry-grid">
          <div className="telemetry-item">
            <span className="telemetry-label">工作凭据状态</span>
            <span className="telemetry-value">
              {CREDENTIAL_STATUS_LABELS[account.credential.status]}
            </span>
          </div>

          <div className="telemetry-item">
            <span className="telemetry-label">最近检查时间（注：不是最后续期时间）</span>
            <span className="telemetry-value mono">
              {formatShanghaiDateTime(account.credential.lastCheckedAt)}
            </span>
          </div>

          <div className="telemetry-item">
            <span className="telemetry-label">Cookie 保存期限（可能提前失效）</span>
            <span className="telemetry-value mono">
              {account.credential.cookieStorageExpiresAt ? (
                <>
                  <Clock size={13} style={{ display: 'inline', marginRight: 4 }} />
                  剩余 {formatRemainingDuration(account.credential.cookieStorageExpiresAt, nowMs)}
                  <div className="text-xs text-muted mt-1">
                    到期时间：{formatShanghaiDateTime(account.credential.cookieStorageExpiresAt)}（来源：
                    {account.credential.expirySource}，服务端可能提前使 Cookie 失效）
                  </div>
                </>
              ) : (
                '无有效保存期限'
              )}
            </span>
          </div>

          <div className="telemetry-item">
            <span className="telemetry-label">根凭据 (stoken_v2) 有效期</span>
            <span className="telemetry-value">
              {account.credential.rootExpiresAt ? (
                formatShanghaiDateTime(account.credential.rootExpiresAt)
              ) : (
                <strong>根凭据有效期未知（不计算虚假剩余天数）</strong>
              )}
            </span>
          </div>
        </div>

        {activeCredOp && (
          <div className="subtle-info-strip mt-3">
            <span>
              最近凭据操作 (<code>{activeCredOp.id.slice(0, 8)}...</code>)：类型{' '}
              <strong>
                {activeCredOp.kind === 'check' ? '检查登录状态' : '重新获取工作 Cookie'}
              </strong>{' '}
              · 状态 <code>{activeCredOp.state}</code>
              {activeCredOp.error ? ` · 错误：${activeCredOp.error.message}` : ''}
            </span>
          </div>
        )}
      </section>

      <GameBenefitsPanel
        key={account.id}
        accountId={account.id}
        enabled={taskKindsDraft.includes('game_sign')}
        selectedIds={gameRoleIdsDraft}
        busy={savingAccount || startingRun || !!account.activeRunId || !!account.activeCredentialOperationId}
        onEnabledChange={() => toggleTaskDraft('game_sign', !!capabilities?.tasks.some(t => t.kind === 'game_sign' && t.executable))}
        onSelectionChange={setGameRoleIdsDraft}
        onSave={() => void handleSaveAccountPreferences()}
        onSign={() => void handleImmediateGameRun()}
      />

      {/* SECTION 2: Miyoushe Coin Balance & Mission Snapshot */}
      <section className="panel-card mb-6">
        <div className="panel-header">
          <div>
            <div className="eyebrow-row">
              <span className={`badge ${missions?.stale ? 'badge-amber' : 'badge-jade'}`}>
                {missions?.stale ? '快照待刷新 (stale=true)' : '最新任务快照 (stale=false)'}
              </span>
              <span className="badge badge-slate mono">
                快照获取时间：{missions?.fetchedAt ? formatShanghaiDateTime(missions.fetchedAt) : '尚未获取'}
              </span>
            </div>
            <h2 className="panel-title">米游币余额与社区任务快照</h2>
            <p className="panel-desc">
              进入页面默认读取本地缓存快照，不自动请求官方接口；点击右侧「刷新任务」才向官方查询最新进度。
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={refreshingMissions}
            onClick={() => void handleRefreshMissions()}
          >
            <RefreshCw size={14} className={refreshingMissions ? 'spin' : ''} />
            {refreshingMissions ? '正在从官方查询...' : '刷新任务'}
          </button>
        </div>

        {missionsError && (
          <div className="alert-banner alert-danger mb-4" role="alert">
            <ShieldAlert size={18} />
            <div className="flex-1">
              <strong>刷新任务快照失败 ({missionsError.code})</strong>
              <p>{missionsError.message}</p>
            </div>
            {missionsError.code === 'ACCOUNT_REAUTH_REQUIRED' && (
              <div className="button-row">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void handleStartCredOp('refresh_cookie')}
                >
                  尝试重新获取工作 Cookie
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => openReloginAccount(account)}
                >
                  重新登录账号
                </button>
              </div>
            )}
          </div>
        )}

        {missions?.warnings && missions.warnings.length > 0 && (
          <div className="alert-banner alert-warning mb-4">
            <AlertTriangle size={18} />
            <div>
              <strong>快照提示</strong>
              <p>{missions.warnings.join('；')}</p>
            </div>
          </div>
        )}

        <div className="metric-grid metric-grid-3 mb-4">
          <div className="metric-card">
            <div className="metric-header">
              <span className="metric-label">当前米游币总余额</span>
              <Coins size={16} className="text-cobalt" />
            </div>
            <div className="metric-value mono" data-testid="mission-total-points">
              {missions?.totalPoints !== null && missions?.totalPoints !== undefined
                ? `${missions.totalPoints} 米游币`
                : '尚未获取'}
            </div>
            <div className="metric-foot">首次未知余额绝不伪造显示为 0</div>
          </div>

          <div className="metric-card">
            <div className="metric-header">
              <span className="metric-label">今日已获取米游币</span>
              <CheckCircle2 size={16} className="text-jade" />
            </div>
            <div className="metric-value mono" data-testid="mission-today-points">
              {missions?.todayReceivedPoints !== null && missions?.todayReceivedPoints !== undefined
                ? `${missions.todayReceivedPoints} 米游币`
                : '尚未获取'}
            </div>
            <div className="metric-foot">业务日期：{missions?.businessDate ?? '2026-10-23'}</div>
          </div>

          <div className="metric-card">
            <div className="metric-header">
              <span className="metric-label">上游 can_get_points 参考值</span>
              <Info size={16} className="text-muted" />
            </div>
            <div className="metric-value mono" data-testid="mission-can-get-points">
              {missions?.upstreamCanGetPoints !== null &&
              missions?.upstreamCanGetPoints !== undefined
                ? `${missions.upstreamCanGetPoints}`
                : '尚未获取'}
            </div>
            <div className="metric-foot">
              仅作上游字段参考，不直接代表所有任务剩余奖励总和
            </div>
          </div>
        </div>

        {missions && missions.missions.length > 0 ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>任务名称</th>
                  <th>上游 Mission ID / Key</th>
                  <th>进度</th>
                  <th>状态与到账核对</th>
                  <th>奖励米游币</th>
                  <th>能力可执行性</th>
                </tr>
              </thead>
              <tbody>
                {missions.missions.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.label}</strong>
                    </td>
                    <td className="mono text-xs">
                      {m.upstreamMissionId ?? '—'} / {m.key}
                    </td>
                    <td className="mono">
                      {m.progress} / {m.target ?? 1}
                    </td>
                    <td>
                      <span className={`badge ${m.completed ? 'badge-jade' : 'badge-slate'}`}>
                        {m.completed
                          ? m.rewardClaimed
                            ? '已完成 · 奖励已到账'
                            : '已完成 · 待领奖'
                          : '未完成'}
                      </span>
                    </td>
                    <td className="mono">
                      {m.rewardPoints !== null ? `+${m.rewardPoints}` : '未知'}
                    </td>
                    <td>
                      {m.executable ? (
                        <span className="badge badge-cobalt">已适配可执行</span>
                      ) : (
                        <span className="badge badge-slate">
                          待适配 ({m.blockedReason || '暂未开放'})
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-inline">
            <Info size={16} />
            <span>
              当前尚无任务明细快照（注意：缺少 <code>mission_id=58</code> 不能等同于“今日已签到”，请点击「刷新任务」或发起签到后由后端核对）。
            </span>
          </div>
        )}
      </section>

      {/* Two-Column Section: Task Preferences & Daily Schedule */}
      <div className="dashboard-columns">
        {/* SECTION 3: Capabilities-Driven Preferences & Account Settings */}
        <section className="panel-card">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">任务偏好与账号配置 (v{account.version})</h2>
              <p className="panel-desc">
                严格按实例能力目录 (<code>/capabilities</code>) 控制可选社区与任务；未验证适配器标记为「待适配」并禁用。
              </p>
            </div>
          </div>

          {/* Optimistic Lock Conflict Banner for Account */}
          {accountConflict && (
            <div className="alert-banner alert-warning mb-4" role="alert">
              <AlertTriangle size={18} />
              <div>
                <strong>检测到账号配置版本冲突 (409 VERSION_CONFLICT)</strong>
                <p>
                  其他窗口已将账号更新至 <code>v{accountConflict.latestServerAccount.version}</code>
                  （服务端最新备注：<code>{accountConflict.latestServerAccount.remark || '无'}</code>）。
                  系统不会自动覆盖最新值，请确认如何处理你的修改：
                </p>
                <div className="button-row mt-2">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() =>
                      void handleSaveAccountPreferences(accountConflict.latestServerAccount.version)
                    }
                  >
                    确认在最新 v{accountConflict.latestServerAccount.version} 基础上提交我的修改
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      syncAccountToDraft(accountConflict.latestServerAccount);
                      setAccountConflict(null);
                    }}
                  >
                    放弃本地修改并采用服务端最新值
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="form-stack">
            <div className="form-group">
              <label htmlFor="account-remark-input" className="form-label">
                账号备注 (最长 100 字符)
              </label>
              <input
                id="account-remark-input"
                type="text"
                maxLength={100}
                className="form-input"
                value={remarkDraft}
                onChange={(e) => setRemarkDraft(e.target.value)}
                placeholder="输入便于识别该米游社账号的备注"
              />
            </div>

            <div className="form-group">
              <span className="form-label">选择目标签到社区</span>
              <div className="capability-list">
                {communitiesList.map((c) => {
                  const checked = communityIdsDraft.includes(c.id);
                  return (
                    <label
                      key={c.id}
                      className={`capability-option ${!c.executable ? 'capability-disabled' : ''}`}
                    >
                      <div className="cap-opt-left">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!c.executable}
                          onChange={() => toggleCommunityDraft(c.id, c.executable)}
                        />
                        <strong>{c.name}</strong>
                        <span className="mono text-xs text-muted">(ID: {c.id})</span>
                      </div>
                      <div className="cap-opt-right">
                        {c.executable ? (
                          <span className="badge badge-jade">已实测可用</span>
                        ) : (
                          <span className="badge badge-slate">
                            待适配 · {c.blockedReason || '尚未验证'}
                          </span>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="form-group">
              <span className="form-label">
                选择每日任务（签到福利领取游戏奖励；社区签到领取米游币）
              </span>
              <div className="capability-list">
                {tasksList.map((t) => {
                  const checked = taskKindsDraft.includes(t.kind);
                  return (
                    <label
                      key={t.kind}
                      className={`capability-option ${!t.executable ? 'capability-disabled' : ''}`}
                    >
                      <div className="cap-opt-left">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!t.executable}
                          onChange={() => toggleTaskDraft(t.kind, t.executable)}
                        />
                        <div>
                          <strong>{t.label}</strong>{' '}
                          <span className="mono text-xs text-muted">({t.kind})</span>
                          {t.requiresExplicitOptIn && (
                            <span className="badge badge-amber ml-2">需显式开启 (Opt-in)</span>
                          )}
                          {t.blockedReason && (
                            <div className="text-xs text-muted mt-1">{t.blockedReason}</div>
                          )}
                        </div>
                      </div>
                      <div className="cap-opt-right">
                        {t.executable ? (
                          <span className="badge badge-jade">{t.verification === 'verified' ? '已实测可用' : '已适配'}</span>
                        ) : (
                          <span className="badge badge-slate">待适配禁用</span>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="form-group">
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={enabledDraft}
                  onChange={(e) => setEnabledDraft(e.target.checked)}
                />
                <span>启用该账号参与自动任务调度（关闭仅暂停定时任务，不退出账号登录）</span>
              </label>

              <label className="checkbox-inline mt-2">
                <input
                  type="checkbox"
                  checked={autoRefreshDraft}
                  onChange={(e) => setAutoRefreshDraft(e.target.checked)}
                />
                <span>允许任务前按需自动换取工作 Cookie（失败时不无限循环重试）</span>
              </label>
            </div>

            <div className="form-actions-row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={savingAccount}
                onClick={() => void handleSaveAccountPreferences()}
              >
                <Save size={15} />
                {savingAccount ? '正在保存账号配置...' : '保存账号任务偏好'}
              </button>
            </div>
          </div>
        </section>

        {/* SECTION 4: Daily Schedule (Fixed Asia/Shanghai + 0-10m Jitter) */}
        <section className="panel-card">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">每日定时计划 (v{schedule?.version ?? 1})</h2>
              <p className="panel-desc">
                新账号默认关闭计划。使用直观的时/分选择器，固定上海时区 (<code>Asia/Shanghai</code>)，自动附带 0–10 分钟随机错峰窗口。
              </p>
            </div>
          </div>

          {scheduleConflict && (
            <div className="alert-banner alert-warning mb-4" role="alert">
              <AlertTriangle size={18} />
              <div>
                <strong>检测到计划版本冲突 (409 VERSION_CONFLICT)</strong>
                <p>
                  服务端计划已更新至 <code>v{scheduleConflict.latestServerSchedule.version}</code>（最新时间：
                  {formatPadTwo(scheduleConflict.latestServerSchedule.hour)}:
                  {formatPadTwo(scheduleConflict.latestServerSchedule.minute)}）。请确认是否覆盖提交：
                </p>
                <div className="button-row mt-2">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() =>
                      void handleSaveSchedule(scheduleConflict.latestServerSchedule.version)
                    }
                  >
                    确认在最新 v{scheduleConflict.latestServerSchedule.version} 上保存修改
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      syncScheduleToDraft(scheduleConflict.latestServerSchedule);
                      setScheduleConflict(null);
                    }}
                  >
                    采用服务端最新计划
                  </button>
                </div>
              </div>
            </div>
          )}

          {schedule && (
            <div className="form-stack">
              <div className="telemetry-grid">
                <div className="telemetry-item">
                  <span className="telemetry-label">固定调度时区</span>
                  <span className="telemetry-value mono">{schedule.timezone} (北京时间)</span>
                </div>
                <div className="telemetry-item">
                  <span className="telemetry-label">随机错峰窗口</span>
                  <span className="telemetry-value mono">
                    0 – {schedule.jitterMaxMinutes} 分钟 (防整点并发峰值)
                  </span>
                </div>
                <div className="telemetry-item">
                  <span className="telemetry-label">下次预计触发时间 (nextRunAt)</span>
                  <span className="telemetry-value mono">
                    {schedule.nextRunAt
                      ? formatShanghaiDateTime(schedule.nextRunAt)
                      : '暂无排期 (nextRunAt = null)'}
                  </span>
                </div>
              </div>

              {!schedule.nextRunAt && (
                <div className="subtle-info-strip">
                  <span>
                    说明：当每日计划未开启、账号被暂停自动调度，或在系统设置中开启了「全局暂停调度」时，实际{' '}
                    <code>nextRunAt</code> 为 <code>null</code>，但你设定的时/分参数仍会完整保留。
                  </span>
                </div>
              )}

              <div className="form-group">
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={schedEnabledDraft}
                    onChange={(e) => setSchedEnabledDraft(e.target.checked)}
                  />
                  <strong>开启该账号每日自动签到计划</strong>
                </label>
              </div>

              <div className="time-picker-row">
                <div className="form-group flex-1">
                  <label htmlFor="sched-hour-select" className="form-label">
                    每日执行小时 (00 – 23 时)
                  </label>
                  <select
                    id="sched-hour-select"
                    className="form-select mono"
                    value={schedHourDraft}
                    onChange={(e) => setSchedHourDraft(Number(e.target.value))}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>
                        {formatPadTwo(h)} 时
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group flex-1">
                  <label htmlFor="sched-minute-select" className="form-label">
                    每日执行分钟 (00 – 59 分)
                  </label>
                  <select
                    id="sched-minute-select"
                    className="form-select mono"
                    value={schedMinuteDraft}
                    onChange={(e) => setSchedMinuteDraft(Number(e.target.value))}
                  >
                    {Array.from({ length: 60 }, (_, m) => (
                      <option key={m} value={m}>
                        {formatPadTwo(m)} 分
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="text-xs text-muted">
                <Calendar size={13} style={{ display: 'inline', marginRight: 4 }} />
                计划窗口预览：每日北京时间{' '}
                <strong className="mono">
                  {formatPadTwo(schedHourDraft)}:{formatPadTwo(schedMinuteDraft)}
                </strong>{' '}
                起 + 0~10 分钟随机错峰执行。
              </div>

              <div className="form-actions-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={savingSchedule}
                  onClick={() => void handleSaveSchedule()}
                >
                  <Save size={15} />
                  {savingSchedule ? '正在保存每日计划...' : '保存每日计划配置'}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
