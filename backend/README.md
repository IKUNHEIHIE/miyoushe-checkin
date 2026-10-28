# 米游社后端

TypeScript / Fastify 5，使用 Node.js 自带的 SQLite、Argon2id 和 AES-256-GCM。正式支持 Node.js 24.12 及更新的24.x版本；开发机也可使用更新的 Node.js。单进程、单本地数据库，不能横向启动多个实例访问同一文件。

已按共享 [OpenAPI](../docs/openapi.json) v0.2.0 实现40个操作。支持短信登录、社区任务查询、原神社区签到和游戏签到福利。原神、星穹铁道、绝区零的游戏签到已完成单账号真实写入与状态复核；其他游戏、渠道与GT3验证的实测限制见 [签到福利接入说明](../docs/game-checkin.md)。浏览/点赞/分享/独立领奖仍禁用。

## 本地启动

在 backend 目录执行：

```powershell
npm ci
Copy-Item .env.example .env
node -e "const c=require('node:crypto'); console.log('DATA_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'));console.log('BOOTSTRAP_TOKEN='+c.randomBytes(32).toString('base64url'))"
```

将生成的两个值分别填入本机 `.env`，不要提交或发送给前端开发者。填写允许访问的前端 Origin，例如 `http://localhost:5173`；这必须与浏览器实际地址一致。通过前端代理访问后端时，也要允许该前端页面的 Origin。

```powershell
npm run dev
```

默认后端地址 `http://127.0.0.1:3000/api/v1`，健康检查为 `/health`。服务不会自动发送验证码或执行手动签到；新账号每日计划默认关闭。已启用的计划在后台到时执行。

首次打开前端，使用 `.env` 中 BOOTSTRAP_TOKEN 初始化管理员。初始化成功不自动登录。管理员登录后由浏览器保存 HttpOnly Cookie，前端从响应获取CSRF token。真实米游社登录需要用户自行输入手机号、短信验证码并手动完成人机验证，不自动解题。

## 构建与验证

```powershell
npm run types:generate
npm run typecheck
npm test
npm run build
npm start
```

接口类型从共享契约生成，生成文件位于 `src/api-types.d.ts`。不要手改它替代修改契约。测试使用虚构账号和模拟上游，不发送真实短信、签到或邮件。真实上游适配器的请求格式来自之前实测，服务实现仍需与正式前端和真实账号联调。

## Gemini 联调

- 不需要向 Gemini 提供 DATA_ENCRYPTION_KEY、BOOTSTRAP_TOKEN 或数据库文件。
- 前端 `/api` 开发代理指向 `http://127.0.0.1:3000`；统一请求前缀 `/api/v1`。
- 所有写请求提供允许的 Origin；已登录的写请求另带 `X-CSRF-Token`。业务POST/DELETE按契约带 UUID 格式的 `Idempotency-Key`。
- 无请求体动作可以不发送body，也可以发送空对象；不接受额外字段。
- 新登录流程、验证码和Challenge仅存在内存，重启后原流程失效。任务、计划和已完成账号持久化保存。
- renew会重新创建本地验证组件会话，但不会偷偷发送新短信，也不会延长原上游验证窗口。过期时返回410，重新开始登录或原操作。
- `check`只检查健康状态；`refresh_cookie`仅获取工作Cookie，根凭据到期仍需重新登录。
- 请求日志默认关闭。前端不应在控制台打印验证码、SDK验证结果或账号凭据。

## Docker部署

先在 `.env` 设置两个独立高熵值和实际HTTPS前端Origin，然后在 backend 目录执行：

```powershell
docker compose up -d --build
```

Compose仅把端口暴露到服务器127.0.0.1，需用HTTPS反向代理提供前端和 `/api/v1`。容器内使用Secure Cookie，不能直接用HTTP公网地址测试登录。数据库保存在命名持久卷，容器以非root用户运行。

项目不自动发布公网域名、不部署到任何云平台、不创建外部邮件账号。Docker构建上下文只包含后端源码与接口契约，不包含前端、`.env`或数据库。

## 备份与恢复

构建完成后，在backend目录执行：

```powershell
npm run backup -- ./backups/backup-2026-10-23.sqlite
```

目标必须是新文件，不能覆盖活动数据库。该命令以只读连接调用SQLite在线备份API，可在后端运行时执行。备份包含加密凭据，但加密密钥不在备份中；在独立安全位置保存密钥。

恢复步骤：停止后端；保留当前数据副本；把备份恢复为 DATABASE_PATH 指定文件；使用匹配的 DATA_ENCRYPTION_KEY；再启动服务。不能把不同实例的密文拼接到一起。错误密钥会拒绝启动，不会清空数据。

不要把 SQLite 数据放到 NFS/SMB，不要仅复制运行中的主数据库而忽略WAL。若实例因进程崩溃遗留 `.lock` 文件，启动时只在确认旧进程不存在后回收；不要在另一实例运行时手动删除锁。

## 限制

- 根凭据长期续期尚未验证，不保证永不掉号。Cookie保存期限与服务器实际有效期不同。
- 缺少真实第二账号与服务器验证条件，虚构A/B隔离测试不替代真实联调。
- 结果未知的签到不会自动重放；可先检查任务状态，再重试对账。
- 未知或已确认但无法从上游复核的记录会保持结果待核对，不将1008一律判为成功。
- 采用SQLite表和版本化JSON业务记录；不包含公共注册、多租户或商品兑换。
