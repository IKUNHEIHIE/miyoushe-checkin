import type {
  Account,
  AccountPage,
  AccountPatch,
  AccountStatus,
  Ack,
  Admin,
  ApiErrorPayload,
  Capabilities,
  Challenge,
  ChallengeReceipt,
  ChallengeSubmission,
  CreateFlowRequest,
  CredentialOperation,
  CredentialOperationRequest,
  Dashboard,
  ErrorCode,
  ErrorDetails,
  ErrorEnvelope,
  Health,
  LoginFlow,
  LoginRequest,
  MissionSnapshot,
  GameRolesSnapshot,
  NotificationSettings,
  NotificationSettingsPatch,
  NotificationTest,
  Run,
  RunEventPage,
  RunPage,
  RunRequest,
  RunState,
  Schedule,
  SchedulePatch,
  Session,
  SetupRequest,
  SetupStatus,
  SubmitCodeRequest,
  SuccessEnvelope,
  SystemSettings,
  SystemSettingsPatch
} from '../types/openapi';
import { generateIdempotencyKey } from '../utils/format';

// In-memory ONLY storage for CSRF token (never persisted to storage or logged)
let inMemoryCsrfToken: string | null = null;

export function setCsrfTokenInMemory(token: string | null): void {
  inMemoryCsrfToken = token;
}

export function getCsrfTokenFromMemory(): string | null {
  return inMemoryCsrfToken;
}

export class ApiClientError extends Error {
  status: number;
  code: ErrorCode | 'NETWORK_ERROR';
  retryable: boolean;
  details?: ErrorDetails;
  requestId: string;
  retryAfterSeconds?: number;

  constructor(params: {
    status: number;
    code: ErrorCode | 'NETWORK_ERROR';
    message: string;
    retryable: boolean;
    details?: ErrorDetails;
    requestId?: string;
    retryAfterSeconds?: number;
  }) {
    super(params.message);
    this.name = 'ApiClientError';
    this.status = params.status;
    this.code = params.code;
    this.retryable = params.retryable;
    this.details = params.details;
    this.requestId = params.requestId ?? 'unknown-request-id';
    this.retryAfterSeconds = params.retryAfterSeconds;
  }
}

type GlobalApiEventListener = (error: ApiClientError) => void;
const globalListeners = new Set<GlobalApiEventListener>();

export function subscribeApiEvents(listener: GlobalApiEventListener): () => void {
  globalListeners.add(listener);
  return () => {
    globalListeners.delete(listener);
  };
}

function notifyGlobalListeners(err: ApiClientError) {
  for (const listener of globalListeners) {
    listener(err);
  }
}

interface RequestOptions {
  operationId: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  requiresCsrf?: boolean;
  requiresIdempotency?: boolean;
  idempotencyKey?: string;
  customHeaders?: Record<string, string>;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

function buildQueryString(query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) return '';
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') {
      search.set(k, String(v));
    }
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}

