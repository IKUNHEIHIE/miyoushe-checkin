import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogIn, Lock, User, AlertTriangle, Info } from 'lucide-react';
import { apiClient, ApiClientError } from '../api/client';
import { useApp } from '../context/AppContext';

export const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const {
    setSessionData,
    setInitializedState,
    pushToast
  } = useApp();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorInfo, setErrorInfo] = useState<{
    code?: string;
    message: string;
    requestId?: string;
  } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;

    setSubmitting(true);
    setErrorInfo(null);
    try {
      const res = await apiClient.loginAdmin({
        username: username.trim(),
        password
      });
      setSessionData(res.data);
      pushToast({
        type: 'success',
        title: '管理员面板登录成功',
        message: `欢迎回来，${res.data.admin.username}。CSRF 令牌已安全载入内存。`
      });
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === 'SETUP_REQUIRED') {
          setInitializedState(false);
          navigate('/setup', { replace: true });
          return;
        }
        setErrorInfo({
          code: err.code,
          message: err.message,
          requestId: err.requestId
        });
      } else {
        setErrorInfo({
          message: '登录请求异常，请检查网络连接'
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
            <span className="badge badge-cobalt">面板管理员认证</span>
            <span className="badge badge-slate">HttpOnly Cookie + 内存 CSRF</span>
          </div>
          <h1 className="auth-title">登录米游社自托管签到面板</h1>
          <p className="auth-subtitle">
            此页面用于验证<strong>本实例面板管理员身份</strong>（用户名与密码），与进入面板后添加米游社账号的<strong>手机号短信登录</strong>是两套完全独立的流程。
          </p>
        </div>

        <div className="alert-banner alert-info mb-4">
          <Info size={18} />
          <div>
            <strong>独立认证说明</strong>
            <p>
              面板管理员会话通过同域 <code>HttpOnly Cookie</code> 维护；前端不拼接 Cookie，CSRF 令牌仅存内存。
            </p>
          </div>
        </div>

        {errorInfo && (
          <div className="alert-banner alert-danger mb-4" role="alert">
            <AlertTriangle size={18} />
            <div>
              <strong>登录未通过 {errorInfo.code ? `(${errorInfo.code})` : ''}</strong>
              <p>{errorInfo.message}</p>
              {errorInfo.requestId && (
                <div className="mono text-xs mt-1">RequestId: {errorInfo.requestId}</div>
              )}
            </div>
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="form-stack">
          <div className="form-group">
            <label htmlFor="admin-username-input" className="form-label">
              面板管理员用户名
            </label>
            <div className="input-icon-wrap">
              <User size={16} className="input-icon" />
              <input
                id="admin-username-input"
                type="text"
                autoComplete="username"
                className="form-input"
                placeholder="请输入面板管理员用户名"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="admin-password-input" className="form-label">
              面板管理员密码
            </label>
            <div className="input-icon-wrap">
              <Lock size={16} className="input-icon" />
              <input
                id="admin-password-input"
                type="password"
                autoComplete="current-password"
                className="form-input"
                placeholder="请输入面板管理员密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-full mt-2"
            disabled={submitting || !username.trim() || !password}
          >
            <LogIn size={16} />
            {submitting ? '正在验证管理员身份...' : '登录管理面板'}
          </button>
        </form>
      </div>
    </div>
  );
};
