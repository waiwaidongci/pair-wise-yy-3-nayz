# 岩芯样本切片实验室

样本、切片任务、制片步骤与交付的小型实验管理应用。原先请求处理、状态重算、记录存储全挤在一个文件里，两人同时补录步骤会互相覆盖。现已拆分为三个业务模块，并引入请求编号幂等、乐观版本冲突与交付快照。

## 运行

```bash
npm start
```

访问 `http://localhost:3025`。

## 模块结构

| 文件 | 职责 |
| --- | --- |
| `server.js` | 薄入口：创建 HTTP 服务并监听。 |
| `lib/handlers.js` | 请求处理：路由、参数解析/校验，编排状态重算与存储。 |
| `lib/domain.js` | 状态重算：纯领域逻辑，推导样本状态、交付结论、交付快照。 |
| `lib/store.js` | 记录存储：落盘（临时文件 + 原子改名）、乐观版本控制、请求编号幂等。 |
| `lib/page.js` | 单页前端。 |

数据落在 `data/core-slices.json`，结构为 `{ version, samples, requests, deliveries }`。

## 三个关键机制

1. **请求编号（幂等）**：每次变更必须带 `X-Request-Id`（或 body 中的 `requestId`）。
   服务端用 `requests[requestId]` 记录结果。同一步骤重复提交、或写入失败后按编号重试，
   都直接沿用第一次结果，绝不重复追加记录。

2. **乐观版本冲突**：每份数据带递增 `version`，变更时通过 `X-Expected-Version`
   携带调用方基于的版本。版本不一致返回 `409 version_conflict`——同时提交只让先到的一笔写入，
   后到者看到版本冲突，刷新后基于新版本重试即可。

3. **交付结论失效重算 + 快照留档**：样本交付后再新增切片、补录步骤，会让已交付结论失效
  （回到「未交付」并记录 `deliveryInvalidatedAt`），状态由 `domain.recalcSample` 重新推导；
   交付时刻的完整快照追加到 `deliveries`，保留可查（`GET /api/deliveries`）。

## 接口

- `GET  /api/samples` → `{ version, samples }`
- `POST /api/samples` → 创建样本（含初始切片）
- `POST /api/samples/:id/slices` → 新增切片
- `POST /api/samples/:id/slices/:sliceId/logs` → 补录步骤
- `POST /api/samples/:id/deliver` → 标记交付（需所有切片均到「观察」）
- `GET  /api/deliveries` → 全部交付快照
- `GET  /api/samples/:id/deliveries` → 单样本的交付快照

所有写接口均需 `X-Request-Id` 与 `X-Expected-Version`，成功返回 `{ version, replayed, sample, ... }`。
