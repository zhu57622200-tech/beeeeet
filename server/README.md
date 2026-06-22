# beeeeet online server

二期联机版 P0 后端。技术栈：Fastify + better-sqlite3 + bcrypt + jsonwebtoken(HS256) + node-cron。

## 启动

安装依赖：

```bash
npm install --prefix server
```

开发启动：

```bash
DB_PATH=/private/tmp/beeeeet-online-dev.db JWT_SECRET=dev-secret node server/index.js
```

服务监听 `127.0.0.1:8788`，健康检查：

```bash
curl http://127.0.0.1:8788/healthz
```

生产默认库路径按规格为 `/var/lib/beeeeet-online/app.db`；本机无该目录写权限时用 `DB_PATH` 指到可写位置。

## bootstrap

首次建库后创建 admin、默认团码和 6 个 NPC：

```bash
ADMIN_NAME=admin ADMIN_PASSWORD='change-me' INVITE_CODE=BEEEEET \
DB_PATH=/private/tmp/beeeeet-online-dev.db npm run --prefix server bootstrap
```

库内已有 admin 时脚本会拒绝重复执行。注册初始金写 `ledger(type='grant', kind='system')`。

## 接口清单

- `GET /healthz`
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/change-password`
- `POST /api/v1/auth/reset-password`
- `GET /api/v1/me`
- `PATCH /api/v1/me`
- `POST /api/v1/admin/users/:id/reset-code`
- `POST /api/v1/admin/users/:id/ban`
- `POST /api/v1/admin/users/:id/unban`
- `GET /api/v1/sync?since=<feedId>`

成功响应统一 `{ ok:true, data:{...} }`；失败响应统一 `{ ok:false, code, message }`。鉴权使用 `Authorization: Bearer <JWT>`。状态写接口使用 `X-Idempotency-Key` 并落 `idempotency_keys`。

## 测试结果

2026-06-11 在 worktree 根执行：

```bash
npx vitest run
```

结果：

```text
Test Files  23 passed (23)
Tests       325 passed (325)
```
