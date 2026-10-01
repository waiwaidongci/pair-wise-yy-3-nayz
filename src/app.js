// 业务模块：请求处理
// HTTP 层：解析请求、取出请求编号与版本号、调用 domain 的业务规则，
// 通过 store 的 commit 完成带乐观锁与幂等的写入。
// 这里不写状态重算规则，也不直接读写数据文件。

import http from "node:http";
import {
  STATUSES,
  TASK_STEPS,
  HttpError,
  createSample,
  appendSlice,
  recordStep,
  markDelivered
} from "./domain.js";
import { commit, readAll, fingerprintOf } from "./store.js";
import { page } from "./page.js";

export const port = Number(process.env.PORT || 3025);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

// 请求编号：优先 X-Request-Id / Idempotency-Key 请求头，也允许放在请求体。
function resolveRequestId(req, input) {
  return req.headers["x-request-id"] || req.headers["idempotency-key"] || input.requestId || "";
}

export const app = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    if (req.method === "GET" && url.pathname === "/api/samples") {
      const state = await readAll();
      return sendJson(res, 200, {
        rev: state.rev,
        statuses: STATUSES,
        steps: TASK_STEPS,
        samples: state.samples
      });
    }

    // 已交付快照查询（样本仍可查，快照单独可查）。
    const deliveriesMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliveries$/);
    if (deliveriesMatch && req.method === "GET") {
      const state = await readAll();
      const sample = state.samples.find((item) => item.id === deliveriesMatch[1]);
      if (!sample) throw new HttpError(404, "sample_not_found");
      return sendJson(res, 200, {
        sampleId: sample.id,
        delivery: sample.delivery,
        snapshots: sample.deliverySnapshots || []
      });
    }

    // 创建样本（整库粒度乐观锁）。
    if (req.method === "POST" && url.pathname === "/api/samples") {
      const input = await readBody(req);
      const result = await commit({
        requestId: resolveRequestId(req, input),
        scope: "global",
        expectedRev: input.expectedRev,
        fingerprint: fingerprintOf(input),
        mutate: (state) => {
          const sample = createSample(input);
          state.samples.unshift(sample);
          return { sample };
        }
      });
      return sendJson(res, 201, { deduped: false, ...result });
    }

    const addSliceMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
    if (addSliceMatch && req.method === "POST") {
      const sampleId = addSliceMatch[1];
      const input = await readBody(req);
      const result = await commit({
        requestId: resolveRequestId(req, input),
        scope: "sample",
        sampleId,
        expectedRev: input.expectedRev,
        fingerprint: fingerprintOf(input),
        mutate: (state) => ({ sample: appendSlice(state, sampleId, input) })
      });
      return sendJson(res, 201, { deduped: false, ...result });
    }

    const logMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
    if (logMatch && req.method === "POST") {
      const [, sampleId, sliceId] = logMatch;
      const input = await readBody(req);
      const result = await commit({
        requestId: resolveRequestId(req, input),
        scope: "sample",
        sampleId,
        expectedRev: input.expectedRev,
        fingerprint: fingerprintOf(input),
        mutate: (state) => recordStep(state, sampleId, sliceId, input)
      });
      return sendJson(res, 200, result);
    }

    const deliverMatch = url.pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
    if (deliverMatch && req.method === "POST") {
      const sampleId = deliverMatch[1];
      const input = await readBody(req);
      const result = await commit({
        requestId: resolveRequestId(req, input),
        scope: "sample",
        sampleId,
        expectedRev: input.expectedRev,
        fingerprint: fingerprintOf(input),
        mutate: (state, ctx) => markDelivered(state, sampleId, input, ctx)
      });
      return sendJson(res, 200, result);
    }

    throw new HttpError(404, "not_found");
  } catch (error) {
    if (error instanceof HttpError) {
      return sendJson(res, error.status, { error: error.code, ...(error.details ? { details: error.details } : {}) });
    }
    return sendJson(res, 500, { error: "internal_error", message: error.message });
  }
});
