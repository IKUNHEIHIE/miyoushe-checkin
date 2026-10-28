# 米游社自托管签到面板

[![Release](https://img.shields.io/github/v/release/IKUNHEIHIE/miyoushe-checkin)](https://github.com/IKUNHEIHIE/miyoushe-checkin/releases)
[![License](https://img.shields.io/github/license/IKUNHEIHIE/miyoushe-checkin)](LICENSE)
[![Build](https://img.shields.io/github/actions/workflow/status/IKUNHEIHIE/miyoushe-checkin/release.yml?label=build)](https://github.com/IKUNHEIHIE/miyoushe-checkin/actions/workflows/release.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D24.12-339933)](https://nodejs.org/)

开源、自托管的米游社多账号管理面板：在你自己的服务器上管理多个已授权账号，完成社区签到（米游币）与游戏签到福利，并查看运行记录与奖励。

每个部署者运行自己的实例，不提供公共注册、账号托管或代挂服务。当前版本 **v0.2.0**（契约 `0.2.0`）。

> [!WARNING]
> 本项目调用米哈游的**非官方接口**，接口可能随时变动，使用自动化签到存在触发风控或违反用户协议的风险。请只使用你本人有权操作的账号，并自行评估后果。项目不保证签到成功、不保证账号安全、不提供任何形式的担保。

> [!NOTE]
> 该项目与米哈游（miHoYo）无关联，未获其授权或背书；米游社等名称与商标归权利人所有。

## 功能

- **多账号管理**：每个账号拥有独立的设备上下文、Cookie 容器与加密凭据，账号之间不共享登录态。
- **短信登录**：使用全新设备标识，不依赖 App 旧 Cookie 或设备 FP；人机验证由用户本人手动完成，不集成自动打码。
- **社区签到**：查询米游币任务、执行签到、核对到账与重复签到。
- **游戏签到福利**：按绑定角色逐个签到，展示游戏奖励与签到天数。
- **每日调度**：每账号独立时间、固定 Asia/Shanghai 时区、0–10 分钟错峰、全局暂停。
- **安全设计**：AES-256-GCM 加密凭据、Argon2id 管理员密码、CSRF 与 Origin 校验、持久化限流、手机号脱敏。
- **可观测**：运行记录、步骤明细、脱敏日志、SMTP 通知与 SQLite 一致性备份。

## 快速开始

### 方式一：Linux 预编译安装（推荐）

Release 提供 Linux x64 / arm64 安装包，自带 Node 运行时，无需 Docker 或本机编译。需要 root、systemd、curl、tar 与 sha256sum。下面的命令以 v0.2.0 为例，可在 [Releases](https://github.com/IKUNHEIHIE/miyoushe-checkin/releases) 页替换为最新版本。

```bash
curl -fL -o install.sh https://github.com/IKUNHEIHIE/miyoushe-checkin/releases/download/v0.2.0/install.sh
sudo bash install.sh
```

脚本安装到 `/opt/miyoushe-checkin`，创建 `miyoushe` 系统用户，并注册两个 systemd 服务：后端（`127.0.0.1:3000`）与本机静态网关（`127.0.0.1:8080`）。可通过 `MIYOUSHE_VERSION` 指定其他版本。

服务默认只监听服务器本机，从自己的电脑建立 SSH 隧道后访问：

```bash
ssh -L 8080:127.0.0.1:8080 用户名@服务器
```

然后打开 `http://127.0.0.1:8080`。首次初始化令牌保存在 `/opt/miyoushe-checkin/.env` 的 `BOOTSTRAP_TOKEN`，请与数据库 `/opt/miyoushe-checkin/data/` 一起安全备份。默认 HTTP 配置仅适用于本机或 SSH 隧道；公网访问必须另行配置 HTTPS、Secure Cookie（`COOKIE_SECURE=true`）和允许的 Origin。

### 方式二：Docker

仅后端提供镜像，前端需自行构建静态文件并反向代理到同一站点（见 [前端说明](frontend/README.md)）。

```bash
cd backend
# 在 backend/.env 中设置 DATA_ENCRYPTION_KEY、BOOTSTRAP_TOKEN、ALLOWED_ORIGINS
docker compose up -d --build
```

Compose 将端口暴露到 `127.0.0.1:3000`，数据保存在命名卷。容器内使用 Secure Cookie，不能直接用 HTTP 公网地址登录，详见 [后端部署说明](backend/README.md)。

### 方式三：源码本地开发

需要 Node.js 24.12 或更新的 24.x。

```bash
cd backend
npm ci
cp .env.example .env
# 生成两个独立密钥并写入 backend/.env
node -e "const c=require('node:crypto'); console.log('DATA_ENCRYPTION_KEY='+c.randomBytes(32).toString('base64'));console.log('BOOTSTRAP_TOKEN='+c.randomBytes(32).toString('base64url'))"
npm run dev
```

`.env.example` 已包含本地开发所需的 `ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173`，只需填入生成的两个密钥。

另开终端启动前端：

```bash
cd frontend
npm ci
npm run dev
```

打开 `http://127.0.0.1:5173`，首次使用 `.env` 中的 `BOOTSTRAP_TOKEN` 初始化管理员。前端通过 Vite 代理把 `/api` 转发到 `http://127.0.0.1:3000`。

## 已实现与验证范围

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 短信登录、工作 Cookie 换取 | ✅ 已实测 | 全新设备、单账号 |
| 登录人机验证（极验 v4） | ✅ 已实测 | 用户手动完成，接口兼容 v3 结果 |
| 原神社区签到与到账复核 | ✅ 已实测 | 含重复签到结果核对 |
| 原神、星穹铁道、绝区零游戏签到 | ✅ 已实测 | 单账号、逐角色、官方状态复核 |
| 崩坏3、崩坏学园2、未定事件簿 | 🟡 已配置未实测 | 适配器存在，缺少真实角色验证 |
| 其他社区与任务（浏览/点赞/分享/独立领奖） | ❌ 未开放 | 验证前不对外宣称可用 |
| 根凭据长期自动续期 | ❌ 不承诺 | 失效后需重新登录 |
| 真实多账号隔离 | 🟡 仅虚构测试 | 缺真实第二账号验收 |
| 服务器长期每日运行 | 🟡 未验证 | 本地通过不等于服务器通过 |

完整的验收条件与未完成项见 [验收清单](docs/acceptance.md)。

## 隐私与安全

- 账号凭据只保存在你自己的实例中，不经过任何第三方服务器；项目无遥测、无公共注册。
- 凭据使用 AES-256-GCM 加密，附加数据绑定实例、账号与用途，防止跨账号误用；`DATA_ENCRYPTION_KEY` 不写入数据库，也**不包含在备份文件里**，必须单独保存。
- 真实手机号加密存储，界面只显示脱敏号码；短信验证码与人工验证结果不落库、不写日志。
- 面板会话只保存 Cookie 令牌的哈希，CSRF token 由会话派生，Cookie 为 HttpOnly。
- 写请求结果无法确认时不会自动重放，会标记为「结果待核对」，避免重复签到。

## 已知限制

- 依赖非官方接口，接口签名、参数与风控策略可能变化；`-5300` 等错误不视为普通网络故障重试。
- 单进程、单 SQLite 文件部署，不支持多个实例共用同一数据库；数据库不要放在 NFS/SMB。
- Cookie 保存期限只是接收时的 `Max-Age`，不等于官方服务器的实际有效期。
- 公网部署需要自行准备 HTTPS、反向代理、Secure Cookie 与允许的 Origin 列表。

## 升级、备份与卸载

- **备份**：构建后在 `backend/` 执行 `npm run backup -- ./backups/backup-日期.sqlite`，以只读连接调用 SQLite 在线备份 API，可在服务运行时执行。
- **升级**：`install.sh` 检测到安装目录已存在时会停止，不支持原地覆盖。请先停止服务并备份 `data/` 与 `.env`，移走旧目录后重新安装，再放回旧数据库与**与之匹配的** `.env`；密钥不匹配会拒绝启动，不会清空数据。
- **卸载**：停止并禁用 `miyoushe-backend.service`、`miyoushe-web.service`，删除 `/etc/systemd/system/` 中对应 unit 后执行 `systemctl daemon-reload`，确认已备份再删除 `/opt/miyoushe-checkin`。

## 文档

| 文档 | 用途 |
| --- | --- |
| [接口验证记录](接口验证记录.md) | 官方接口的实测证据与限制 |
| [后端设计](docs/backend-design.md) | 架构、数据模型、账号隔离、凭据管理、调度与部署 |
| [OpenAPI 契约](docs/openapi.json) | 本项目 `/api/v1` 接口、字段、状态与错误的唯一机器可读来源 |
| [前端交接](docs/frontend-handoff.md) | 页面、交互流程、请求示例、人工验证及联调约定 |
| [签到福利接入说明](docs/game-checkin.md) | 游戏角色选择、每日签到、奖励展示与实测范围 |
| [测试场景](docs/mock-scenarios.json) | 自动化测试使用的虚构数据，不进入面板运行流程 |
| [验收清单](docs/acceptance.md) | 实施顺序、必须通过的验证及尚未满足的条件 |
| [后端启动与部署](backend/README.md) | 本地启动、配置、Docker 与数据库备份 |
| [后端联调答复](backend/INTEGRATION.md) | 对前端接口问题的答复与实际行为 |

## 开发与贡献

- **契约优先**：`docs/openapi.json` 是接口唯一来源。后端路由、请求校验与响应 schema 均从契约生成，类型通过 `npm run types:generate` 生成。修改接口时必须同步契约与上述文档。
- **测试**：后端 `npm test`，前端 `npm test -- --testTimeout=15000`。自动化测试使用虚构账号与模拟上游，不会发送真实短信、签到或邮件。
- **提交问题**：欢迎通过 GitHub Issues 反馈，但请勿粘贴手机号、验证码、Cookie、令牌或数据库文件。安全漏洞请使用仓库 Security 页面的私密漏洞报告，不要公开提交。
- 账号凭据、验证码与真实手机号不得出现在 issue、日志、示例或 Git 历史中。

## 许可证

本项目基于 [Apache License 2.0](LICENSE) 发布。你可以自由使用、修改与分发，但需保留许可证与版权声明；本项目按「现状」提供，不附带任何明示或暗示的担保。

Copyright © 2026 IKUNHEIHIE.
