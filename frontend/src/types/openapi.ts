// Strictly mapped from docs/openapi.json v0.2.0
// Single source of truth for HTTP contract types and state mappings.

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'CSRF_INVALID'
  | 'SETUP_REQUIRED'
  | 'SETUP_TOKEN_INVALID'
  | 'ALREADY_INITIALIZED'
  | 'AUTH_INVALID'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ACCOUNT_EXISTS'
  | 'ACCOUNT_IDENTITY_MISMATCH'
  | 'ACCOUNT_BUSY'
  | 'ACCOUNT_DISABLED'
  | 'ACCOUNT_REAUTH_REQUIRED'
  | 'FLOW_EXPIRED'
  | 'FLOW_STATE_CONFLICT'
  | 'SMS_CODE_INVALID'
  | 'CHALLENGE_REQUIRED'
  | 'CHALLENGE_FAILED'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_UNSUPPORTED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'RUN_STATE_CONFLICT'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_OUTCOME_UNKNOWN'
  | 'NOTIFICATION_NOT_CONFIGURED'
  | 'INTERNAL_ERROR';

export interface FieldError {
  field: string;
  message: string;
}

export interface ErrorDetails {
  fieldErrors?: FieldError[];
  retryAfterSeconds?: number;
  upstreamRetcode?: number;
}

export interface ApiErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: ErrorDetails;
}

export interface ErrorEnvelope {
  error: ApiErrorPayload;
  requestId: string;
}

export interface SuccessEnvelope<T> {
  data: T;
  requestId: string;
}

export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface Health {
  status: 'ok' | 'degraded';
  version: string;
  database: 'ok' | 'unavailable';
  serverTime: string;
}

export interface SetupStatus {
  initialized: boolean;
  contractVersion: string;
}

export interface SetupRequest {
  username: string;
  password: string;
}

export interface Admin {
  id: string;
  username: string;
}

