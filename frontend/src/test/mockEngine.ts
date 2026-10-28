import rawScenariosDoc from '../../../docs/mock-scenarios.json';
import type {
  Account,
  AccountPage,
  AccountPatch,
  Ack,
  ApiErrorPayload,
  Capabilities,
  Challenge,
  ChallengeReceipt,
  ChallengeSubmission,
  CreateFlowRequest,
  CredentialOperation,
  CredentialOperationRequest,
  Dashboard,
  Health,
  LoginFlow,
  LoginRequest,
  MissionSnapshot,
  GameRolesSnapshot,
  NotificationSettings,
  NotificationSettingsPatch,
  NotificationTest,
  Run,
  RunEvent,
  RunEventPage,
  RunPage,
  RunRequest,
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
import { getNowIso, getNowMs, maskPhoneForDisplay } from '../utils/format';
import { resetMockClock } from './mockClock';

export type MockPresetId =
  | 'default-ready'
  | 'setup-required'
  | 'accounts-empty'
  | 'account-reauth-required'
  | 'credential-awaiting-verification'
  | 'missions-unfetched'
  | 'missions-signed'
  | 'flow-invalid-code'
  | 'flow-expired'
  | 'challenge-failed'
  | 'sms-rate-limited'
  | 'run-awaiting-verification'
  | 'run-already-completed'
  | 'run-partially-succeeded'
  | 'run-outcome-unknown'
  | 'run-failed'
  | 'account-version-conflict'
  | 'session-expired'
  | 'unsupported-task';

export interface MockPresetMeta {
  id: MockPresetId;
  label: string;
  category: '基础与会话' | '账号与凭据' | '登录与验证' | '任务与执行' | '冲突与异常';
  description: string;
}

export const MOCK_PRESETS: MockPresetMeta[] = [
  {
    id: 'default-ready',
    label: '标准演示环境 (完整可交互)',
    category: '基础与会话',
    description: '已初始化并登录，含有效账号、极验v4短信登录流程、任务刷新、每日计划、签到与邮件测试完整闭环'
  },
  {
    id: 'setup-required',
    label: '未初始化实例 (setup-required)',
    category: '基础与会话',
    description: '模拟首次部署尚未创建管理员，需输入 X-Setup-Token 完成初始化后再登录'
  },
  {
    id: 'session-expired',
    label: '管理员会话失效 (session-expired)',
    category: '基础与会话',
    description: '模拟面板管理员 Cookie 会话过期 (401 UNAUTHENTICATED)，清除内存态并回退到面板登录页'
  },
  {
    id: 'accounts-empty',
    label: '空账号列表 (accounts-empty)',
    category: '账号与凭据',
    description: '已登录但尚未绑定任何米游社账号，引导添加首个账号'
  },
  {
    id: 'account-reauth-required',
    label: '根凭据失效需重登 (account-reauth-required)',
    category: '账号与凭据',
    description: '账号 status=reauth_required，不显示虚假倒计时，提供重新登录入口'
  },
  {
    id: 'credential-awaiting-verification',
    label: '凭据更新等待人工验证 (credential-awaiting-verification)',
    category: '账号与凭据',
    description: '工作 Cookie 更新操作暂停在 awaiting_verification，展示统一人工验证入口'
  },
  {
    id: 'flow-invalid-code',
    label: '短信验证码错误 (flow-invalid-code)',
    category: '登录与验证',
    description: '提交验证码返回 422 SMS_CODE_INVALID，保留输入界面并要求新幂等 Key'
  },
  {
    id: 'flow-expired',
    label: '登录流程已过期 (flow-expired)',
    category: '登录与验证',
    description: '查询或提交登录流程返回 410 FLOW_EXPIRED，引导重新开始'
  },
  {
    id: 'challenge-failed',
    label: '人工验证被官方拒绝 (challenge-failed)',
    category: '登录与验证',
    description: '提交极验结果返回 422 CHALLENGE_FAILED (-3102)，销毁旧组件并引导用户主动更新验证会话'
  },
  {
    id: 'sms-rate-limited',
    label: '短信发送触发限流 (sms-rate-limited)',
    category: '登录与验证',
    description: '发送短信返回 429 RATE_LIMITED (retryAfterSeconds: 60)，遵守冷却不循环请求'
  },
  {
    id: 'missions-unfetched',
    label: '尚无任务快照 (missions-unfetched)',
    category: '任务与执行',
    description: '首次未知余额为 null，界面显示“尚未获取”而非 0'
  },
  {
    id: 'missions-signed',
    label: '任务与奖励已核对 (missions-signed)',
    category: '任务与执行',
    description: '已获取最新米游币快照（总额 1030，今日已得 30，原神社区签到已完成）'
  },
  {
    id: 'run-awaiting-verification',
    label: '签到暂停等待验证 (run-awaiting-verification)',
    category: '任务与执行',
    description: '签到任务处于 awaiting_verification 状态，复用统一人工验证组件'
  },
  {
    id: 'run-already-completed',
    label: '今日重复签到已完成 (run-already-completed)',
    category: '任务与执行',
    description: '步骤状态为 already_completed (retcode 1008)，标记“今日已完成”，本次确认收益 0'
  },
  {
    id: 'run-partially-succeeded',
    label: '部分步骤完成 (run-partially-succeeded)',
    category: '任务与执行',
    description: '原神签到成功 (+30)，星穹铁道步骤失败 (-1)，支持安全重试失败步骤'
  },
  {
    id: 'run-outcome-unknown',
    label: '执行结果未知待核对 (run-outcome-unknown)',
    category: '任务与执行',
    description: '写请求超时且状态无法核对 (outcome_unknown)，不冒充成功，不自动盲目重放'
  },
  {
    id: 'run-failed',
    label: '执行失败需重登 (run-failed)',
    category: '任务与执行',
    description: '因根凭据失效导致执行失败 (ACCOUNT_REAUTH_REQUIRED)'
  },
  {
    id: 'account-version-conflict',
    label: '乐观锁版本冲突 (account-version-conflict)',
    category: '冲突与异常',
    description: '修改账号/计划/设置时返回 409 VERSION_CONFLICT，刷新最新数据并让用户确认合并'
  },
  {
    id: 'unsupported-task',
    label: '未适配能力拒绝执行 (unsupported-task)',
    category: '冲突与异常',
    description: '请求未开放能力返回 422 CAPABILITY_UNAVAILABLE'
  }
];

interface ScenarioEntry {
  id: string;
  description: string;
  request: {
    operationId: string;
    method: string;
    pathTemplate: string;
    pathParams: Record<string, string | undefined>;
    headers: Record<string, string | undefined>;
    body?: unknown;
  };
  status: number;
  response: unknown;
}

const scenariosMap = new Map<string, ScenarioEntry>();
for (const item of (rawScenariosDoc as unknown as { scenarios: ScenarioEntry[] }).scenarios) {
  scenariosMap.set(item.id, item);
}

function getScenarioResponse<T>(id: string): SuccessEnvelope<T> {
  const entry = scenariosMap.get(id);
  if (!entry) {
    throw new Error(`Missing scenario ${id} in docs/mock-scenarios.json`);
  }
  return structuredClone(entry.response) as SuccessEnvelope<T>;
}

export class MockHttpError extends Error {
  status: number;
  envelope: { error: ApiErrorPayload; requestId: string };
  headers: Record<string, string>;

  constructor(
    status: number,
    error: ApiErrorPayload,
    requestId = '77777777-7777-4777-8777-777777777777',
    headers: Record<string, string> = {}
  ) {
    super(error.message);
    this.status = status;
    this.envelope = { error, requestId };
    this.headers = headers;
  }
}

function throwFromScenario(id: string, extraHeaders: Record<string, string> = {}): never {
  const entry = scenariosMap.get(id);
  if (!entry) {
    throw new Error(`Missing error scenario ${id}`);
  }
  const env = structuredClone(entry.response) as { error: ApiErrorPayload; requestId: string };
  const headers: Record<string, string> = { ...extraHeaders };
  if (entry.status === 429 && env.error.details?.retryAfterSeconds !== undefined) {
    headers['retry-after'] = String(env.error.details.retryAfterSeconds);
  }
  throw new MockHttpError(entry.status, env.error, env.requestId, headers);
}

interface MockState {
  preset: MockPresetId;
  initialized: boolean;
  authenticated: boolean;
  admin: { id: string; username: string };
  csrfToken: string;
  capabilities: Capabilities;
  accounts: Account[];
  missionsByAccount: Record<string, MissionSnapshot>;
  gameRolesByAccount: Record<string, GameRolesSnapshot>;
  schedulesByAccount: Record<string, Schedule>;
  flows: Record<string, LoginFlow & { pollCount?: number; stage?: 'sms' | 'exchange' }>;
  challenges: Record<string, Challenge>;
  credentialOps: Record<string, CredentialOperation & { pollCount?: number }>;
  runs: Run[];
  runPollCounts: Record<string, number>;
  eventsByRun: Record<string, RunEvent[]>;
  systemSettings: SystemSettings;
  notificationSettings: NotificationSettings;
  notificationTests: Record<string, NotificationTest & { pollCount?: number }>;
  idempotencyCache: Record<string, { fingerprint: string; response: unknown; status: number }>;
  versionConflictTriggeredOnce: boolean;
}

const REQ_ID = '77777777-7777-4777-8777-777777777777';

function createInitialMockState(preset: MockPresetId = 'default-ready'): MockState {
  resetMockClock('2026-10-23T12:00:10Z');

  const caps = getScenarioResponse<Capabilities>('capabilities').data;
  const baseAccount = getScenarioResponse<AccountPage>('accounts-ready').data.items[0];
  // In default-ready, clear activeCredentialOperationId so it's clean unless credential-awaiting-verification is selected
  const cleanAccount: Account = {
    ...structuredClone(baseAccount),
    activeCredentialOperationId:
      preset === 'credential-awaiting-verification' ? baseAccount.activeCredentialOperationId : null
  };

  const reauthAccount = getScenarioResponse<Account>('account-reauth-required').data;
  const credAwaitOp = getScenarioResponse<CredentialOperation>('credential-awaiting-verification').data;
  const secondAccount: Account = {
    id: '12222222-2222-4222-8222-222222222222',
    uid: '100000002',
    nickname: '星海旅行者',
    phoneMasked: '138****8888',
    remark: '第二测试账号（需重新登录演示）',
    enabled: true,
    status: 'reauth_required',
    communityIds: [2],
    taskKinds: ['community_sign'],
    autoRefresh: true,
    credential: {
      status: 'reauth_required',
      lastCheckedAt: '2026-10-23T11:30:00Z',
      lastCookieIssuedAt: '2026-10-20T12:00:00Z',
      cookieStorageExpiresAt: null,
      rootExpiresAt: null,
      expirySource: 'unknown'
    },
    version: 1,
    createdAt: '2026-10-20T12:00:00Z',
    updatedAt: '2026-10-23T11:30:00Z',
    activeCredentialOperationId: null,
    activeRunId: null
  };

  let accounts: Account[] = [cleanAccount, secondAccount];
  if (preset === 'accounts-empty') {
    accounts = [];
  } else if (preset === 'account-reauth-required') {
    accounts = [structuredClone(reauthAccount)];
  } else if (preset === 'credential-awaiting-verification') {
    accounts = [structuredClone(credAwaitOp.account)];
  }

  const missionsUnfetched = getScenarioResponse<MissionSnapshot>('missions-unfetched').data;
  const missionsSigned = getScenarioResponse<MissionSnapshot>('missions-signed').data;

  const missionsByAccount: Record<string, MissionSnapshot> = {
    [cleanAccount.id]:
      preset === 'missions-unfetched' ? structuredClone(missionsUnfetched) : structuredClone(missionsSigned),
    [secondAccount.id]: {
      ...structuredClone(missionsUnfetched),
      accountId: secondAccount.id
    }
  };

  const baseSchedule = getScenarioResponse<Schedule>('schedule-off').data;
  const schedulesByAccount: Record<string, Schedule> = {
    [cleanAccount.id]:
      preset === 'default-ready'
        ? {
            ...structuredClone(baseSchedule),
            enabled: true,
            hour: 6,
            minute: 30,
            nextRunAt: '2026-10-23T22:30:00Z'
          }
        : structuredClone(baseSchedule),
    [secondAccount.id]: {
      ...structuredClone(baseSchedule),
      accountId: secondAccount.id
    }
  };

  // Initial Runs
  const runSucceeded = getScenarioResponse<Run>('run-succeeded').data;
  const runAwaiting = getScenarioResponse<Run>('run-awaiting-verification').data;
  const runAlready = getScenarioResponse<Run>('run-already-completed').data;
  const runPartial = getScenarioResponse<Run>('run-partially-succeeded').data;
  const runUnknown = getScenarioResponse<Run>('run-outcome-unknown').data;
  const runFailed = getScenarioResponse<Run>('run-failed').data;

  let runs: Run[] = [
    structuredClone(runSucceeded),
    {
      ...structuredClone(runPartial),
      id: '44444444-4444-4444-8444-444444444445',
      businessDate: '2026-10-22',
      createdAt: '2026-10-22T12:00:00Z',
      startedAt: '2026-10-22T12:00:00Z',
      finishedAt: '2026-10-22T12:00:05Z'
    },
    {
      ...structuredClone(runUnknown),
      id: '44444444-4444-4444-8444-444444444446',
      accountId: secondAccount.id
    }
  ];

  if (preset === 'run-awaiting-verification') {
    runs = [structuredClone(runAwaiting)];
    if (accounts[0]) {
      accounts[0].activeRunId = runAwaiting.id;
      accounts[0].status = 'verification_required';
    }
  } else if (preset === 'run-already-completed') {
    runs = [structuredClone(runAlready)];
  } else if (preset === 'run-partially-succeeded') {
    runs = [structuredClone(runPartial)];
  } else if (preset === 'run-outcome-unknown') {
    runs = [structuredClone(runUnknown)];
  } else if (preset === 'run-failed') {
    runs = [structuredClone(runFailed)];
  } else if (preset === 'accounts-empty') {
    runs = [];
  }

  const baseEvent = getScenarioResponse<RunEventPage>('run-events').data.items[0];
  const eventsByRun: Record<string, RunEvent[]> = {};
  for (const r of runs) {
    eventsByRun[r.id] = [
      {
        id: `evt-start-${r.id.slice(-4)}`,
        runId: r.id,
        level: 'info',
        message: `任务启动：社区 [${r.communityIds.join(', ')}]，类型 [${r.taskKinds.join(', ')}]`,
        stepId: r.steps[0]?.id ?? null,
        createdAt: r.createdAt
      },
      {
        ...structuredClone(baseEvent),
        id: r.id === runSucceeded.id ? baseEvent.id : `evt-end-${r.id.slice(-4)}`,
        runId: r.id,
        level: r.state === 'failed' ? 'error' : r.state === 'partially_succeeded' || r.state === 'outcome_unknown' ? 'warning' : 'info',
        message: r.steps[0]?.message ?? '执行步骤记录已更新'
      }
    ];
  }

  const challenges: Record<string, Challenge> = {
    '33333333-3333-4333-8333-333333333333': structuredClone(
      preset === 'run-awaiting-verification'
        ? getScenarioResponse<Challenge>('challenge-run').data
        : preset === 'credential-awaiting-verification'
          ? getScenarioResponse<Challenge>('challenge-credential-operation').data
          : getScenarioResponse<Challenge>('challenge-gt4').data
    )
  };

  const credentialOps: Record<string, CredentialOperation & { pollCount?: number }> = {};
  if (preset === 'credential-awaiting-verification') {
    credentialOps[credAwaitOp.id] = structuredClone(credAwaitOp);
  } else {
    const completeOp = getScenarioResponse<CredentialOperation>('credential-refresh-complete').data;
    credentialOps[completeOp.id] = structuredClone(completeOp);
  }

  const flowCreated = getScenarioResponse<LoginFlow>('flow-created').data;
  const flows: Record<string, LoginFlow & { pollCount?: number; stage?: 'sms' | 'exchange' }> = {
    [flowCreated.id]: structuredClone(flowCreated)
  };

  return {
    preset,
    initialized: preset !== 'setup-required',
    authenticated: preset !== 'setup-required' && preset !== 'session-expired',
    admin: {
      id: '88888888-8888-4888-8888-888888888888',
      username: 'admin-demo'
    },
    csrfToken: 'mock-only-csrf-token',
    capabilities: structuredClone(caps),
    gameRolesByAccount: {},
    accounts,
    missionsByAccount,
    schedulesByAccount,
    flows,
    challenges,
    credentialOps,
    runs,
    runPollCounts: {},
    eventsByRun,
    systemSettings: structuredClone(getScenarioResponse<SystemSettings>('settings').data),
    notificationSettings: structuredClone(
      getScenarioResponse<NotificationSettings>('notification-settings').data
    ),
    notificationTests: {},
    idempotencyCache: {},
    versionConflictTriggeredOnce: false
  };
}

let state: MockState = createInitialMockState('default-ready');

export function getMockPreset(): MockPresetId {
  return state.preset;
}

export function setMockPreset(preset: MockPresetId): void {
  state = createInitialMockState(preset);
}

export function resetMockState(): void {
  state = createInitialMockState(state.preset);
}

function wrap<T>(data: T): SuccessEnvelope<T> {
  return {
    data: structuredClone(data),
    requestId: REQ_ID
  };
}

function requireAuth(): void {
  if (!state.initialized) {
    throw new MockHttpError(409, {
      code: 'SETUP_REQUIRED',
      message: '实例尚未初始化，请先设置管理员账号',
      retryable: false
    });
  }
  if (!state.authenticated || state.preset === 'session-expired') {
    throwFromScenario('session-expired');
  }
}

function requireCsrf(headers: Record<string, string>): void {
  const token = headers['x-csrf-token'] || headers['X-CSRF-Token'];
  if (!token || token !== state.csrfToken) {
    throw new MockHttpError(403, {
      code: 'CSRF_INVALID',
      message: 'CSRF 令牌无效或已过期，已重新同步会话，请再次确认操作',
      retryable: true
    });
  }
}

function requireIdempotency(
  headers: Record<string, string>,
  operationId: string,
  body: unknown
): { key: string; cached?: { status: number; response: unknown } } {
  const key = headers['idempotency-key'] || headers['Idempotency-Key'];
  if (!key) {
    throw new MockHttpError(400, {
      code: 'VALIDATION_ERROR',
      message: '缺少必需的 Idempotency-Key 请求头',
      retryable: false
    });
  }
  const fingerprint = `${operationId}:${JSON.stringify(body ?? null)}`;
  const existing = state.idempotencyCache[key];
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new MockHttpError(409, {
        code: 'IDEMPOTENCY_CONFLICT',
        message: '同一幂等 Key 不能用于不同请求参数，请使用新的操作意图重试',
        retryable: false
      });
    }
    return { key, cached: { status: existing.status, response: structuredClone(existing.response) } };
  }
  return { key };
}

