import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { AppProvider, useApp } from './context/AppContext';
import { Layout } from './components/Layout';
import { AddAccountModal } from './components/AddAccountModal';
import { ChallengeModal } from './components/ChallengeModal';
import { SetupPage } from './pages/SetupPage';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { AccountsPage } from './pages/AccountsPage';
import { AccountDetailPage } from './pages/AccountDetailPage';
import { RunsPage } from './pages/RunsPage';
import { SettingsPage } from './pages/SettingsPage';

const AppRoutes: React.FC = () => {
  const {
    initialized,
    session,
    bootstrapping,
    connectionError,
    refreshAuthAndBootstrap
  } = useApp();

  if (bootstrapping) {
    return (
      <div className="auth-page-layout">
        <div className="state-box">
          <RefreshCw className="spin" size={22} />
          <span>正在检查实例初始化与管理员会话状态...</span>
        </div>
      </div>
    );
  }

  if (connectionError) {
    return (
      <div className="auth-page-layout">
        <div className="auth-card">
          <div className="eyebrow-row mb-2">
            <span className="badge badge-crimson">连接异常</span>
          </div>
          <h1 className="auth-title">无法连接至本实例后端服务</h1>
          <div className="alert-banner alert-danger my-4" role="alert">
            <ShieldAlert size={20} />
            <div>
              <strong>错误码：{connectionError.code}</strong>
              <p>{connectionError.message}</p>
              <div className="mono text-xs mt-1">RequestId: {connectionError.requestId}</div>
            </div>
          </div>
          <p className="auth-subtitle">
            请确认后端服务已启动，然后重试连接。
          </p>
          <div className="button-row mt-4">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void refreshAuthAndBootstrap()}
            >
              <RefreshCw size={15} /> 重试连接后端
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (initialized === false) {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  }

  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/accounts/:accountId" element={<AccountDetailPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      <AddAccountModal />
      <ChallengeModal />
    </>
  );
};

export const App: React.FC = () => {
  return (
    <AppProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProvider>
  );
};
export default App;
