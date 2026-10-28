# Gemini 前端交接说明 v0.2.0

2026-10-26补充：[签到福利接入说明](game-checkin.md) 描述新增的游戏角色接口、任务偏好、游戏奖励与人工验证目的。首页、账号详情与执行记录已按项目所有者要求同步实现。后续前端修改须保留这套接入，不能仅显示米游币任务。

请先阅读本文件，再读取 [openapi.json](openapi.json) 和 [mock-scenarios.json](mock-scenarios.json)。后端首版现已实现，实际联调答复见 [backend/INTEGRATION.md](../backend/INTEGRATION.md)。早期临时验证页面不是正式接口。

## 1. 协作边界

- Gemini：前端页面、交互、API client、人工验证组件、模拟数据接入、前端测试。
- Codex：后端、上游适配、凭据加密、数据库、调度和服务部署。
- 共享：`docs/openapi.json` 是 HTTP 契约唯一来源；变更先修改契约并记录版本，不能在前端自行假定字段或路由。
- 不要求前端采用特定框架。建议使用 TypeScript，并从 OpenAPI 生成或对照维护类型；不要复制上游米哈游完整响应类型。
- 所有数据均经过本项目后端；前端只为官方人机验证加载官方 SDK，不直接发短信、请求签到或计算 DS。

## 2. 本地与部署入口

后端计划监听 `127.0.0.1:3000`，统一前缀 `/api/v1`。前端开发服务器自行选择端口，并把 `/api` 代理至后端。此端口是设计默认值，不表示服务当前已运行。

生产建议反向代理为同域：`/` 前端、`/api/v1` 后端。若分开域名，必须和后端配置完全一致的 Origin 白名单；跨站 Cookie 的可用性另行验证，不假定随意两个域名都能共享登录。

请求统一使用 `credentials: include`。管理员会话在 HttpOnly Cookie 中，前端不能读取，也不应手动拼 Cookie。CSRF token 来自管理员登录或 `GET /auth/session`，只存内存。修改接口带 `X-CSRF-Token`；业务 POST/DELETE 再带 `Idempotency-Key`。

## 3. 页面清单

| 页面 | 内容 | 主要 operationId |
| --- | --- | --- |
| 初始化 | 设置单个管理员；输入部署者的初始化 token；初始化完成转登录，不自动登录 | getSetupStatus、initializeAdmin |
| 面板登录 | 管理员用户名密码，与米游社短信登录明确区分 | loginAdmin、getAdminSession、logoutAdmin |
| 概览 | 账号数、需要处理的账号、当天已确认收益、活动任务 | getDashboard |
| 账号列表 | 脱敏手机号、昵称、备注、状态、启用开关、检查、更新工作 Cookie、重新登录、删除 | listAccounts、updateAccount、deleteAccount |
| 添加/重新登录账号 | 手机号、短信发送、验证码输入、人工验证、登录进度 | createLoginFlow、sendLoginSms、submitLoginCode、getLoginFlow、cancelLoginFlow |
| 账号详情 | 余额、任务、凭据检查时间、Cookie 保存期限、任务偏好、每日计划 | getAccount、getAccountMissions、refreshAccountMissions、getAccountSchedule、updateAccountSchedule |
| 执行记录与详情 | 筛选、步骤结果、收益、脱敏日志、重试、取消、人工验证入口 | listRuns、getRun、listRunEvents、retryRun、cancelRun |
| 设置 | 全局暂停调度、日志保留、SMTP 邮件通知及测试 | getSystemSettings、updateSystemSettings、getNotificationSettings、updateNotificationSettings、createNotificationTest、getNotificationTest |

无需公共注册、租户切换、计费或商品兑换页面。需要首页签到福利入口、角色选择、状态/奖励和每日计划。管理多个米游社账号属于同一管理员，不是多用户系统。

批量操作先由前端对用户选中的每个 accountId 分别调用接口，汇总每个结果；不能显示“全部成功”掩盖部分失败。批量人工验证依次展示；不同时弹出多个验证组件。

## 4. 请求与响应约定

具体 method/path/字段见 OpenAPI。以下是路径示例，不是直接访问官方账号接口。

