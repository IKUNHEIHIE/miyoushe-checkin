import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ShieldAlert, RefreshCw, X, Play, AlertTriangle, Clock } from 'lucide-react';
import { apiClient, ApiClientError } from '../api/client';
import { useApp } from '../context/AppContext';
import {
  type Challenge,
  CHALLENGE_OWNER_LABELS,
  CHALLENGE_PURPOSE_LABELS,
  type ChallengeSubmission
} from '../types/openapi';
import {
  formatRemainingDuration,
  formatShanghaiDateTime,
  generateIdempotencyKey,
  getNowMs,
  getRemainingSeconds
} from '../utils/format';

// Fixed allowlisted official Geetest script URLs — never execute arbitrary script URLs from backend
const OFFICIAL_GT4_SCRIPT_URL = 'https://static.geetest.com/v4/gt4.js';
const OFFICIAL_GT3_SCRIPT_URL = 'https://static.geetest.com/static/tools/gt.js';

interface Gt4CaptchaObj {
  onReady: (cb: () => void) => Gt4CaptchaObj;
  onSuccess: (cb: () => void) => Gt4CaptchaObj;
  onError: (cb: (err: unknown) => void) => Gt4CaptchaObj;
  onClose: (cb: () => void) => Gt4CaptchaObj;
  showCaptcha: () => void;
  getValidate: () => {
    lot_number: string;
    captcha_output: string;
    pass_token: string;
    gen_time: string;
    captcha_id?: string;
  } | false;
  destroy?: () => void;
}

interface Gt3CaptchaObj {
  onReady: (cb: () => void) => void;
  onSuccess: (cb: () => void) => void;
  onError: (cb: () => void) => void;
  onClose: (cb: () => void) => void;
  verify: () => void;
  getValidate: () => {
    geetest_challenge: string;
    geetest_validate: string;
    geetest_seccode: string;
  } | false;
  destroy?: () => void;
}

declare global {
  interface Window {
    initGeetest4?: (
      config: Record<string, unknown>,
      callback: (captchaObj: Gt4CaptchaObj) => void
    ) => void;
    initGeetest?: (
      config: Record<string, unknown>,
      callback: (captchaObj: Gt3CaptchaObj) => void
    ) => void;
  }
}

function loadAllowlistedScript(allowedUrl: string): Promise<void> {
  if (allowedUrl !== OFFICIAL_GT4_SCRIPT_URL && allowedUrl !== OFFICIAL_GT3_SCRIPT_URL) {
    return Promise.reject(new Error('禁止加载非官方白名单脚本地址'));
  }
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${allowedUrl}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = allowedUrl;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('OFFICIAL_SDK_LOAD_ERROR'));
    document.head.appendChild(script);
  });
}

type UiNoticeKind =
  | null
  | 'sdk_error'
  | 'user_canceled'
  | 'upstream_rejected'
  | 'session_expired'
  | 'unsupported_version';

