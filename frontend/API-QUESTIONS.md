# 前端接口契约核对与待确认事项 (API-QUESTIONS.md)

契约版本：`docs/openapi.json` `v0.1.0`  
记录日期：`2026-10-23`

前端已严格以 `docs/openapi.json` (`v0.1.0`) 为唯一契约来源完成全部 32 条路径、38 个操作的客户端接入与类型映射，未自行编造任何字段或路由。在对照 `docs/openapi.json`、`docs/mock-scenarios.json` 与 `docs/frontend-handoff.md` 的实现过程中，整理以下细节供前后端联调时最终对齐：

## 1. `Account.activeCredentialOperationId` 在终态后的清理时机

- **现象**：在 `docs/mock-scenarios.json` 的 `accounts-ready` 与 `credential-refresh-complete` 场景中，当 `CredentialOperation.state` 已经进入终态 `succeeded` 且 `account.status` 为 `active` 时，返回的 `Account` 快照中 `activeCredentialOperationId` 仍保留为 `"66666666-6666-4666-8666-666666666666"`（非 `null`）。
- **前端当前兼容处理**：前端在刷新页面恢复操作时，若检测到 `account.activeCredentialOperationId` 非空，会调用 `GET /credential-operations/{operationId}` 查询该操作状态；只有当其 `state` 处于非终态（`queued` / `running` / `awaiting_verification`）时才继续轮询或展示人工验证入口，若已处于 `succeeded` / `failed` / `canceled` 则不阻塞新操作。
- **后端联调答复（已对齐 `backend/INTEGRATION.md`）**：实际后端在读取 `Account` 时从持久化操作记录重新计算活动指针，仅 `queued`、`running`、`awaiting_verification` 返回该指针，终态（`succeeded`、`failed`、`canceled`）均返回 `null`。前端对终态操作的防御性判断继续保留。

## 2. `POST /login-flows/{flowId}/submit-code` 的 HTTP 状态码与同步完成分支

- **现象**：`docs/openapi.json` 中 `submitLoginCode` 仅定义了 `202` 响应（返回 `LoginFlowResponse`），而 `docs/frontend-handoff.md` 第 4、5 节提到“可能返回 `awaiting_captcha`、`exchanging` 或 `completed`”。
- **前端当前兼容处理**：前端不假设特定 2xx 状态码代表特定业务状态，无论是 `200` 还是 `202`，均统一读取响应体中的 `data.state` 与 `data.nextAction` 驱动界面流转。
- **后端联调答复（已对齐 `backend/INTEGRATION.md`）**：`POST /login-flows/{flowId}/submit-code` 在正常受理时统一返回 HTTP `202`（包含 `awaiting_captcha`、`exchanging`、`completed`），前端以 `data.state` 与 `nextAction` 驱动交互，完全一致。

## 3. 执行记录列表 (`GET /runs`) 的账号信息关联展示

- **现象**：`Run` schema 中仅包含 `accountId`（UUID），不包含冗余的 `nickname` 或 `phoneMasked`。
- **前端当前处理**：前端在执行记录页同时读取 `listAccounts` 并在内存中将 `run.accountId` 映射为对应账号的 `nickname (phoneMasked)`；若某历史记录对应的账号已被删除或不在当前分页中，则安全回退显示 `accountId` 摘要。
- **后端联调答复（已对齐 `backend/INTEGRATION.md`）**：沿用当前契约，无需新增字段。