| 目的 | 请求 |
| --- | --- |
| 创建米游社短信登录流程 | `POST /api/v1/login-flows`，body 为 phone、countryCode；重新登录附 targetAccountId |
| 发送短信 | `POST /api/v1/login-flows/{flowId}/send-sms`，无 body |
| 提交短信验证码 | `POST /api/v1/login-flows/{flowId}/submit-code`，body 为 code |
| 获取人工验证配置 | `GET /api/v1/challenges/{challengeId}` |
| 提交用户验证结果 | `POST /api/v1/challenges/{challengeId}/submit` |
| 用户主动更新验证会话 | `POST /api/v1/challenges/{challengeId}/renew` |
| 更新工作 Cookie | `POST /api/v1/accounts/{accountId}/credential-operations`，body 为 kind=refresh_cookie |
| 立即签到 | `POST /api/v1/accounts/{accountId}/runs`，body 为 communityIds、taskKinds |

成功响应统一是 `{ data, requestId }`，错误统一是 `{ error: { code, message, retryable, details? }, requestId }`。不要认为 200/202 就等于短信发送、账号登录或签到已经成功；必须读取资源的 state。

所有 UUID 均为后端生成的不透明 ID。业务 idempotency key 除外，由前端为一次用户意图生成。API list 返回 `{data:{items,page:{nextCursor,hasMore}},requestId}`，不能按数组直接解析。首次未知余额是 null，显示“尚未获取”，不显示 0。

账号、计划、系统设置、通知设置 PATCH 均带当前 version。409 VERSION_CONFLICT 时重新获取，展示冲突提示，让用户确认修改；不要自动覆盖最新值。

幂等规则：一次点击生成一个 key，网络超时重试复用该 key；修正验证码、重新验证或新的发送意图使用新 key。禁止全局固定 key，也不能在 HTTP client 每次重试时重新生成。Idempotency-Key 只表示本项目请求去重，不代表上游短信或签到天然幂等。

## 5. 添加账号完整流程

1. 用户输入手机号，发送 `createLoginFlow`，保存 flowId。新建流程本身不发短信。
2. 用户点击“获取验证码”，调用 `sendLoginSms`。
3. 返回 awaiting_captcha：获取 Challenge 并展示人工验证。此时不能提示短信已发送，也不要启动短信倒计时。
4. 返回 awaiting_sms_code：提示短信已发送，用 resendAfter 计算重发等待时间。该倒计时不是验证码官方有效期。
5. 将验证码作为字符串提交，保留前导零；关闭自动填充或日志记录中的敏感值输出。
6. 返回 exchanging：展示“正在获取登录凭据”，按 getLoginFlow 轮询；如再次 awaiting_captcha，继续统一验证流程。
7. 只有 completed 且 accountId 非空才提示绑定成功，刷新账号列表。新增账号后，提示用户选择任务并主动开启每日计划。
8. 重新登录必须创建带 targetAccountId 的流程。手机号可以重新输入；不能自行把新登录账号覆盖到旧 accountId。

| Flow.state | 展示与 nextAction |
| --- | --- |
| created | 等待用户发送短信，send_sms |
| awaiting_captcha | solve_challenge 或 renew_challenge；按 nextAction 判断，不能仅看 challengeId |
| awaiting_sms_code | 允许输入验证码，submit_code；重发受 resendAfter 限制 |
| exchanging | 轮询，poll |
| completed | 绑定成功，none |
| failed | 展示 lastError，restart |
| canceled | 已取消，none |
| expired | 已过期，restart；后端也可能直接返回410 FLOW_EXPIRED |

刷新浏览器后，如果当前管理员会话仍有效，可以凭保存在当前标签 sessionStorage 的 flowId 恢复；sessionStorage 不得保存手机号原文、验证码、Challenge 结果或令牌。进程重启或流程过期后重新开始。关闭弹层不自动取消已提交的登录操作；“取消登录”按钮明确调用 cancelLoginFlow。

## 6. 人工验证组件

做一个统一组件，供登录、凭据操作和任务执行复用。用户手动完成，不加入自动拖动、图片识别或打码服务。

Challenge 携带 ownerType、ownerId、purpose、version、expiresAt、config。使用后端提供的当前配置，不硬编码 captchaId、session_id 或 riskType；不在 URL 中传验证结果。官方脚本使用固定允许地址，不能执行后端返回的任意 HTML/script URL。

