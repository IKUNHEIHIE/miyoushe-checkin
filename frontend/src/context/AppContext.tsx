import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  apiClient,
  ApiClientError,
  setCsrfTokenInMemory,
  subscribeApiEvents
} from '../api/client';
import type {
  Account,
  Capabilities,
  ChallengeReceipt,
  Session
} from '../types/openapi';

export interface ToastItem {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
  requestId?: string;
}

export interface QueuedChallenge {
  challengeId: string;
  contextLabel?: string;
  onAccepted?: (receipt: ChallengeReceipt) => void;
  onDismissed?: () => void;
}

interface AppContextValue {
  initialized: boolean | null;
  session: Session | null;
  capabilities: Capabilities | null;
  bootstrapping: boolean;
  connectionError: ApiClientError | null;
  refreshAuthAndBootstrap: () => Promise<void>;
  setSessionData: (session: Session | null) => void;
  setInitializedState: (val: boolean) => void;
  toasts: ToastItem[];
  pushToast: (toast: Omit<ToastItem, 'id'>) => void;
  dismissToast: (id: string) => void;
  // Unified Challenge Queue (sequential, 1 active modal at a time)
  activeChallenge: QueuedChallenge | null;
  queuedChallengesCount: number;
  deferredChallengeIds: { challengeId: string; contextLabel?: string }[];
  enqueueChallenge: (item: QueuedChallenge) => void;
  closeActiveChallenge: (wasAccepted: boolean) => void;
  updateActiveChallengeId: (newChallengeId: string) => void;
  // Login / Re-login modal trigger
  loginModalState: {
    open: boolean;
    targetAccount: Account | null;
    recoverFlowId: string | null;
  };
  openAddAccount: () => void;
  openReloginAccount: (account: Account) => void;
  openRecoverFlow: (flowId: string) => void;
  closeLoginModal: () => void;
  savedRecoverableFlowId: string | null;
  setSavedRecoverableFlowId: (flowId: string | null) => void;
  accountsVersionTrigger: number;
  triggerAccountsRefresh: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export const FLOW_SESSION_STORAGE_KEY = 'mys_active_login_flow_id';

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [bootstrapping, setBootstrapping] = useState<boolean>(true);
  const [connectionError, setConnectionError] = useState<ApiClientError | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [challengeQueue, setChallengeQueue] = useState<QueuedChallenge[]>([]);
  const [deferredChallengeIds, setDeferredChallengeIds] = useState<
    { challengeId: string; contextLabel?: string }[]
  >([]);
  const [accountsVersionTrigger, setAccountsVersionTrigger] = useState(0);

  const [savedRecoverableFlowId, setSavedRecoverableFlowIdState] = useState<string | null>(() => {
    if (typeof window === 'undefined' || typeof window.sessionStorage?.getItem !== 'function') {
      return null;
    }
    return window.sessionStorage.getItem(FLOW_SESSION_STORAGE_KEY);
  });

  const setSavedRecoverableFlowId = useCallback((flowId: string | null) => {
    setSavedRecoverableFlowIdState(flowId);
    if (typeof window !== 'undefined' && typeof window.sessionStorage?.setItem === 'function') {
      if (flowId) {
        window.sessionStorage.setItem(FLOW_SESSION_STORAGE_KEY, flowId);
      } else {
        window.sessionStorage.removeItem(FLOW_SESSION_STORAGE_KEY);
      }
    }
  }, []);

  const [loginModalState, setLoginModalState] = useState<{
    open: boolean;
    targetAccount: Account | null;
    recoverFlowId: string | null;
  }>({
    open: false,
    targetAccount: null,
    recoverFlowId: null
  });

