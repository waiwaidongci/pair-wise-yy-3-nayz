// 业务模块：记录存储
// 负责 data/core-slices.json 的读写：
//  - 每次写入整库 rev 自增（乐观锁，后到提交看到版本冲突 409）
//  - 请求编号台账（requestLedger）：同一 requestId 的重试直接返回第一次结果，
//    不会重复追加记录；台账与数据在同一次原子写入里落盘，写入失败后重试安全
//  - 所有写操作经同一串行队列执行，读-改-写不会互相覆盖
// 存储层不认识 HTTP，也不包含业务规则（业务规则在 domain.js）。

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "./domain.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 默认数据文件；测试可通过 CORE_DB_PATH 指向临时文件，互不干扰。
const dbPath = process.env.CORE_DB_PATH || join(__dirname, "..", "data", "core-slices.json");
const tmpPath = `${dbPath}.tmp`;

// ---------- 种子与迁移 ----------

const seed = {
  rev: 0,
  samples: [
    {
      id: "CORE-001",
      project: "东岭铜矿薄片",
      borehole: "ZK-17",
      coreBox: "BX-09",
      depth: "128.4-128.8m",
      owner: "陆川",
      status: "制片中",
      delivery: "未交付",
      slices: [
        {
          id: "SL-001-A",
          method: "茜素红染色",
          observation: "",
          status: "研磨",
          logs: [
            { at: "2026-06-12T10:00:00.000Z", step: "取样", note: "截取含矿化条带位置" },
            { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" }
          ]
        }
      ],
      deliverySnapshots: []
    }
  ],
  requestLedger: {}
};

// 旧版数据文件没有 rev / 样本 rev / requestLedger / deliverySnapshots，读取时补齐。
function migrate(state) {
  if (typeof state.rev !== "number") state.rev = 0;
  if (!state.requestLedger) state.requestLedger = {};
  if (!Array.isArray(state.samples)) state.samples = [];
  for (const sample of state.samples) {
    if (typeof sample.rev !== "number") sample.rev = state.rev;
    if (!Array.isArray(sample.deliverySnapshots)) sample.deliverySnapshots = [];
  }
  return state;
}

async function loadState() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return migrate(JSON.parse(await readFile(dbPath, "utf8")));
}

// 原子写：先写临时文件再 rename，崩溃也不会留下半截 JSON。
// requestLedger 与业务数据一起落盘 —— 台账记了就一定写了，写失败台账也不存在。
async function persist(state) {
  await writeFile(tmpPath, JSON.stringify(state, null, 2));
  await rename(tmpPath, dbPath);
}

// ---------- 串行写队列 ----------

let queueTail = Promise.resolve();
function enqueue(task) {
  const run = queueTail.then(() => task());
  // 单个任务失败不影响后续任务入队。
  queueTail = run.then(() => {}, () => {});
  return run;
}

// ---------- 提交协议 ----------
//
// commit({
//   requestId,        请求编号；为空时由存储层生成并在响应里回传
//   scope: 'sample',  版本校验粒度；'sample' 需提供 sampleId，'global' 校验整库 rev
//   expectedRev,      客户端读到的版本号
//   fingerprint,      请求体指纹；同一 requestId 但内容不同 -> 409
//   mutate(state)     业务变更，返回给客户端的响应数据；不抛错才会落盘
// })
//
// 时序保证：队列让并发提交按到达顺序排队；第一笔通过版本校验并写入，
// 第二笔 expectedRev 落后 -> 409 version_conflict。
// 同一 requestId 重试：命中台账直接回放第一次的响应，mutate 不会再执行。

export async function commit({ requestId, scope = "global", sampleId = null, expectedRev, fingerprint, mutate }) {
  return enqueue(async () => {
    const state = await loadState();
    const clientRequestId = !requestId || requestId === "undefined" ? null : String(requestId);
    const id = clientRequestId || `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    const ledgerEntry = state.requestLedger[id];
    if (ledgerEntry) {
      if (ledgerEntry.fingerprint !== fingerprint) {
        throw new HttpError(409, "idempotency_key_conflict", { requestId: id });
      }
      return structuredClone(ledgerEntry.response);
    }

    const currentRev = scope === "sample"
      ? (state.samples.find((item) => item.id === sampleId) || {}).rev
      : state.rev;
    if (currentRev === undefined) throw new HttpError(404, "sample_not_found");

    const claimed = Number(expectedRev);
    if (!Number.isInteger(claimed)) {
      throw new HttpError(400, "missing_expected_rev");
    }
    if (claimed !== currentRev) {
      throw new HttpError(409, "version_conflict", { expected: claimed, current: currentRev });
    }

    const ctx = { nextSampleRev: currentRev + 1 };
    const result = await mutate(state, ctx);

    // 业务层声明本次没有实质变化（如同一步骤重复提交）：
    // 不推进版本，但仍把结果登记到请求台账并落盘——
    // 之后用同一请求编号重试一律回放，不会再执行业务函数。
    if (result && result.noWrite) {
      const { noWrite, ...payload } = result;
      const response = { requestId: id, ...payload };
      state.requestLedger[id] = {
        at: new Date().toISOString(),
        fingerprint,
        response: structuredClone(response)
      };
      await persist(state);
      return structuredClone(response);
    }

    // 业务函数返回 sample 时推进它的版本；
    // 样本级写操作推进该样本版本，整库版本仅在全局粒度（创建样本）时推进。
    if (result && result.sample) {
      result.sample.rev = ctx.nextSampleRev;
    }
    if (scope === "global") state.rev += 1;

    const response = {
      requestId: id,
      ...(result && typeof result === "object" ? result : { result: result === undefined ? null : result })
    };
    state.requestLedger[id] = {
      at: new Date().toISOString(),
      fingerprint,
      response: structuredClone(response)
    };

    await persist(state);
    return structuredClone(response);
  });
}

// 读不走队列（原子 rename 保证读到的永远是完整文件）。
export async function readAll() {
  return loadState();
}

// 请求体指纹：剔除 requestId 本身，其余字段参与比对。
export function fingerprintOf(input = {}) {
  const copy = { ...input };
  delete copy.requestId;
  return JSON.stringify(copy);
}
