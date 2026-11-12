# 如影 AI 能力开放平台

商予科技（SenseYu）数字人 PaaS 能力门户：官网（首页 / 能力矩阵 / 应用场景 / 接入指南）+ 工作台（总览 / 创作中心 / 我的作品 / 能力目录 / 环境与配置）+ 后台管理（超级管理员 / 客户管理员），6 大类 15 项能力，演示 / 真实双模式可切换。

- 前端：Vite + 原生 JS 单页应用（无框架），hash 路由
- 后端：Node 22（≥ 22.13）原生 `http` + 内置 `node:sqlite`（`server/index.mjs`），运行时**零第三方依赖**
- 部署：单端口 8080，静态页面与 API 同源；Docker Compose

版本号只在 `package.json` 的 `version` 字段维护，服务端启动时读取，前端构建时注入。

---

## 本地运行

需要 Node.js ≥ 22.13（使用内置 SQLite）。

```bash
npm install
npm run build                       # 产出 dist/
PORT=8099 npm start                 # 打开 http://127.0.0.1:8099（等同 node --disable-warning=ExperimentalWarning server/index.mjs）
```

不需要任何配置，默认就是**演示模式**。

开发时可以用热更新：

```bash
npm run dev     # Vite 5173（页面）+ API 8787，/api 自动代理
```

常用命令：

| 命令 | 作用 |
|---|---|
| `npm test` | 运行全部自动化测试（不需要任何平台密钥，不访问外网） |
| `npm run build` | 构建前端到 `dist/` |
| `npm run check:leaks` | 扫描源码与文档中的密钥、令牌、邮箱、手机号明文 |
| `npm run ci` | 依次执行测试、构建、泄露扫描 |
| `npm run admin -- create-super <用户名>` | 创建超级管理员（另有 `reset-super`、`list-super`） |

---

## Docker Compose 部署

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps        # 健康检查走 /api/health
```

服务监听容器内 8080，映射到宿主机 8080。

**真实模式的配置**：服务端优先读进程环境变量，读不到再读项目根目录的 `.env` 文件。下面两种方式任选一种：

1. 继续沿用挂载 `.env` 文件的方式，把文件挂到容器内的 `/app/.env`；
2. 用 Compose 的 `env_file:` 或 `environment:` 直接注入环境变量。

> ⚠ **必须持久化 `/app/data`**：客户、账号、厂商凭据、日志（SQLite）和知识库都在这个目录。现有 `deploy/docker-compose.yml` 没有挂载数据卷，**重建容器会清空全部客户与账号**。上线前请在服务下加上：
>
> ```yaml
>     volumes:
>       - ruying-data:/app/data
> # 文件末尾
> volumes:
>   ruying-data:
> ```
>
> 并定期备份该卷（SQLite 单文件，可直接复制 `ruying.db`）。

---

## 后台管理

### 角色

| 角色 | 谁来用 | 能做什么 |
|---|---|---|
| 超级管理员 | 商予科技运营 | 添加厂商凭据（如影 APP_ID / APP_KEY）并从厂商获取 Token；登记采购额度、给客户分配 / 回收额度、签发 API 密钥；新建客户，决定**体验时间与到期时间**、**可用模块**、成员上限、是否开通真实环境与计费调用，并为客户分配厂商凭据；查看全部日志与审计记录 |
| 客户管理员 | 客户企业的负责人 | 查看本企业的**到期时间**、已开通模块与**剩余额度**；自助签发 / 吊销 API 密钥；**添加 / 停用 / 删除成员、重置成员密码**；查看并导出本企业成员的**使用日志** |
| 成员 | 客户企业的员工 | 在开通的模块与有效期内使用工作台；知识库在企业内共享 |
| 访客 | 未登录的访问者 | 只能使用演示环境（`PUBLIC_DEMO=false` 时必须登录） |

### 首次使用

1. 在服务端配置 `DATA_ENCRYPTION_KEY`（用于加密厂商 APP_KEY，设置后不要更换）。
2. 创建超级管理员，二选一：
   - 首次启动前设置 `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD`，启动时自动创建；
   - 或在服务器上执行 `npm run admin -- create-super <用户名>`（交互输入密码）。Docker 部署时执行 `docker compose -f deploy/docker-compose.yml exec experience node --disable-warning=ExperimentalWarning scripts/admin.mjs create-super <用户名>`。
3. 打开 `#login` 登录，首次登录必须修改密码。
4. 「厂商凭据」：添加如影 APP_ID / APP_KEY（以及 TTS 音色 QID、数字人形象图），点「获取 Token」确认凭据可用。服务端 `.env` 里的 `RUYING_APP_ID` / `RUYING_APP_KEY` 会作为只读的「默认凭据」出现在这里。
5. 「客户管理」→「新建客户」：填写有效期、勾选模块、按需开通真实环境并分配凭据，同时创建客户管理员。保存后页面**只显示一次**初始密码，请安全地交给客户。