- `gt4`：加载官方极验 v4 SDK，使用 captchaId / riskType / userInfo 等配置；product=bind。组件 ready 后由用户点击开始，成功回调获取 getValidate()。
- `gt3`：仅当能力目录实际包含 gt3 时启用对应官方组件，将 config.captchaId 映射为 SDK 的 gt、config.newCaptcha 映射为 new_captcha，使用 config.challenge/offline；映射 SDK 结果为契约规定的字段。该分支属于契约预留，尚未实测。
- 提交 `{version:'gt4',result:{lot_number,captcha_output,pass_token,gen_time,captcha_id?}}` 或 gt3 对应结构；不要提交 raw x-rpc-aigis 或拼接上游请求头。
- 提交成功后根据 receipt.ownerType 重新获取 Flow、Run 或 CredentialOperation。receipt.accepted=true 只代表这次验证处理完成，不能直接关闭整个登录步骤并显示登录成功。
- 失败/过期时销毁旧组件，显示“更新验证会话”；用户点击 renew 后使用返回的新 challengeId。新会话使用新幂等 key，旧结果不能重复提交。
- 点击关闭只关闭验证组件，所有者仍等待；提供“继续验证”入口。不自动无限重开弹窗。
- SDK 加载错误、用户取消、上游拒绝、会话过期要有不同文案。用户取消不是“验证失败”，不自动扣除重试次数。