  const pushToast = useCallback((toast: Omit<ToastItem, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev.slice(-4), { ...toast, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, 6000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const triggerAccountsRefresh = useCallback(() => {
    setAccountsVersionTrigger((v) => v + 1);
  }, []);

  const refreshAuthAndBootstrap = useCallback(async () => {
    setBootstrapping(true);
    setConnectionError(null);
    try {
      const setupRes = await apiClient.getSetupStatus();
      setInitialized(setupRes.data.initialized);
      if (!setupRes.data.initialized) {
        setSession(null);
        setCapabilities(null);
        setCsrfTokenInMemory(null);
        setBootstrapping(false);
        return;
      }

      try {
        const sessRes = await apiClient.getAdminSession();
        setSession(sessRes.data);
        const capRes = await apiClient.getCapabilities();
        setCapabilities(capRes.data);
      } catch (err) {
        if (err instanceof ApiClientError && err.code === 'UNAUTHENTICATED') {
          setSession(null);
          setCapabilities(null);
          setCsrfTokenInMemory(null);
        } else {
          throw err;
        }
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.code === 'SETUP_REQUIRED') {
          setInitialized(false);
          setSession(null);
          setCapabilities(null);
        } else {
          setConnectionError(err);
        }
      }
    } finally {
      setBootstrapping(false);
    }
  }, []);

  useEffect(() => {
    void refreshAuthAndBootstrap();
  }, [refreshAuthAndBootstrap]);

  useEffect(() => {
    return subscribeApiEvents((err) => {
      if (err.code === 'UNAUTHENTICATED') {
        setSession(null);
        setCsrfTokenInMemory(null);
        pushToast({
          type: 'warning',
          title: '面板管理员会话已失效',
          message: '请重新登录管理面板（已绑定的米游社账号凭据不受影响，无需重新登录米游社账号）。',
          requestId: err.requestId
        });
      } else if (err.code === 'SETUP_REQUIRED') {
        setInitialized(false);
        setSession(null);
        setCsrfTokenInMemory(null);
      } else if (err.code === 'ALREADY_INITIALIZED') {
        setInitialized(true);
      } else if (err.code === 'CSRF_INVALID') {
        pushToast({
          type: 'warning',
          title: '安全令牌已同步更新',
          message: 'CSRF 令牌已自动重新读取，请再次点击确认您刚才的操作。',
          requestId: err.requestId
        });
      }
    });
  }, [pushToast]);

  const setSessionData = useCallback(
    (newSession: Session | null) => {
      setSession(newSession);
      if (newSession) {
        void apiClient.getCapabilities().then((res) => setCapabilities(res.data)).catch(() => {});
      } else {
        setCapabilities(null);
      }
    },
    []
  );

  const setInitializedState = useCallback((val: boolean) => {
    setInitialized(val);
  }, []);

  const enqueueChallenge = useCallback((item: QueuedChallenge) => {
    setDeferredChallengeIds((prev) => prev.filter((d) => d.challengeId !== item.challengeId));
    setChallengeQueue((prev) => {
      if (prev.some((q) => q.challengeId === item.challengeId)) {
        return prev;
      }
      return [...prev, item];
    });
  }, []);

  const closeActiveChallenge = useCallback((wasAccepted: boolean) => {
    setChallengeQueue((prev) => {
      const [current, ...rest] = prev;
      if (current && !wasAccepted) {
        // Record in deferredChallengeIds so user can manually click "继续人工验证" without infinite auto-popup
        setDeferredChallengeIds((defPrev) => {
          if (defPrev.some((d) => d.challengeId === current.challengeId)) return defPrev;
          return [...defPrev, { challengeId: current.challengeId, contextLabel: current.contextLabel }];
        });
        current.onDismissed?.();
      }
      return rest;
    });
  }, []);

  const updateActiveChallengeId = useCallback((newChallengeId: string) => {
    setChallengeQueue((prev) => {
      if (prev.length === 0) return prev;
      const [first, ...rest] = prev;
      return [{ ...first, challengeId: newChallengeId }, ...rest];
    });
  }, []);

  const openAddAccount = useCallback(() => {
    setLoginModalState({
      open: true,
      targetAccount: null,
      recoverFlowId: null
    });
  }, []);

  const openReloginAccount = useCallback((account: Account) => {
    setLoginModalState({
      open: true,
      targetAccount: account,
      recoverFlowId: null
    });
  }, []);

  const openRecoverFlow = useCallback((flowId: string) => {
    setLoginModalState({
      open: true,
      targetAccount: null,
      recoverFlowId: flowId
    });
  }, []);

  const closeLoginModal = useCallback(() => {
    setLoginModalState((prev) => ({
      ...prev,
      open: false
    }));
  }, []);

  return (
    <AppContext.Provider
      value={{
        initialized,
        session,
        capabilities,
        bootstrapping,
        connectionError,
        refreshAuthAndBootstrap,
        setSessionData,
        setInitializedState,
        toasts,
        pushToast,
        dismissToast,
        activeChallenge: challengeQueue[0] ?? null,
        queuedChallengesCount: challengeQueue.length,
        deferredChallengeIds,
        enqueueChallenge,
        closeActiveChallenge,
        updateActiveChallengeId,
        loginModalState,
        openAddAccount,
        openReloginAccount,
        openRecoverFlow,
        closeLoginModal,
        savedRecoverableFlowId,
        setSavedRecoverableFlowId,
        accountsVersionTrigger,
        triggerAccountsRefresh
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used within AppProvider');
  }
  return ctx;
}