忘记超级管理员密码：`npm run admin -- reset-super <用户名>`。

### Token 与额度的分配链路（A → B → C / D）

```
A 如影（源头厂商）──APP_ID/APP_KEY──▶ B 本平台（超级管理员）──API 密钥 + 额度──▶ C、D 等客户
                    B 用凭据换取 A 的 Token        客户调用 B 的开放接口 /open/v1，B 再用 A 的 Token 转发
```

1. **采购入账（A→B）**：「厂商凭据 → 额度池」按采购单登记从如影买到的量。如影没有可供查询的额度接口，这是平台自己的**台账**，请以合同 / 采购单为准，并定期与如影控制台核对。
2. **分配额度（B→C/D）**：在「客户详情 → 额度」里从厂商池划拨给客户，分配总量不能超过未分配余额；也可以把未用完的额度回收到池里。删除客户时剩余额度自动退回。
3. **签发 API 密钥（B→C/D）**：超级管理员在「客户详情 → API 密钥」签发，客户管理员也可以在「API 接入」自助签发 / 吊销。密钥原文只显示一次，服务端只保存哈希，可设置有效期。
4. **计量与扣减**：

   | 计量项 | 单位 | 什么时候扣 |
   |---|---|---|
   | 视频时长 | 秒 | 图片数字人 / 视频合成：按整数秒、至少 5 秒，提交时预扣 |
   | 语音合成字数 | 字 | 语音合成、视频口播的配音 |
   | 其他能力调用 | 次 | 其他转发到如影的能力；真实环境下由 DeepSeek 作答的知识库问答 |

   只在**真实环境**扣减，门户与开放接口共用同一份客户额度；演示环境和开放接口沙箱不扣。调用失败、平台任务失败（status 9）自动退回。每笔变动都写入额度流水；余额低于 10% 时工作台与企业概览会提醒。客户之间额度完全独立。

### 开放接口（客户从自己的系统调用）

```bash
BASE=https://你的域名/digital-human/open/v1
curl $BASE/account -H "Authorization: Bearer $RUYING_API_KEY"                     # 账户、开通能力、剩余额度
curl -X POST $BASE/tts -H "Authorization: Bearer $RUYING_API_KEY" -H "Content-Type: application/json" \
  -d '{"text":"欢迎体验如影数字人"}'                                                # 语音合成
curl -X POST $BASE/videos -H "Authorization: Bearer $RUYING_API_KEY" -H "Content-Type: application/json" \
  -d '{"audioUrl":"https://…/voice.mp3","duration":12,"imageUrl":"https://…/portrait.png"}'   # 图片数字人，返回 taskId
curl $BASE/tasks/<taskId> -H "Authorization: Bearer $RUYING_API_KEY"               # 查询任务
curl -X POST $BASE/capabilities/<能力ID>/run -H "Authorization: Bearer $RUYING_API_KEY" -d '{"params":{…}}'
```