GT4 参考 [官方 Web API](https://docs.geetest.com/gt4/apirefer/api/web)。登录阶段已实测；签到阶段可能出现另一种验证，接口能力目录和 Challenge.version 是最终依据。

## 7. 凭据状态与倒计时

账号 enabled 与登录状态分别展示。暂停自动任务不等于账号已退出登录。

| 字段/操作 | 正确展示 |
| --- | --- |
| credential.lastCheckedAt | 最近检查时间；不是最后续期时间 |
| credential.cookieStorageExpiresAt | “Cookie 保存期限”；允许倒计时，但附说明“可能提前失效” |
| credential.rootExpiresAt=null | “根凭据有效期未知”，不计算虚假天数 |
| check | “检查登录状态” |
| refresh_cookie | “重新获取工作 Cookie” |
| rootCredentialRenewal=false | 不显示“永久续期”“保证不掉号”等按钮或宣传 |
| status=reauth_required | 展示重新登录入口，停止对该账号连续自动重试 |
| status=verification_required | 提供活动 CredentialOperation/Run 的人工验证入口 |

凭据操作返回202后，轮询 getCredentialOperation。awaiting_verification 时显示 Challenge；succeeded 后以返回 account 快照更新页面。刷新页面后，从 account.activeCredentialOperationId 或 activeRunId 恢复对应操作，再读取其 challengeId。失败提示不得打印原始官方登录响应。

## 8. 任务与执行界面

先请求 capabilities，社区与任务均按 executable、verification、blockedReason 渲染。未验证任务可显示“待适配”并禁用，不能伪装已实现。浏览、点赞、分享需要明确 opt-in；前端不默认勾选，也不因“获取全部米游币”自动开启。接口最终会再次校验能力和账号偏好。

GET missions 读取缓存，用户点击“刷新任务”才 POST refresh。展示 fetchedAt 与 stale。不能把缺少 mission_id=58 等同“已经签到”，也不能把上游 can_get_points 直接解释成所有任务奖励总和。

签到返回 Run 后展示步骤。终态前不要提前把奖励加入概览；米游币只显示 confirmedRewardPoints，游戏奖励显示各步骤 rewards 数组。already_completed 标记“今日已完成”，本次不重复计收益。1008 和游戏签到的-5003都不是通用成功码，由后端对账得出状态。

| Run.state | 用户文案 |
| --- | --- |
| queued | 排队中 |
| running | 执行中 |
| awaiting_verification | 等待你完成验证 |
| succeeded | 已确认完成 |
| partially_succeeded | 部分完成，查看失败步骤 |
| failed | 执行失败 |
| outcome_unknown | 结果待核对，不自动重复执行 |
| canceled | 已停止后续步骤，已执行操作不会回滚 |

运行中每2秒轮询，超过30秒改5秒；终态停止，页面隐藏暂停。日志可重新读取第一页并按 event.id 去重，不用把分页 cursor 当作 SSE 游标。离开页面不取消后台任务。

每日计划使用时/分选择器，默认关闭、时区固定上海；展示0–10分钟错峰窗口。全局暂停、账号停用时实际 nextRunAt=null，保留原计划设置。不要要求普通用户输入 cron。

## 9. 错误处理

| HTTP / error.code | UI 行为 |
| --- | --- |
| 400 VALIDATION_ERROR | 显示字段错误；不得弹出原始异常栈 |
| 401 UNAUTHENTICATED | 清除内存认证状态，转面板登录；不是让所有米游社账号重新登录 |
| 401 AUTH_INVALID | 管理员凭据错误，保留登录页 |
| 403 CSRF_INVALID | 重新读取管理员 session；不要盲目重放写请求 |
| 403 SETUP_TOKEN_INVALID / FORBIDDEN | 显示权限或初始化 token 错误 |
| 409 SETUP_REQUIRED / ALREADY_INITIALIZED | 导向正确的初始化或登录页面 |
| 409 VERSION_CONFLICT | 刷新资源，用户确认后重新提交 |
| 409 ACCOUNT_EXISTS / ACCOUNT_IDENTITY_MISMATCH | 分别提示已绑定或与重新登录目标不一致 |
| 409 ACCOUNT_BUSY / RUN_STATE_CONFLICT / FLOW_STATE_CONFLICT | 刷新资源，提示当前不允许操作 |
| 409 ACCOUNT_REAUTH_REQUIRED | 提供账号重新登录入口；可先由用户尝试工作 Cookie 更新 |
| 410 FLOW_EXPIRED / CHALLENGE_EXPIRED | 丢弃旧流程/验证结果，重新开始或更新会话 |
| 422 SMS_CODE_INVALID / CHALLENGE_FAILED | 允许用户修正或更新验证会话，使用新幂等 key |
| 422 CAPABILITY_UNAVAILABLE / CHALLENGE_UNSUPPORTED | 说明暂不支持，不自动降级或跳过验证 |
| 429 RATE_LIMITED | 按 Retry-After 和 details 等待，不循环请求 |
| 502 UPSTREAM_OUTCOME_UNKNOWN | 提示“结果待确认”，先刷新业务状态，不能自动重发短信或签到 |
| 502 UPSTREAM_ERROR / 504 UPSTREAM_TIMEOUT | 展示安全摘要与 requestId；仅适合安全读请求的重试由 client 策略决定 |
| 500 INTERNAL_ERROR / 503 服务不可用 | 保留操作上下文，提示稍后重试，提供 requestId 便于排查 |

message 可直接作为纯文本反馈，但不要按文案判断业务分支；以 code / state 为准。未知错误码提供通用提示，不导致页面崩溃。

## 10. 通知设置与删除

SMTP 密码是只写字段。GET 只返回 smtpPasswordConfigured；不能把“******”回填提交成新密码。用户不修改时省略 smtpPassword；清除密码需 clearPassword=true。测试邮件发给已保存的收件地址，保存成功后才能测试，轮询测试结果再提示成功。

删除账号显示明确确认框：“仅删除本实例中的账号、凭据和计划，不删除米哈游账号”。后端可能因活动任务拒绝，前端须处理409。取消任务文案说明不回滚已经完成的签到。

## 11. 模拟开发与交付要求

`mock-scenarios.json` 是自动化测试使用的静态场景集，不是面板运行模式或现成服务。测试通过拦截HTTP请求按operationId绑定虚构响应；面板开发与部署均直接连接后端。不同场景可以复用 ID，但彼此独立，不应盲目拼接为真实会话。

2026-10-26按项目所有者要求移除应用的模拟模式、模式切换、场景控件与验证演练台。面板始终连接后端；虚构响应、固定时钟和验证码SDK替代仅留在自动化测试目录，不进入应用入口或生产包。旧的模式链接、环境变量和浏览器设置不再生效。

至少覆盖空列表、正常登录、人工验证、验证码错误、流程过期、凭据失效、未适配能力、任务成功、重复已完成、部分失败、未知结果、管理员会话失效和版本冲突。现有场景可扩展，但要通过契约校验。

前端交付应包含：页面实现、集中 API client、类型与状态映射、用户手动验证组件、基础交互测试、环境变量示例（无秘密）。直接使用真实后端联调，不再提供运行模式开关。不要把真实手机号、验证码、Cookie、SMTP 密码放进仓库。

优先开发顺序：页面壳与管理员登录 → 账号与短信流程 → 人工验证 → 账号详情/计划 → 执行记录 → 设置/通知。后端尚未完成时，真实请求失败应显示连接状态，不要自动退回模拟成功。
