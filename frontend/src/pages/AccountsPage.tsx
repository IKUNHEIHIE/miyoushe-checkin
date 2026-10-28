import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  PlusCircle,
  RefreshCw,
  ShieldAlert,
  KeyRound,
  Trash2,
  CheckSquare,
  Play,
  ExternalLink,
  Clock,
  CheckCircle2,
  AlertTriangle
} from 'lucide-react';
import { apiClient, ApiClientError } from '../api/client';
import { useApp } from '../context/AppContext';
import {
  type Account,
  ACCOUNT_STATUS_LABELS,
  type AccountStatus,
  CREDENTIAL_STATUS_LABELS,
  type CredentialOperationKind
} from '../types/openapi';
import {
  formatRemainingDuration,
  formatShanghaiDateTime,
  generateIdempotencyKey,
  getNowMs
} from '../utils/format';

interface BatchItemResult {
  accountId: string;
  nickname: string;
  phoneMasked: string;
  outcome: 'succeeded' | 'awaiting_verification' | 'failed';
  detail: string;
  challengeId?: string | null;
}

export const AccountsPage: React.FC = () => {
  const {
    capabilities,
    openAddAccount,
    openReloginAccount,
    enqueueChallenge,
    pushToast,
    accountsVersionTrigger
  } = useApp();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiClientError | null>(null);
  const [statusFilter, setStatusFilter] = useState<AccountStatus | ''>('');
  const [enabledFilter, setEnabledFilter] = useState<string>('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busyAccountMap, setBusyAccountMap] = useState<Record<string, string>>({});
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchSummary, setBatchSummary] = useState<{
    actionLabel: string;
    results: BatchItemResult[];
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => getNowMs());

  useEffect(() => {
    const t = setInterval(() => setNowMs(getNowMs()), 5000);
    return () => clearInterval(t);
  }, []);

  const updateAccountInList = useCallback((updated: Account) => {
    setAccounts((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  }, []);

  // Poll a CredentialOperation until terminal or awaiting_verification
  const pollCredentialOpUntilSettled = useCallback(
    async (
      operationId: string,
      accountNickname: string,
      openModalOnChallenge = true
    ): Promise<{
      outcome: 'succeeded' | 'awaiting_verification' | 'failed';
      detail: string;
      challengeId?: string | null;
    }> => {
      for (let attempt = 0; attempt < 15; attempt++) {
        const res = await apiClient.getCredentialOperation(operationId);
        const op = res.data;
        updateAccountInList(op.account);

        if (op.state === 'succeeded') {
          return {
            outcome: 'succeeded',
            detail:
              op.kind === 'check'
                ? '登录状态检查通过，当前凭据有效'
                : '已重新获取工作 Cookie（注意：不代表根凭据永久续期）'
          };
        }
        if (op.state === 'awaiting_verification') {
          if (openModalOnChallenge && op.challengeId) {
            enqueueChallenge({
              challengeId: op.challengeId,
              contextLabel: `${accountNickname} · ${op.kind === 'check' ? '检查登录状态' : '更新工作 Cookie'}`,
              onAccepted: () => {
                void pollCredentialOpUntilSettled(operationId, accountNickname, true);
              }
            });
          }
          return {
            outcome: 'awaiting_verification',
            detail: '需要手动完成人机验证',
            challengeId: op.challengeId
          };
        }
        if (op.state === 'failed' || op.state === 'canceled') {
          return {
            outcome: 'failed',
            detail: op.error?.message ?? '凭据操作未通过，请重新登录账号'
          };
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      return {
        outcome: 'failed',
        detail: '凭据操作轮询超时，请刷新状态查看'
      };
    },
    [enqueueChallenge, updateAccountInList]
  );

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiClient.listAccounts({
        limit: 50,
        status: statusFilter || undefined,
        enabled:
          enabledFilter === 'true' ? true : enabledFilter === 'false' ? false : undefined
      });
      setAccounts(res.data.items);

      // Recovery on page refresh: inspect activeCredentialOperationId for any account in verification_required
      for (const acc of res.data.items) {
        if (acc.activeCredentialOperationId && acc.status === 'verification_required') {
          void apiClient
            .getCredentialOperation(acc.activeCredentialOperationId)
            .then((opRes) => {
              updateAccountInList(opRes.data.account);
            })
            .catch(() => {});
        }
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err);
      }
    } finally {
      setLoading(false);
    }
  }, [enabledFilter, statusFilter, updateAccountInList]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts, accountsVersionTrigger]);

  const handleToggleEnabled = async (acc: Account) => {
    if (busyAccountMap[acc.id]) return;
    setBusyAccountMap((prev) => ({ ...prev, [acc.id]: 'toggle' }));
    try {
      const res = await apiClient.updateAccount(acc.id, {
        version: acc.version,
        enabled: !acc.enabled
      });
      updateAccountInList(res.data);
      pushToast({
        type: 'success',
        title: res.data.enabled ? `已启用「${acc.nickname}」自动调度` : `已暂停「${acc.nickname}」自动调度`,
        message: '暂停自动任务调度仅停止定时触发，不等于退出该米游社账号登录。'
      });
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === 'VERSION_CONFLICT') {
          pushToast({
            type: 'warning',
            title: '检测到账号版本冲突 (409 VERSION_CONFLICT)',
            message: '已为您重新同步最新账号数据，请核对后再次操作。',
            requestId: err.requestId
          });
          await loadAccounts();
        } else {
          pushToast({
            type: 'error',
            title: `更新失败 (${err.code})`,
            message: err.message,
            requestId: err.requestId
          });
        }
      }
    } finally {
      setBusyAccountMap((prev) => {
        const next = { ...prev };
        delete next[acc.id];
        return next;
      });
    }
  };

  const handleSingleCredentialOp = async (acc: Account, kind: CredentialOperationKind) => {
    if (busyAccountMap[acc.id]) return;
    setBusyAccountMap((prev) => ({ ...prev, [acc.id]: kind }));
    try {
      const startRes = await apiClient.startCredentialOperation(
        acc.id,
        { kind },
        generateIdempotencyKey()
      );
      updateAccountInList(startRes.data.account);

      const settled = await pollCredentialOpUntilSettled(startRes.data.id, acc.nickname, true);
      if (settled.outcome === 'succeeded') {
        pushToast({
          type: 'success',
          title: `${acc.nickname}：${kind === 'check' ? '检查登录状态完成' : '工作 Cookie 已更新'}`,
          message: settled.detail
        });
      } else if (settled.outcome === 'failed') {
        pushToast({
          type: 'error',
          title: `${acc.nickname}：操作未通过`,
          message: settled.detail
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
      setBusyAccountMap((prev) => {
        const next = { ...prev };
        delete next[acc.id];
        return next;
      });
    }
  };

  const handleOpenPendingVerification = async (acc: Account) => {
    if (acc.activeCredentialOperationId) {
      try {
        const opRes = await apiClient.getCredentialOperation(acc.activeCredentialOperationId);
        if (opRes.data.challengeId) {
          enqueueChallenge({
            challengeId: opRes.data.challengeId,
            contextLabel: `${acc.nickname} · 凭据操作`,
            onAccepted: () => {
              void pollCredentialOpUntilSettled(opRes.data.id, acc.nickname, true);
            }
          });
          return;
        }
      } catch {
        // Ignore and check activeRunId
      }
    }
    if (acc.activeRunId) {
      try {
        const runRes = await apiClient.getRun(acc.activeRunId);
        if (runRes.data.challengeId) {
          enqueueChallenge({
            challengeId: runRes.data.challengeId,
            contextLabel: `${acc.nickname} · 社区签到`,
            onAccepted: () => void loadAccounts()
          });
          return;
        }
      } catch {
        // Ignore
      }
    }
    pushToast({
      type: 'info',
      title: '未找到待验证会话',
      message: '请点击「检查登录状态」或「重新获取工作 Cookie」发起操作。'
    });
  };

  // Batch Operations: execute per accountId individually, summarize every result, never mask partial failure as "all succeeded", queue challenges sequentially!
  const handleBatchOperation = async (action: 'check' | 'refresh_cookie' | 'run_sign') => {
    const selectedAccounts = accounts.filter((a) => selectedIds.has(a.id));
    if (selectedAccounts.length === 0 || batchRunning) return;

    setBatchRunning(true);
    const results: BatchItemResult[] = [];
    const actionLabel =
      action === 'check'
        ? '批量检查登录状态'
        : action === 'refresh_cookie'
          ? '批量重新获取工作 Cookie'
          : '批量立即执行签到';

    for (const acc of selectedAccounts) {
      try {
        if (action === 'check' || action === 'refresh_cookie') {
          const startRes = await apiClient.startCredentialOperation(
            acc.id,
            { kind: action },
            generateIdempotencyKey()
          );
          // Do not auto-open challenge inside loop; enqueue sequentially via enqueueChallenge!
          const settled = await pollCredentialOpUntilSettled(startRes.data.id, acc.nickname, false);
          if (settled.outcome === 'awaiting_verification' && settled.challengeId) {
            enqueueChallenge({
              challengeId: settled.challengeId,
              contextLabel: `${acc.nickname} (${actionLabel})`,
              onAccepted: () => {
                void pollCredentialOpUntilSettled(startRes.data.id, acc.nickname, false);
              }
            });
          }
          results.push({
            accountId: acc.id,
            nickname: acc.nickname,
            phoneMasked: acc.phoneMasked,
            outcome: settled.outcome,
            detail: settled.detail,
            challengeId: settled.challengeId
          });
        } else {
          const runRes = await apiClient.createAccountRun(
            acc.id,
            {
              communityIds: acc.communityIds.length > 0 ? acc.communityIds : [2],
              taskKinds: acc.taskKinds.length > 0 ? acc.taskKinds : ['community_sign']
            },
            generateIdempotencyKey()
          );
          const polledRun = await apiClient.getRun(runRes.data.id);
          const rData = polledRun.data;
          if (rData.state === 'awaiting_verification' && rData.challengeId) {
            enqueueChallenge({
              challengeId: rData.challengeId,
              contextLabel: `${acc.nickname} · 批量签到`,
              onAccepted: () => void loadAccounts()
            });
            results.push({
              accountId: acc.id,
              nickname: acc.nickname,
              phoneMasked: acc.phoneMasked,
              outcome: 'awaiting_verification',
              detail: '任务暂停，等待你手动完成人机验证',
              challengeId: rData.challengeId
            });
          } else if (rData.state === 'succeeded') {
            results.push({
              accountId: acc.id,
              nickname: acc.nickname,
              phoneMasked: acc.phoneMasked,
              outcome: 'succeeded',
              detail: `已确认完成（本次确认到账 +${rData.confirmedRewardPoints} 米游币）`
            });
          } else {
            results.push({
              accountId: acc.id,
              nickname: acc.nickname,
              phoneMasked: acc.phoneMasked,
              outcome: 'failed',
              detail: rData.error?.message ?? `当前状态：${rData.state}`
            });
          }
        }
      } catch (err) {
        results.push({
          accountId: acc.id,
          nickname: acc.nickname,
          phoneMasked: acc.phoneMasked,
          outcome: 'failed',
          detail: err instanceof ApiClientError ? `${err.message} (${err.code})` : '请求失败'
        });
      }
    }

    setBatchSummary({ actionLabel, results });
    setBatchRunning(false);
    await loadAccounts();
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await apiClient.deleteAccount(deleteTarget.id, generateIdempotencyKey());
      pushToast({
        type: 'success',
        title: `已删除本地账号「${deleteTarget.nickname}」`,
        message: '本实例中的凭据与每日计划已移除（米哈游官方账号不受影响）。'
      });
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget.id);
        return next;
      });
      setDeleteTarget(null);
      await loadAccounts();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setDeleteError(`${err.message} (${err.code}, RequestId: ${err.requestId})`);
      } else {
        setDeleteError('删除失败，请稍后重试');
      }
    } finally {
      setDeleting(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === accounts.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(accounts.map((a) => a.id)));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <div className="eyebrow-row">
            <span className="badge badge-cobalt">多账号隔离管理</span>
            {capabilities?.rootCredentialRenewal === false && (
              <span className="badge badge-slate">
                不支持根凭据长期自动续期 · 不承诺永不掉号
              </span>
            )}
          </div>
          <h1 className="page-title">米游社账号列表</h1>
          <p className="page-subtitle">
            管理本实例下的多个米游社账号。注意：<strong>自动调度启用开关</strong>与<strong>账号登录凭据状态</strong>相互独立；暂停自动任务不等于退出登录。
          </p>
        </div>

        <div className="button-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loading}
            onClick={() => void loadAccounts()}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} /> 刷新列表
          </button>
          <button type="button" className="btn btn-primary" onClick={openAddAccount}>
            <PlusCircle size={16} /> 添加米游社账号
          </button>
        </div>
      </div>

      {/* Filters & Batch Toolbar */}
      <div className="toolbar-card mb-5">
        <div className="toolbar-filters">
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={accounts.length > 0 && selectedIds.size === accounts.length}
              onChange={toggleSelectAll}
              disabled={accounts.length === 0}
            />
            <span>全选 ({selectedIds.size}/{accounts.length})</span>
          </label>

          <select
            aria-label="按登录状态筛选"
            className="form-select form-select-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as AccountStatus | '')}
          >
            <option value="">全部登录状态</option>
            <option value="active">登录有效 (active)</option>
            <option value="reauth_required">需要重新登录 (reauth_required)</option>
            <option value="verification_required">等待人工验证 (verification_required)</option>
            <option value="unknown">状态待检查 (unknown)</option>
          </select>

          <select
            aria-label="按自动调度启用状态筛选"
            className="form-select form-select-sm"
            value={enabledFilter}
            onChange={(e) => setEnabledFilter(e.target.value)}
          >
            <option value="">全部调度开关状态</option>
            <option value="true">已开启自动调度</option>
            <option value="false">已暂停自动调度</option>
          </select>
        </div>

        <div className="toolbar-batch">
          <span className="text-xs text-muted">
            批量操作（逐个调用并汇总明细，验证依次弹出）：
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={selectedIds.size === 0 || batchRunning}
            onClick={() => void handleBatchOperation('check')}
          >
            <CheckSquare size={14} /> 检查登录状态
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={selectedIds.size === 0 || batchRunning}
            onClick={() => void handleBatchOperation('refresh_cookie')}
          >
            <RefreshCw size={14} /> 重新获取工作 Cookie
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={selectedIds.size === 0 || batchRunning}
            onClick={() => void handleBatchOperation('run_sign')}
          >
            <Play size={14} /> 批量立即签到
          </button>
        </div>
      </div>

      {/* Batch Execution Detailed Summary Banner (Never claims "all succeeded" when partial failure or verification exists) */}
      {batchSummary && (
        <div className="panel-card mb-5" role="region" aria-label="批量操作汇总结果">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                {batchSummary.actionLabel} · 逐账号执行结果汇总
              </h2>
              <p className="panel-desc">
                成功：{batchSummary.results.filter((r) => r.outcome === 'succeeded').length} 项 ·
                等待验证：{batchSummary.results.filter((r) => r.outcome === 'awaiting_verification').length} 项 ·
                失败：{batchSummary.results.filter((r) => r.outcome === 'failed').length} 项
                （绝不以“全部成功”掩盖部分失败或待验证项）
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setBatchSummary(null)}
            >
              收起汇总
            </button>
          </div>
          <div className="item-stack">
            {batchSummary.results.map((item) => (
              <div key={item.accountId} className="attention-row">
                <div>
                  <strong>{item.nickname}</strong>{' '}
                  <span className="mono text-xs text-muted">({item.phoneMasked})</span>
                  <div className="text-sm mt-1">{item.detail}</div>
                </div>
                <span
                  className={`badge ${
                    item.outcome === 'succeeded'
                      ? 'badge-jade'
                      : item.outcome === 'awaiting_verification'
                        ? 'badge-amber'
                        : 'badge-crimson'
                  }`}
                >
                  {item.outcome === 'succeeded' && <CheckCircle2 size={13} />}
                  {item.outcome === 'awaiting_verification' && <ShieldAlert size={13} />}
                  {item.outcome === 'failed' && <AlertTriangle size={13} />}
                  {item.outcome === 'succeeded'
                    ? '已确认成功'
                    : item.outcome === 'awaiting_verification'
                      ? '等待人工验证'
                      : '未通过/失败'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="alert-banner alert-danger mb-5" role="alert">
          <ShieldAlert size={18} />
          <div>
            <strong>读取账号列表失败 ({error.code})</strong>
            <p>{error.message}</p>
            <div className="mono text-xs mt-1">RequestId: {error.requestId}</div>
          </div>
        </div>
      )}

      {loading && accounts.length === 0 && (
        <div className="state-box">
          <RefreshCw className="spin" size={20} />
          <span>正在加载账号列表...</span>
        </div>
      )}

      {!loading && accounts.length === 0 && (
        <div className="empty-hero-card">
          <h3>当前筛选条件下没有米游社账号</h3>
          <p>你可以点击上方「添加米游社账号」通过手机号短信验证绑定新账号。</p>
          <button type="button" className="btn btn-primary mt-3" onClick={openAddAccount}>
            <PlusCircle size={16} /> 添加米游社账号
          </button>
        </div>
      )}

      {/* Account Cards List */}
      <div className="account-cards-grid">
        {accounts.map((acc) => {
          const busy = busyAccountMap[acc.id];
          return (
            <article key={acc.id} className="account-card">
              <div className="account-card-top">
                <div className="account-identity">
                  <input
                    type="checkbox"
                    aria-label={`选择账号 ${acc.nickname}`}
                    checked={selectedIds.has(acc.id)}
                    onChange={() => toggleSelectOne(acc.id)}
                  />
                  <div>
                    <div className="account-title-row">
                      <Link to={`/accounts/${acc.id}`} className="account-name-link">
                        {acc.nickname}
                      </Link>
                      <span className={`badge badge-status-${acc.status}`}>
                        {ACCOUNT_STATUS_LABELS[acc.status]}
                      </span>
                    </div>
                    <div className="account-meta-row mono">
                      <span>手机号: {acc.phoneMasked}</span>
                      <span>·</span>
                      <span>通行证 ID (aid): {acc.uid}</span>
                    </div>
                  </div>
                </div>

                {/* Independent Schedule Enabled Toggle */}
                <div className="schedule-switch-box">
                  <label className="switch-label" title="暂停自动任务不等于退出账号登录">
                    <span className="switch-text">
                      {acc.enabled ? '自动任务已启用' : '自动任务已暂停'}
                    </span>
                    <input
                      type="checkbox"
                      checked={acc.enabled}
                      disabled={Boolean(busy)}
                      onChange={() => void handleToggleEnabled(acc)}
                    />
                  </label>
                </div>
              </div>

              {acc.remark && <p className="account-remark">备注：{acc.remark}</p>}

              {/* Dual-Track Credential Telemetry Gauge */}
              <div className="credential-telemetry-box">
                <div className="cred-item">
                  <span className="cred-label">凭据状态</span>
                  <span className="cred-value">{CREDENTIAL_STATUS_LABELS[acc.credential.status]}</span>
                </div>
                <div className="cred-item">
                  <span className="cred-label">最近检查时间（非续期时间）</span>
                  <span className="cred-value mono">
                    {formatShanghaiDateTime(acc.credential.lastCheckedAt)}
                  </span>
                </div>
                <div className="cred-item">
                  <span className="cred-label">Cookie 保存期限（可能提前失效）</span>
                  <span className="cred-value mono">
                    {acc.credential.cookieStorageExpiresAt ? (
                      <>
                        <Clock size={12} style={{ display: 'inline', marginRight: 4 }} />
                        {formatRemainingDuration(acc.credential.cookieStorageExpiresAt, nowMs)} (至{' '}
                        {formatShanghaiDateTime(acc.credential.cookieStorageExpiresAt)})
                      </>
                    ) : (
                      '无有效 Cookie 保存期限'
                    )}
                  </span>
                </div>
                <div className="cred-item">
                  <span className="cred-label">根凭据 (stoken_v2) 有效期</span>
                  <span className="cred-value text-muted">
                    {acc.credential.rootExpiresAt
                      ? formatShanghaiDateTime(acc.credential.rootExpiresAt)
                      : '根凭据有效期未知（不计算虚假天数）'}
                  </span>
                </div>
              </div>

              {/* Action Buttons Row */}
              <div className="account-card-actions">
                <div className="button-row">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={Boolean(busy)}
                    onClick={() => void handleSingleCredentialOp(acc, 'check')}
                  >
                    <RefreshCw size={13} className={busy === 'check' ? 'spin' : ''} />
                    检查登录状态
                  </button>

                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={Boolean(busy)}
                    onClick={() => void handleSingleCredentialOp(acc, 'refresh_cookie')}
                  >
                    <RefreshCw size={13} className={busy === 'refresh_cookie' ? 'spin' : ''} />
                    重新获取工作 Cookie
                  </button>

                  {acc.status === 'reauth_required' ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => openReloginAccount(acc)}
                    >
                      <KeyRound size={13} /> 重新登录账号
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => openReloginAccount(acc)}
                    >
                      <KeyRound size={13} /> 重新登录
                    </button>
                  )}

                  {(acc.status === 'verification_required' ||
                    acc.activeCredentialOperationId ||
                    acc.activeRunId) && (
                    <button
                      type="button"
                      className="btn btn-amber btn-sm"
                      onClick={() => void handleOpenPendingVerification(acc)}
                    >
                      <ShieldAlert size={13} /> 完成人工验证
                    </button>
                  )}
                </div>

                <div className="button-row">
                  <Link to={`/accounts/${acc.id}`} className="btn btn-primary btn-sm">
                    账号详情与计划 <ExternalLink size={13} />
                  </Link>
                  <button
                    type="button"
                    className="btn btn-danger-outline btn-sm"
                    onClick={() => {
                      setDeleteError(null);
                      setDeleteTarget(acc);
                    }}
                    aria-label={`删除账号 ${acc.nickname}`}
                  >
                    <Trash2 size={14} /> 删除
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {/* Explicit Delete Confirmation Modal */}
      {deleteTarget && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-account-modal-title"
        >
          <div className="modal-card modal-card-sm">
            <div className="modal-header">
              <h2 id="delete-account-modal-title" className="modal-title">
                确认删除本地账号「{deleteTarget.nickname}」？
              </h2>
            </div>
            <div className="modal-body">
              <div className="alert-banner alert-warning">
                <AlertTriangle size={18} />
                <div>
                  <strong>重要说明</strong>
                  <p>
                    <strong>仅删除本实例中的账号、凭据和计划，不删除米哈游账号。</strong>
                    如果该账号当前有正在运行的签到任务或凭据操作，后端将返回 409 ACCOUNT_BUSY 拒绝删除。
                  </p>
                </div>
              </div>

              <div className="telemetry-grid mt-3">
                <div className="telemetry-item">
                  <span className="telemetry-label">账号昵称</span>
                  <span className="telemetry-value">{deleteTarget.nickname}</span>
                </div>
                <div className="telemetry-item">
                  <span className="telemetry-label">脱敏手机号 / 通行证 ID</span>
                  <span className="telemetry-value mono">
                    {deleteTarget.phoneMasked} / {deleteTarget.uid}
                  </span>
                </div>
              </div>

              {deleteError && (
                <div className="alert-banner alert-danger mt-3" role="alert">
                  <ShieldAlert size={18} />
                  <div>
                    <strong>无法删除账号</strong>
                    <p>{deleteError}</p>
                  </div>
                </div>
              )}
            </div>
            <div className="modal-footer">
              <span className="footer-note">此操作不可撤销，重新使用需再次短信登录。</span>
              <div className="footer-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={deleting}
                  onClick={() => setDeleteTarget(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={deleting}
                  onClick={() => void handleConfirmDelete()}
                >
                  <Trash2 size={14} />
                  {deleting ? '正在删除...' : '确认删除本地数据'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
