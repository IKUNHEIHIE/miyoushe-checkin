import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck, KeyRound, Lock, User, AlertTriangle } from 'lucide-react';
import { apiClient, ApiClientError } from '../api/client';
import { useApp } from '../context/AppContext';

export const SetupPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    contractVersion,
    setInitializedState,
    pushToast
  } = useApp();

  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorInfo, setErrorInfo] = useState<{
    code?: string;
    message: string;
    fieldErrors?: { field: string; message: string }[];
    requestId?: string;
  } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorInfo(null);

    if (password !== confirmPassword) {
      setErrorInfo({
        code: 'VALIDATION_ERROR',
        message: '两次输入的管理员密码不一致，请核对后重试'
      });
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiClient.initializeAdmin(setupToken.trim(), {
        username: username.trim(),
        password
      });
      // Contract rule: Initialization does NOT auto-login; redirect to /login
      setInitializedState(true);
      pushToast({
        type: 'success',
        title: `实例管理员 (${res.data.username}) 初始化完成`,
        message: '初始化不会自动建立登录会话，请使用刚刚设置的管理员账号密码登录面板。'
      });
      navigate('/login', { replace: true });
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === 'ALREADY_INITIALIZED') {
          setInitializedState(true);
          pushToast({
            type: 'info',
            title: '实例已完成初始化',
            message: '已为您跳转至面板管理员登录页面。'
          });
          navigate('/login', { replace: true });
          return;
        }
        setErrorInfo({
          code: err.code,
          message: err.message,
          fieldErrors: err.details?.fieldErrors,
          requestId: err.requestId
        });
      } else {
        setErrorInfo({
          message: '初始化请求失败，请检查网络连接'
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page-layout">
      <div className="auth-card">
        <div className="auth-card-header">
          <div className="eyebrow-row">
            <span className="badge badge-cobalt">首次部署初始化 · 单管理员实例</span>
            <span className="badge badge-slate">契约 v{contractVersion ?? '…'}</span>
          </div>
          <h1 className="auth-title">初始化自托管签到面板</h1>
          <p className="auth-subtitle">
            本产品为单实例自托管架构：仅设置一名面板管理员来统一管理你的多个米游社账号，不开放公共注册。初始化完成后将跳转至登录页（不自动登录）。
          </p>
        </div>

        {errorInfo && (
          <div className="alert-banner alert-danger mb-4" role="alert">
            <AlertTriangle size={18} />
            <div>
              <strong>初始化失败 {errorInfo.code ? `(${errorInfo.code})` : ''}</strong>
              <p>{errorInfo.message}</p>
              {errorInfo.fieldErrors && errorInfo.fieldErrors.length > 0 && (
                <ul className="field-error-list">
                  {errorInfo.fieldErrors.map((fe, i) => (
                    <li key={i}>
                      <code>{fe.field}</code>: {fe.message}
                    </li>
                  ))}
                </ul>
              )}
              {errorInfo.requestId && (
                <div className="mono text-xs mt-1">RequestId: {errorInfo.requestId}</div>
              )}
            </div>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="form-stack">
          <div className="form-group">
            <label htmlFor="setup-token-input" className="form-label">
              部署者初始化令牌 (Header: <code>X-Setup-Token</code>)
            </label>
            <div className="input-icon-wrap">
              <KeyRound size={16} className="input-icon" />
              <input
                id="setup-token-input"
                type="password"
                autoComplete="off"
                className="form-input mono"
                placeholder="请输入服务端环境变量配置的初始化 Token"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                required
              />
            </div>
            <span className="form-hint">
              来自部署环境配置，不会写入前端构建产物。（模拟模式下输入 <code>invalid-token</code> 可测试 403 拒绝）
            </span>
          </div>

          <div className="form-group">
            <label htmlFor="setup-username-input" className="form-label">
              面板管理员用户名 (3–64 位，允许字母/数字/<code>_.-</code>)
            </label>
            <div className="input-icon-wrap">
              <User size={16} className="input-icon" />
              <input
                id="setup-username-input"
                type="text"
                autoComplete="username"
                minLength={3}
                maxLength={64}
                pattern="^[a-zA-Z0-9_.-]+$"
                className="form-input"
                placeholder="例如 admin"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="setup-password-input" className="form-label">
              面板管理员密码 (12–128 位)
            </label>
            <div className="input-icon-wrap">
              <Lock size={16} className="input-icon" />
              <input
                id="setup-password-input"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                className="form-input"
                placeholder="请输入至少 12 位的高强度管理员密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="setup-confirm-password-input" className="form-label">
              确认管理员密码
            </label>
            <div className="input-icon-wrap">
              <Lock size={16} className="input-icon" />
              <input
                id="setup-confirm-password-input"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                className="form-input"
                placeholder="请再次输入管理员密码"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
              />
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-full mt-2"
            disabled={submitting || !setupToken.trim() || username.trim().length < 3 || password.length < 12}
          >
            <ShieldCheck size={16} />
            {submitting ? '正在提交初始化...' : '完成实例初始化并前往登录'}
          </button>
        </form>
      </div>
    </div>
  );
};