- 联调时加请求头 `X-Ruying-Mode: sandbox`：返回样例结果，不扣额度，也不需要开通真实环境。
- 响应统一为 `{ code, message, hint, requestId, data }`；HTTP 状态码：401 密钥无效/吊销/过期，402 额度不足，403 未开通能力/已到期/未开通真实环境，429 超出限流（默认每个密钥每分钟 120 次），502/504 如影平台异常。
- 密钥只能放在服务端，不要写进网页或 App 前端代码。客户管理员的「API 接入」页有带本站地址的完整示例。
- 反向代理需要把 `/open/` 一并转发到本服务（与 `/api/` 相同）。

### 规则说明

- **有效期**：按北京时间的自然日计算，开始日期 00:00 生效，到期日期 23:59 失效。未开始或已到期时，成员无法使用工作台；客户管理员仍可登录查看到期时间、成员与日志。到期前 7 天起，工作台顶部会提示即将到期。
- **模块权限**：以 15 项能力为单位开通。创作中心的快捷链路对应：视频口播 = 图片数字人（含配音），语音合成 = 语音合成 TTS，知识库问答 = 流式问答助手。未开通的能力在工作台里显示「未开通」，服务端也会拒绝调用。
- **真实环境**：需要同时满足「客户开通了真实环境」「分配了可用的厂商凭据」「在有效期内」。计费接口还需要客户开通计费调用，且服务端 `ALLOW_BILLABLE=true`。
- **Token**：由服务端按厂商凭据分别获取与缓存（剩余不足 30 分钟提前更换，失效时重取并重试一次）。客户和成员看不到凭据与 Token。
- **账号安全**：密码 scrypt 加盐哈希；新账号与重置后的密码为一次性随机密码，首次登录必须修改；连续输错 5 次锁定 15 分钟；停用账号或客户后会话立即失效；会话 Cookie 为 HttpOnly + SameSite=Lax，写操作还要求 `X-Requested-With` 请求头。
- **日志**：记录每次能力调用（含被权限或有效期拒绝的调用）、登录、改密与所有后台管理操作（审计），默认保留 180 天，可导出 CSV。数据都来自真实记录，不做估算。
- **数据**：账号、客户、凭据与日志存放在 SQLite（默认 `data/ruying.db`）。Docker 部署请把 `/app/data` 挂载为数据卷，否则重建容器会丢失。

---

## 环境变量

参考 `server/.env.example`。真实值只放在服务器上的 `.env` 文件里（权限 600）或部署平台的密钥配置里，**不要写进代码、文档或提交信息**。

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` | 否 | 监听端口，默认 8080 |
| `RUYING_MOCK` | 否 | 默认模式。`false` 且配置了凭据时默认真实模式，否则演示模式 |
| `RUYING_APP_ID` / `RUYING_APP_KEY` | 真实模式必填 | 如影平台应用凭据，用于签名换取 Token |
| `RUYING_BASE_URL` | 否 | 默认 `https://aigc.softsugar.com` |
| `RUYING_TTS_QID` | 真实模式下配音必填 | TTS 音色 QID |
| `RUYING_AVATAR_IMAGE_URL` | 真实模式下视频口播必填 | 数字人形象图，需可公网访问 |
| `ALLOW_BILLABLE` | 否 | `true` 才放行计费接口（视频生成等），默认拒绝 |
| `DEEPSEEK_API_KEY` | 否 | 配置后，真实模式下知识库问答由 DeepSeek 生成回答 |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | 否 | 默认 `https://api.deepseek.com` / `deepseek-chat` |
| `KB_DIR` | 否 | 知识库数据目录，默认 `./data` |
| `DATA_ENCRYPTION_KEY` | 使用后台必填 | 加密厂商 APP_KEY 的密钥（任意长度口令），设置后不要更换 |
| `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD` | 否 | 首次启动时自动创建超级管理员（仅在还没有超级管理员时生效） |
| `PUBLIC_DEMO` | 否 | `false` 时工作台必须登录；默认 `true`，访客可体验演示环境 |
| `LOG_RETENTION_DAYS` | 否 | 日志保留天数，默认 180 |
| `DB_FILE` | 否 | 数据库文件，默认 `./data/ruying.db` |
| `COOKIE_SECURE` | 否 | `auto`（默认，按 `X-Forwarded-Proto` 判断）/ `true` / `false` |
| `OPEN_API_RATE_PER_MIN` | 否 | 开放接口每个密钥每分钟的请求上限，默认 120 |
| `PUBLIC_BASE_PATH` | 否 | 反向代理没有去掉子路径前缀时填写，如 `/digital-human` |
| `SIGN_TS_UNIT` | 否 | 签名时间戳单位 `ms`（默认）或 `s` |
| `UPSTREAM_TIMEOUT_MS` | 否 | 访问如影平台的超时，默认 20000 |
| `MOCK_TASK_MS` | 否 | 演示模式任务耗时，默认 1400 |