async function request<T>(opts: RequestOptions): Promise<SuccessEnvelope<T>> {
  const headers: Record<string, string> = {
    ...(opts.customHeaders ?? {})
  };

  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  if (opts.requiresCsrf) {
    if (inMemoryCsrfToken) {
      headers['X-CSRF-Token'] = inMemoryCsrfToken;
    }
  }

  if (opts.requiresIdempotency) {
    headers['Idempotency-Key'] = opts.idempotencyKey || generateIdempotencyKey();
  }

  const url = `${API_BASE_URL}${opts.path}${buildQueryString(opts.query)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: opts.method,
      headers,
      credentials: 'include',
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });
  } catch {
    const netErr = new ApiClientError({
      status: 0,
      code: 'NETWORK_ERROR',
      message:
        '无法连接到后端服务，请确认服务已启动后重试。',
      retryable: true,
      requestId: 'network-unreachable'
    });
    notifyGlobalListeners(netErr);
    throw netErr;
  }

  const retryAfterHeader = response.headers.get('Retry-After');
  const parsedRetryHeader = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : 0;

  let jsonBody: unknown = null;
  try {
    jsonBody = await response.json();
  } catch {
    // Non-JSON error response (e.g. 502/503 proxy gateway error)
  }

  if (!response.ok) {
    const errEnv = jsonBody as Partial<ErrorEnvelope> | null;
    const payload: ApiErrorPayload = errEnv?.error ?? {
      code: 'INTERNAL_ERROR',
      message: `服务端返回异常状态 (HTTP ${response.status})，请稍后重试`,
      retryable: response.status >= 500
    };
    const detailRetry = payload.details?.retryAfterSeconds ?? 0;
    const retryAfterSeconds =
      Math.max(Number.isNaN(parsedRetryHeader) ? 0 : parsedRetryHeader, detailRetry) || undefined;

    const apiErr = new ApiClientError({
      status: response.status,
      code: payload.code,
      message: payload.message,
      retryable: payload.retryable,
      details: payload.details,
      requestId: errEnv?.requestId ?? 'untracked-request',
      retryAfterSeconds
    });

    if (apiErr.code === 'UNAUTHENTICATED') {
      inMemoryCsrfToken = null;
    } else if (apiErr.code === 'CSRF_INVALID') {
      // Refresh admin session to update CSRF token in memory without blindly replaying write request
      try {
        const sess = await apiClient.getAdminSession();
        inMemoryCsrfToken = sess.data.csrfToken;
      } catch {
        // Ignore secondary failure
      }
    }

    notifyGlobalListeners(apiErr);
    throw apiErr;
  }

  return jsonBody as SuccessEnvelope<T>;
}

export const apiClient = {
  // System & Auth
  getHealth: () =>
    request<Health>({
      operationId: 'getHealth',
      method: 'GET',
      path: '/health'
    }),

  getSetupStatus: () =>
    request<SetupStatus>({
      operationId: 'getSetupStatus',
      method: 'GET',
      path: '/setup/status'
    }),

  initializeAdmin: (setupToken: string, body: SetupRequest) =>
    request<Admin>({
      operationId: 'initializeAdmin',
      method: 'POST',
      path: '/setup',
      body,
      customHeaders: {
        'X-Setup-Token': setupToken
      }
    }),

  loginAdmin: async (body: LoginRequest) => {
    const res = await request<Session>({
      operationId: 'loginAdmin',
      method: 'POST',
      path: '/auth/login',
      body
    });
    inMemoryCsrfToken = res.data.csrfToken;
    return res;
  },

  getAdminSession: async () => {
    const res = await request<Session>({
      operationId: 'getAdminSession',
      method: 'GET',
      path: '/auth/session'
    });
    inMemoryCsrfToken = res.data.csrfToken;
    return res;
  },

  logoutAdmin: async () => {
    const res = await request<Ack>({
      operationId: 'logoutAdmin',
      method: 'POST',
      path: '/auth/logout',
      requiresCsrf: true
    });
    inMemoryCsrfToken = null;
    return res;
  },

  getDashboard: () =>
    request<Dashboard>({
      operationId: 'getDashboard',
      method: 'GET',
      path: '/dashboard'
    }),

  getCapabilities: () =>
    request<Capabilities>({
      operationId: 'getCapabilities',
      method: 'GET',
      path: '/capabilities'
    }),

  // Accounts
  listAccounts: (params?: {
    limit?: number;
    cursor?: string;
    status?: AccountStatus;
    enabled?: boolean;
  }) =>
    request<AccountPage>({
      operationId: 'listAccounts',
      method: 'GET',
      path: '/accounts',
      query: params
    }),

  getAccount: (accountId: string) =>
    request<Account>({
      operationId: 'getAccount',
      method: 'GET',
      path: `/accounts/${accountId}`,
      pathParams: { accountId }
    }),

  updateAccount: (accountId: string, body: AccountPatch) =>
    request<Account>({
      operationId: 'updateAccount',
      method: 'PATCH',
      path: `/accounts/${accountId}`,
      pathParams: { accountId },
      body,
      requiresCsrf: true
    }),

  deleteAccount: (accountId: string, idempotencyKey?: string) =>
    request<Ack>({
      operationId: 'deleteAccount',
      method: 'DELETE',
      path: `/accounts/${accountId}`,
      pathParams: { accountId },
      requiresCsrf: true,
      requiresIdempotency: true,
      idempotencyKey
    }),

  // Login Flows
  createLoginFlow: (body: CreateFlowRequest, idempotencyKey?: string) =>
    request<LoginFlow>({
      operationId: 'createLoginFlow',
      method: 'POST',
      path: '/login-flows',
      body,
      requiresCsrf: true,
      requiresIdempotency: true,
      idempotencyKey
    }),

  getLoginFlow: (flowId: string) =>
    request<LoginFlow>({
      operationId: 'getLoginFlow',
      method: 'GET',
      path: `/login-flows/${flowId}`,
      pathParams: { flowId }
    }),

  cancelLoginFlow: (flowId: string, idempotencyKey?: string) =>
    request<LoginFlow>({
      operationId: 'cancelLoginFlow',
      method: 'DELETE',
      path: `/login-flows/${flowId}`,
      pathParams: { flowId },
      requiresCsrf: true,
      requiresIdempotency: true,
      idempotencyKey
    }),

  sendLoginSms: (flowId: string, idempotencyKey?: string) =>
    request<LoginFlow>({
      operationId: 'sendLoginSms',
      method: 'POST',
      path: `/login-flows/${flowId}/send-sms`,
      pathParams: { flowId },
      requiresCsrf: true,
      requiresIdempotency: true,
      idempotencyKey
    }),

  submitLoginCode: (flowId: string, body: SubmitCodeRequest, idempotencyKey?: string) =>
    request<LoginFlow>({
      operationId: 'submitLoginCode',
      method: 'POST',
      path: `/login-flows/${flowId}/submit-code`,
      pathParams: { flowId },
      body,
      requiresCsrf: true,
      requiresIdempotency: true,
      idempotencyKey
    }),

  // Challenges
  getChallenge: (challengeId: string) =>
    request<Challenge>({
      operationId: 'getChallenge',
      method: 'GET',
      path: `/challenges/${challengeId}`,
      pathParams: { challengeId }
    }),

  submitChallenge: (challengeId: string, body: ChallengeSubmission, idempotencyKey?: string) =>
    request<ChallengeReceipt>({
      operationId: 'submitChallenge',
      method: 'POST',
      path: `/challenges/${challengeId}/submit`,
      pathParams: { challengeId },
      body,
      requiresCsrf: true,
      requiresIdempotency: true,
      idempotencyKey
    }),

  renewChallenge: (challengeId: string, idempotencyKey?: string) =>
    request<Challenge>({
      operationId: 'renewChallenge',
      method: 'POST',
      path: `/challenges/${challengeId}/renew`,
      pathParams: { challengeId },
      requiresCsrf: true,
      requiresIdempotency: true,
      idempotencyKey
    }),

  // Credential Operations
  startCredentialOperation: (
    accountId: string,
    body: CredentialOperationRequest,
    idempotencyKey?: string
  ) =>
    request<CredentialOperation>({
      operationId: 'startCredentialOperation',
      method: 'POST',
      path: `/accounts/${accountId}/credential-operations`,
      pathParams: { accountId },
      body,
      requiresCsrf: true,
      requiresIdempotency: true,
      idempotencyKey
    }),

  getCredentialOperation: (operationId: string) =>
    request<CredentialOperation>({
      operationId: 'getCredentialOperation',
      method: 'GET',
      path: `/credential-operations/${operationId}`,
      pathParams: { operationId }
    }),

  // Missions
  getAccountMissions: (accountId: string) =>
    request<MissionSnapshot>({
      operationId: 'getAccountMissions',
      method: 'GET',
      path: `/accounts/${accountId}/missions`,
      pathParams: { accountId }
    }),

  refreshAccountMissions: (accountId: string, idempotencyKey?: string) =>
    request<MissionSnapshot>({
      operationId: 'refreshAccountMissions',
      method: 'POST',
      path: `/accounts/${accountId}/missions/refresh`,
      pathParams: { accountId },
      requiresCsrf: true,
      requiresIdempotency: true,
      idempotencyKey
    }),

  // Schedules
  getGameRoles: (accountId: string) => request<GameRolesSnapshot>({
    operationId: 'getGameRoles', method: 'GET', path: `/accounts/${accountId}/game-roles`, pathParams: { accountId }
  }),
  refreshGameRoles: (accountId: string, idempotencyKey?: string) => request<GameRolesSnapshot>({
    operationId: 'refreshGameRoles', method: 'POST', path: `/accounts/${accountId}/game-roles/refresh`, pathParams: { accountId },
    requiresCsrf: true, requiresIdempotency: true, idempotencyKey
  }),

  // Schedules
  getAccountSchedule: (accountId: string) =>
    request<Schedule>({
      operationId: 'getAccountSchedule',
      method: 'GET',
      path: `/accounts/${accountId}/schedule`,
      pathParams: { accountId }
    }),

  updateAccountSchedule: (accountId: string, body: SchedulePatch) =>
    request<Schedule>({
      operationId: 'updateAccountSchedule',
      method: 'PATCH',
      path: `/accounts/${accountId}/schedule`,
      pathParams: { accountId },
      body,
      requiresCsrf: true
    }),

  // Runs
  createAccountRun: (accountId: string, body: RunRequest, idempotencyKey?: string) =>
    request<Run>({
      operationId: 'createAccountRun',
      method: 'POST',
      path: `/accounts/${accountId}/runs`,
      pathParams: { accountId },
      body,
      requiresCsrf: true,
      requiresIdempotency: true,
      idempotencyKey
    }),

  listRuns: (params?: {
    limit?: number;
    cursor?: string;
    accountId?: string;
    state?: RunState;
    dateFrom?: string;
    dateTo?: string;
  }) =>
    request<RunPage>({
      operationId: 'listRuns',
      method: 'GET',
      path: '/runs',
      query: params
    }),

  getRun: (runId: string) =>
    request<Run>({
      operationId: 'getRun',
      method: 'GET',
      path: `/runs/${runId}`,
      pathParams: { runId }
    }),

  listRunEvents: (runId: string, params?: { limit?: number; cursor?: string }) =>
    request<RunEventPage>({
      operationId: 'listRunEvents',
      method: 'GET',
      path: `/runs/${runId}/events`,
      pathParams: { runId },
      query: params
    }),

  retryRun: (runId: string, idempotencyKey?: string) =>
    request<Run>({
      operationId: 'retryRun',
      method: 'POST',
      path: `/runs/${runId}/retry`,
      pathParams: { runId },
      requiresCsrf: true,
      requiresIdempotency: true,
      idempotencyKey
    }),

  cancelRun: (runId: string, idempotencyKey?: string) =>
    request<Run>({
      operationId: 'cancelRun',
      method: 'POST',
      path: `/runs/${runId}/cancel`,
      pathParams: { runId },
      requiresCsrf: true,
      requiresIdempotency: true,
      idempotencyKey
    }),

  // Settings & Notifications
  getSystemSettings: () =>
    request<SystemSettings>({
      operationId: 'getSystemSettings',
      method: 'GET',
      path: '/settings/system'
    }),

  updateSystemSettings: (body: SystemSettingsPatch) =>
    request<SystemSettings>({
      operationId: 'updateSystemSettings',
      method: 'PATCH',
      path: '/settings/system',
      body,
      requiresCsrf: true
    }),

  getNotificationSettings: () =>
    request<NotificationSettings>({
      operationId: 'getNotificationSettings',
      method: 'GET',
      path: '/settings/notifications'
    }),

  updateNotificationSettings: (body: NotificationSettingsPatch) =>
    request<NotificationSettings>({
      operationId: 'updateNotificationSettings',
      method: 'PATCH',
      path: '/settings/notifications',
      body,
      requiresCsrf: true
    }),

  createNotificationTest: (idempotencyKey?: string) =>
    request<NotificationTest>({
      operationId: 'createNotificationTest',
      method: 'POST',
      path: '/notifications/tests',
      requiresCsrf: true,
      requiresIdempotency: true,
      idempotencyKey
    }),

  getNotificationTest: (testId: string) =>
    request<NotificationTest>({
      operationId: 'getNotificationTest',
      method: 'GET',
      path: `/notifications/tests/${testId}`,
      pathParams: { testId }
    })
};