export const ChallengeModal: React.FC = () => {
  const {
    capabilities,
    activeChallenge,
    queuedChallengesCount,
    closeActiveChallenge,
    updateActiveChallengeId,
    pushToast
  } = useApp();

  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [renewing, setRenewing] = useState<boolean>(false);
  const [sdkReady, setSdkReady] = useState<boolean>(false);
  const [noticeKind, setNoticeKind] = useState<UiNoticeKind>(null);
  const [errorDetailText, setErrorDetailText] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => getNowMs());

  const submitIdempotencyKeyRef = useRef<string>(generateIdempotencyKey());
  const renewIdempotencyKeyRef = useRef<string>(generateIdempotencyKey());
  const captchaInstanceRef = useRef<Gt4CaptchaObj | Gt3CaptchaObj | null>(null);

  const destroySdkInstance = useCallback(() => {
    if (captchaInstanceRef.current && typeof captchaInstanceRef.current.destroy === 'function') {
      try {
        captchaInstanceRef.current.destroy();
      } catch {
        // Ignore cleanup error
      }
    }
    captchaInstanceRef.current = null;
    setSdkReady(false);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(getNowMs());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const fetchChallengeConfig = useCallback(
    async (challengeId: string) => {
      setLoading(true);
      setNoticeKind(null);
      setErrorDetailText(null);
      destroySdkInstance();
      submitIdempotencyKeyRef.current = generateIdempotencyKey();

      try {
        const res = await apiClient.getChallenge(challengeId);
        const data = res.data;
        setChallenge(data);

        // Check expiration or failed state
        if (data.state === 'expired' || getRemainingSeconds(data.expiresAt) <= 0) {
          setNoticeKind('session_expired');
          return;
        }
        if (data.state === 'failed') {
          setNoticeKind('upstream_rejected');
          return;
        }

        // Check capabilities for version support
        const supportedVersions = capabilities?.captchaVersions ?? ['gt4'];
        if (!supportedVersions.includes(data.version)) {
          setNoticeKind('unsupported_version');
          return;
        }
      } catch (err) {
        if (err instanceof ApiClientError) {
          if (err.code === 'CHALLENGE_EXPIRED' || err.status === 410) {
            setNoticeKind('session_expired');
            setErrorDetailText(err.message);
          } else if (err.code === 'CHALLENGE_UNSUPPORTED') {
            setNoticeKind('unsupported_version');
            setErrorDetailText(err.message);
          } else {
            setErrorDetailText(`${err.message} (RequestId: ${err.requestId})`);
          }
        }
      } finally {
        setLoading(false);
      }
    },
    [capabilities?.captchaVersions, destroySdkInstance]
  );

  useEffect(() => {
    if (activeChallenge?.challengeId) {
      if (challenge?.id !== activeChallenge.challengeId) {
        void fetchChallengeConfig(activeChallenge.challengeId);
      }
    } else {
      setChallenge(null);
      destroySdkInstance();
    }
  }, [activeChallenge?.challengeId, challenge?.id, fetchChallengeConfig, destroySdkInstance]);

  useEffect(() => {
    return () => {
      destroySdkInstance();
    };
  }, [destroySdkInstance]);

  const handleSubmitValidation = useCallback(
    async (submission: ChallengeSubmission) => {
      if (!challenge || submitting) return;
      setSubmitting(true);
      setNoticeKind(null);
      setErrorDetailText(null);

      try {
        const res = await apiClient.submitChallenge(
          challenge.id,
          submission,
          submitIdempotencyKeyRef.current
        );
        destroySdkInstance();
        pushToast({
          type: 'info',
          title: '人工验证结果已提交',
          message: res.data.message || '验证结果已受理，正在继续查询关联操作状态（不等同于整个流程已完成）。'
        });
        activeChallenge?.onAccepted?.(res.data);
        closeActiveChallenge(true);
      } catch (err) {
        // Generate a fresh idempotency key for subsequent attempts
        submitIdempotencyKeyRef.current = generateIdempotencyKey();
        destroySdkInstance();
        if (err instanceof ApiClientError) {
          if (err.code === 'CHALLENGE_FAILED') {
            setNoticeKind('upstream_rejected');
            setErrorDetailText(
              `${err.message}${err.details?.upstreamRetcode ? ` (上游返回码: ${err.details.upstreamRetcode})` : ''}`
            );
          } else if (err.code === 'CHALLENGE_EXPIRED' || err.status === 410) {
            setNoticeKind('session_expired');
            setErrorDetailText(err.message);
          } else if (err.code === 'CHALLENGE_UNSUPPORTED' || err.code === 'CAPABILITY_UNAVAILABLE') {
            setNoticeKind('unsupported_version');
            setErrorDetailText(err.message);
          } else {
            setErrorDetailText(`${err.message} (RequestId: ${err.requestId})`);
          }
        } else {
          setErrorDetailText('提交验证结果失败，请检查网络或更新验证会话');
        }
      } finally {
        setSubmitting(false);
      }
    },
    [activeChallenge, challenge, closeActiveChallenge, destroySdkInstance, pushToast, submitting]
  );

  // Load only the allowlisted official verification component.
  const initRealOfficialSdk = useCallback(async () => {
    if (!challenge) return;
    if (challenge.config.captchaId.startsWith('mock-')) {
      setNoticeKind('sdk_error');
      setErrorDetailText('验证配置无效，请更新验证会话后重试。');
      return;
    }

    setNoticeKind(null);
    setErrorDetailText(null);
    destroySdkInstance();

    try {
      if (challenge.version === 'gt4') {
        await loadAllowlistedScript(OFFICIAL_GT4_SCRIPT_URL);
        if (typeof window.initGeetest4 !== 'function') {
          throw new Error('OFFICIAL_SDK_LOAD_ERROR');
        }
        const gt4InitConfig: Record<string, unknown> = {
          captchaId: challenge.config.captchaId,
          product: 'bind',
          language: challenge.config.language || 'zho'
        };
        if (challenge.config.riskType) {
          gt4InitConfig.riskType = challenge.config.riskType;
        }
        if (challenge.config.userInfo) {
          gt4InitConfig.userInfo = challenge.config.userInfo;
        }
        window.initGeetest4(gt4InitConfig, (captchaObj) => {
          captchaInstanceRef.current = captchaObj;
          captchaObj
            .onReady(() => {
              setSdkReady(true);
            })
            .onSuccess(() => {
              const result = captchaObj.getValidate();
              if (result) {
                void handleSubmitValidation({
                  version: 'gt4',
                  result: {
                    lot_number: String(result.lot_number),
                    captcha_output: String(result.captcha_output),
                    pass_token: String(result.pass_token),
                    gen_time: String(result.gen_time),
                    ...(result.captcha_id ? { captcha_id: String(result.captcha_id) } : {})
                  }
                });
              }
            })
            .onClose(() => {
              // User closed the Geetest popup without completing: NOT a verification failure!
              setNoticeKind('user_canceled');
            })
            .onError(() => {
              setNoticeKind('sdk_error');
              setErrorDetailText('极验 v4 官方组件运行异常，请点击重试加载或更新验证会话。');
            });
        });
      } else if (challenge.version === 'gt3') {
        const supported = capabilities?.captchaVersions ?? [];
        if (!supported.includes('gt3')) {
          setNoticeKind('unsupported_version');
          return;
        }
        await loadAllowlistedScript(OFFICIAL_GT3_SCRIPT_URL);
        if (typeof window.initGeetest !== 'function' || !challenge.config.challenge) {
          throw new Error('OFFICIAL_SDK_LOAD_ERROR');
        }
        window.initGeetest(
          {
            gt: challenge.config.captchaId,
            challenge: challenge.config.challenge,
            offline: challenge.config.offline,
            new_captcha: challenge.config.newCaptcha ?? true,
            product: 'bind',
            lang: 'zh-cn'
          },
          (captchaObj) => {
            captchaInstanceRef.current = captchaObj;
            captchaObj.onReady(() => {
              setSdkReady(true);
            });
            captchaObj.onSuccess(() => {
              const res = captchaObj.getValidate();
              if (res) {
                void handleSubmitValidation({
                  version: 'gt3',
                  result: {
                    geetest_challenge: String(res.geetest_challenge),
                    geetest_validate: String(res.geetest_validate),
                    geetest_seccode: String(res.geetest_seccode)
                  }
                });
              }
            });
            captchaObj.onClose(() => {
              setNoticeKind('user_canceled');
            });
            captchaObj.onError(() => {
              setNoticeKind('sdk_error');
            });
          }
        );
      }
    } catch {
      setNoticeKind('sdk_error');
      setErrorDetailText('无法从官方地址加载极验 SDK 脚本，请检查网络连接或广告拦截插件设置。');
    }
  }, [capabilities?.captchaVersions, challenge, destroySdkInstance, handleSubmitValidation]);

  useEffect(() => {
    if (
      challenge &&
      challenge.state === 'pending' &&
      noticeKind === null
    ) {
      void initRealOfficialSdk();
    }
  }, [challenge, initRealOfficialSdk, noticeKind]);

  const handleRenewSession = async () => {
    if (!challenge || renewing) return;
    setRenewing(true);
    destroySdkInstance();
    setNoticeKind(null);
    setErrorDetailText(null);

    try {
      const res = await apiClient.renewChallenge(challenge.id, renewIdempotencyKeyRef.current);
      // Generate fresh idempotency keys for the new challenge session
      renewIdempotencyKeyRef.current = generateIdempotencyKey();
      submitIdempotencyKeyRef.current = generateIdempotencyKey();
      setChallenge(res.data);
      updateActiveChallengeId(res.data.id);
      pushToast({
        type: 'success',
        title: '已更新验证会话',
        message: `新会话 ID (${res.data.id.slice(0, 8)}...) 已就绪，请手动完成人机验证。`
      });
    } catch (err) {
      renewIdempotencyKeyRef.current = generateIdempotencyKey();
      if (err instanceof ApiClientError) {
        if (err.code === 'CHALLENGE_EXPIRED' || err.status === 410) {
          setNoticeKind('session_expired');
          setErrorDetailText(
            `${err.message} — 官方验证会话剩余窗口已彻底过期 (HTTP 410)，请关闭此窗口并重新发起短信发送或任务操作。`
          );
        } else {
          setErrorDetailText(`${err.message} (RequestId: ${err.requestId})`);
        }
      } else {
        setErrorDetailText('更新验证会话失败，请稍后重试');
      }
    } finally {
      setRenewing(false);
    }
  };

  if (!activeChallenge) return null;

  const remainingSec = challenge ? getRemainingSeconds(challenge.expiresAt, nowMs) : 0;
  const isExpired = challenge ? challenge.state === 'expired' || remainingSec <= 0 : false;
  const requiresRenew =
    isExpired ||
    challenge?.state === 'failed' ||
    noticeKind === 'upstream_rejected' ||
    noticeKind === 'session_expired';

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="challenge-modal-title"
    >
      <div className="modal-card modal-card-md">
        <div className="modal-header">
          <div>
            <div className="eyebrow-row">
              <span className="badge badge-amber">人工验证舱 · 手动完成</span>
              {queuedChallengesCount > 1 && (
                <span className="badge badge-slate">
                  队列中还有 {queuedChallengesCount - 1} 项待验证
                </span>
              )}
            </div>
            <h2 id="challenge-modal-title" className="modal-title">
              {challenge
                ? CHALLENGE_PURPOSE_LABELS[challenge.purpose] || '需要你手动完成人机验证'
                : '正在加载人工验证配置...'}
            </h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => closeActiveChallenge(false)}
            aria-label="暂不验证并关闭窗口"
            title="仅关闭弹窗，关联操作保持等待状态，可稍后点击继续验证"
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {loading && (
            <div className="state-box">
              <RefreshCw className="spin" size={20} />
              <span>正在从本实例后端读取当前 Challenge 配置...</span>
            </div>
          )}

          {!loading && challenge && (
            <>
              <div className="telemetry-grid">
                <div className="telemetry-item">
                  <span className="telemetry-label">关联操作类型</span>
                  <span className="telemetry-value">
                    {CHALLENGE_OWNER_LABELS[challenge.ownerType]}
                    {activeChallenge.contextLabel ? ` (${activeChallenge.contextLabel})` : ''}
                  </span>
                </div>
                <div className="telemetry-item">
                  <span className="telemetry-label">验证引擎与版本</span>
                  <span className="telemetry-value mono">
                    {challenge.provider.toUpperCase()} / {challenge.version.toUpperCase()} (product=
                    {challenge.config.product})
                  </span>
                </div>
                <div className="telemetry-item">
                  <span className="telemetry-label">Challenge 会话 ID</span>
                  <span className="telemetry-value mono">{challenge.id}</span>
                </div>
                <div className="telemetry-item">
                  <span className="telemetry-label">会话过期时间</span>
                  <span className={`telemetry-value mono ${isExpired ? 'text-danger' : ''}`}>
                    <Clock size={13} style={{ display: 'inline', marginRight: 4 }} />
                    {formatShanghaiDateTime(challenge.expiresAt)} (
                    {isExpired ? '已过期' : `剩余 ${formatRemainingDuration(challenge.expiresAt, nowMs)}`})
                  </span>
                </div>
              </div>

              {/* Distinct feedback banners for SDK error, user cancel, upstream reject, session expired, unsupported */}
              {noticeKind === 'user_canceled' && (
                <div className="alert-banner alert-info" role="status">
                  <AlertTriangle size={18} />
                  <div>
                    <strong>你已取消或关闭验证面板（未记为验证失败）</strong>
                    <p>
                      用户取消操作不会扣除重试次数，也不会销毁当前待验证会话。你可以再次点击下方按钮继续完成验证。
                    </p>
                  </div>
                </div>
              )}

              {noticeKind === 'sdk_error' && (
                <div className="alert-banner alert-warning" role="alert">
                  <ShieldAlert size={18} />
                  <div>
                    <strong>官方验证组件 (SDK) 加载失败</strong>
                    <p>{errorDetailText || '未能加载极验官方脚本，请检查网络或浏览器拦截规则后重试。'}</p>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm mt-2"
                        onClick={() => void initRealOfficialSdk()}
                      >
                        <RefreshCw size={14} /> 重新加载官方组件
                      </button>

                  </div>
                </div>
              )}

              {noticeKind === 'upstream_rejected' && (
                <div className="alert-banner alert-danger" role="alert">
                  <ShieldAlert size={18} />
                  <div>
                    <strong>上游未通过本次验证结果 (CHALLENGE_FAILED)</strong>
                    <p>
                      {errorDetailText || '验证未通过，旧验证组件已销毁，旧结果不能重复提交。'}
                      请点击下方【更新验证会话】获取全新的 Challenge 后重新手动完成。
                    </p>
                  </div>
                </div>
              )}

              {(noticeKind === 'session_expired' || isExpired) && (
                <div className="alert-banner alert-warning" role="alert">
                  <Clock size={18} />
                  <div>
                    <strong>当前人工验证会话已过期 (CHALLENGE_EXPIRED)</strong>
                    <p>
                      {errorDetailText || '验证会话已超过有效期，原组件已销毁。请点击【更新验证会话】创建新会话。'}
                    </p>
                  </div>
                </div>
              )}

              {noticeKind === 'unsupported_version' && (
                <div className="alert-banner alert-danger" role="alert">
                  <ShieldAlert size={18} />
                  <div>
                    <strong>当前能力目录暂不支持该验证版本 ({challenge.version})</strong>
                    <p>
                      系统不会自动跳过验证或伪造结果。请等待后端完成对应适配器验证并开放能力。
                    </p>
                  </div>
                </div>
              )}

              {errorDetailText && !noticeKind && (
                <div className="alert-banner alert-danger" role="alert">
                  <ShieldAlert size={18} />
                  <div>
                    <strong>验证请求提示</strong>
                    <p>{errorDetailText}</p>
                  </div>
                </div>
              )}

              {/* Renewal UI when failed or expired */}
              {requiresRenew && noticeKind !== 'unsupported_version' && (
                <div className="verification-stage-card renew-stage">
                  <div className="stage-title">需要更新人工验证会话</div>
                  <p className="stage-desc">
                    一次性验证会话失效或被拒绝后，必须由你主动申请新的验证会话（将生成新的{' '}
                    <code>challengeId</code> 与新的幂等 Key）。
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={renewing}
                    onClick={() => void handleRenewSession()}
                  >
                    <RefreshCw size={16} className={renewing ? 'spin' : ''} />
                    {renewing ? '正在生成新验证会话...' : '更新验证会话'}
                  </button>
                </div>
              )}

              {/* Active Verification Stage */}
              {!requiresRenew && noticeKind !== 'unsupported_version' && (
                <>

                    <div className="verification-stage-card">
                      <div className="stage-title">官方极验 ({challenge.version.toUpperCase()}) 人工验证</div>
                      <p className="stage-desc">
                        系统严格遵循手动完成原则，不集成任何自动解题服务。请点击下方按钮唤起官方验证框并手动完成验证。
                      </p>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={!sdkReady || submitting}
                        onClick={() => {
                          setNoticeKind(null);
                          const inst = captchaInstanceRef.current;
                          if (!inst) return;
                          if ('showCaptcha' in inst) {
                            inst.showCaptcha();
                          } else if ('verify' in inst) {
                            inst.verify();
                          }
                        }}
                      >
                        <Play size={16} />
                        {submitting
                          ? '正在提交验证结果...'
                          : sdkReady
                            ? '点击开始手动验证'
                            : '正在准备官方验证组件...'}
                      </button>
                    </div>

                </>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          <span className="footer-note">
            关闭此窗口不会取消后台等待中的任务；你可随时从页面顶部或对应任务处点击「继续验证」。
          </span>
          <div className="footer-actions">
            {challenge && !requiresRenew && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={renewing || submitting}
                onClick={() => void handleRenewSession()}
              >
                <RefreshCw size={14} className={renewing ? 'spin' : ''} /> 主动更换验证会话
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => closeActiveChallenge(false)}
            >
              稍后处理（保持等待）
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