页面「环境与配置」只显示各项**是否已配置**，不显示任何值。

---

## 演示模式与真实模式

| | 演示模式 | 真实模式 |
|---|---|---|
| 数据来源 | 本地样例素材（`server/mock/assets`） | 如影平台线上接口 |
| 费用 | 不产生 | 按平台计费；计费接口还需 `ALLOW_BILLABLE=true` |
| 凭据 | 不需要 | 服务端配置 `RUYING_APP_ID` / `RUYING_APP_KEY` |
| 结果标识 | 每个结果都标注「演示结果 · 本地样例」 | 标注「真实环境结果」 |
| 知识库问答 | 检索后摘录资料原文 | 检索命中后由 DeepSeek 依据资料回答；未配置则摘录原文 |
| Token | 不需要，设置页如实说明 | 设置页显示剩余有效期、过期时间与计划更换时间，可在线获取 |

模式**按访客生效**：页面把当前模式放在请求头 `X-Ruying-Mode` 里发给服务端，一个访客切换不会影响其他访客。服务端没有配置凭据时，任何访客都无法切到真实模式。

### Token 策略

- 平台返回的是**绝对过期点**，服务端按它计算剩余时间
- 剩余不足 **30 分钟**时提前重新获取，并发请求只换取一次
- 平台提前作废（调用返回 Token 无效）时：作废缓存 → 重取一次 → 重试一次；仍失败则提示用户联系管理员

### 已实测的真实接口调用方式（不要随意改动）

- TTS：`POST /api/voice/v3/tts/request`（带 qid），再轮询 `/api/voice/v3/tts/result`
- 图片数字人：带 `videoName`；参数放在 `param` 字段，值为 JSON 字符串 `{imageUrl, audioUrl, duration}`
- 任务查询：`POST /api/2dvh/v1/task/info`，请求体 `{"ids":[...]}`
- `duration` 为整数秒，且至少 5 秒

请求体与返回字段的解析集中在 `server/lib/ruying.mjs` 顶部的 `PLATFORM` 对象里。

---

## 知识库

- 支持 `.txt` / `.md`（UTF-8），单文件 1MB 以内；可拖拽上传，显示进度，可删除
- 重复内容、同名文件会给出提示，不会重复入库
- 检索：按标题分节切块 → BM25 排序（标题与首段加权）→ 关键词覆盖不足时如实回答「库里没有」，不硬凑
- 按浏览器隔离：每个浏览器有自己的工作区，访客之间互相看不到资料；30 天未使用的工作区在服务启动时清理

---

## 目录结构