export interface Session {
  admin: Admin;
  expiresAt: string;
  csrfToken: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface Ack {
  accepted: boolean;
}

export type CredentialStatus =
  | 'unknown'
  | 'valid'
  | 'reauth_required'
  | 'verification_required';

export interface Credential {
  status: CredentialStatus;
  lastCheckedAt: string | null;
  lastCookieIssuedAt: string | null;
  cookieStorageExpiresAt: string | null;
  rootExpiresAt: string | null;
  expirySource: 'cookie_max_age' | 'unknown';
}

export type TaskKind =
  | 'game_sign'
  | 'community_sign'
  | 'claim_rewards'
  | 'browse_posts'
  | 'like_posts'
  | 'share_posts';

export type AccountStatus =
  | 'unknown'
  | 'active'
  | 'reauth_required'
  | 'verification_required';

export interface Account {
  gameRoleIds?: string[];
  id: string;
  uid: string;
  nickname: string;
  phoneMasked: string;
  remark: string;
  enabled: boolean;
  status: AccountStatus;
  communityIds: number[];
  taskKinds: TaskKind[];
  autoRefresh: boolean;
  credential: Credential;
  version: number;
  createdAt: string;
  updatedAt: string;
  activeCredentialOperationId: string | null;
  activeRunId: string | null;
}

export interface AccountPatch {
  gameRoleIds?: string[];
  version: number;
  remark?: string;
  enabled?: boolean;
  communityIds?: number[];
  taskKinds?: TaskKind[];
  autoRefresh?: boolean;
}

export interface AccountPage {
  items: Account[];
  page: PageInfo;
}

export interface GameReward { name: string; count: number; icon: string | null }
export interface GameRole {
  id: string; gameBiz: string; gameName: string; uid: string; region: string; regionName: string;
  nickname: string; level: number; communityId: number | null; executable: boolean; blockedReason: string | null;
  status: 'unknown' | 'not_signed' | 'signed' | 'unavailable'; totalSignDays: number | null;
  reward: GameReward | null; lastCheckedAt: string | null;
}
export interface GameRolesSnapshot { accountId: string; fetchedAt: string | null; stale: boolean; roles: GameRole[] }

export type CapabilityVerification = 'verified' | 'unverified' | 'unsupported';
export type RewardMode = 'automatic' | 'claim_required' | 'none' | 'unknown';

export interface TaskCapability {
  kind: TaskKind;
  label: string;
  executable: boolean;
  verification: CapabilityVerification;
  blockedReason: string | null;
  rewardMode: RewardMode;
  requiresExplicitOptIn: boolean;
}

export interface Community {
  id: number;
  name: string;
  executable: boolean;
  verification: CapabilityVerification;
  blockedReason: string | null;
}

export type CaptchaVersion = 'gt3' | 'gt4';

export interface Capabilities {
  games?: { gameBiz: string; name: string; communityId: number; executable: boolean }[];
  contractVersion: string;
  rootCredentialRenewal: boolean;
  captchaVersions: CaptchaVersion[];
  communities: Community[];
  tasks: TaskCapability[];
}

export type FlowState =
  | 'created'
  | 'awaiting_captcha'
  | 'awaiting_sms_code'
  | 'exchanging'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'expired';

export type FlowNextAction =
  | 'send_sms'
  | 'solve_challenge'
  | 'renew_challenge'
  | 'submit_code'
  | 'poll'
  | 'restart'
  | 'none';

export interface LoginFlow {
  id: string;
  state: FlowState;
  phoneMasked: string;
  targetAccountId: string | null;
  accountId: string | null;
  expiresAt: string;
  resendAfter: string | null;
  nextAction: FlowNextAction;
  challengeId: string | null;
  lastError: ApiErrorPayload | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFlowRequest {
  phone: string;
  countryCode: '+86';
  targetAccountId?: string;
}

export interface SubmitCodeRequest {
  code: string;
}

export interface CaptchaConfig {
  captchaId: string;
  challenge: string | null;
  newCaptcha: boolean | null;
  offline: boolean;
  product: 'bind';
  language: 'zho';
  riskType: string | null;
  userInfo: string | null;
}

export type ChallengeOwnerType = 'login_flow' | 'run' | 'credential_operation';
export type ChallengePurpose =
  | 'game_sign'
  | 'send_sms'
  | 'login'
  | 'credential_refresh'
  | 'community_sign'
  | 'claim_rewards'
  | 'browse_posts'
  | 'like_posts'
  | 'share_posts';

export type ChallengeState = 'pending' | 'accepted' | 'failed' | 'expired';

export interface Challenge {
  id: string;
  ownerType: ChallengeOwnerType;
  ownerId: string;
  purpose: ChallengePurpose;
  provider: 'geetest';
  version: CaptchaVersion;
  state: ChallengeState;
  expiresAt: string;
  config: CaptchaConfig;
}

export interface Gt4Result {
  lot_number: string;
  captcha_output: string;
  pass_token: string;
  gen_time: string;
  captcha_id?: string;
}

export interface Gt3Result {
  geetest_challenge: string;
  geetest_validate: string;
  geetest_seccode: string;
}

export type ChallengeSubmission =
  | {
      version: 'gt4';
      result: Gt4Result;
    }
  | {
      version: 'gt3';
      result: Gt3Result;
    };

export interface ChallengeReceipt {
  challengeId: string;
  accepted: boolean;
  ownerType: ChallengeOwnerType;
  ownerId: string;
  nextAction: 'poll_owner';
  message: string;
}

export type CredentialOperationKind = 'check' | 'refresh_cookie';
export type CredentialOperationState =
  | 'queued'
  | 'running'
  | 'awaiting_verification'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface CredentialOperation {
  id: string;
  accountId: string;
  kind: CredentialOperationKind;
  state: CredentialOperationState;
  challengeId: string | null;
  account: Account;
  error: ApiErrorPayload | null;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialOperationRequest {
  kind: CredentialOperationKind;
}

export interface Mission {
  id: string;
  upstreamMissionId: number | null;
  key: string;
  label: string;
  kind: TaskKind | 'other';
  communityId: number | null;
  progress: number;
  target: number | null;
  completed: boolean;
  rewardClaimed: boolean;
  rewardPoints: number | null;
  executable: boolean;
  blockedReason: string | null;
  rewardMode: RewardMode;
}

export interface MissionSnapshot {
  accountId: string;
  businessDate: string;
  fetchedAt: string | null;
  stale: boolean;
  totalPoints: number | null;
  todayReceivedPoints: number | null;
  upstreamCanGetPoints: number | null;
  missions: Mission[];
  warnings: string[];
}

export interface Schedule {
  accountId: string;
  enabled: boolean;
  hour: number;
  minute: number;
  timezone: 'Asia/Shanghai';
  jitterMaxMinutes: 10;
  nextRunAt: string | null;
  version: number;
}

export interface SchedulePatch {
  version: number;
  enabled?: boolean;
  hour?: number;
  minute?: number;
  timezone?: 'Asia/Shanghai';
}

export type RunState =
  | 'queued'
  | 'running'
  | 'awaiting_verification'
  | 'succeeded'
  | 'partially_succeeded'
  | 'failed'
  | 'outcome_unknown'
  | 'canceled';

export type StepState =
  | 'pending'
  | 'running'
  | 'awaiting_verification'
  | 'succeeded'
  | 'already_completed'
  | 'failed'
  | 'outcome_unknown'
  | 'skipped'
  | 'canceled';

export interface RunStep {
  gameRoleId?: string;
  roleLabel?: string;
  gameName?: string;
  rewards?: GameReward[];
  id: string;
  communityId: number;
  taskKind: TaskKind;
  state: StepState;
  message: string;
  rewardPoints: number | null;
  upstreamRetcode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface Run {
  gameRoleIds?: string[];
  id: string;
  accountId: string;
  source: 'manual' | 'scheduled' | 'retry';
  parentRunId: string | null;
  businessDate: string;
  state: RunState;
  communityIds: number[];
  taskKinds: TaskKind[];
  challengeId: string | null;
  steps: RunStep[];
  confirmedRewardPoints: number;
  cancelRequestedAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: ApiErrorPayload | null;
}

export interface RunRequest {
  gameRoleIds?: string[];
  communityIds: number[];
  taskKinds: TaskKind[];
}

export interface RunPage {
  items: Run[];
  page: PageInfo;
}

export interface RunEvent {
  id: string;
  runId: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  stepId: string | null;
  createdAt: string;
}

export interface RunEventPage {
  items: RunEvent[];
  page: PageInfo;
}

export interface SystemSettings {
  timezone: 'Asia/Shanghai';
  pauseScheduler: boolean;
  logRetentionDays: number;
  version: number;
}

export interface SystemSettingsPatch {
  version: number;
  pauseScheduler?: boolean;
  logRetentionDays?: number;
}

export type NotificationPolicy = 'failures_and_actions' | 'every_run';
export type SmtpSecurity = 'ssl' | 'starttls';

export interface NotificationSettings {
  enabled: boolean;
  policy: NotificationPolicy;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  smtpUsername: string;
  smtpPasswordConfigured: boolean;
  fromAddress: string;
  toAddress: string;
  version: number;
}

export interface NotificationSettingsPatch {
  version: number;
  enabled?: boolean;
  policy?: NotificationPolicy;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecurity?: SmtpSecurity;
  smtpUsername?: string;
  smtpPassword?: string | null;
  clearPassword?: boolean;
  fromAddress?: string;
  toAddress?: string;
}

export type NotificationTestState = 'queued' | 'sending' | 'succeeded' | 'failed';

export interface NotificationTest {
  id: string;
  state: NotificationTestState;
  error: ApiErrorPayload | null;
  createdAt: string;
  updatedAt: string;
}

export interface Dashboard {
  businessDate: string;
  accountCount: number;
  activeAccountCount: number;
  actionRequiredCount: number;
  todaySucceededRuns: number;
  todayFailedRuns: number;
  todayConfirmedRewardPoints: number;
  activeRuns: Run[];
}

// UI copy and status mappings strictly aligned with docs/frontend-handoff.md
export const RUN_STATE_LABELS: Record<RunState, string> = {
  queued: '排队中',
  running: '执行中',
  awaiting_verification: '等待你完成验证',
  succeeded: '已确认完成',
  partially_succeeded: '部分完成，查看失败步骤',
  failed: '执行失败',
  outcome_unknown: '结果待核对，不自动重复执行',
  canceled: '已停止后续步骤，已执行操作不会回滚'
};

export const STEP_STATE_LABELS: Record<StepState, string> = {
  pending: '等待执行',
  running: '执行中',
  awaiting_verification: '等待人工验证',
  succeeded: '已确认完成',
  already_completed: '今日已完成',
  failed: '执行失败',
  outcome_unknown: '结果待核对',
  skipped: '已跳过',
  canceled: '已取消'
};

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  active: '登录有效',
  reauth_required: '需要重新登录',
  verification_required: '等待人工验证',
  unknown: '状态待检查'
};

export const CREDENTIAL_STATUS_LABELS: Record<CredentialStatus, string> = {
  valid: '工作凭据有效',
  reauth_required: '根凭据失效（需重新登录）',
  verification_required: '等待完成人工验证',
  unknown: '尚未检查'
};

export const FLOW_STATE_LABELS: Record<FlowState, string> = {
  created: '等待发送短信验证码',
  awaiting_captcha: '需要手动完成人机验证',
  awaiting_sms_code: '短信已发送，请输入验证码',
  exchanging: '正在获取登录凭据',
  completed: '账号绑定成功',
  failed: '登录失败，请重新开始',
  canceled: '登录流程已取消',
  expired: '登录流程已过期，请重新开始'
};

export const CHALLENGE_PURPOSE_LABELS: Record<ChallengePurpose, string> = {
  game_sign: '签到福利验证',
  send_sms: '发送短信验证码验证',
  login: '米游社登录验证',
  credential_refresh: '工作凭据更新验证',
  community_sign: '社区签到验证',
  claim_rewards: '领取奖励验证',
  browse_posts: '浏览帖子验证',
  like_posts: '点赞帖子验证',
  share_posts: '分享任务验证'
};

export const CHALLENGE_OWNER_LABELS: Record<ChallengeOwnerType, string> = {
  login_flow: '短信登录流程',
  credential_operation: '凭据检查/更新操作',
  run: '社区任务执行'
};

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  game_sign: '签到福利（游戏奖励）',
  community_sign: '社区签到',
  claim_rewards: '独立领取奖励',
  browse_posts: '浏览帖子',
  like_posts: '点赞帖子',
  share_posts: '分享任务'
};

export const COMMUNITY_NAME_FALLBACK: Record<number, string> = {
  1: '崩坏3',
  3: '崩坏学园2',
  4: '未定事件簿',
  8: '绝区零',
  2: '原神',
  6: '崩坏：星穹铁道'
};
