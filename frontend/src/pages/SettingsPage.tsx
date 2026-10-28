import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Save,
  Send,
  RefreshCw,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  Lock,
  Mail,
  Sliders
} from 'lucide-react';
import { apiClient, ApiClientError } from '../api/client';
import { useApp } from '../context/AppContext';
import type {
  NotificationPolicy,
  NotificationSettings,
  NotificationSettingsPatch,
  NotificationTest,
  SmtpSecurity,
  SystemSettings
} from '../types/openapi';
import { formatShanghaiDateTime, generateIdempotencyKey } from '../utils/format';

export const SettingsPage: React.FC = () => {
  const { pushToast, accountsVersionTrigger } = useApp();

  const [sysSettings, setSysSettings] = useState<SystemSettings | null>(null);
  const [notifSettings, setNotifSettings] = useState<NotificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiClientError | null>(null);

  // System Settings Draft
  const [pauseSchedulerDraft, setPauseSchedulerDraft] = useState(false);
  const [logRetentionDaysDraft, setLogRetentionDaysDraft] = useState(90);
  const [savingSystem, setSavingSystem] = useState(false);
  const [sysConflict, setSysConflict] = useState<SystemSettings | null>(null);

  // Notification Settings Draft (Password is NEVER pre-filled with "******"!)
  const [notifEnabledDraft, setNotifEnabledDraft] = useState(false);
  const [policyDraft, setPolicyDraft] = useState<NotificationPolicy>('failures_and_actions');
  const [smtpHostDraft, setSmtpHostDraft] = useState('');
  const [smtpPortDraft, setSmtpPortDraft] = useState(465);
  const [smtpSecurityDraft, setSmtpSecurityDraft] = useState<SmtpSecurity>('ssl');
  const [smtpUsernameDraft, setSmtpUsernameDraft] = useState('');
  const [newSmtpPasswordDraft, setNewSmtpPasswordDraft] = useState('');
  const [clearPasswordDraft, setClearPasswordDraft] = useState(false);
  const [fromAddressDraft, setFromAddressDraft] = useState('');
  const [toAddressDraft, setToAddressDraft] = useState('');
  const [savingNotif, setSavingNotif] = useState(false);
  const [notifConflict, setNotifConflict] = useState<NotificationSettings | null>(null);

  // Notification Test State
  const [testRecord, setTestRecord] = useState<NotificationTest | null>(null);
  const [testingEmail, setTestingEmail] = useState(false);
  const testIdempotencyKeyRef = useRef<string>(generateIdempotencyKey());

  const syncSysToDraft = useCallback((s: SystemSettings) => {
    setSysSettings(s);
    setPauseSchedulerDraft(s.pauseScheduler);
    setLogRetentionDaysDraft(s.logRetentionDays);
  }, []);

  const syncNotifToDraft = useCallback((n: NotificationSettings) => {
    setNotifSettings(n);
    setNotifEnabledDraft(n.enabled);
    setPolicyDraft(n.policy);
    setSmtpHostDraft(n.smtpHost);
    setSmtpPortDraft(n.smtpPort);
    setSmtpSecurityDraft(n.smtpSecurity);
    setSmtpUsernameDraft(n.smtpUsername);
    setFromAddressDraft(n.fromAddress);
    setToAddressDraft(n.toAddress);
    // Explicitly keep password input blank — never prefill "******"
    setNewSmtpPasswordDraft('');
    setClearPasswordDraft(false);
  }, []);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sysRes, notifRes] = await Promise.all([
        apiClient.getSystemSettings(),
        apiClient.getNotificationSettings()
      ]);
      syncSysToDraft(sysRes.data);
      syncNotifToDraft(notifRes.data);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err);
      }
    } finally {
      setLoading(false);
    }
  }, [syncNotifToDraft, syncSysToDraft]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings, accountsVersionTrigger]);

  // Check if notification form has unsaved changes
  const isNotificationDirty = Boolean(
    notifSettings &&
      (notifEnabledDraft !== notifSettings.enabled ||
        policyDraft !== notifSettings.policy ||
        smtpHostDraft !== notifSettings.smtpHost ||
        smtpPortDraft !== notifSettings.smtpPort ||
        smtpSecurityDraft !== notifSettings.smtpSecurity ||
        smtpUsernameDraft !== notifSettings.smtpUsername ||
        fromAddressDraft !== notifSettings.fromAddress ||
        toAddressDraft !== notifSettings.toAddress ||
        newSmtpPasswordDraft.length > 0 ||
        clearPasswordDraft)
  );

  const handleSaveSystemSettings = async (overrideVersion?: number) => {
    if (!sysSettings || savingSystem) return;
    setSavingSystem(true);
    try {
      const res = await apiClient.updateSystemSettings({
        version: overrideVersion ?? sysSettings.version,
        pauseScheduler: pauseSchedulerDraft,
        logRetentionDays: Number(logRetentionDaysDraft)
      });
      syncSysToDraft(res.data);
      setSysConflict(null);
      pushToast({
        type: 'success',
        title: '系统调度与日志设置已保存',
        message: res.data.pauseScheduler
          ? '已开启全局暂停调度：所有账号的 nextRunAt 将置为 null，原计划时/分设置保留。'
          : `系统配置已更新至 v${res.data.version}。`
      });
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === 'VERSION_CONFLICT') {
          const latest = await apiClient.getSystemSettings();
          setSysSettings(latest.data);
          setSysConflict(latest.data);
        } else {
          pushToast({
            type: 'error',
            title: `保存系统设置失败 (${err.code})`,
            message: err.message,
            requestId: err.requestId
          });
        }
      }
    } finally {
      setSavingSystem(false);
    }
  };

  const handleSaveNotificationSettings = async (overrideVersion?: number) => {
    if (!notifSettings || savingNotif) return;
    setSavingNotif(true);
    try {
      const patch: NotificationSettingsPatch = {
        version: overrideVersion ?? notifSettings.version,
        enabled: notifEnabledDraft,
        policy: policyDraft,
        smtpHost: smtpHostDraft.trim(),
        smtpPort: Number(smtpPortDraft),
        smtpSecurity: smtpSecurityDraft,
        smtpUsername: smtpUsernameDraft.trim(),
        fromAddress: fromAddressDraft.trim(),
        toAddress: toAddressDraft.trim()
      };

      // Strict write-only password semantics:
      // - If clearPasswordDraft is true: send clearPassword: true, omit smtpPassword
      // - If newSmtpPasswordDraft is non-empty: send smtpPassword, omit clearPassword
      // - Otherwise: omit both so existing password is retained!
      if (clearPasswordDraft) {
        patch.clearPassword = true;
      } else if (newSmtpPasswordDraft.length > 0) {
        patch.smtpPassword = newSmtpPasswordDraft;
      }

      const res = await apiClient.updateNotificationSettings(patch);
      syncNotifToDraft(res.data);
      setNotifConflict(null);
      pushToast({
        type: 'success',
        title: '邮件通知配置已保存',
        message: `当前密码状态：${res.data.smtpPasswordConfigured ? '已配置' : '未配置'} (v${res.data.version})。`
      });
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === 'VERSION_CONFLICT') {
          const latest = await apiClient.getNotificationSettings();
          setNotifSettings(latest.data);
          setNotifConflict(latest.data);
        } else {
          pushToast({
            type: 'error',
            title: `保存通知配置失败 (${err.code})`,
            message: err.message,
            requestId: err.requestId
          });
        }
      }
    } finally {
      setSavingNotif(false);
    }
  };

  const handleSendTestEmail = async () => {
    if (!notifSettings || testingEmail || isNotificationDirty) return;
    setTestingEmail(true);
    setTestRecord(null);
    try {
      const startRes = await apiClient.createNotificationTest(testIdempotencyKeyRef.current);
      testIdempotencyKeyRef.current = generateIdempotencyKey();
      setTestRecord(startRes.data);

      // 202 queued: DO NOT show immediate success; poll getNotificationTest until terminal!
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const pollRes = await apiClient.getNotificationTest(startRes.data.id);
        setTestRecord(pollRes.data);
        if (pollRes.data.state === 'succeeded') {
          pushToast({
            type: 'success',
            title: '测试邮件发送成功',
            message: `后台已确认测试邮件发往已保存的收件地址 (${notifSettings.toAddress})。`
          });
          break;
        }
        if (pollRes.data.state === 'failed') {
          pushToast({
            type: 'error',
            title: '测试邮件发送失败',
            message: pollRes.data.error?.message ?? '请检查 SMTP 配置'
          });
          break;
        }
      }
    } catch (err) {
      testIdempotencyKeyRef.current = generateIdempotencyKey();
      if (err instanceof ApiClientError) {
        pushToast({
          type: 'error',
          title: `无法发送测试邮件 (${err.code})`,
          message: err.message,
          requestId: err.requestId
        });
      }
    } finally {
      setTestingEmail(false);
    }
  };

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <div className="eyebrow-row">
            <span className="badge badge-cobalt">单实例系统配置</span>
            <span className="badge badge-slate">SMTP 密码只写不读 · 乐观锁版本控制</span>
          </div>
          <h1 className="page-title">系统设置与邮件通知</h1>
          <p className="page-subtitle">
            管理全局定时调度开关、脱敏日志保留天数以及 SMTP 邮件通知配置。
          </p>
        </div>

        <button
          type="button"
          className="btn btn-secondary"
          disabled={loading}
          onClick={() => void loadSettings()}
        >
          <RefreshCw size={15} className={loading ? 'spin' : ''} /> 重新读取设置
        </button>
      </div>

      {error && (
        <div className="alert-banner alert-danger mb-5" role="alert">
          <ShieldAlert size={18} />
          <div>
            <strong>读取设置失败 ({error.code})</strong>
            <p>{error.message}</p>
          </div>
        </div>
      )}

      <div className="dashboard-columns">
        {/* Left: System Settings */}
        <section className="panel-card">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <Sliders size={18} style={{ display: 'inline', marginRight: 6 }} />
                调度与日志保留设置 (v{sysSettings?.version ?? 1})
              </h2>
              <p className="panel-desc">
                全局暂停调度时，所有账号的实际下次触发时间 (<code>nextRunAt</code>) 变为 <code>null</code>，但保留各账号原有的每日时/分设置。
              </p>
            </div>
          </div>

          {sysConflict && (
            <div className="alert-banner alert-warning mb-4" role="alert">
              <AlertTriangle size={18} />
              <div>
                <strong>检测到系统设置版本冲突 (409 VERSION_CONFLICT)</strong>
                <p>
                  服务端版本已更新至 <code>v{sysConflict.version}</code>（日志保留天数：
                  {sysConflict.logRetentionDays} 天）。请确认是否覆盖提交：
                </p>
                <div className="button-row mt-2">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleSaveSystemSettings(sysConflict.version)}
                  >
                    确认在最新 v{sysConflict.version} 基础上提交
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      syncSysToDraft(sysConflict);
                      setSysConflict(null);
                    }}
                  >
                    采用服务端最新设置
                  </button>
                </div>
              </div>
            </div>
          )}

          {sysSettings && (
            <div className="form-stack">
              <div className="telemetry-grid">
                <div className="telemetry-item">
                  <span className="telemetry-label">实例固定业务时区</span>
                  <span className="telemetry-value mono">{sysSettings.timezone} (北京时间)</span>
                </div>
                <div className="telemetry-item">
                  <span className="telemetry-label">当前调度状态</span>
                  <span className="telemetry-value">
                    {sysSettings.pauseScheduler ? '全局已暂停' : '正常调度运行中'}
                  </span>
                </div>
              </div>

              <div className="form-group">
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={pauseSchedulerDraft}
                    onChange={(e) => setPauseSchedulerDraft(e.target.checked)}
                  />
                  <strong>全局暂停定时调度 (pauseScheduler)</strong>
                </label>
                <span className="form-hint">
                  开启后将暂停所有账号的定时签到触发，不影响管理员手动发起立即签到或凭据检查。
                </span>
              </div>

              <div className="form-group">
                <label htmlFor="log-retention-input" className="form-label">
                  执行记录与脱敏日志保留天数 (7 – 365 天)
                </label>
                <input
                  id="log-retention-input"
                  type="number"
                  min={7}
                  max={365}
                  className="form-input mono"
                  value={logRetentionDaysDraft}
                  onChange={(e) => setLogRetentionDaysDraft(Number(e.target.value))}
                />
              </div>

              <div className="form-actions-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={savingSystem}
                  onClick={() => void handleSaveSystemSettings()}
                >
                  <Save size={15} />
                  {savingSystem ? '正在保存系统设置...' : '保存系统设置'}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Right: Notification Settings */}
        <section className="panel-card">
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <Mail size={18} style={{ display: 'inline', marginRight: 6 }} />
                SMTP 邮件通知配置 (v{notifSettings?.version ?? 1})
              </h2>
              <p className="panel-desc">
                当账号需要人工验证、根凭据失效或签到异常时发送邮件提醒。SMTP 密码为只写字段，不回显明文或假掩码。
              </p>
            </div>
          </div>

          {notifConflict && (
            <div className="alert-banner alert-warning mb-4" role="alert">
              <AlertTriangle size={18} />
              <div>
                <strong>检测到通知设置版本冲突 (409 VERSION_CONFLICT)</strong>
                <p>
                  服务端通知配置已更新至 <code>v{notifConflict.version}</code>。请确认是否应用你的修改：
                </p>
                <div className="button-row mt-2">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleSaveNotificationSettings(notifConflict.version)}
                  >
                    确认在最新 v{notifConflict.version} 上保存
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      syncNotifToDraft(notifConflict);
                      setNotifConflict(null);
                    }}
                  >
                    采用服务端最新配置
                  </button>
                </div>
              </div>
            </div>
          )}

          {notifSettings && (
            <div className="form-stack">
              <div className="form-group">
                <label className="checkbox-inline">
                  <input
                    type="checkbox"
                    checked={notifEnabledDraft}
                    onChange={(e) => setNotifEnabledDraft(e.target.checked)}
                  />
                  <strong>启用 SMTP 邮件通知 (开启时要求配置完整且已设置密码)</strong>
                </label>
              </div>

              <div className="form-group">
                <label htmlFor="notif-policy-select" className="form-label">
                  通知触发策略 (policy)
                </label>
                <select
                  id="notif-policy-select"
                  className="form-select"
                  value={policyDraft}
                  onChange={(e) => setPolicyDraft(e.target.value as NotificationPolicy)}
                >
                  <option value="failures_and_actions">
                    仅失败与需人工处理时通知 (failures_and_actions)
                  </option>
                  <option value="every_run">每次执行结束后均通知 (every_run)</option>
                </select>
              </div>

              <div className="time-picker-row">
                <div className="form-group flex-2">
                  <label htmlFor="smtp-host-input" className="form-label">
                    SMTP 服务器地址 (smtpHost)
                  </label>
                  <input
                    id="smtp-host-input"
                    type="text"
                    className="form-input mono"
                    value={smtpHostDraft}
                    onChange={(e) => setSmtpHostDraft(e.target.value)}
                    placeholder="smtp.example.invalid"
                  />
                </div>

                <div className="form-group flex-1">
                  <label htmlFor="smtp-port-input" className="form-label">
                    端口 (smtpPort)
                  </label>
                  <input
                    id="smtp-port-input"
                    type="number"
                    min={1}
                    max={65535}
                    className="form-input mono"
                    value={smtpPortDraft}
                    onChange={(e) => setSmtpPortDraft(Number(e.target.value))}
                  />
                </div>

                <div className="form-group flex-1">
                  <label htmlFor="smtp-security-select" className="form-label">
                    加密方式
                  </label>
                  <select
                    id="smtp-security-select"
                    className="form-select mono"
                    value={smtpSecurityDraft}
                    onChange={(e) => setSmtpSecurityDraft(e.target.value as SmtpSecurity)}
                  >
                    <option value="ssl">SSL / TLS (ssl)</option>
                    <option value="starttls">STARTTLS (starttls)</option>
                  </select>
                </div>
              </div>

              <div className="form-group">
                <label htmlFor="smtp-username-input" className="form-label">
                  SMTP 登录用户名 (smtpUsername)
                </label>
                <input
                  id="smtp-username-input"
                  type="text"
                  autoComplete="off"
                  className="form-input mono"
                  value={smtpUsernameDraft}
                  onChange={(e) => setSmtpUsernameDraft(e.target.value)}
                />
              </div>

              {/* Write-only SMTP Password Box */}
              <div className="password-semantics-box">
                <div className="eyebrow-row mb-2">
                  <span
                    className={`badge ${
                      notifSettings.smtpPasswordConfigured ? 'badge-jade' : 'badge-amber'
                    }`}
                  >
                    <Lock size={12} /> 服务端密码状态：
                    {notifSettings.smtpPasswordConfigured
                      ? '已配置密码 (smtpPasswordConfigured = true)'
                      : '尚未配置密码 (smtpPasswordConfigured = false)'}
                  </span>
                </div>

                <div className="form-group">
                  <label htmlFor="smtp-password-input" className="form-label">
                    替换 SMTP 密码（只写字段：留空表示保留原密码，绝不回填 <code>******</code>）
                  </label>
                  <input
                    id="smtp-password-input"
                    type="password"
                    autoComplete="new-password"
                    className="form-input"
                    disabled={clearPasswordDraft}
                    value={newSmtpPasswordDraft}
                    onChange={(e) => setNewSmtpPasswordDraft(e.target.value)}
                    placeholder={
                      clearPasswordDraft
                        ? '已勾选清除密码，不可同时输入新密码'
                        : notifSettings.smtpPasswordConfigured
                          ? '已保存密码（留空则保留现有密码，输入非空字符则替换）'
                          : '当前未保存密码，请输入新的 SMTP 密码'
                    }
                  />
                </div>

                {notifSettings.smtpPasswordConfigured && (
                  <label className="checkbox-inline mt-2">
                    <input
                      type="checkbox"
                      checked={clearPasswordDraft}
                      onChange={(e) => {
                        setClearPasswordDraft(e.target.checked);
                        if (e.target.checked) {
                          setNewSmtpPasswordDraft('');
                        }
                      }}
                    />
                    <span>
                      明确清除已保存的 SMTP 密码 (<code>clearPassword = true</code>)
                    </span>
                  </label>
                )}
              </div>

              <div className="time-picker-row">
                <div className="form-group flex-1">
                  <label htmlFor="smtp-from-input" className="form-label">
                    发件人邮箱 (fromAddress)
                  </label>
                  <input
                    id="smtp-from-input"
                    type="email"
                    className="form-input mono"
                    value={fromAddressDraft}
                    onChange={(e) => setFromAddressDraft(e.target.value)}
                  />
                </div>

                <div className="form-group flex-1">
                  <label htmlFor="smtp-to-input" className="form-label">
                    管理员收件邮箱 (toAddress)
                  </label>
                  <input
                    id="smtp-to-input"
                    type="email"
                    className="form-input mono"
                    value={toAddressDraft}
                    onChange={(e) => setToAddressDraft(e.target.value)}
                  />
                </div>
              </div>

              <div className="form-actions-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={savingNotif}
                  onClick={() => void handleSaveNotificationSettings()}
                >
                  <Save size={15} />
                  {savingNotif ? '正在保存通知设置...' : '保存通知配置'}
                </button>

                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={testingEmail || isNotificationDirty || !notifSettings.toAddress}
                  onClick={() => void handleSendTestEmail()}
                  title={
                    isNotificationDirty
                      ? '请先保存修改后再发送测试邮件'
                      : `向已保存的 ${notifSettings.toAddress} 发送测试邮件`
                  }
                >
                  <Send size={15} />
                  {testingEmail ? '正在发送并轮询结果...' : '向已保存收件地址发送测试邮件'}
                </button>
              </div>

              {isNotificationDirty && (
                <div className="text-xs text-amber">
                  提示：测试邮件仅发往服务端<strong>已保存</strong>的收件地址 (
                  <code>{notifSettings.toAddress}</code>)。检测到你有未保存的修改，请先点击「保存通知配置」后再测试。
                </div>
              )}

              {/* Polled Notification Test Result */}
              {testRecord && (
                <div
                  className={`alert-banner ${
                    testRecord.state === 'succeeded'
                      ? 'alert-success'
                      : testRecord.state === 'failed'
                        ? 'alert-danger'
                        : 'alert-info'
                  }`}
                  role="status"
                >
                  {testRecord.state === 'succeeded' ? (
                    <CheckCircle2 size={18} />
                  ) : testRecord.state === 'failed' ? (
                    <ShieldAlert size={18} />
                  ) : (
                    <RefreshCw size={18} className="spin" />
                  )}
                  <div>
                    <strong>
                      测试邮件状态：
                      {testRecord.state === 'queued' && '排队中 (queued) — 正在轮询结果...'}
                      {testRecord.state === 'sending' && '正在发送 (sending) — 正在轮询结果...'}
                      {testRecord.state === 'succeeded' && '已确认发送成功 (succeeded)'}
                      {testRecord.state === 'failed' && '发送失败 (failed)'}
                    </strong>
                    <p className="text-xs mono mt-1">
                      Test ID: {testRecord.id} · 更新时间：{formatShanghaiDateTime(testRecord.updatedAt)}
                      {testRecord.error ? ` · 错误：${testRecord.error.message}` : ''}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
