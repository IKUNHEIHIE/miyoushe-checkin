import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Users,
  ShieldAlert,
  Coins,
  CheckCircle2,
  RefreshCw,
  PlusCircle,
  ArrowRight,
  Activity,
  KeyRound,
  Sparkles
} from 'lucide-react';
import { apiClient, ApiClientError } from '../api/client';
import { useApp } from '../context/AppContext';
import {
  type Account,
  ACCOUNT_STATUS_LABELS,
  type Dashboard,
  RUN_STATE_LABELS
} from '../types/openapi';
import { formatShanghaiDateTime } from '../utils/format';

export const DashboardPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    openAddAccount,
    openReloginAccount,
    enqueueChallenge,
    accountsVersionTrigger
  } = useApp();

  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiClientError | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dashRes, accRes] = await Promise.all([
        apiClient.getDashboard(),
        apiClient.listAccounts({ limit: 50 })
      ]);
      setDashboard(dashRes.data);
      setAccounts(accRes.data.items);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData, accountsVersionTrigger]);

  const attentionAccounts = accounts.filter(
    (a) => a.status === 'reauth_required' || a.status === 'verification_required' || a.activeCredentialOperationId || a.activeRunId
  );

  const handleResumeAccountVerification = async (acc: Account) => {
    if (acc.activeCredentialOperationId) {
      try {
        const opRes = await apiClient.getCredentialOperation(acc.activeCredentialOperationId);
        if (opRes.data.state === 'awaiting_verification' && opRes.data.challengeId) {
          enqueueChallenge({
            challengeId: opRes.data.challengeId,
            contextLabel: `${acc.nickname} · 凭据操作`,
            onAccepted: () => void loadData()
          });
          return;
        }
      } catch {
        // Fallback to detail page
      }
    }
    if (acc.activeRunId) {
      try {
        const runRes = await apiClient.getRun(acc.activeRunId);
        if (runRes.data.state === 'awaiting_verification' && runRes.data.challengeId) {
          enqueueChallenge({
            challengeId: runRes.data.challengeId,
            contextLabel: `${acc.nickname} · 社区签到`,
            onAccepted: () => void loadData()
          });
          return;
        }
      } catch {
        // Fallback to detail page
      }
    }
    navigate(`/accounts/${acc.id}`);
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <div className="eyebrow-row">
            <span className="badge badge-slate mono">
              上海业务日期：{dashboard?.businessDate ?? '2026-10-23'} (Asia/Shanghai)
            </span>
          </div>
          <h1 className="page-title">实例运行概览</h1>
          <p className="page-subtitle">
            汇总当前实例绑定的米游社账号状态、需人工介入的验证或重登事项，以及今日已核对确认的米游币收益。
          </p>
        </div>

        <div className="button-row">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={loading}
            onClick={() => void loadData()}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} /> 刷新概览
          </button>
          <button type="button" className="btn btn-primary" onClick={openAddAccount}>
            <PlusCircle size={16} /> 添加米游社账号
          </button>
        </div>
      </div>

      {error && (
        <div className="alert-banner alert-danger mb-6" role="alert">
          <ShieldAlert size={18} />
          <div>
            <strong>读取概览失败 ({error.code})</strong>
            <p>{error.message}</p>
            <div className="mono text-xs mt-1">RequestId: {error.requestId}</div>
          </div>
        </div>
      )}

      {loading && !dashboard && (
        <div className="state-box">
          <RefreshCw className="spin" size={20} />
          <span>正在加载实例概览数据...</span>
        </div>
      )}

      {dashboard && (
        <>
          <section className="panel-card mb-6" aria-label="签到福利入口">
            <div className="panel-header">
              <div><h2 className="panel-title"><Sparkles size={18} /> 签到福利 · 游戏每日奖励</h2>
                <p className="panel-desc">为绑定的原神、星穹铁道、绝区零等角色自动签到。在账号详情选择游戏角色，开启每日计划即可每天执行。</p></div>
              <Link className="btn btn-primary btn-sm" to="/accounts">管理签到福利 <ArrowRight size={14} /></Link>
            </div>
            <div className="button-row">{accounts.map(account => <Link key={account.id} className="btn btn-secondary btn-sm" to={`/accounts/${account.id}#game-benefits`}>{account.remark || account.nickname} · {account.taskKinds.includes('game_sign') ? '已启用' : '去启用'}</Link>)}</div>
          </section>
          {/* Metric Telemetry Strip */}
          <div className="metric-grid">
            <div className="metric-card">
              <div className="metric-header">
                <span className="metric-label">托管账号总数 / 启用正常</span>
                <Users size={18} className="text-cobalt" />
              </div>
              <div className="metric-value mono">
                {dashboard.accountCount}{' '}
                <span className="metric-sub">/ {dashboard.activeAccountCount} 正常启用</span>
              </div>
              <div className="metric-foot">单管理员统一管理，账号间 Cookie 与设备指纹完全隔离</div>
            </div>

            <div className={`metric-card ${dashboard.actionRequiredCount > 0 ? 'metric-card-amber' : ''}`}>
              <div className="metric-header">
                <span className="metric-label">需要人工处理的账号</span>
                <ShieldAlert
                  size={18}
                  className={dashboard.actionRequiredCount > 0 ? 'text-amber' : 'text-muted'}
                />
              </div>
              <div className="metric-value mono">{dashboard.actionRequiredCount}</div>
              <div className="metric-foot">
                {dashboard.actionRequiredCount > 0
                  ? '包含需手动完成极验验证或根凭据失效需重登的账号'
                  : '所有账号状态正常，无需人工干预'}
              </div>
            </div>

            <div className="metric-card">
              <div className="metric-header">
                <span className="metric-label">今日已确认到账收益</span>
                <Coins size={18} className="text-jade" />
              </div>
              <div className="metric-value mono">
                +{dashboard.todayConfirmedRewardPoints}{' '}
                <span className="metric-sub">米游币</span>
              </div>
              <div className="metric-foot">
                仅计入终态复核确认到账的奖励；进行中或今日重复签到不重复计入
              </div>
            </div>

            <div className="metric-card">
              <div className="metric-header">
                <span className="metric-label">今日执行统计 (成功 / 失败)</span>
                <CheckCircle2 size={18} className="text-jade" />
              </div>
              <div className="metric-value mono">
                {dashboard.todaySucceededRuns}{' '}
                <span className="metric-sub">/ {dashboard.todayFailedRuns} 异常</span>
              </div>
              <div className="metric-foot">
                当前活动任务数：{dashboard.activeRuns.length}
              </div>
            </div>
          </div>

          {/* Empty Accounts Invitation */}
          {dashboard.accountCount === 0 && (
            <div className="empty-hero-card">
              <Sparkles size={32} className="text-cobalt" />
              <h2>尚未添加任何米游社账号</h2>
              <p>
                点击下方按钮通过手机号短信验证添加你的第一个米游社账号。登录过程中如遇极验 v4 验证，将弹出统一人工验证窗口由你手动完成。
              </p>
              <button type="button" className="btn btn-primary mt-3" onClick={openAddAccount}>
                <PlusCircle size={16} /> 立即添加首个米游社账号
              </button>
            </div>
          )}

          <div className="dashboard-columns">
            {/* Left Column: Accounts requiring manual action or all accounts preview */}
            <section className="panel-card">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">需关注与处理的账号</h2>
                  <p className="panel-desc">
                    根凭据失效不会自动无限重试，人机验证需由管理员手动完成。
                  </p>
                </div>
                <Link to="/accounts" className="btn btn-ghost btn-sm">
                  全部账号 ({accounts.length}) <ArrowRight size={14} />
                </Link>
              </div>

              {attentionAccounts.length === 0 ? (
                <div className="empty-inline">
                  <CheckCircle2 size={18} className="text-jade" />
                  <span>当前没有需要重新登录或等待人工验证的账号。</span>
                </div>
              ) : (
                <div className="item-stack">
                  {attentionAccounts.map((acc) => (
                    <div key={acc.id} className="attention-row">
                      <div>
                        <div className="row-title-group">
                          <Link to={`/accounts/${acc.id}`} className="row-title-link">
                            {acc.nickname}
                          </Link>
                          <span className="mono text-xs text-muted">{acc.phoneMasked}</span>
                          <span className={`badge badge-status-${acc.status}`}>
                            {ACCOUNT_STATUS_LABELS[acc.status]}
                          </span>
                        </div>
                        <div className="text-xs text-muted mt-1">
                          通行证 ID (aid): <code className="mono">{acc.uid}</code> · 最近检查:{' '}
                          {formatShanghaiDateTime(acc.credential.lastCheckedAt)}
                        </div>
                      </div>

                      <div className="button-row">
                        {acc.status === 'reauth_required' && (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => openReloginAccount(acc)}
                          >
                            <KeyRound size={14} /> 重新登录
                          </button>
                        )}
                        {(acc.status === 'verification_required' ||
                          acc.activeCredentialOperationId ||
                          acc.activeRunId) && (
                          <button
                            type="button"
                            className="btn btn-amber btn-sm"
                            onClick={() => void handleResumeAccountVerification(acc)}
                          >
                            <ShieldAlert size={14} /> 继续验证 / 查看操作
                          </button>
                        )}
                        <Link to={`/accounts/${acc.id}`} className="btn btn-secondary btn-sm">
                          详情
                        </Link>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Right Column: Active Runs */}
            <section className="panel-card">
              <div className="panel-header">
                <div>
                  <h2 className="panel-title">当前活动任务 ({dashboard.activeRuns.length})</h2>
                  <p className="panel-desc">
                    展示正在排队、执行中或暂停等待你完成人机验证的任务。
                  </p>
                </div>
                <Link to="/runs" className="btn btn-ghost btn-sm">
                  执行历史记录 <ArrowRight size={14} />
                </Link>
              </div>

              {dashboard.activeRuns.length === 0 ? (
                <div className="empty-inline">
                  <Activity size={18} className="text-muted" />
                  <span>当前没有正在后台运行或等待验证的任务。</span>
                </div>
              ) : (
                <div className="item-stack">
                  {dashboard.activeRuns.map((run) => {
                    const acc = accounts.find((a) => a.id === run.accountId);
                    return (
                      <div key={run.id} className="attention-row">
                        <div>
                          <div className="row-title-group">
                            <Link to={`/runs?runId=${run.id}`} className="row-title-link">
                              {acc ? acc.nickname : `账号 ${run.accountId.slice(0, 8)}`}
                            </Link>
                            <span className={`badge badge-run-${run.state}`}>
                              {RUN_STATE_LABELS[run.state]}
                            </span>
                          </div>
                          <div className="text-xs text-muted mt-1">
                            Run ID: <code className="mono">{run.id.slice(0, 8)}...</code> · 创建于{' '}
                            {formatShanghaiDateTime(run.createdAt)}
                          </div>
                        </div>

                        <div className="button-row">
                          {run.state === 'awaiting_verification' && run.challengeId && (
                            <button
                              type="button"
                              className="btn btn-amber btn-sm"
                              onClick={() =>
                                enqueueChallenge({
                                  challengeId: run.challengeId!,
                                  contextLabel: `${acc?.nickname ?? '任务'} · 社区签到`,
                                  onAccepted: () => void loadData()
                                })
                              }
                            >
                              <ShieldAlert size={14} /> 手动完成验证
                            </button>
                          )}
                          <Link to={`/runs?runId=${run.id}`} className="btn btn-secondary btn-sm">
                            查看步骤
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
};
