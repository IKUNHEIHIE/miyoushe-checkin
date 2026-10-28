import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Smartphone,
  Send,
  ShieldAlert,
  CheckCircle2,
  RefreshCw,
  X,
  ArrowRight,
  Ban,
  KeyRound,
  Clock
} from 'lucide-react';
import { apiClient, ApiClientError } from '../api/client';
import { useApp } from '../context/AppContext';
import { FLOW_STATE_LABELS, type LoginFlow } from '../types/openapi';
import {
  formatShanghaiDateTime,
  generateIdempotencyKey,
  getNowMs,
  getRemainingSeconds,
  isValidCnPhone,
  isValidSmsCode
} from '../utils/format';

export const AddAccountModal: React.FC = () => {
  const navigate = useNavigate();
  const {
    loginModalState,
    closeLoginModal,
    enqueueChallenge,
    pushToast,
    setSavedRecoverableFlowId,
    triggerAccountsRefresh
  } = useApp();

  const { open, targetAccount, recoverFlowId } = loginModalState;

  const [phoneInput, setPhoneInput] = useState<string>('');
  const [smsCodeInput, setSmsCodeInput] = useState<string>('');
  const [flow, setFlow] = useState<LoginFlow | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<{
    code?: string;
    message: string;
    requestId?: string;
  } | null>(null);
  const [rateLimitUntilIso, setRateLimitUntilIso] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => getNowMs());

  // Separate idempotency keys per user action intent
  const createKeyRef = useRef<string>(generateIdempotencyKey());
  const sendSmsKeyRef = useRef<string>(generateIdempotencyKey());
  const submitCodeKeyRef = useRef<string>(generateIdempotencyKey());
  const cancelKeyRef = useRef<string>(generateIdempotencyKey());

  // Tick clock every 1s for resendAfter cooldown
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      setNowMs(getNowMs());
    }, 1000);
    return () => clearInterval(timer);
  }, [open]);

  const syncFlowState = useCallback(
    (nextFlow: LoginFlow, openCaptchaIfNeeded = true) => {
      setFlow(nextFlow);

      if (['completed', 'failed', 'canceled', 'expired'].includes(nextFlow.state)) {
        setSavedRecoverableFlowId(null);
      } else {
        setSavedRecoverableFlowId(nextFlow.id);
      }

      if (nextFlow.state === 'completed' && nextFlow.accountId) {
        triggerAccountsRefresh();
        pushToast({
          type: 'success',
          title: nextFlow.targetAccountId ? '账号重新登录成功' : '米游社账号绑定成功',
          message: nextFlow.targetAccountId
            ? '目标账号登录凭据已更新。'
            : '新账号默认关闭每日定时计划，请前往账号详情选择任务并主动开启每日计划。'
        });
      }

      if (
        openCaptchaIfNeeded &&
        nextFlow.state === 'awaiting_captcha' &&
        (nextFlow.nextAction === 'solve_challenge' || nextFlow.nextAction === 'renew_challenge') &&
        nextFlow.challengeId
      ) {
        enqueueChallenge({
          challengeId: nextFlow.challengeId,
          contextLabel: `手机号 ${nextFlow.phoneMasked}`,
          onAccepted: () => {
            // After challenge receipt accepted, poll/query the login flow!
            void (async () => {
              try {
                const updated = await apiClient.getLoginFlow(nextFlow.id);
                syncFlowState(updated.data, true);
              } catch (err) {
                if (err instanceof ApiClientError) {
                  setErrorBanner({
                    code: err.code,
                    message: err.message,
                    requestId: err.requestId
                  });
                }
              }
            })();
          }
        });
      }
    },
    [enqueueChallenge, pushToast, setSavedRecoverableFlowId, triggerAccountsRefresh]
  );

  // Recover flow if recoverFlowId is passed
  useEffect(() => {
    if (!open) return;
    setErrorBanner(null);

    if (recoverFlowId) {
      setBusyAction('recovering');
      void apiClient
        .getLoginFlow(recoverFlowId)
        .then((res) => {
          syncFlowState(res.data, false);
        })
        .catch((err) => {
          setSavedRecoverableFlowId(null);
          setFlow(null);
          if (err instanceof ApiClientError) {
            setErrorBanner({
              code: err.code,
              message:
                err.code === 'FLOW_EXPIRED'
                  ? '之前未完成的登录流程已过期，请重新输入手机号开始。'
                  : err.message,
              requestId: err.requestId
            });
          }
        })
        .finally(() => {
          setBusyAction(null);
        });
    } else if (targetAccount && flow?.targetAccountId !== targetAccount.id) {
      // Starting fresh re-login for a specific target account
      setFlow(null);
      setPhoneInput('');
      setSmsCodeInput('');
      createKeyRef.current = generateIdempotencyKey();
    }
  }, [open, recoverFlowId, targetAccount]);

  // Poll when flow.state === 'exchanging' or nextAction === 'poll'
  useEffect(() => {
    if (!open || !flow) return;
    if (flow.state !== 'exchanging' && flow.nextAction !== 'poll') return;

    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void apiClient
        .getLoginFlow(flow.id)
        .then((res) => {
          syncFlowState(res.data, true);
        })
        .catch((err) => {
          if (err instanceof ApiClientError) {
            if (err.code === 'FLOW_EXPIRED' || err.status === 410) {
              setSavedRecoverableFlowId(null);
              setFlow((prev) => (prev ? { ...prev, state: 'expired', nextAction: 'restart' } : null));
            }
            setErrorBanner({
              code: err.code,
              message: err.message,
              requestId: err.requestId
            });
          }
        });
    }, 1500);

    return () => clearInterval(timer);
  }, [open, flow, syncFlowState, setSavedRecoverableFlowId]);

  if (!open) return null;

  const resendCooldownSec = Math.max(
    getRemainingSeconds(flow?.resendAfter, nowMs),
    getRemainingSeconds(rateLimitUntilIso, nowMs)
  );

  const handleCreateFlow = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedPhone = phoneInput.trim();
    if (!isValidCnPhone(trimmedPhone)) {
      setErrorBanner({
        code: 'VALIDATION_ERROR',
        message: '请输入有效的 11 位中国大陆手机号（1 开头，如 13900000000）'
      });
      return;
    }

    setBusyAction('create');
    setErrorBanner(null);
    try {
      const res = await apiClient.createLoginFlow(
        {
          phone: trimmedPhone,
          countryCode: '+86',
          ...(targetAccount ? { targetAccountId: targetAccount.id } : {})
        },
        createKeyRef.current
      );
      // Clear raw phone from state so it doesn't linger unnecessarily
      setPhoneInput('');
      setSmsCodeInput('');
      sendSmsKeyRef.current = generateIdempotencyKey();
      syncFlowState(res.data, false);
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (!err.retryable) {
          createKeyRef.current = generateIdempotencyKey();
        }
        setErrorBanner({
          code: err.code,
          message: err.message,
          requestId: err.requestId
        });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleSendSms = async () => {
    if (!flow || busyAction || resendCooldownSec > 0) return;
    setBusyAction('send_sms');
    setErrorBanner(null);

    try {
      const res = await apiClient.sendLoginSms(flow.id, sendSmsKeyRef.current);
      // Prepare new key for future resend intent
      sendSmsKeyRef.current = generateIdempotencyKey();
      syncFlowState(res.data, true);
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === 'RATE_LIMITED' && err.retryAfterSeconds) {
          setRateLimitUntilIso(new Date(getNowMs() + err.retryAfterSeconds * 1000).toISOString());
          sendSmsKeyRef.current = generateIdempotencyKey();
        } else if (err.code === 'FLOW_EXPIRED' || err.status === 410) {
          setSavedRecoverableFlowId(null);
          setFlow((prev) => (prev ? { ...prev, state: 'expired', nextAction: 'restart' } : null));
        } else if (!err.retryable) {
          sendSmsKeyRef.current = generateIdempotencyKey();
        }
        setErrorBanner({
          code: err.code,
          message: err.message,
          requestId: err.requestId
        });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleSubmitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!flow || busyAction) return;

    // Preserve string with leading zeros strictly!
    if (!isValidSmsCode(smsCodeInput)) {
      setErrorBanner({
        code: 'VALIDATION_ERROR',
        message: '请输入完整的 6 位数字短信验证码（保留前导零，如 000000）'
      });
      return;
    }

    setBusyAction('submit_code');
    setErrorBanner(null);

    try {
      const res = await apiClient.submitLoginCode(
        flow.id,
        { code: smsCodeInput },
        submitCodeKeyRef.current
      );
      submitCodeKeyRef.current = generateIdempotencyKey();
      setSmsCodeInput('');
      syncFlowState(res.data, true);
    } catch (err) {
      if (err instanceof ApiClientError) {
        // When code is invalid (422 SMS_CODE_INVALID), generate a new idempotency key for the next attempt
        if (err.code === 'SMS_CODE_INVALID' || !err.retryable) {
          submitCodeKeyRef.current = generateIdempotencyKey();
        }
        if (err.code === 'FLOW_EXPIRED' || err.status === 410) {
          setSavedRecoverableFlowId(null);
          setFlow((prev) => (prev ? { ...prev, state: 'expired', nextAction: 'restart' } : null));
        }
        setErrorBanner({
          code: err.code,
          message: err.message,
          requestId: err.requestId
        });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleCancelFlow = async () => {
    if (!flow || busyAction) return;
    setBusyAction('cancel');
    setErrorBanner(null);

    try {
      const res = await apiClient.cancelLoginFlow(flow.id, cancelKeyRef.current);
      cancelKeyRef.current = generateIdempotencyKey();
      syncFlowState(res.data, false);
      setSavedRecoverableFlowId(null);
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === 'FLOW_EXPIRED' || err.status === 410) {
          setSavedRecoverableFlowId(null);
          setFlow(null);
        }
        setErrorBanner({
          code: err.code,
          message: err.message,
          requestId: err.requestId
        });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const handleRestart = () => {
    setFlow(null);
    setErrorBanner(null);
    setSmsCodeInput('');
    setSavedRecoverableFlowId(null);
    createKeyRef.current = generateIdempotencyKey();
    sendSmsKeyRef.current = generateIdempotencyKey();
    submitCodeKeyRef.current = generateIdempotencyKey();
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-account-modal-title"
    >
      <div className="modal-card modal-card-md">
        <div className="modal-header">
          <div>
            <div className="eyebrow-row">
              <span className="badge badge-cobalt">
                {targetAccount || flow?.targetAccountId ? '重新登录既有米游社账号' : '绑定新米游社账号'}
              </span>
              <span className="badge badge-slate">本实例后端代理 · 不直连上游</span>
            </div>
            <h2 id="add-account-modal-title" className="modal-title">
              {targetAccount
                ? `重新登录：${targetAccount.nickname} (${targetAccount.phoneMasked})`
                : '添加米游社短信登录账号'}
            </h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={closeLoginModal}
            aria-label="关闭窗口（不取消后台已提交操作）"
            title="仅关闭弹窗，不自动取消进行中的流程"
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {/* Notice distinguishing panel admin login vs Miyoushe SMS login */}
          <div className="subtle-info-strip">
            <span>
              说明：此处为<strong>米游社通行证短信验证流程</strong>，仅用于获取社区签到凭据；
              手机号与验证码不会保存在浏览器存储或前端日志中。
            </span>
          </div>

          {targetAccount && (
            <div className="alert-banner alert-info">
              <KeyRound size={18} />
              <div>
                <strong>正在为目标账号更新根凭据 (targetAccountId: {targetAccount.id.slice(0, 8)}...)</strong>
                <p>
                  你可以重新输入完整手机号。后端将校验新登录通行证的 <code>aid</code> 必须与原账号 ({targetAccount.uid}) 一致，绝不将其他账号覆盖到该记录。
                </p>
              </div>
            </div>
          )}

          {errorBanner && (
            <div className="alert-banner alert-danger" role="alert">
              <ShieldAlert size={18} />
              <div>
                <strong>
                  操作未完成 {errorBanner.code ? `(${errorBanner.code})` : ''}
                </strong>
                <p>{errorBanner.message}</p>
                {errorBanner.requestId && (
                  <span className="mono text-xs">RequestId: {errorBanner.requestId}</span>
                )}
              </div>
            </div>
          )}

          {/* STEP 1: Create Login Flow */}
          {!flow && (
            <form onSubmit={(e) => void handleCreateFlow(e)} className="form-stack">
              <div className="form-group">
                <label htmlFor="mys-phone-input" className="form-label">
                  中国大陆手机号码 (+86)
                </label>
                <div className="input-with-prefix">
                  <span className="input-prefix mono">+86</span>
                  <input
                    id="mys-phone-input"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={11}
                    placeholder="请输入 11 位手机号，如 13900000000"
                    className="form-input mono"
                    value={phoneInput}
                    onChange={(e) => {
                      const digitsOnly = e.target.value.replace(/\D/g, '').slice(0, 11);
                      setPhoneInput(digitsOnly);
                      createKeyRef.current = generateIdempotencyKey();
                    }}
                    required
                  />
                </div>
                <span className="form-hint">
                  第一步仅在本地创建登录流程并记录状态，<strong>不会自动发送短信</strong>。
                  （模拟提示：输入 <code>13900008888</code> 可测试重复绑定冲突，重登时输入{' '}
                  <code>13900009999</code> 可测试 aid 不一致拦截）
                </span>
              </div>

              <div className="form-actions-row">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={busyAction !== null || !isValidCnPhone(phoneInput)}
                >
                  <Smartphone size={16} />
                  {busyAction === 'create' ? '正在创建登录流程...' : '第一步：创建登录流程'}
                </button>
              </div>
            </form>
          )}

          {/* STEP 2+: Active Flow State Machine */}
          {flow && (
            <div className="flow-status-container">
              <div className="flow-progress-header">
                <div>
                  <span className="text-xs text-muted mono">Flow ID: {flow.id}</span>
                  <div className="flow-state-headline">
                    <span className={`status-dot status-${flow.state}`} />
                    <strong>{FLOW_STATE_LABELS[flow.state]}</strong>
                  </div>
                </div>
                <div className="text-right">
                  <span className="badge badge-slate mono">{flow.phoneMasked}</span>
                  <div className="text-xs text-muted mt-1">
                    流程有效期至 {formatShanghaiDateTime(flow.expiresAt)}
                  </div>
                </div>
              </div>

              {/* State: created */}
              {flow.state === 'created' && (
                <div className="stage-box">
                  <p>
                    登录流程已创建（当前尚未向手机号 <code>{flow.phoneMasked}</code> 发送短信）。
                    请点击下方按钮请求发送短信验证码；若触发风控将弹出人工验证窗口。
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary mt-3"
                    disabled={busyAction !== null || resendCooldownSec > 0}
                    onClick={() => void handleSendSms()}
                  >
                    <Send size={16} />
                    {busyAction === 'send_sms'
                      ? '正在请求发送短信...'
                      : resendCooldownSec > 0
                        ? `请等待 ${resendCooldownSec} 秒后再试`
                        : '获取验证码（发送短信）'}
                  </button>
                </div>
              )}

              {/* State: awaiting_captcha */}
              {flow.state === 'awaiting_captcha' && (
                <div className="stage-box stage-box-amber">
                  <div className="stage-box-title">
                    <ShieldAlert size={18} />
                    <span>需要手动完成人机验证（短信尚未发送）</span>
                  </div>
                  <p>
                    注意：当前状态为 <code>awaiting_captcha</code>，<strong>短信尚未发出，也未开始重发倒计时</strong>。
                    请先手动完成极验验证，验证通过后系统将自动继续短信发送或登录流程。
                  </p>
                  <div className="button-row mt-3">
                    {flow.challengeId && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() =>
                          enqueueChallenge({
                            challengeId: flow.challengeId!,
                            contextLabel: `手机号 ${flow.phoneMasked}`,
                            onAccepted: () => {
                              void apiClient.getLoginFlow(flow.id).then((res) => syncFlowState(res.data, true));
                            }
                          })
                        }
                      >
                        {flow.nextAction === 'renew_challenge'
                          ? '打开验证舱并更新验证会话'
                          : '继续手动完成人机验证'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busyAction !== null}
                      onClick={() => {
                        setBusyAction('poll');
                        void apiClient
                          .getLoginFlow(flow.id)
                          .then((res) => syncFlowState(res.data, false))
                          .finally(() => setBusyAction(null));
                      }}
                    >
                      <RefreshCw size={14} /> 刷新流程状态
                    </button>
                  </div>
                </div>
              )}

              {/* State: awaiting_sms_code */}
              {flow.state === 'awaiting_sms_code' && (
                <form onSubmit={(e) => void handleSubmitCode(e)} className="stage-box">
                  <div className="alert-banner alert-success mb-3">
                    <CheckCircle2 size={18} />
                    <div>
                      <strong>短信验证码已发送至 {flow.phoneMasked}</strong>
                      <p>
                        请输入收到的 6 位数字验证码（支持前导零，如 <code>000000</code>；模拟模式下输入{' '}
                        <code>000001</code> 可测试验证码错误分支）。
                      </p>
                    </div>
                  </div>

                  <div className="form-group">
                    <label htmlFor="mys-sms-code-input" className="form-label">
                      6 位短信验证码（字符串格式，保留前导零）
                    </label>
                    <input
                      id="mys-sms-code-input"
                      type="text"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={6}
                      placeholder="例如 000000"
                      className="form-input mono code-input-lg"
                      value={smsCodeInput}
                      onChange={(e) => {
                        const rawDigits = e.target.value.replace(/[^0-9]/g, '').slice(0, 6);
                        setSmsCodeInput(rawDigits);
                        // Modifying the code generates a new idempotency key
                        submitCodeKeyRef.current = generateIdempotencyKey();
                      }}
                      required
                    />
                  </div>

                  <div className="resend-row">
                    <div className="text-xs text-muted">
                      <Clock size={13} style={{ display: 'inline', marginRight: 4 }} />
                      {resendCooldownSec > 0 ? (
                        <span>
                          重发等待时间：<strong>{resendCooldownSec} 秒</strong>
                          （注：此倒计时仅代表服务端重发冷却限制，不是验证码的官方失效时间）
                        </span>
                      ) : (
                        <span>已超过重发冷却时间，如未收到短信可点击重新发送。</span>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busyAction !== null || resendCooldownSec > 0}
                      onClick={() => void handleSendSms()}
                    >
                      <Send size={13} />
                      {resendCooldownSec > 0 ? `重发 (${resendCooldownSec}s)` : '重新发送短信'}
                    </button>
                  </div>

                  <div className="form-actions-row mt-4">
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={busyAction !== null || !isValidSmsCode(smsCodeInput)}
                    >
                      <KeyRound size={16} />
                      {busyAction === 'submit_code' ? '正在提交验证码...' : '提交短信验证码'}
                    </button>
                  </div>
                </form>
              )}

              {/* State: exchanging */}
              {flow.state === 'exchanging' && (
                <div className="stage-box">
                  <div className="state-box">
                    <RefreshCw className="spin" size={22} />
                    <div>
                      <strong>正在获取登录凭据 (exchanging)...</strong>
                      <p className="text-muted text-sm mt-1">
                        后端正在安全交换 <code>stoken_v2</code> 与工作 Cookie，正在自动轮询登录进度...
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* State: completed */}
              {flow.state === 'completed' && flow.accountId && (
                <div className="stage-box stage-box-green">
                  <div className="stage-box-title">
                    <CheckCircle2 size={20} />
                    <span>
                      {flow.targetAccountId ? '账号重新登录并更新凭据成功！' : '米游社账号绑定成功！'}
                    </span>
                  </div>
                  <p className="mt-2">
                    已确认关联账号 ID：<code className="mono">{flow.accountId}</code>。
                    {!flow.targetAccountId && (
                      <>
                        {' '}
                        新添加的账号<strong>默认关闭每日定时计划</strong>，请立即前往账号详情页核对要执行的社区任务，并主动开启每日计划。
                      </>
                    )}
                  </p>
                  <div className="button-row mt-4">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        const targetId = flow.accountId!;
                        closeLoginModal();
                        setFlow(null);
                        navigate(`/accounts/${targetId}`);
                      }}
                    >
                      前往选择任务并开启每日计划 <ArrowRight size={16} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => {
                        closeLoginModal();
                        setFlow(null);
                      }}
                    >
                      返回当前页面
                    </button>
                  </div>
                </div>
              )}

              {/* State: failed / expired / canceled */}
              {(flow.state === 'failed' || flow.state === 'expired' || flow.state === 'canceled') && (
                <div className="stage-box stage-box-red">
                  <div className="stage-box-title">
                    <ShieldAlert size={18} />
                    <span>{FLOW_STATE_LABELS[flow.state]}</span>
                  </div>
                  {flow.lastError && (
                    <p className="mt-2">
                      错误码：<code>{flow.lastError.code}</code> — {flow.lastError.message}
                    </p>
                  )}
                  <div className="button-row mt-3">
                    <button type="button" className="btn btn-primary" onClick={handleRestart}>
                      <RefreshCw size={15} /> 重新开始登录流程
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-footer">
          <span className="footer-note">
            关闭弹窗不会自动终止已提交的流程；如需作废当前流程请点击「取消登录」。
          </span>
          <div className="footer-actions">
            {flow && !['completed', 'failed', 'canceled', 'expired'].includes(flow.state) && (
              <button
                type="button"
                className="btn btn-danger-outline"
                disabled={busyAction !== null}
                onClick={() => void handleCancelFlow()}
              >
                <Ban size={14} />
                {busyAction === 'cancel' ? '正在取消...' : '取消登录'}
              </button>
            )}
            <button type="button" className="btn btn-secondary" onClick={closeLoginModal}>
              关闭窗口
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