```
server/
  index.mjs          入口：路由、静态托管、按请求的模式分发
  mock.mjs           演示模式：本地模拟平台
  lib/config.mjs     配置（环境变量优先，.env 回退）
  lib/token.mjs      Token 生命周期
  lib/ruying.mjs     如影真实接口客户端
  lib/kb.mjs         知识库切块、检索、存储
  lib/answer.mjs     知识库问答（检索 + DeepSeek / 原文摘录）
  lib/errors.mjs     统一的「人话」错误
  lib/version.mjs    从 package.json 读取版本号
  lib/db.mjs         SQLite 表结构
  lib/tenancy.mjs    客户、账号、会话、厂商凭据、API 密钥、权限判定、日志
  lib/quota.mjs      额度台账：采购入账、分配、回收、预扣与退回
  lib/secrets.mjs    口令哈希、会话令牌、凭据加密
src/
  main.js            前端入口：外壳只渲染一次，事件统一委托
  lib/views.js       视图（官网、工作台、覆盖层）
  lib/experience.js  通用能力体验器
  lib/capabilities.js 15 项能力定义（前后端共用的唯一数据源）
  lib/api.js         前端 API 封装、任务轮询、上传、SSE
  lib/admin.js       登录、账号、超级管理员与客户管理员后台
public/brand/        官方 logo 放这里（见下）
tests/               node:test 自动化测试
```

### 品牌 logo

顶栏与页脚是商汤 SenseTime + 商予 SenseYu 双 logo 并排。把官方文件放进 `public/brand/`：

- `sensetime.svg`（或 `.png` / `.webp`）
- `senseyu.svg`（或 `.png` / `.webp`）

然后重新执行 `npm run build`。没有文件时显示文字标识，不会请求不存在的资源。

---

## 常见问题

**部署在子路径（如 `http://host/digital-human/`）下，页面空白或接口 404？**
构建产物与前端请求都使用**相对路径**（Vite `base: './'`，接口为 `api/...`），所以页面、资源和接口会自动带上子路径。两种反向代理方式都支持：

- 代理去掉前缀转发，例如 nginx 的 `location /digital-human/ { proxy_pass http://127.0.0.1:8080/; }`（注意末尾的 `/`）
- 代理原样转发：服务端设置 `PUBLIC_BASE_PATH=/digital-human`

入口地址要以 `/` 结尾（`/digital-human/` 而不是 `/digital-human`），否则相对路径会解析到根目录；可在代理上把不带斜杠的地址 301 到带斜杠的地址。

问答接口是 SSE 流式返回，nginx 需要关闭缓冲：`proxy_buffering off;`（服务端已经发送了 `X-Accel-Buffering: no` 响应头）。

**客户说「看不到某个功能」？**
在「客户管理」里检查该客户的模块权限与有效期；客户管理员可以在「企业概览」看到已开通的模块。

**客户的真实环境用不了？**
需要同时满足：开通真实环境、分配了厂商凭据、在有效期内。在「厂商凭据」页点「获取 Token」可以确认凭据本身是否可用。

**切换真实环境提示「尚未配置」？**
服务端没读到 `RUYING_APP_ID` / `RUYING_APP_KEY`。确认环境变量已注入，或 `.env` 位于项目根目录（容器内是 `/app/.env`），然后重启服务。启动日志会打印「真实环境=可用 / 未配置」。

**视频一直显示「平台排队中」？**
这是如影平台侧的队列。页面会持续等待，最长 15 分钟，可以随时停止；停止后任务仍在平台继续处理，点「继续等待」就能接着取结果。

**生成视频提示「这项能力会产生平台费用」？**
计费接口默认受保护。确认需要真实生成时，在服务端设置 `ALLOW_BILLABLE=true`。

**上传 txt 提示编码无法识别？**
文件很可能是 GBK 编码，请另存为 UTF-8 后再上传。

**页面上为什么没有额度数字？**
如影平台没有提供可供门户查询的额度接口。为避免展示不准确的数据，额度与用量请以如影控制台为准。