function saveIdempotency(key: string, operationId: string, body: unknown, status: number, response: unknown) {
  const fingerprint = `${operationId}:${JSON.stringify(body ?? null)}`;
  state.idempotencyCache[key] = {
    fingerprint,
    status,
    response: structuredClone(response)
  };
}

export interface MockRequestInput {
  operationId: string;
  method: string;
  path: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
}

export async function executeMockRequest<T>(input: MockRequestInput): Promise<{ status: number; data: SuccessEnvelope<T> }> {
  // Small artificial latency so loading states are visible and testable
  await new Promise((r) => setTimeout(r, 40));

  const headers = input.headers ?? {};
  const pathParams = input.pathParams ?? {};
  const query = input.query ?? {};

  switch (input.operationId) {
    case 'getHealth': {
      const health: Health = {
        status: 'ok',
        version: '0.2.0',
        database: 'ok',
        serverTime: getNowIso()
      };
      return { status: 200, data: wrap(health) as SuccessEnvelope<T> };
    }

    case 'getSetupStatus': {
      if (!state.initialized) {
        return { status: 200, data: getScenarioResponse<SetupStatus>('setup-required') as SuccessEnvelope<T> };
      }
      const statusData: SetupStatus = {
        initialized: true,
        contractVersion: '0.2.0'
      };
      return { status: 200, data: wrap(statusData) as SuccessEnvelope<T> };
    }

    case 'initializeAdmin': {
      if (state.initialized) {
        throw new MockHttpError(409, {
          code: 'ALREADY_INITIALIZED',
          message: '当前实例已完成初始化，请直接登录面板',
          retryable: false
        });
      }
      const setupToken = headers['x-setup-token'] || headers['X-Setup-Token'];
      if (!setupToken || setupToken.trim().length < 4 || setupToken === 'invalid-token') {
        throw new MockHttpError(403, {
          code: 'SETUP_TOKEN_INVALID',
          message: '部署初始化令牌 (X-Setup-Token) 无效，请核对服务端环境变量配置',
          retryable: false
        });
      }
      const req = input.body as SetupRequest;
      if (!req?.username || req.username.length < 3 || !/^[a-zA-Z0-9_.-]+$/.test(req.username)) {
        throw new MockHttpError(400, {
          code: 'VALIDATION_ERROR',
          message: '管理员用户名需为 3–64 位字母、数字或 _.- 字符',
          retryable: false,
          details: {
            fieldErrors: [{ field: 'username', message: '用户名格式不符合要求' }]
          }
        });
      }
      if (!req?.password || req.password.length < 12) {
        throw new MockHttpError(400, {
          code: 'VALIDATION_ERROR',
          message: '管理员密码长度至少为 12 位',
          retryable: false,
          details: {
            fieldErrors: [{ field: 'password', message: '密码长度需在 12–128 位之间' }]
          }
        });
      }
      state.initialized = true;
      state.authenticated = false; // Setup does NOT auto-login!
      state.admin = {
        id: '88888888-8888-4888-8888-888888888888',
        username: req.username
      };
      if (state.preset === 'setup-required') {
        state.preset = 'default-ready';
      }
      return { status: 201, data: wrap(state.admin) as SuccessEnvelope<T> };
    }

    case 'loginAdmin': {
      if (!state.initialized) {
        throw new MockHttpError(409, {
          code: 'SETUP_REQUIRED',
          message: '实例尚未初始化，请先完成初始化设置',
          retryable: false
        });
      }
      const req = input.body as LoginRequest;
      if (!req?.username || !req?.password || req.password === 'wrong-password') {
        throw new MockHttpError(401, {
          code: 'AUTH_INVALID',
          message: '管理员用户名或密码错误',
          retryable: false
        });
      }
      state.authenticated = true;
      state.admin.username = req.username;
      if (state.preset === 'session-expired') {
        state.preset = 'default-ready';
      }
      const session: Session = {
        admin: state.admin,
        expiresAt: '2026-10-24T00:00:00Z',
        csrfToken: state.csrfToken
      };
      return { status: 200, data: wrap(session) as SuccessEnvelope<T> };
    }

    case 'getAdminSession': {
      requireAuth();
      const session: Session = {
        admin: state.admin,
        expiresAt: '2026-10-24T00:00:00Z',
        csrfToken: state.csrfToken
      };
      return { status: 200, data: wrap(session) as SuccessEnvelope<T> };
    }

    case 'logoutAdmin': {
      requireAuth();
      requireCsrf(headers);
      state.authenticated = false;
      const ack: Ack = { accepted: true };
      return { status: 200, data: wrap(ack) as SuccessEnvelope<T> };
    }

    case 'getCapabilities': {
      requireAuth();
      return { status: 200, data: wrap(state.capabilities) as SuccessEnvelope<T> };
    }

    case 'getDashboard': {
      requireAuth();
      const activeRuns = state.runs.filter((r) =>
        ['queued', 'running', 'awaiting_verification'].includes(r.state)
      );
      const todayRuns = state.runs.filter((r) => r.businessDate === '2026-10-23');
      const todayConfirmed = todayRuns.reduce((sum, r) => sum + (r.confirmedRewardPoints || 0), 0);
      const dashboard: Dashboard = {
        businessDate: '2026-10-23',
        accountCount: state.accounts.length,
        activeAccountCount: state.accounts.filter((a) => a.status === 'active' && a.enabled).length,
        actionRequiredCount: state.accounts.filter(
          (a) => a.status === 'reauth_required' || a.status === 'verification_required'
        ).length,
        todaySucceededRuns: todayRuns.filter((r) => r.state === 'succeeded').length,
        todayFailedRuns: todayRuns.filter((r) => r.state === 'failed' || r.state === 'partially_succeeded').length,
        todayConfirmedRewardPoints: todayConfirmed,
        activeRuns
      };
      return { status: 200, data: wrap(dashboard) as SuccessEnvelope<T> };
    }

    case 'listAccounts': {
      requireAuth();
      let items = [...state.accounts];
      if (query.status) {
        items = items.filter((a) => a.status === query.status);
      }
      if (query.enabled !== undefined && query.enabled !== '') {
        const boolVal = query.enabled === true || query.enabled === 'true';
        items = items.filter((a) => a.enabled === boolVal);
      }
      const page: AccountPage = {
        items,
        page: {
          nextCursor: null,
          hasMore: false
        }
      };
      return { status: 200, data: wrap(page) as SuccessEnvelope<T> };
    }

    case 'getAccount': {
      requireAuth();
      const account = state.accounts.find((a) => a.id === pathParams.accountId);
      if (!account) {
        throw new MockHttpError(404, {
          code: 'NOT_FOUND',
          message: '未找到指定账号',
          retryable: false
        });
      }
      return { status: 200, data: wrap(account) as SuccessEnvelope<T> };
    }

    case 'updateAccount': {
      requireAuth();
      requireCsrf(headers);
      const accountIndex = state.accounts.findIndex((a) => a.id === pathParams.accountId);
      if (accountIndex === -1) {
        throw new MockHttpError(404, {
          code: 'NOT_FOUND',
          message: '未找到指定账号',
          retryable: false
        });
      }
      const current = state.accounts[accountIndex];
      const patch = input.body as AccountPatch;

      // Check minProperties: 2
      const keys = Object.keys(patch).filter((k) => patch[k as keyof AccountPatch] !== undefined);
      if (keys.length < 2) {
        throw new MockHttpError(400, {
          code: 'VALIDATION_ERROR',
          message: '除 version 外至少需要提供一个要修改的字段',
          retryable: false
        });
      }

      // Check version conflict preset or mismatched version
      if (
        (state.preset === 'account-version-conflict' && !state.versionConflictTriggeredOnce) ||
        patch.version !== current.version
      ) {
        if (state.preset === 'account-version-conflict' && !state.versionConflictTriggeredOnce) {
          state.versionConflictTriggeredOnce = true;
          current.version += 1;
          current.remark = '其他管理员窗口刚更新的备注';
          current.updatedAt = getNowIso();
        }
        throwFromScenario('account-version-conflict');
      }

      // Validate capabilities
      if (patch.communityIds) {
        for (const cid of patch.communityIds) {
          const cap = state.capabilities.communities.find((c) => c.id === cid);
          if (!cap || !cap.executable) {
            throw new MockHttpError(422, {
              code: 'CAPABILITY_UNAVAILABLE',
              message: `所选社区（ID: ${cid}）尚未开放执行：${cap?.blockedReason ?? '未验证'}`,
              retryable: false
            });
          }
        }
      }
      if (patch.taskKinds) {
        for (const tk of patch.taskKinds) {
          const cap = state.capabilities.tasks.find((t) => t.kind === tk);
          if (!cap || !cap.executable) {
            throw new MockHttpError(422, {
              code: 'CAPABILITY_UNAVAILABLE',
              message: `所选任务（${cap?.label ?? tk}）尚未开放执行：${cap?.blockedReason ?? '未验证'}`,
              retryable: false
            });
          }
        }
      }

      const updated: Account = {
        ...current,
        remark: patch.remark !== undefined ? patch.remark : current.remark,
        enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
        communityIds: patch.communityIds !== undefined ? patch.communityIds : current.communityIds,
        taskKinds: patch.taskKinds !== undefined ? patch.taskKinds : current.taskKinds,
        gameRoleIds: patch.gameRoleIds !== undefined ? patch.gameRoleIds : current.gameRoleIds,
        autoRefresh: patch.autoRefresh !== undefined ? patch.autoRefresh : current.autoRefresh,
        version: current.version + 1,
        updatedAt: getNowIso()
      };
      state.accounts[accountIndex] = updated;

      // Sync schedule nextRunAt if account enabled changed
      const sched = state.schedulesByAccount[updated.id];
      if (sched) {
        sched.nextRunAt =
          updated.enabled && sched.enabled && !state.systemSettings.pauseScheduler
            ? '2026-10-23T22:30:00Z'
            : null;
      }

      return { status: 200, data: wrap(updated) as SuccessEnvelope<T> };
    }

    case 'deleteAccount': {
      requireAuth();
      requireCsrf(headers);
      const idem = requireIdempotency(headers, 'deleteAccount', pathParams);
      if (idem.cached) {
        return { status: idem.cached.status, data: idem.cached.response as SuccessEnvelope<T> };
      }

      const idx = state.accounts.findIndex((a) => a.id === pathParams.accountId);
      if (idx === -1) {
        throw new MockHttpError(404, {
          code: 'NOT_FOUND',
          message: '账号不存在或已被删除',
          retryable: false
        });
      }
      const acc = state.accounts[idx];
      if (acc.activeRunId || acc.activeCredentialOperationId) {
        throw new MockHttpError(409, {
          code: 'ACCOUNT_BUSY',
          message: '该账号当前有正在执行的任务或凭据操作，请等待完成或取消后再删除',
          retryable: false
        });
      }
      state.accounts.splice(idx, 1);
      const res = wrap<Ack>({ accepted: true });
      saveIdempotency(idem.key, 'deleteAccount', pathParams, 200, res);
      return { status: 200, data: res as SuccessEnvelope<T> };
    }

    case 'createLoginFlow': {
      requireAuth();
      requireCsrf(headers);
      const idem = requireIdempotency(headers, 'createLoginFlow', input.body);
      if (idem.cached) {
        return { status: idem.cached.status, data: idem.cached.response as SuccessEnvelope<T> };
      }

      const req = input.body as CreateFlowRequest;
      if (!req?.phone || !/^1[3-9][0-9]{9}$/.test(req.phone) || req.countryCode !== '+86') {
        throw new MockHttpError(400, {
          code: 'VALIDATION_ERROR',
          message: '请输入有效的 11 位中国大陆手机号（+86）',
          retryable: false,
          details: {
            fieldErrors: [{ field: 'phone', message: '手机号需符合 ^1[3-9][0-9]{9}$ 格式' }]
          }
        });
      }

      const flowId = '22222222-2222-4222-8222-222222222222';
      const flow: LoginFlow & { pollCount?: number; stage?: 'sms' | 'exchange'; rawPhone?: string } = {
        id: flowId,
        state: 'created',
        phoneMasked: maskPhoneForDisplay(req.phone),
        targetAccountId: req.targetAccountId ?? null,
        accountId: null,
        expiresAt: new Date(getNowMs() + 10 * 60 * 1000).toISOString(),
        resendAfter: null,
        nextAction: 'send_sms',
        challengeId: null,
        lastError: null,
        createdAt: getNowIso(),
        updatedAt: getNowIso(),
        pollCount: 0,
        stage: 'sms'
      };
      // Store internal test trigger flag based on phone number (never returned in API)
      (flow as unknown as { _testPhone: string })._testPhone = req.phone;
      state.flows[flowId] = flow;

      const cleanFlow: LoginFlow = {
        id: flow.id,
        state: flow.state,
        phoneMasked: flow.phoneMasked,
        targetAccountId: flow.targetAccountId,
        accountId: flow.accountId,
        expiresAt: flow.expiresAt,
        resendAfter: flow.resendAfter,
        nextAction: flow.nextAction,
        challengeId: flow.challengeId,
        lastError: flow.lastError,
        createdAt: flow.createdAt,
        updatedAt: flow.updatedAt
      };
      const res = wrap(cleanFlow);
      saveIdempotency(idem.key, 'createLoginFlow', input.body, 201, res);
      return { status: 201, data: res as SuccessEnvelope<T> };
    }

    case 'getLoginFlow': {
      requireAuth();
      if (state.preset === 'flow-expired') {
        throwFromScenario('flow-expired');
      }
      const flow = state.flows[pathParams.flowId];
      if (!flow) {
        throwFromScenario('flow-expired');
      }
      if (flow.state === 'exchanging') {
        flow.pollCount = (flow.pollCount ?? 0) + 1;
        const testPhone = (flow as unknown as { _testPhone?: string })._testPhone;
        if (testPhone === '13900009999' && flow.targetAccountId) {
          flow.state = 'failed';
          flow.nextAction = 'restart';
          flow.lastError = {
            code: 'ACCOUNT_IDENTITY_MISMATCH',
            message: '重新登录的米游社通行证 (aid) 与目标账号不一致，已拒绝覆盖',
            retryable: false
          };
        } else if (testPhone === '13900008888' && !flow.targetAccountId) {
          flow.state = 'failed';
          flow.nextAction = 'restart';
          flow.lastError = {
            code: 'ACCOUNT_EXISTS',
            message: '该米游社账号已存在于本实例中，请勿重复添加',
            retryable: false
          };
        } else {
          // Transition to completed!
          let boundAccountId = flow.targetAccountId;
          if (boundAccountId) {
            const existing = state.accounts.find((a) => a.id === boundAccountId);
            if (existing) {
              existing.status = 'active';
              existing.phoneMasked = flow.phoneMasked;
              existing.credential = {
                status: 'valid',
                lastCheckedAt: getNowIso(),
                lastCookieIssuedAt: getNowIso(),
                cookieStorageExpiresAt: new Date(getNowMs() + 48 * 3600 * 1000).toISOString(),
                rootExpiresAt: null,
                expirySource: 'cookie_max_age'
              };
              existing.updatedAt = getNowIso();
            }
          } else {
            boundAccountId =
              state.accounts.length === 0
                ? '11111111-1111-4111-8111-111111111111'
                : `acc-${Date.now().toString(16).slice(-8)}-4111-8111-111111111111`.slice(0, 36);
            // If 11111111... doesn't exist yet, or add new account
            const existingIdx = state.accounts.findIndex((a) => a.id === boundAccountId);
            const newAcc: Account = {
              id: '11111111-1111-4111-8111-111111111111',
              uid: `10000000${state.accounts.length + 1}`,
              nickname: state.accounts.length === 0 ? '演示账号' : `旅行者_${flow.phoneMasked.slice(-4)}`,
              phoneMasked: flow.phoneMasked,
              remark: '通过短信登录新绑定的账号',
              enabled: true,
              status: 'active',
              communityIds: [2],
              taskKinds: ['community_sign'],
              autoRefresh: true,
              credential: {
                status: 'valid',
                lastCheckedAt: getNowIso(),
                lastCookieIssuedAt: getNowIso(),
                cookieStorageExpiresAt: new Date(getNowMs() + 48 * 3600 * 1000).toISOString(),
                rootExpiresAt: null,
                expirySource: 'cookie_max_age'
              },
              version: 1,
              createdAt: getNowIso(),
              updatedAt: getNowIso(),
              activeCredentialOperationId: null,
              activeRunId: null
            };
            if (existingIdx === -1) {
              state.accounts.unshift(newAcc);
            } else {
              const altId = '13333333-3333-4333-8333-333333333333';
              newAcc.id = altId;
              boundAccountId = altId;
              const altIdx = state.accounts.findIndex((a) => a.id === altId);
              if (altIdx === -1) {
                state.accounts.unshift(newAcc);
              } else {
                state.accounts[altIdx] = newAcc;
              }
            }
            state.missionsByAccount[boundAccountId] = {
              ...structuredClone(getScenarioResponse<MissionSnapshot>('missions-unfetched').data),
              accountId: boundAccountId
            };
            state.schedulesByAccount[boundAccountId] = {
              ...structuredClone(getScenarioResponse<Schedule>('schedule-off').data),
              accountId: boundAccountId
            };
          }
          flow.state = 'completed';
          flow.accountId = boundAccountId;
          flow.nextAction = 'none';
          flow.resendAfter = null;
          flow.updatedAt = getNowIso();
        }
      }

      const cleanFlow: LoginFlow = {
        id: flow.id,
        state: flow.state,
        phoneMasked: flow.phoneMasked,
        targetAccountId: flow.targetAccountId,
        accountId: flow.accountId,
        expiresAt: flow.expiresAt,
        resendAfter: flow.resendAfter,
        nextAction: flow.nextAction,
        challengeId: flow.challengeId,
        lastError: flow.lastError,
        createdAt: flow.createdAt,
        updatedAt: flow.updatedAt
      };
      return { status: 200, data: wrap(cleanFlow) as SuccessEnvelope<T> };
    }

    case 'cancelLoginFlow': {
      requireAuth();
      requireCsrf(headers);
      const idem = requireIdempotency(headers, 'cancelLoginFlow', pathParams);
      if (idem.cached) {
        return { status: idem.cached.status, data: idem.cached.response as SuccessEnvelope<T> };
      }
      const flow = state.flows[pathParams.flowId];
      if (!flow) {
        throwFromScenario('flow-expired');
      }
      flow.state = 'canceled';
      flow.nextAction = 'none';
      flow.challengeId = null;
      flow.updatedAt = getNowIso();
      const res = wrap<LoginFlow>({
        id: flow.id,
        state: flow.state,
        phoneMasked: flow.phoneMasked,
        targetAccountId: flow.targetAccountId,
        accountId: flow.accountId,
        expiresAt: flow.expiresAt,
        resendAfter: flow.resendAfter,
        nextAction: flow.nextAction,
        challengeId: flow.challengeId,
        lastError: flow.lastError,
        createdAt: flow.createdAt,
        updatedAt: flow.updatedAt
      });
      saveIdempotency(idem.key, 'cancelLoginFlow', pathParams, 200, res);
      return { status: 200, data: res as SuccessEnvelope<T> };
    }

    case 'sendLoginSms': {
      requireAuth();
      requireCsrf(headers);
      const idem = requireIdempotency(headers, 'sendLoginSms', pathParams);
      if (idem.cached) {
        return { status: idem.cached.status, data: idem.cached.response as SuccessEnvelope<T> };
      }
      if (state.preset === 'sms-rate-limited') {
        throwFromScenario('sms-rate-limited');
      }
      if (state.preset === 'flow-expired') {
        throwFromScenario('flow-expired');
      }
      const flow = state.flows[pathParams.flowId];
      if (!flow) {
        throwFromScenario('flow-expired');
      }

      // Check resendAfter cooldown
      if (flow.resendAfter && Date.parse(flow.resendAfter) > getNowMs()) {
        const waitSec = Math.ceil((Date.parse(flow.resendAfter) - getNowMs()) / 1000);
        throw new MockHttpError(
          429,
          {
            code: 'RATE_LIMITED',
            message: '请稍后再发送验证码',
            retryable: true,
            details: { retryAfterSeconds: waitSec }
          },
          REQ_ID,
          { 'retry-after': String(waitSec) }
        );
      }

      // By default in mock mode, first send-sms requires human captcha (matching flow-awaiting-captcha scenario)
      const challengeId = '33333333-3333-4333-8333-333333333333';
      state.challenges[challengeId] = {
        ...structuredClone(getScenarioResponse<Challenge>('challenge-gt4').data),
        id: challengeId,
        ownerType: 'login_flow',
        ownerId: flow.id,
        purpose: 'send_sms',
        state: 'pending',
        expiresAt: new Date(getNowMs() + 5 * 60 * 1000).toISOString()
      };

      flow.state = 'awaiting_captcha';
      flow.nextAction = 'solve_challenge';
      flow.challengeId = challengeId;
      flow.resendAfter = null; // Crucial: do NOT set resendAfter when awaiting_captcha!
      flow.updatedAt = getNowIso();

      const res = wrap<LoginFlow>({
        id: flow.id,
        state: flow.state,
        phoneMasked: flow.phoneMasked,
        targetAccountId: flow.targetAccountId,
        accountId: flow.accountId,
        expiresAt: flow.expiresAt,
        resendAfter: flow.resendAfter,
        nextAction: flow.nextAction,
        challengeId: flow.challengeId,
        lastError: flow.lastError,
        createdAt: flow.createdAt,
        updatedAt: flow.updatedAt
      });
      saveIdempotency(idem.key, 'sendLoginSms', pathParams, 200, res);
      return { status: 200, data: res as SuccessEnvelope<T> };
    }

    case 'submitLoginCode': {
      requireAuth();
      requireCsrf(headers);
      const idem = requireIdempotency(headers, 'submitLoginCode', { ...pathParams, body: input.body });
      if (idem.cached) {
        return { status: idem.cached.status, data: idem.cached.response as SuccessEnvelope<T> };
      }

      if (state.preset === 'flow-expired') {
        throwFromScenario('flow-expired');
      }

      const flow = state.flows[pathParams.flowId];
      if (!flow) {
        throwFromScenario('flow-expired');
      }

      const req = input.body as SubmitCodeRequest;
      if (typeof req?.code !== 'string' || !/^[0-9]{6}$/.test(req.code)) {
        throw new MockHttpError(400, {
          code: 'VALIDATION_ERROR',
          message: '短信验证码必须为 6 位数字字符串（保留前导零）',
          retryable: false,
          details: {
            fieldErrors: [{ field: 'code', message: '请输入 6 位数字验证码' }]
          }
        });
      }

      if (state.preset === 'flow-invalid-code' || req.code === '000001') {
        throwFromScenario('flow-invalid-code');
      }

      flow.state = 'exchanging';
      flow.nextAction = 'poll';
      flow.challengeId = null;
      flow.lastError = null;
      flow.pollCount = 0;
      flow.updatedAt = getNowIso();

      const res = wrap<LoginFlow>({
        id: flow.id,
        state: flow.state,
        phoneMasked: flow.phoneMasked,
        targetAccountId: flow.targetAccountId,
        accountId: flow.accountId,
        expiresAt: flow.expiresAt,
        resendAfter: flow.resendAfter,
        nextAction: flow.nextAction,
        challengeId: flow.challengeId,
        lastError: flow.lastError,
        createdAt: flow.createdAt,
        updatedAt: flow.updatedAt
      });
      saveIdempotency(idem.key, 'submitLoginCode', { ...pathParams, body: input.body }, 202, res);
      return { status: 202, data: res as SuccessEnvelope<T> };
    }

    case 'getChallenge': {
      requireAuth();
      const ch = state.challenges[pathParams.challengeId];
      if (!ch) {
        throw new MockHttpError(410, {
          code: 'CHALLENGE_EXPIRED',
          message: '该人工验证会话已过期，请更新验证会话',
          retryable: false
        });
      }
      return { status: 200, data: wrap(ch) as SuccessEnvelope<T> };
    }

    case 'submitChallenge': {
      requireAuth();
      requireCsrf(headers);
      const idem = requireIdempotency(headers, 'submitChallenge', { ...pathParams, body: input.body });
      if (idem.cached) {
        return { status: idem.cached.status, data: idem.cached.response as SuccessEnvelope<T> };
      }

      const ch = state.challenges[pathParams.challengeId];
      if (!ch || ch.state === 'expired') {
        throw new MockHttpError(410, {
          code: 'CHALLENGE_EXPIRED',
          message: '验证会话已过期，请点击更新验证会话',
          retryable: false
        });
      }

      const sub = input.body as ChallengeSubmission;
      if (!sub || sub.version !== ch.version) {
        throw new MockHttpError(400, {
          code: 'VALIDATION_ERROR',
          message: '提交的验证版本与当前 Challenge 不匹配',
          retryable: false
        });
      }

      // Check simulated failure trigger
      const isFailureSim =
        state.preset === 'challenge-failed' ||
        (sub.version === 'gt4' && sub.result.lot_number === 'mock-old-lot');

      if (isFailureSim) {
        ch.state = 'failed';
        if (ch.ownerType === 'login_flow' && state.flows[ch.ownerId]) {
          state.flows[ch.ownerId].nextAction = 'renew_challenge';
        }
        throwFromScenario('challenge-failed');
      }

      if (sub.version === 'gt4' && sub.result.lot_number === 'mock-expired-lot') {
        ch.state = 'expired';
        if (ch.ownerType === 'login_flow' && state.flows[ch.ownerId]) {
          state.flows[ch.ownerId].nextAction = 'renew_challenge';
        }
        throw new MockHttpError(410, {
          code: 'CHALLENGE_EXPIRED',
          message: '验证会话已过期，请更新验证会话后重试',
          retryable: false
        });
      }

      ch.state = 'accepted';

      // Transition the owner resource!
      if (ch.ownerType === 'login_flow') {
        const flow = state.flows[ch.ownerId];
        if (flow) {
          flow.state = 'awaiting_sms_code';
          flow.nextAction = 'submit_code';
          flow.challengeId = null;
          flow.resendAfter = new Date(getNowMs() + 50 * 1000).toISOString();
          flow.updatedAt = getNowIso();
        }
      } else if (ch.ownerType === 'credential_operation') {
        const op = state.credentialOps[ch.ownerId];
        if (op) {
          op.state = 'succeeded';
          op.challengeId = null;
          op.updatedAt = getNowIso();
          const acc = state.accounts.find((a) => a.id === op.accountId);
          if (acc) {
            acc.status = 'active';
            acc.activeCredentialOperationId = null;
            acc.credential = {
              status: 'valid',
              lastCheckedAt: getNowIso(),
              lastCookieIssuedAt: getNowIso(),
              cookieStorageExpiresAt: new Date(getNowMs() + 48 * 3600 * 1000).toISOString(),
              rootExpiresAt: null,
              expirySource: 'cookie_max_age'
            };
            acc.updatedAt = getNowIso();
            op.account = structuredClone(acc);
          }
        }
      } else if (ch.ownerType === 'run') {
        const run = state.runs.find((r) => r.id === ch.ownerId);
        if (run) {
          run.state = 'succeeded';
          run.challengeId = null;
          run.confirmedRewardPoints = 30;
          run.finishedAt = getNowIso();
          if (run.steps[0]) {
            run.steps[0].state = 'succeeded';
            run.steps[0].message = '人工验证通过，已确认签到完成，奖励到账';
            run.steps[0].rewardPoints = 30;
            run.steps[0].upstreamRetcode = 0;
            run.steps[0].finishedAt = getNowIso();
          }
          const acc = state.accounts.find((a) => a.id === run.accountId);
          if (acc) {
            acc.activeRunId = null;
            if (acc.status === 'verification_required') {
              acc.status = 'active';
              acc.credential.status = 'valid';
            }
          }
          state.eventsByRun[run.id] = [
            ...(state.eventsByRun[run.id] ?? []),
            {
              id: `evt-verified-${Date.now()}`,
              runId: run.id,
              level: 'info',
              message: '用户手动完成人工验证，签到核对成功 (+30 米游币)',
              stepId: run.steps[0]?.id ?? null,
              createdAt: getNowIso()
            }
          ];
        }
      }

      const receipt: ChallengeReceipt = {
        challengeId: ch.id,
        accepted: true,
        ownerType: ch.ownerType,
        ownerId: ch.ownerId,
        nextAction: 'poll_owner',
        message: '验证结果已处理，正在同步关联任务状态'
      };
      const res = wrap(receipt);
      saveIdempotency(idem.key, 'submitChallenge', { ...pathParams, body: input.body }, 200, res);
      return { status: 200, data: res as SuccessEnvelope<T> };
    }

    case 'renewChallenge': {
      requireAuth();
      requireCsrf(headers);
      const idem = requireIdempotency(headers, 'renewChallenge', pathParams);
      if (idem.cached) {
        return { status: idem.cached.status, data: idem.cached.response as SuccessEnvelope<T> };
      }

      const oldCh = state.challenges[pathParams.challengeId];
      const newId = '33333333-3333-4333-8333-333333333334';
      const newCh: Challenge = {
        id: newId,
        ownerType: oldCh?.ownerType ?? 'login_flow',
        ownerId: oldCh?.ownerId ?? '22222222-2222-4222-8222-222222222222',
        purpose: oldCh?.purpose ?? 'send_sms',
        provider: 'geetest',
        version: 'gt4',
        state: 'pending',
        expiresAt: new Date(getNowMs() + 5 * 60 * 1000).toISOString(),
        config: {
          captchaId: 'mock-not-a-real-captcha-id',
          challenge: null,
          newCaptcha: null,
          offline: false,
          product: 'bind',
          language: 'zho',
          riskType: 'slide',
          userInfo: null
        }
      };
      state.challenges[newId] = newCh;
      if (oldCh) {
        oldCh.state = 'expired';
        if (oldCh.ownerType === 'login_flow' && state.flows[oldCh.ownerId]) {
          state.flows[oldCh.ownerId].challengeId = newId;
          state.flows[oldCh.ownerId].nextAction = 'solve_challenge';
        } else if (oldCh.ownerType === 'credential_operation' && state.credentialOps[oldCh.ownerId]) {
          state.credentialOps[oldCh.ownerId].challengeId = newId;
        } else if (oldCh.ownerType === 'run') {
          const r = state.runs.find((item) => item.id === oldCh.ownerId);
          if (r) r.challengeId = newId;
        }
      }
      // If user was in challenge-failed preset, allow the renewed challenge to succeed
      if (state.preset === 'challenge-failed') {
        state.preset = 'default-ready';
      }

      const res = wrap(newCh);
      saveIdempotency(idem.key, 'renewChallenge', pathParams, 200, res);
      return { status: 200, data: res as SuccessEnvelope<T> };
    }

    case 'startCredentialOperation': {
      requireAuth();
      requireCsrf(headers);
      const idem = requireIdempotency(headers, 'startCredentialOperation', { ...pathParams, body: input.body });
      if (idem.cached) {
        return { status: idem.cached.status, data: idem.cached.response as SuccessEnvelope<T> };
      }

      const acc = state.accounts.find((a) => a.id === pathParams.accountId);
      if (!acc) {
        throw new MockHttpError(404, {
          code: 'NOT_FOUND',
          message: '账号不存在',
          retryable: false
        });
      }

      const req = input.body as CredentialOperationRequest;
      const opId = '66666666-6666-4666-8666-666666666666';
      const needsChallenge = state.preset === 'credential-awaiting-verification';
      const challengeId = needsChallenge ? '33333333-3333-4333-8333-333333333333' : null;

      if (needsChallenge && challengeId) {
        state.challenges[challengeId] = {
          ...structuredClone(getScenarioResponse<Challenge>('challenge-credential-operation').data),
          id: challengeId,
          ownerId: opId
        };
      }

      acc.activeCredentialOperationId = opId;
      const op: CredentialOperation & { pollCount?: number } = {
        id: opId,
        accountId: acc.id,
        kind: req.kind,
        state: 'queued',
        challengeId: null,
        account: structuredClone(acc),
        error: null,
        createdAt: getNowIso(),
        updatedAt: getNowIso(),
        pollCount: 0
      };
      state.credentialOps[opId] = op;

      const res = wrap<CredentialOperation>({
        id: op.id,
        accountId: op.accountId,
        kind: op.kind,
        state: op.state,
        challengeId: op.challengeId,
        account: op.account,
        error: op.error,
        createdAt: op.createdAt,
        updatedAt: op.updatedAt
      });
      saveIdempotency(idem.key, 'startCredentialOperation', { ...pathParams, body: input.body }, 202, res);
      return { status: 202, data: res as SuccessEnvelope<T> };
    }

    case 'getCredentialOperation': {
      requireAuth();
      const op = state.credentialOps[pathParams.operationId];
      if (!op) {
        throw new MockHttpError(404, {
          code: 'NOT_FOUND',
          message: '未找到对应的凭据操作记录',
          retryable: false
        });
      }

      if (op.state === 'queued' || op.state === 'running') {
        op.pollCount = (op.pollCount ?? 0) + 1;
        const acc = state.accounts.find((a) => a.id === op.accountId);
        if (state.preset === 'credential-awaiting-verification') {
          const chId = '33333333-3333-4333-8333-333333333333';
          op.state = 'awaiting_verification';
          op.challengeId = chId;
          state.challenges[chId] = {
            ...structuredClone(getScenarioResponse<Challenge>('challenge-credential-operation').data),
            id: chId,
            ownerId: op.id
          };
          if (acc) {
            acc.status = 'verification_required';
            acc.credential.status = 'verification_required';
            op.account = structuredClone(acc);
          }
        } else if (acc && acc.status === 'reauth_required' && op.kind === 'check') {
          op.state = 'failed';
          op.error = {
            code: 'ACCOUNT_REAUTH_REQUIRED',
            message: '根凭据 (stoken_v2) 已失效，无法换取工作 Cookie，请重新登录该账号',
            retryable: false
          };
          acc.activeCredentialOperationId = null;
          acc.credential.lastCheckedAt = getNowIso();
          op.account = structuredClone(acc);
        } else {
          op.state = 'succeeded';
          if (acc) {
            acc.status = 'active';
            acc.activeCredentialOperationId = null;
            acc.credential = {
              status: 'valid',
              lastCheckedAt: getNowIso(),
              lastCookieIssuedAt:
                op.kind === 'refresh_cookie' ? getNowIso() : acc.credential.lastCookieIssuedAt ?? getNowIso(),
              cookieStorageExpiresAt: new Date(getNowMs() + 48 * 3600 * 1000).toISOString(),
              rootExpiresAt: null,
              expirySource: 'cookie_max_age'
            };
            acc.updatedAt = getNowIso();
            op.account = structuredClone(acc);
          }
        }
        op.updatedAt = getNowIso();
      }

      return {
        status: 200,
        data: wrap<CredentialOperation>({
          id: op.id,
          accountId: op.accountId,
          kind: op.kind,
          state: op.state,
          challengeId: op.challengeId,
          account: op.account,
          error: op.error,
          createdAt: op.createdAt,
          updatedAt: op.updatedAt
        }) as SuccessEnvelope<T>
      };
    }

    case 'getAccountMissions': {
      requireAuth();
      const acc = state.accounts.find((a) => a.id === pathParams.accountId);
      if (!acc) {
        throw new MockHttpError(404, {
          code: 'NOT_FOUND',
          message: '账号不存在',
          retryable: false
        });
      }
      const snap =
        state.missionsByAccount[acc.id] ??
        ({
          ...structuredClone(getScenarioResponse<MissionSnapshot>('missions-unfetched').data),
          accountId: acc.id
        } satisfies MissionSnapshot);
      return { status: 200, data: wrap(snap) as SuccessEnvelope<T> };
    }

    case 'refreshAccountMissions': {
      requireAuth();
      requireCsrf(headers);
      const idem = requireIdempotency(headers, 'refreshAccountMissions', pathParams);
      if (idem.cached) {
        return { status: idem.cached.status, data: idem.cached.response as SuccessEnvelope<T> };
      }

      const acc = state.accounts.find((a) => a.id === pathParams.accountId);
      if (!acc) {
        throw new MockHttpError(404, {
          code: 'NOT_FOUND',
          message: '账号不存在',
          retryable: false
        });
      }
      if (acc.status === 'reauth_required') {
        throw new MockHttpError(409, {
          code: 'ACCOUNT_REAUTH_REQUIRED',
          message: '当前账号根凭据已失效，请先尝试更新工作 Cookie 或重新登录账号',
          retryable: false
        });
      }

      const signed = structuredClone(getScenarioResponse<MissionSnapshot>('missions-signed').data);
      signed.accountId = acc.id;
      signed.fetchedAt = getNowIso();
      state.missionsByAccount[acc.id] = signed;

      const res = wrap(signed);
      saveIdempotency(idem.key, 'refreshAccountMissions', pathParams, 200, res);
      return { status: 200, data: res as SuccessEnvelope<T> };
    }

    case 'getGameRoles':
    case 'refreshGameRoles': {
      requireAuth();
      const acc = state.accounts.find(a => a.id === pathParams.accountId);
      if (!acc) throw new MockHttpError(404, { code: 'NOT_FOUND', message: '账号不存在', retryable: false });
      if (input.operationId === 'refreshGameRoles') {
        requireCsrf(headers);
        const idem = requireIdempotency(headers, 'refreshGameRoles', pathParams);
        if (idem.cached) return { status: idem.cached.status, data: idem.cached.response as SuccessEnvelope<T> };
        const snapshot = structuredClone(getScenarioResponse<GameRolesSnapshot>('game-roles-ready').data);
        snapshot.accountId = acc.id; snapshot.fetchedAt = getNowIso();
        for (const role of snapshot.roles) if (state.runs.some(r => r.accountId === acc.id && r.steps.some(s => s.gameRoleId === role.id && ['succeeded', 'already_completed'].includes(s.state)))) role.status = 'signed';
        state.gameRolesByAccount[acc.id] = snapshot;
        const response = wrap(snapshot); saveIdempotency(idem.key, 'refreshGameRoles', pathParams, 200, response);
        return { status: 200, data: response as SuccessEnvelope<T> };
      }
      return { status: 200, data: wrap(state.gameRolesByAccount[acc.id] ?? { accountId: acc.id, fetchedAt: null, stale: true, roles: [] }) as SuccessEnvelope<T> };
    }

    case 'getAccountSchedule': {
      requireAuth();
      const acc = state.accounts.find((a) => a.id === pathParams.accountId);
      if (!acc) {
        throw new MockHttpError(404, {
          code: 'NOT_FOUND',
          message: '账号不存在',
          retryable: false
        });
      }
      const sched =
        state.schedulesByAccount[acc.id] ??
        ({
          ...structuredClone(getScenarioResponse<Schedule>('schedule-off').data),
          accountId: acc.id
        } satisfies Schedule);
      return { status: 200, data: wrap(sched) as SuccessEnvelope<T> };
    }

    case 'updateAccountSchedule': {
      requireAuth();
      requireCsrf(headers);
      const acc = state.accounts.find((a) => a.id === pathParams.accountId);
      if (!acc) {
        throw new MockHttpError(404, {
          code: 'NOT_FOUND',
          message: '账号不存在',
          retryable: false
        });
      }
      const current =
        state.schedulesByAccount[acc.id] ??
        ({
          ...structuredClone(getScenarioResponse<Schedule>('schedule-off').data),
          accountId: acc.id
        } satisfies Schedule);

      const patch = input.body as SchedulePatch;
      const keys = Object.keys(patch).filter((k) => patch[k as keyof SchedulePatch] !== undefined);
      if (keys.length < 2) {
        throw new MockHttpError(400, {
          code: 'VALIDATION_ERROR',
          message: '除 version 外至少需要提供一个修改字段',
          retryable: false
        });
      }

      if (
        (state.preset === 'account-version-conflict' && !state.versionConflictTriggeredOnce) ||
        patch.version !== current.version
      ) {
        if (state.preset === 'account-version-conflict' && !state.versionConflictTriggeredOnce) {
          state.versionConflictTriggeredOnce = true;
          current.version += 1;
          current.hour = 7;
          current.minute = 15;
          state.schedulesByAccount[acc.id] = current;
        }
        throwFromScenario('account-version-conflict');
      }

      const enabled = patch.enabled !== undefined ? patch.enabled : current.enabled;
      const hour = patch.hour !== undefined ? patch.hour : current.hour;
      const minute = patch.minute !== undefined ? patch.minute : current.minute;

      const updated: Schedule = {
        accountId: acc.id,
        enabled,
        hour,
        minute,
        timezone: 'Asia/Shanghai',
        jitterMaxMinutes: 10,
        nextRunAt:
          enabled && acc.enabled && !state.systemSettings.pauseScheduler
            ? `2026-10-23T${String((hour - 8 + 24) % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`
            : null,
        version: current.version + 1
      };
      state.schedulesByAccount[acc.id] = updated;
      return { status: 200, data: wrap(updated) as SuccessEnvelope<T> };
    }

    case 'createAccountRun': {
      requireAuth();
      requireCsrf(headers);
      const idem = requireIdempotency(headers, 'createAccountRun', { ...pathParams, body: input.body });
      if (idem.cached) {
        return { status: idem.cached.status, data: idem.cached.response as SuccessEnvelope<T> };
      }

      if (state.preset === 'unsupported-task') {
        throwFromScenario('unsupported-task');
      }

      const acc = state.accounts.find((a) => a.id === pathParams.accountId);
      if (!acc) {
        throw new MockHttpError(404, {
          code: 'NOT_FOUND',
          message: '账号不存在',
          retryable: false
        });
      }

      const req = input.body as RunRequest;
      for (const cid of req.communityIds) {
        const cap = state.capabilities.communities.find((c) => c.id === cid);
        if (!cap || !cap.executable) {
          throwFromScenario('unsupported-task');
        }
      }
      for (const tk of req.taskKinds) {
        const cap = state.capabilities.tasks.find((t) => t.kind === tk);
        if (!cap || !cap.executable) {
          throwFromScenario('unsupported-task');
        }
      }

      const queuedRun = structuredClone(getScenarioResponse<Run>('run-queued').data);
      const runId = '44444444-4444-4444-8444-444444444444';
      queuedRun.id = runId;
      queuedRun.accountId = acc.id;
      queuedRun.communityIds = req.communityIds;
      queuedRun.taskKinds = req.taskKinds;
      queuedRun.gameRoleIds = req.gameRoleIds ?? acc.gameRoleIds ?? [];
      if (req.taskKinds.includes('game_sign')) {
        queuedRun.steps = req.taskKinds.includes('community_sign') ? queuedRun.steps : [];
        const snapshot = state.gameRolesByAccount[acc.id] ?? getScenarioResponse<GameRolesSnapshot>('game-roles-ready').data;
        queuedRun.steps.push(...snapshot.roles.filter(r => r.executable && (!queuedRun.gameRoleIds?.length || queuedRun.gameRoleIds.includes(r.id))).map(role => ({
          id: 'step-' + role.id, communityId: role.communityId!, taskKind: 'game_sign' as const, gameRoleId: role.id, gameName: role.gameName,
          roleLabel: `${role.nickname} (${role.uid} / ${role.regionName})`, rewards: [], state: 'pending' as const, message: '等待游戏签到',
          rewardPoints: 0, upstreamRetcode: null, startedAt: null, finishedAt: null
        })));
      }
      queuedRun.createdAt = getNowIso();

      state.runPollCounts[runId] = 0;
      const existingIdx = state.runs.findIndex((r) => r.id === runId);
      if (existingIdx >= 0) {
        state.runs[existingIdx] = queuedRun;
      } else {
        state.runs.unshift(queuedRun);
      }
      acc.activeRunId = runId;
      state.eventsByRun[runId] = [
        {
          id: `evt-queued-${Date.now()}`,
          runId,
          level: 'info',
          message: '已受理立即签到请求，任务进入队列',
          stepId: queuedRun.steps[0]?.id ?? null,
          createdAt: getNowIso()
        }
      ];

      const res = wrap(queuedRun);
      saveIdempotency(idem.key, 'createAccountRun', { ...pathParams, body: input.body }, 202, res);
      return { status: 202, data: res as SuccessEnvelope<T> };
    }

    case 'listRuns': {
      requireAuth();
      let items = [...state.runs];
      if (query.accountId) {
        items = items.filter((r) => r.accountId === query.accountId);
      }
      if (query.state) {
        items = items.filter((r) => r.state === query.state);
      }
      if (query.dateFrom) {
        items = items.filter((r) => r.businessDate >= String(query.dateFrom));
      }
      if (query.dateTo) {
        items = items.filter((r) => r.businessDate <= String(query.dateTo));
      }
      const page: RunPage = {
        items,
        page: {
          nextCursor: null,
          hasMore: false
        }
      };
      return { status: 200, data: wrap(page) as SuccessEnvelope<T> };
    }

    case 'getRun': {
      requireAuth();
      const idx = state.runs.findIndex((r) => r.id === pathParams.runId);
      if (idx === -1) {
        throw new MockHttpError(404, {
          code: 'NOT_FOUND',
          message: '未找到该执行记录',
          retryable: false
        });
      }
      const current = state.runs[idx];

      // Progress queued/running runs on poll
      if (current.state === 'queued' || current.state === 'running') {
        const count = (state.runPollCounts[current.id] ?? 0) + 1;
        state.runPollCounts[current.id] = count;

        let nextRun: Run;
        if (state.preset === 'run-awaiting-verification') {
          nextRun = structuredClone(getScenarioResponse<Run>('run-awaiting-verification').data);
          state.challenges['33333333-3333-4333-8333-333333333333'] = structuredClone(
            getScenarioResponse<Challenge>('challenge-run').data
          );
        } else if (state.preset === 'run-already-completed') {
          nextRun = structuredClone(getScenarioResponse<Run>('run-already-completed').data);
        } else if (state.preset === 'run-partially-succeeded') {
          nextRun = structuredClone(getScenarioResponse<Run>('run-partially-succeeded').data);
        } else if (state.preset === 'run-outcome-unknown') {
          nextRun = structuredClone(getScenarioResponse<Run>('run-outcome-unknown').data);
        } else if (state.preset === 'run-failed') {
          nextRun = structuredClone(getScenarioResponse<Run>('run-failed').data);
        } else {
          const acc = state.accounts.find((a) => a.id === current.accountId);
          if (acc?.status === 'reauth_required') {
            nextRun = structuredClone(getScenarioResponse<Run>('run-failed').data);
          } else {
            nextRun = structuredClone(getScenarioResponse<Run>('run-succeeded').data);
          }
        }
        nextRun.id = current.id;
        nextRun.accountId = current.accountId;
        nextRun.source = current.source;
        nextRun.parentRunId = current.parentRunId;
        if (current.taskKinds.includes('game_sign') && state.preset === 'default-ready') {
          nextRun.taskKinds = current.taskKinds; nextRun.communityIds = current.communityIds; nextRun.gameRoleIds = current.gameRoleIds;
          const roles = state.gameRolesByAccount[current.accountId]?.roles ?? getScenarioResponse<GameRolesSnapshot>('game-roles-ready').data.roles;
          nextRun.steps = current.steps.map(step => ({ ...step, state: 'succeeded', message: '模拟：已核对签到状态', finishedAt: getNowIso(), rewardPoints: step.taskKind === 'game_sign' ? 0 : 30, rewards: step.gameRoleId && roles.find(r => r.id === step.gameRoleId)?.reward ? [roles.find(r => r.id === step.gameRoleId)!.reward!] : [] }));
          nextRun.confirmedRewardPoints = nextRun.steps.reduce((n, s) => n + (s.rewardPoints ?? 0), 0);
        }
        state.runs[idx] = nextRun;

        const acc = state.accounts.find((a) => a.id === current.accountId);
        if (acc) {
          acc.activeRunId = nextRun.state === 'awaiting_verification' ? nextRun.id : null;
        }

        state.eventsByRun[current.id] = [
          ...(state.eventsByRun[current.id] ?? []),
          {
            id: '99999999-9999-4999-8999-999999999999',
            runId: current.id,
            level:
              nextRun.state === 'failed'
                ? 'error'
                : nextRun.state === 'partially_succeeded' || nextRun.state === 'outcome_unknown'
                  ? 'warning'
                  : 'info',
            message: nextRun.steps[0]?.message ?? '步骤状态已更新',
            stepId: nextRun.steps[0]?.id ?? null,
            createdAt: getNowIso()
          }
        ];
      }

      return { status: 200, data: wrap(state.runs[idx]) as SuccessEnvelope<T> };
    }

    case 'listRunEvents': {
      requireAuth();
      const events = state.eventsByRun[pathParams.runId] ?? getScenarioResponse<RunEventPage>('run-events').data.items;
      const page: RunEventPage = {
        items: events,
        page: {
          nextCursor: null,
          hasMore: false
        }
      };
      return { status: 200, data: wrap(page) as SuccessEnvelope<T> };
    }

    case 'retryRun': {
      requireAuth();
      requireCsrf(headers);
      const idem = requireIdempotency(headers, 'retryRun', pathParams);
      if (idem.cached) {
        return { status: idem.cached.status, data: idem.cached.response as SuccessEnvelope<T> };
      }

      const orig = state.runs.find((r) => r.id === pathParams.runId);
      if (!orig) {
        throw new MockHttpError(404, {
          code: 'NOT_FOUND',
          message: '原执行记录不存在',
          retryable: false
        });
      }
      if (!['failed', 'partially_succeeded', 'outcome_unknown'].includes(orig.state)) {
        throw new MockHttpError(409, {
          code: 'RUN_STATE_CONFLICT',
          message: '仅执行失败、部分完成或结果未知的记录支持安全重试',
          retryable: false
        });
      }
      if (orig.businessDate !== '2026-10-23') {
        throw new MockHttpError(409, {
          code: 'RUN_STATE_CONFLICT',
          message: '跨日历史记录不支持补签重试，请直接发起今日签到任务',
          retryable: false
        });
      }

      const retryId = '44444444-4444-4444-8444-444444444499';
      const newRun: Run = {
        id: retryId,
        accountId: orig.accountId,
        source: 'retry',
        parentRunId: orig.id,
        businessDate: '2026-10-23',
        state: 'queued',
        communityIds: orig.communityIds,
        taskKinds: orig.taskKinds,
        challengeId: null,
        steps: orig.steps.map((s) =>
          s.state === 'succeeded' || s.state === 'already_completed'
            ? { ...s, state: 'skipped', message: '前序步骤已确认完成，本次跳过不重复执行', rewardPoints: 0 }
            : { ...s, state: 'pending', message: '等待对账与重试', startedAt: null, finishedAt: null }
        ),
        confirmedRewardPoints: 0,
        cancelRequestedAt: null,
        createdAt: getNowIso(),
        startedAt: null,
        finishedAt: null,
        error: null
      };
      state.runs.unshift(newRun);
      state.runPollCounts[retryId] = 0;
      state.eventsByRun[retryId] = [
        {
          id: `evt-retry-${Date.now()}`,
          runId: retryId,
          level: 'info',
          message: `已从父任务 (${orig.id.slice(0, 8)}) 发起安全对账重试，已确认成功的步骤将自动跳过`,
          stepId: newRun.steps[0]?.id ?? null,
          createdAt: getNowIso()
        }
      ];

      const res = wrap(newRun);
      saveIdempotency(idem.key, 'retryRun', pathParams, 202, res);
      return { status: 202, data: res as SuccessEnvelope<T> };
    }

    case 'cancelRun': {
      requireAuth();
      requireCsrf(headers);
      const idem = requireIdempotency(headers, 'cancelRun', pathParams);
      if (idem.cached) {
        return { status: idem.cached.status, data: idem.cached.response as SuccessEnvelope<T> };
      }

      const run = state.runs.find((r) => r.id === pathParams.runId);
      if (!run) {
        throw new MockHttpError(404, {
          code: 'NOT_FOUND',
          message: '未找到指定执行记录',
          retryable: false
        });
      }
      if (!['queued', 'running', 'awaiting_verification'].includes(run.state)) {
        throw new MockHttpError(409, {
          code: 'RUN_STATE_CONFLICT',
          message: '该任务已进入终态，无法取消',
          retryable: false
        });
      }

      run.state = 'canceled';
      run.cancelRequestedAt = getNowIso();
      run.finishedAt = getNowIso();
      run.challengeId = null;
      run.steps = run.steps.map((s) =>
        ['pending', 'running', 'awaiting_verification'].includes(s.state)
          ? { ...s, state: 'canceled', message: '已按管理员请求停止后续步骤，已执行操作不会回滚', finishedAt: getNowIso() }
          : s
      );
      const acc = state.accounts.find((a) => a.id === run.accountId);
      if (acc && acc.activeRunId === run.id) {
        acc.activeRunId = null;
      }
      state.eventsByRun[run.id] = [
        ...(state.eventsByRun[run.id] ?? []),
        {
          id: `evt-cancel-${Date.now()}`,
          runId: run.id,
          level: 'warning',
          message: '管理员请求停止后续步骤；已完成的上游写入不会回滚',
          stepId: run.steps[0]?.id ?? null,
          createdAt: getNowIso()
        }
      ];

      const res = wrap(run);
      saveIdempotency(idem.key, 'cancelRun', pathParams, 202, res);
      return { status: 202, data: res as SuccessEnvelope<T> };
    }

    case 'getSystemSettings': {
      requireAuth();
      return { status: 200, data: wrap(state.systemSettings) as SuccessEnvelope<T> };
    }

    case 'updateSystemSettings': {
      requireAuth();
      requireCsrf(headers);
      const patch = input.body as SystemSettingsPatch;
      const keys = Object.keys(patch).filter((k) => patch[k as keyof SystemSettingsPatch] !== undefined);
      if (keys.length < 2) {
        throw new MockHttpError(400, {
          code: 'VALIDATION_ERROR',
          message: '除 version 外至少需要提供一个修改字段',
          retryable: false
        });
      }

      if (
        (state.preset === 'account-version-conflict' && !state.versionConflictTriggeredOnce) ||
        patch.version !== state.systemSettings.version
      ) {
        if (state.preset === 'account-version-conflict' && !state.versionConflictTriggeredOnce) {
          state.versionConflictTriggeredOnce = true;
          state.systemSettings.version += 1;
          state.systemSettings.logRetentionDays = 60;
        }
        throwFromScenario('account-version-conflict');
      }

      if (
        patch.logRetentionDays !== undefined &&
        (patch.logRetentionDays < 7 || patch.logRetentionDays > 365)
      ) {
        throw new MockHttpError(400, {
          code: 'VALIDATION_ERROR',
          message: '日志保留天数需在 7–365 天之间',
          retryable: false,
          details: {
            fieldErrors: [{ field: 'logRetentionDays', message: '允许范围：7 至 365 天' }]
          }
        });
      }

      state.systemSettings = {
        timezone: 'Asia/Shanghai',
        pauseScheduler:
          patch.pauseScheduler !== undefined ? patch.pauseScheduler : state.systemSettings.pauseScheduler,
        logRetentionDays:
          patch.logRetentionDays !== undefined ? patch.logRetentionDays : state.systemSettings.logRetentionDays,
        version: state.systemSettings.version + 1
      };

      // Update schedule nextRunAt according to pauseScheduler
      for (const acc of state.accounts) {
        const sched = state.schedulesByAccount[acc.id];
        if (sched) {
          sched.nextRunAt =
            !state.systemSettings.pauseScheduler && acc.enabled && sched.enabled
              ? `2026-10-23T${String((sched.hour - 8 + 24) % 24).padStart(2, '0')}:${String(sched.minute).padStart(2, '0')}:00Z`
              : null;
        }
      }

      return { status: 200, data: wrap(state.systemSettings) as SuccessEnvelope<T> };
    }

    case 'getNotificationSettings': {
      requireAuth();
      return { status: 200, data: wrap(state.notificationSettings) as SuccessEnvelope<T> };
    }

    case 'updateNotificationSettings': {
      requireAuth();
      requireCsrf(headers);
      const patch = input.body as NotificationSettingsPatch;
      const keys = Object.keys(patch).filter((k) => patch[k as keyof NotificationSettingsPatch] !== undefined);
      if (keys.length < 2) {
        throw new MockHttpError(400, {
          code: 'VALIDATION_ERROR',
          message: '除 version 外至少需要提供一个修改字段',
          retryable: false
        });
      }

      if (patch.smtpPassword && patch.clearPassword) {
        throw new MockHttpError(400, {
          code: 'VALIDATION_ERROR',
          message: '不能同时设置新 SMTP 密码与 clearPassword=true',
          retryable: false
        });
      }

      if (
        (state.preset === 'account-version-conflict' && !state.versionConflictTriggeredOnce) ||
        patch.version !== state.notificationSettings.version
      ) {
        if (state.preset === 'account-version-conflict' && !state.versionConflictTriggeredOnce) {
          state.versionConflictTriggeredOnce = true;
          state.notificationSettings.version += 1;
        }
        throwFromScenario('account-version-conflict');
      }

      let passwordConfigured = state.notificationSettings.smtpPasswordConfigured;
      if (patch.clearPassword === true) {
        passwordConfigured = false;
      } else if (typeof patch.smtpPassword === 'string' && patch.smtpPassword.length > 0) {
        passwordConfigured = true;
      }

      const nextSettings: NotificationSettings = {
        enabled: patch.enabled !== undefined ? patch.enabled : state.notificationSettings.enabled,
        policy: patch.policy !== undefined ? patch.policy : state.notificationSettings.policy,
        smtpHost: patch.smtpHost !== undefined ? patch.smtpHost : state.notificationSettings.smtpHost,
        smtpPort: patch.smtpPort !== undefined ? patch.smtpPort : state.notificationSettings.smtpPort,
        smtpSecurity:
          patch.smtpSecurity !== undefined ? patch.smtpSecurity : state.notificationSettings.smtpSecurity,
        smtpUsername:
          patch.smtpUsername !== undefined ? patch.smtpUsername : state.notificationSettings.smtpUsername,
        smtpPasswordConfigured: passwordConfigured,
        fromAddress:
          patch.fromAddress !== undefined ? patch.fromAddress : state.notificationSettings.fromAddress,
        toAddress: patch.toAddress !== undefined ? patch.toAddress : state.notificationSettings.toAddress,
        version: state.notificationSettings.version + 1
      };

      if (
        nextSettings.enabled &&
        (!nextSettings.smtpHost || !nextSettings.fromAddress || !nextSettings.toAddress || !nextSettings.smtpPasswordConfigured)
      ) {
        throw new MockHttpError(400, {
          code: 'VALIDATION_ERROR',
          message: '开启邮件通知时，必须完整配置 SMTP 主机、发件人、收件人及 SMTP 密码',
          retryable: false
        });
      }

      state.notificationSettings = nextSettings;
      return { status: 200, data: wrap(state.notificationSettings) as SuccessEnvelope<T> };
    }

    case 'createNotificationTest': {
      requireAuth();
      requireCsrf(headers);
      const idem = requireIdempotency(headers, 'createNotificationTest', null);
      if (idem.cached) {
        return { status: idem.cached.status, data: idem.cached.response as SuccessEnvelope<T> };
      }

      if (!state.notificationSettings.toAddress || !state.notificationSettings.smtpHost) {
        throw new MockHttpError(422, {
          code: 'NOTIFICATION_NOT_CONFIGURED',
          message: '尚未保存完整的 SMTP 与收件地址配置，请先保存后再发送测试邮件',
          retryable: false
        });
      }

      const queued = structuredClone(
        getScenarioResponse<NotificationTest>('notification-test-queued').data
      );
      queued.createdAt = getNowIso();
      queued.updatedAt = getNowIso();
      state.notificationTests[queued.id] = { ...queued, pollCount: 0 };

      const res = wrap(queued);
      saveIdempotency(idem.key, 'createNotificationTest', null, 202, res);
      return { status: 202, data: res as SuccessEnvelope<T> };
    }

    case 'getNotificationTest': {
      requireAuth();
      const t = state.notificationTests[pathParams.testId];
      if (!t) {
        return {
          status: 200,
          data: getScenarioResponse<NotificationTest>('notification-test-completed') as SuccessEnvelope<T>
        };
      }
      t.pollCount = (t.pollCount ?? 0) + 1;
      t.state = 'succeeded';
      t.updatedAt = getNowIso();
      const completed: NotificationTest = {
        id: t.id,
        state: t.state,
        error: t.error,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt
      };
      return { status: 200, data: wrap(completed) as SuccessEnvelope<T> };
    }

    default:
      throw new MockHttpError(500, {
        code: 'INTERNAL_ERROR',
        message: `未实现的模拟操作: ${input.operationId}`,
        retryable: false
      });
  }
}
