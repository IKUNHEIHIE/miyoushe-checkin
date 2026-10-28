import React, { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Users,
  Activity,
  Settings,
  PlusCircle,
  LogOut,
  ShieldAlert,
  Menu,
  X,
  CheckCircle2,
  AlertTriangle,
  Info,
  Smartphone
} from 'lucide-react';
import { apiClient } from '../api/client';
import { useApp } from '../context/AppContext';

export const Layout: React.FC = () => {
  const navigate = useNavigate();
  const {
    session,
    setSessionData,
    capabilities,
    toasts,
    dismissToast,
    openAddAccount,
    openRecoverFlow,
    savedRecoverableFlowId,
    setSavedRecoverableFlowId,
    deferredChallengeIds,
    enqueueChallenge
  } = useApp();

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await apiClient.logoutAdmin();
    } catch {
      // Clear local session regardless
    } finally {
      setSessionData(null);
      setLoggingOut(false);
      navigate('/login');
    }
  };

  return (
    <div className="console-shell">
      {/* Left Navigation Sidebar */}
      <aside className={`console-sidebar ${mobileMenuOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <div className="brand-crest" aria-hidden="true">
            MYS
          </div>
          <div className="brand-text">
            <span className="brand-title">米游社签到面板</span>
            <span className="brand-subtitle">Self-Hosted Console v0.2.0</span>
          </div>
          <button
            type="button"
            className="icon-btn mobile-only"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="关闭菜单"
          >
            <X size={18} />
          </button>
        </div>

        <div className="sidebar-action-wrap">
          <button
            type="button"
            className="btn btn-primary btn-full"
            onClick={() => {
              setMobileMenuOpen(false);
              openAddAccount();
            }}
          >
            <PlusCircle size={16} /> 添加米游社账号
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          <NavLink
            to="/"
            end
            className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}
            onClick={() => setMobileMenuOpen(false)}
          >
            <LayoutDashboard size={18} />
            <span>概览控制台</span>
          </NavLink>
          <NavLink
            to="/accounts"
            className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}
            onClick={() => setMobileMenuOpen(false)}
          >
            <Users size={18} />
            <span>多账号管理</span>
          </NavLink>
          <NavLink
            to="/runs"
            className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}
            onClick={() => setMobileMenuOpen(false)}
          >
            <Activity size={18} />
            <span>执行记录与日志</span>
          </NavLink>
          <NavLink
            to="/settings"
            className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}
            onClick={() => setMobileMenuOpen(false)}
          >
            <Settings size={18} />
            <span>系统与通知设置</span>
          </NavLink>
        </nav>

        <div className="sidebar-capability-card">
          <div className="cap-header">实例能力边界 (v{capabilities?.contractVersion ?? '0.1.0'})</div>
          <ul className="cap-list">
            <li>
              <span>根凭据长期续期：</span>
              <strong>{capabilities?.rootCredentialRenewal ? '支持' : '不支持（不承诺永不掉号）'}</strong>
            </li>
            <li>
              <span>支持验证码：</span>
              <strong className="mono">
                {capabilities?.captchaVersions.join(', ').toUpperCase() || 'GT4'}
              </strong>
            </li>
            <li>
              <span>已实测社区：</span>
              <strong>
                {capabilities?.communities
                  .filter((c) => c.executable)
                  .map((c) => c.name)
                  .join('、') || '原神'}
              </strong>
            </li>
          </ul>
        </div>

        {session && (
          <div className="sidebar-footer">
            <div className="admin-badge">
              <div className="admin-avatar">{session.admin.username.slice(0, 1).toUpperCase()}</div>
              <div className="admin-meta">
                <span className="admin-name">{session.admin.username}</span>
                <span className="admin-role">单实例管理员</span>
              </div>
            </div>
            <button
              type="button"
              className="icon-btn icon-btn-light"
              onClick={() => void handleLogout()}
              disabled={loggingOut}
              title="撤销当前管理员面板会话"
              aria-label="退出管理员登录"
            >
              <LogOut size={16} />
            </button>
          </div>
        )}
      </aside>

      {/* Main Content Area */}
      <div className="console-main">
        <header className="console-topbar mobile-only">
          <button type="button" className="icon-btn" onClick={() => setMobileMenuOpen(true)} aria-label="打开导航菜单"><Menu size={20} /></button>
        </header>

        {/* Global Actionable Banners: Deferred Human Verification & Unfinished Login Flow Recovery */}
        {deferredChallengeIds.length > 0 && (
          <div className="global-action-strip strip-amber" role="region" aria-label="待完成人工验证提醒">
            <div className="strip-content">
              <ShieldAlert size={18} />
              <span>
                当前有 <strong>{deferredChallengeIds.length}</strong> 项操作正在等待你手动完成人机验证
                {deferredChallengeIds[0].contextLabel ? `（${deferredChallengeIds[0].contextLabel}）` : ''}
                。
              </span>
            </div>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                const next = deferredChallengeIds[0];
                if (next) {
                  enqueueChallenge({
                    challengeId: next.challengeId,
                    contextLabel: next.contextLabel
                  });
                }
              }}
            >
              继续人工验证
            </button>
          </div>
        )}

        {savedRecoverableFlowId && (
          <div className="global-action-strip strip-cobalt" role="region" aria-label="恢复未完成登录流程">
            <div className="strip-content">
              <Smartphone size={18} />
              <span>
                检测到当前浏览器标签存在未结束的短信登录流程 (
                <code className="mono">{savedRecoverableFlowId.slice(0, 8)}...</code>
                )，关闭弹窗未自动取消。
              </span>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => openRecoverFlow(savedRecoverableFlowId)}
              >
                恢复登录流程
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setSavedRecoverableFlowId(null)}
              >
                忽略
              </button>
            </div>
          </div>
        )}

        <main className="console-workspace">
          <Outlet />
        </main>
      </div>

      {/* Toast Notifications */}
      {toasts.length > 0 && (
        <div className="toast-stack" role="region" aria-label="系统通知">
          {toasts.map((t) => (
            <div key={t.id} className={`toast-card toast-${t.type}`}>
              <div className="toast-icon">
                {t.type === 'success' && <CheckCircle2 size={18} />}
                {t.type === 'warning' && <AlertTriangle size={18} />}
                {t.type === 'error' && <ShieldAlert size={18} />}
                {t.type === 'info' && <Info size={18} />}
              </div>
              <div className="toast-body">
                <div className="toast-title">{t.title}</div>
                {t.message && <div className="toast-message">{t.message}</div>}
                {t.requestId && <div className="toast-reqid mono">RequestId: {t.requestId}</div>}
              </div>
              <button
                type="button"
                className="icon-btn"
                onClick={() => dismissToast(t.id)}
                aria-label="关闭通知"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
