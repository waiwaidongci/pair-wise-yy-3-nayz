// 记录存储模块：负责持久化、乐观版本控制与请求编号幂等。
//
// 关键机制：
//  1. 数据整体落盘在 data/core-slices.json，写入采用「写临时文件 + 原子改名」。
//  2. 每份数据带一个递增 version。写入时校验调用方基于的版本（expectedVersion），
//     不一致则抛 version_conflict —— 同时提交只让先到的一笔写入，后到者看到版本冲突。
//  3. 每次变更必须带请求编号 requestId。服务端用 requests[requestId] 记录结果：
//     同一步骤重复提交 / 写入失败后按编号重试，都直接沿用第一次结果，绝不重复追加记录。
//  4. 变更在进程内串行化（mutex），避免并发读写互相覆盖。

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");
const dbPath = join(dataDir, "core-slices.json");
const tmpPath = join(dataDir, ".core-slices.json.tmp");

let db = null;
let mutex = Promise.resolve();

function emptyDb() {
  return { version: 0, samples: [], requests: {}, deliveries: [] };
}

// 首次运行时的种子样本（与原始数据一致）。
function seedDb() {
  return {
    version: 0,
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
              { at: "2026-06-13T11:20:00.000Z", step: "切割", note: "完成粗切" },
            ],
          },
        ],
      },
    ],
    requests: {},
    deliveries: [],
  };
}

async function normalize(parsed) {
  parsed.version = Number.isInteger(parsed.version) ? parsed.version : 0;
  parsed.samples = Array.isArray(parsed.samples) ? parsed.samples : [];
  parsed.deliveries = Array.isArray(parsed.deliveries) ? parsed.deliveries : [];
  parsed.requests = parsed.requests && typeof parsed.requests === "object" ? parsed.requests : {};
  return parsed;
}

async function load() {
  if (db) return db;
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(dbPath)) {
    db = seedDb();
    await persist();
    return db;
  }
  db = await normalize(JSON.parse(await readFile(dbPath, "utf8")));
  return db;
}

async function persist() {
  await mkdir(dataDir, { recursive: true });
  await writeFile(tmpPath, JSON.stringify(db, null, 2));
  await rename(tmpPath, dbPath);
}

export async function getDb() {
  return load();
}

export async function getVersion() {
  return (await load()).version;
}

// 串行化的「读 - 改 - 写」事务。
// apply(draft) 在草稿上执行业务变更，返回 { status, body }；
// 只有 apply 成功才会提交版本号并落盘，失败则草稿丢弃、不落盘。
export function mutate({ requestId, expectedVersion, apply }) {
  const op = mutex.then(async () => {
    const d = await load();

    // 幂等：同一请求编号已完成过，直接沿用第一次结果，不再执行变更。
    if (requestId && d.requests[requestId] && d.requests[requestId].status === "completed") {
      const rec = d.requests[requestId];
      return { replayed: true, version: d.version, status: rec.httpStatus ?? 200, result: rec.result };
    }

    // 乐观锁：调用方基于的版本已过期 -> 版本冲突。
    if (expectedVersion != null && d.version !== expectedVersion) {
      const err = new Error("version_conflict");
      err.code = "version_conflict";
      err.currentVersion = d.version;
      throw err;
    }

    // 在草稿上变更，成功才整体提交，避免半写状态。
    const draft = structuredClone(d);
    const { status, body } = apply(draft);

    d.samples = draft.samples;
    d.deliveries = draft.deliveries;
    d.version += 1;
    if (requestId) {
      d.requests[requestId] = {
        status: "completed",
        httpStatus: status,
        at: new Date().toISOString(),
        result: body,
      };
    }
    await persist();
    return { replayed: false, version: d.version, status, result: body };
  });

  mutex = op.catch(() => {});
  return op;
}
