import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  RefreshCw,
  ShieldAlert,
  RotateCcw,
  Ban,
  Terminal,
  Coins,
  KeyRound,
  AlertTriangle
} from 'lucide-react';
import { apiClient, ApiClientError } from '../api/client';
import { useApp } from '../context/AppContext';
import {
  type Account,
  COMMUNITY_NAME_FALLBACK,
  type Run,
  RUN_STATE_LABELS,
  type RunEvent,
  type RunState,
  STEP_STATE_LABELS,
  TASK_KIND_LABELS
} from '../types/openapi';
import { formatShanghaiDateTime, generateIdempotencyKey } from '../utils/format';

const TERMINAL_RUN_STATES: RunState[] = [
  'succeeded',
  'partially_succeeded',
  'failed',
  'outcome_unknown',
  'canceled'
];

export const RunsPage: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedRunIdParam = searchParams.get('runId');

  const {
    capabilities,
    enqueueChallenge,
    openReloginAccount,
    pushToast,
    accountsVersionTrigger
  } = useApp();

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);

  // Filters
  const [accountFilter, setAccountFilter] = useState<string>('');
  const [stateFilter, setStateFilter] = useState<RunState | ''>('');
  const [dateFromFilter, setDateFromFilter] = useState<string>('');
  const [dateToFilter, setDateToFilter] = useState<string>('');

  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [actionBusy, setActionBusy] = useState<'retry' | 'cancel' | null>(null);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  const [error, setError] = useState<ApiClientError | null>(null);

  const retryKeyRef = useRef<string>(generateIdempotencyKey());
  const cancelKeyRef = useRef<string>(generateIdempotencyKey());
  const pollStartedAtRef = useRef<number>(Date.now());

  const mergeEventsDedup = useCallback((incoming: RunEvent[]) => {
    setEvents((prev) => {
      const map = new Map<string, RunEvent>();
      for (const item of prev) map.set(item.id, item);
      for (const item of incoming) map.set(item.id, item);
      return Array.from(map.values()).sort(
        (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
      );
    });
  }, []);

  const loadRunDetailAndEvents = useCallback(
    async (runId: string, resetEvents = false) => {
      if (resetEvents) {
        setLoadingDetail(true);
        setEvents([]);
        pollStartedAtRef.current = Date.now();
      }
      try {
        const [runRes, evtRes] = await Promise.all([
          apiClient.getRun(runId),
          apiClient.listRunEvents(runId, { limit: 50 })
        ]);
        const rData = runRes.data;
        setSelectedRun(rData);
        setRuns((prev) => prev.map((r) => (r.id === rData.id ? rData : r)));
        if (resetEvents) {
          setEvents(evtRes.data.items);
        } else {
          mergeEventsDedup(evtRes.data.items);
        }
      } catch (err) {
        if (err instanceof ApiClientError) {
          setError(err);
        }
      } finally {
        if (resetEvents) {
          setLoadingDetail(false);
        }
      }
    },
    [mergeEventsDedup]
  );

  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const [accRes, runsRes] = await Promise.all([
        apiClient.listAccounts({ limit: 50 }),
        apiClient.listRuns({
          limit: 50,
          accountId: accountFilter || undefined,
          state: stateFilter || undefined,
          dateFrom: dateFromFilter || undefined,
          dateTo: dateToFilter || undefined
        })
      ]);
      setAccounts(accRes.data.items);
      const list = runsRes.data.items;
      setRuns(list);

      const targetId = selectedRunIdParam || list[0]?.id;
      if (targetId) {
        await loadRunDetailAndEvents(targetId, true);
      } else {
        setSelectedRun(null);
        setEvents([]);
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err);
      }
    } finally {
      setLoadingList(false);
    }
  }, [accountFilter, dateFromFilter, dateToFilter, loadRunDetailAndEvents, selectedRunIdParam, stateFilter]);

  useEffect(() => {
    void loadList();
  }, [loadList, accountsVersionTrigger]);

  // Adaptive Polling: 2s for first 30s, then 5s; pause when document hidden; stop on terminal state!
  useEffect(() => {
    if (!selectedRun) return;
    if (TERMINAL_RUN_STATES.includes(selectedRun.state)) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const scheduleNextTick = () => {
      if (cancelled) return;
      const elapsedMs = Date.now() - pollStartedAtRef.current;
      const intervalMs = elapsedMs > 30000 ? 5000 : 2000;

      timer = setTimeout(async () => {
        if (cancelled) return;
        if (document.visibilityState !== 'hidden') {
          await loadRunDetailAndEvents(selectedRun.id, false);
        }
        scheduleNextTick();
      }, intervalMs);
    };

    scheduleNextTick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [selectedRun?.id, selectedRun?.state, loadRunDetailAndEvents]);

  const handleSelectRun = (run: Run) => {
    setSearchParams({ runId: run.id });
    void loadRunDetailAndEvents(run.id, true);
  };

  const handleRetryRun = async () => {
    if (!selectedRun || actionBusy) return;
    setActionBusy('retry');
    try {
      const res = await apiClient.retryRun(selectedRun.id, retryKeyRef.current);
      retryKeyRef.current = generateIdempotencyKey();
      const newRun = res.data;
      setRuns((prev) => [newRun, ...prev.filter((r) => r.id !== newRun.id)]);
      setSearchParams({ runId: newRun.id });
      await loadRunDetailAndEvents(newRun.id, true);
      pushToast({
        type: 'info',
        title: '已创建安全重试任务',
        message: `新任务 (${newRun.id.slice(0, 8)}...) 将先对账并跳过已确认成功步骤，不盲目重复写入。`
      });
    } catch (err) {
      retryKeyRef.current = generateIdempotencyKey();
      if (err instanceof ApiClientError) {
        pushToast({
          type: 'error',
          title: `重试请求被拒绝 (${err.code})`,
          message: err.message,
          requestId: err.requestId
        });
      }
    } finally {
      setActionBusy(null);
    }
  };

  const handleCancelRun = async () => {
    if (!selectedRun || actionBusy) return;
    setActionBusy('cancel');
    try {
      const res = await apiClient.cancelRun(selectedRun.id, cancelKeyRef.current);
      cancelKeyRef.current = generateIdempotencyKey();
      setCancelConfirmOpen(false);
      setSelectedRun(res.data);
      setRuns((prev) => prev.map((r) => (r.id === res.data.id ? res.data : r)));
      await loadRunDetailAndEvents(res.data.id, false);
      pushToast({
        type: 'warning',
        title: '已停止后续任务步骤',
        message: '注意：取消操作仅停止尚未执行的后续步骤，已完成的上游签到或写入不会回滚。'
      });
    } catch (err) {
      cancelKeyRef.current = generateIdempotencyKey();
      if (err instanceof ApiClientError) {
        pushToast({
          type: 'error',
          title: `无法取消任务 (${err.code})`,
          message: err.message,
          requestId: err.requestId
        });
      }
    } finally {
      setActionBusy(null);
    }
  };

  const getCommunityName = (cid: number) => {
    return (
      capabilities?.communities.find((c) => c.id === cid)?.name ??
      COMMUNITY_NAME_FALLBACK[cid] ??
      `社区 #${cid}`
    );
  };

  const selectedAccount = selectedRun
    ? accounts.find((a) => a.id === selectedRun.accountId)
    : undefined;

  const canRetry =
    selectedRun &&
    ['failed', 'partially_succeeded', 'outcome_unknown'].includes(selectedRun.state);

  const canCancel =
    selectedRun &&
    ['queued', 'running', 'awaiting_verification'].includes(selectedRun.state);

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <div className="eyebrow-row">
            <span className="badge badge-cobalt">执行审计与步骤追踪</span>
            <span className="badge badge-slate">运行中 2s/5s 自适应轮询 · 离开页面不取消后台任务</span>
          </div>
          <h1 className="page-title">执行记录与脱敏日志</h1>
          <p className="page-subtitle">
            核对每一次手动或定时签到的步骤结果、确认到账收益与脱敏事件日志。
          </p>
        </div>

        <button
          type="button"
          className="btn btn-secondary"
          disabled={loadingList}
          onClick={() => void loadList()}
        >
          <RefreshCw size={15} className={loadingList ? 'spin' : ''} /> 刷新记录
        </button>
      </div>

      {/* Filters Toolbar */}
      <div className="toolbar-card mb-5">
        <div className="toolbar-filters">
          <select
            aria-label="按账号筛选执行记录"
            className="form-select form-select-sm"
            value={accountFilter}
            onChange={(e) => setAccountFilter(e.target.value)}
          >
            <option value="">全部米游社账号</option>
            {accounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                {acc.nickname} ({acc.phoneMasked})
              </option>
            ))}
          </select>

          <select
            aria-label="按执行状态筛选"
            className="form-select form-select-sm"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as RunState | '')}
          >
            <option value="">全部任务状态</option>
            {(Object.keys(RUN_STATE_LABELS) as RunState[]).map((st) => (
              <option key={st} value={st}>
                {RUN_STATE_LABELS[st]} ({st})
              </option>
            ))}
          </select>

          <div className="date-filter-group">
            <label htmlFor="runs-date-from" className="text-xs text-muted">
              起始日期
            </label>
            <input
              id="runs-date-from"
              type="date"
              className="form-input form-input-sm mono"
              value={dateFromFilter}
              onChange={(e) => setDateFromFilter(e.target.value)}
            />
          </div>

          <div className="date-filter-group">
            <label htmlFor="runs-date-to" className="text-xs text-muted">
              截止日期
            </label>
            <input
              id="runs-date-to"
              type="date"
              className="form-input form-input-sm mono"
              value={dateToFilter}
              onChange={(e) => setDateToFilter(e.target.value)}
            />
          </div>

          {(accountFilter || stateFilter || dateFromFilter || dateToFilter) && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setAccountFilter('');
                setStateFilter('');
                setDateFromFilter('');
                setDateToFilter('');
              }}
            >
              清除筛选
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="alert-banner alert-danger mb-5" role="alert">
          <ShieldAlert size={18} />
          <div>
            <strong>读取执行记录异常 ({error.code})</strong>
            <p>{error.message}</p>
          </div>
        </div>
      )}

      <div className="runs-master-detail">
        {/* Left List Column */}
        <aside className="runs-list-panel">
          <div className="panel-header">
            <h2 className="panel-title">执行记录列表 ({runs.length})</h2>
          </div>

          {runs.length === 0 ? (
            <div className="empty-inline">
              <span>当前筛选条件下暂无执行记录。</span>
            </div>
          ) : (
            <div className="run-list-items">
              {runs.map((r) => {
                const acc = accounts.find((a) => a.id === r.accountId);
                const isSelected = selectedRun?.id === r.id;
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={`run-list-item ${isSelected ? 'run-list-item-active' : ''}`}
                    onClick={() => handleSelectRun(r)}
                  >
                    <div className="run-item-top">
                      <strong>{acc ? acc.nickname : `账号 ${r.accountId.slice(0, 8)}`}</strong>
                      <span className={`badge badge-run-${r.state}`}>
                        {RUN_STATE_LABELS[r.state]}
                      </span>
                    </div>
                    <div className="run-item-meta mono">
                      <span>日期: {r.businessDate}</span>
                      <span>·</span>
                      <span>
                        来源:{' '}
                        {r.source === 'manual'
                          ? '手动触发'
                          : r.source === 'scheduled'
                            ? '定时计划'
                            : '失败重试'}
                      </span>
                    </div>
                    <div className="run-item-bottom">
                      <span className="text-xs text-muted mono">ID: {r.id.slice(0, 8)}...</span>
                      <span className="text-xs font-semibold text-jade mono">
                        已确认收益: +{r.confirmedRewardPoints} 米游币
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        {/* Right Detail Inspector */}
        <section className="runs-detail-panel">
          {!selectedRun ? (
            <div className="empty-hero-card">
              <h3>请从左侧选择一条执行记录查看步骤与日志详情</h3>
            </div>
          ) : (
            <div className="panel-card">
              <div className="panel-header">
                <div>
                  <div className="eyebrow-row">
                    <span className={`badge badge-run-${selectedRun.state}`}>
                      {RUN_STATE_LABELS[selectedRun.state]}
                    </span>
                    <span className="badge badge-slate mono">
                      业务日期：{selectedRun.businessDate}
                    </span>
                    {!TERMINAL_RUN_STATES.includes(selectedRun.state) && (
                      <span className="badge badge-cobalt">
                        <RefreshCw size={12} className="spin" /> 正在自动轮询更新
                      </span>
                    )}
                  </div>
                  <h2 className="panel-title mt-1">
                    {selectedAccount ? (
                      <Link to={`/accounts/${selectedAccount.id}`} className="row-title-link">
                        {selectedAccount.nickname} ({selectedAccount.phoneMasked})
                      </Link>
                    ) : (
                      `账号 ID: ${selectedRun.accountId}`
                    )}{' '}
                    · 任务执行详情
                  </h2>
                  <p className="panel-desc mono">
                    Run ID: {selectedRun.id}
                    {selectedRun.parentRunId && ` · 重试自父任务: ${selectedRun.parentRunId}`}
                  </p>
                </div>

                <div className="button-row">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={loadingDetail}
                    onClick={() => void loadRunDetailAndEvents(selectedRun.id, false)}
                  >
                    <RefreshCw size={14} className={loadingDetail ? 'spin' : ''} /> 刷新状态
                  </button>

                  {selectedRun.state === 'awaiting_verification' && selectedRun.challengeId && (
                    <button
                      type="button"
                      className="btn btn-amber btn-sm"
                      onClick={() =>
                        enqueueChallenge({
                          challengeId: selectedRun.challengeId!,
                          contextLabel: `${selectedAccount?.nickname ?? '任务'} · 社区签到`,
                          onAccepted: () => void loadRunDetailAndEvents(selectedRun.id, false)
                        })
                      }
                    >
                      <ShieldAlert size={14} /> 手动完成人机验证
                    </button>
                  )}

                  {canRetry && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={actionBusy !== null}
                      onClick={() => void handleRetryRun()}
                    >
                      <RotateCcw size={14} />
                      {actionBusy === 'retry' ? '正在提交重试...' : '安全重试失败步骤'}
                    </button>
                  )}

                  {canCancel && (
                    <button
                      type="button"
                      className="btn btn-danger-outline btn-sm"
                      disabled={actionBusy !== null}
                      onClick={() => setCancelConfirmOpen(true)}
                    >
                      <Ban size={14} /> 停止后续步骤
                    </button>
                  )}
                </div>
              </div>

              {/* Outcome Unknown / Partial / Error Alerts */}
              {selectedRun.state === 'outcome_unknown' && (
                <div className="alert-banner alert-warning mb-4" role="alert">
                  <AlertTriangle size={18} />
                  <div>
                    <strong>结果待核对，不自动重复执行 (outcome_unknown)</strong>
                    <p>
                      上游写请求超时且状态暂时无法核对。系统绝不将其伪造为签到成功，也不会盲目自动重复发送签到请求。你可点击「安全重试失败步骤」由后端先对账再决定是否补执行。
                    </p>
                  </div>
                </div>
              )}

              {selectedRun.state === 'partially_succeeded' && (
                <div className="alert-banner alert-warning mb-4" role="alert">
                  <AlertTriangle size={18} />
                  <div>
                    <strong>部分完成，查看失败步骤 (partially_succeeded)</strong>
                    <p>
                      本次任务中部分步骤已确认成功到账，部分步骤执行失败。点击「安全重试失败步骤」时，后端将自动跳过已确认完成的步骤。
                    </p>
                  </div>
                </div>
              )}

              {selectedRun.state === 'canceled' && (
                <div className="alert-banner alert-info mb-4" role="status">
                  <Ban size={18} />
                  <div>
                    <strong>已停止后续步骤，已执行操作不会回滚 (canceled)</strong>
                    <p>
                      取消请求于 {formatShanghaiDateTime(selectedRun.cancelRequestedAt)} 生效；在此之前已完成的上游写入不会回滚。
                    </p>
                  </div>
                </div>
              )}

              {selectedRun.error && (
                <div className="alert-banner alert-danger mb-4" role="alert">
                  <ShieldAlert size={18} />
                  <div className="flex-1">
                    <strong>
                      任务异常摘要 ({selectedRun.error.code})
                    </strong>
                    <p>{selectedRun.error.message}</p>
                  </div>
                  {selectedRun.error.code === 'ACCOUNT_REAUTH_REQUIRED' && selectedAccount && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => openReloginAccount(selectedAccount)}
                    >
                      <KeyRound size={14} /> 重新登录该账号
                    </button>
                  )}
                </div>
              )}

              {/* Run Summary Telemetry */}
              <div className="telemetry-grid mb-5">
                <div className="telemetry-item">
                  <span className="telemetry-label">本次已确认到账收益</span>
                  <span className="telemetry-value mono text-jade">
                    <Coins size={14} style={{ display: 'inline', marginRight: 4 }} />+
                    {selectedRun.confirmedRewardPoints} 米游币
                  </span>
                </div>
                <div className="telemetry-item">
                  <span className="telemetry-label">创建时间</span>
                  <span className="telemetry-value mono">
                    {formatShanghaiDateTime(selectedRun.createdAt)}
                  </span>
                </div>
                <div className="telemetry-item">
                  <span className="telemetry-label">开始时间</span>
                  <span className="telemetry-value mono">
                    {formatShanghaiDateTime(selectedRun.startedAt)}
                  </span>
                </div>
                <div className="telemetry-item">
                  <span className="telemetry-label">结束时间</span>
                  <span className="telemetry-value mono">
                    {formatShanghaiDateTime(selectedRun.finishedAt)}
                  </span>
                </div>
              </div>

              {/* Steps Breakdown Table */}
              <h3 className="section-subheading">步骤执行明细 ({selectedRun.steps.length})</h3>
              <div className="table-wrap mb-6">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>目标游戏 / 角色</th>
                      <th>任务类型</th>
                      <th>步骤状态</th>
                      <th>状态说明与对账结果</th>
                      <th>确认收益</th>
                      <th>上游返回码</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedRun.steps.map((step) => (
                      <tr key={step.id}>
                        <td>
                          <strong>{step.gameName ?? getCommunityName(step.communityId)}</strong>
                          {step.roleLabel && <div className="text-xs text-muted">{step.roleLabel}</div>}
                        </td>
                        <td>{TASK_KIND_LABELS[step.taskKind] || step.taskKind}</td>
                        <td>
                          <span className={`badge badge-step-${step.state}`}>
                            {STEP_STATE_LABELS[step.state]}
                          </span>
                        </td>
                        <td>
                          {step.message}
                          {step.state === 'already_completed' && (
                            <span className="text-xs text-muted block">
                              （已核对今日任务已完成，本次收益计 0，不重复累加）
                            </span>
                          )}
                        </td>
                        <td className="mono">
                          {step.taskKind === 'game_sign'
                            ? (step.rewards?.map(reward => `${reward.name} × ${reward.count}`).join('、') || (step.state === 'already_completed' ? '今日已完成，本次未重复领取' : '—'))
                            : step.rewardPoints !== null ? `+${step.rewardPoints} 米游币` : '—'}
                        </td>
                        <td className="mono text-xs">
                          {step.upstreamRetcode !== null ? step.upstreamRetcode : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Sanitized Event Logs */}
              <div className="log-console-box">
                <div className="log-console-header">
                  <div className="row-title-group">
                    <Terminal size={16} />
                    <strong>脱敏执行事件日志 ({events.length} 条，按 event.id 去重)</strong>
                  </div>
                  <span className="text-xs text-muted">
                    纯文本展示 · 不含 Cookie、令牌、手机号或真实验证码
                  </span>
                </div>
                <div className="log-console-body mono">
                  {events.length === 0 ? (
                    <div className="log-empty">暂无事件日志记录</div>
                  ) : (
                    events.map((evt) => (
                      <div key={evt.id} className={`log-line log-level-${evt.level}`}>
                        <span className="log-time">{formatShanghaiDateTime(evt.createdAt)}</span>
                        <span className="log-badge">[{evt.level.toUpperCase()}]</span>
                        <span className="log-msg">{evt.message}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* Cancel Run Confirmation Modal */}
      {cancelConfirmOpen && selectedRun && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-run-modal-title"
        >
          <div className="modal-card modal-card-sm">
            <div className="modal-header">
              <h2 id="cancel-run-modal-title" className="modal-title">
                确认停止后续任务步骤？
              </h2>
            </div>
            <div className="modal-body">
              <div className="alert-banner alert-warning">
                <AlertTriangle size={18} />
                <div>
                  <strong>不回滚说明</strong>
                  <p>
                    请求取消仅停止尚未执行的后续步骤；<strong>已经完成的上游签到或写入操作不会回滚</strong>，当前正在执行的请求须核对结束后才能进入终态。
                  </p>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <div className="footer-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={actionBusy === 'cancel'}
                  onClick={() => setCancelConfirmOpen(false)}
                >
                  继续执行
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={actionBusy === 'cancel'}
                  onClick={() => void handleCancelRun()}
                >
                  <Ban size={14} />
                  {actionBusy === 'cancel' ? '正在请求停止...' : '确认停止后续步骤'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
