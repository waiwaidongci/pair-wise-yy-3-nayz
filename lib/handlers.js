// 请求处理模块：HTTP 路由、参数解析与校验，编排状态重算与记录存储。
// 本模块不含状态推导细节（在 domain.js）也不含落盘细节（在 store.js）。

import { getDb, mutate } from "./store.js";
import * as domain from "./domain.js";
import { page } from "./page.js";

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function header(req, name) {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requestIdOf(req, input) {
  return header(req, "x-request-id") || input?.requestId || input?.request_id || null;
}

function expectedVersionOf(req, input) {
  const raw = header(req, "x-expected-version") ?? input?.expectedVersion ?? input?.expected_version;
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
}

function httpError(status, error) {
  const err = new Error(error);
  err.status = status;
  err.code = error;
  return err;
}

// 在存储事务内执行业务变更。apply 接收草稿 db，返回 { status, body }。
function routeMutation(pathname, input, db) {
  let match;

  if (pathname === "/api/samples") {
    const sample = domain.createSample({
      id: `CORE-${Date.now()}`,
      project: input.project,
      borehole: input.borehole,
      coreBox: input.coreBox,
      depth: input.depth,
      owner: input.owner,
      sliceId: input.sliceId,
      method: input.method,
    });
    db.samples.unshift(sample);
    return { status: 201, body: { sample } };
  }

  match = pathname.match(/^\/api\/samples\/([^/]+)\/slices$/);
  if (match) {
    const sample = db.samples.find((item) => item.id === match[1]);
    if (!sample) throw httpError(404, "sample_not_found");
    const slice = domain.addSlice(sample, { id: input.id, method: input.method });
    return { status: 201, body: { sample, slice } };
  }

  match = pathname.match(/^\/api\/samples\/([^/]+)\/slices\/([^/]+)\/logs$/);
  if (match) {
    const sample = db.samples.find((item) => item.id === match[1]);
    if (!sample) throw httpError(404, "sample_not_found");
    const slice = sample.slices.find((item) => item.id === match[2]);
    if (!slice) throw httpError(404, "slice_not_found");
    domain.applyStep(sample, slice, input.step, input.note);
    return { status: 200, body: { sample, slice } };
  }

  match = pathname.match(/^\/api\/samples\/([^/]+)\/deliver$/);
  if (match) {
    const sample = db.samples.find((item) => item.id === match[1]);
    if (!sample) throw httpError(404, "sample_not_found");
    const { snapshot, alreadyDelivered } = domain.deliverSample(db, sample);
    return { status: 200, body: { sample, delivery: snapshot, alreadyDelivered } };
  }

  throw httpError(404, "not_found");
}

export async function handle(req, res) {
  let input = {};
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method;

    if (method === "GET" && pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    if (method === "GET" && pathname === "/api/samples") {
      const db = await getDb();
      return sendJson(res, 200, { version: db.version, samples: db.samples });
    }

    if (method === "GET" && pathname === "/api/deliveries") {
      const db = await getDb();
      return sendJson(res, 200, { version: db.version, deliveries: db.deliveries });
    }

    let match = pathname.match(/^\/api\/samples\/([^/]+)\/deliveries$/);
    if (method === "GET" && match) {
      const db = await getDb();
      const deliveries = db.deliveries.filter((item) => item.sampleId === match[1]);
      return sendJson(res, 200, { version: db.version, deliveries });
    }

    const isMutation =
      method === "POST" &&
      (pathname === "/api/samples" ||
        /^\/api\/samples\/[^/]+\/slices$/.test(pathname) ||
        /^\/api\/samples\/[^/]+\/slices\/[^/]+\/logs$/.test(pathname) ||
        /^\/api\/samples\/[^/]+\/deliver$/.test(pathname));

    if (isMutation) {
      input = await readBody(req);
      const requestId = requestIdOf(req, input);
      if (!requestId) return sendJson(res, 400, { error: "request_id_required" });

      const expectedVersion = expectedVersionOf(req, input);
      if (Number.isNaN(expectedVersion)) return sendJson(res, 400, { error: "invalid_expected_version" });

      const outcome = await mutate({
        requestId,
        expectedVersion,
        apply: (db) => routeMutation(pathname, input, db),
      });
      return sendJson(res, outcome.status, {
        version: outcome.version,
        replayed: outcome.replayed,
        ...outcome.result,
      });
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (error.code === "version_conflict") {
      return sendJson(res, 409, { error: "version_conflict", currentVersion: error.currentVersion });
    }
    if (error.code === "not_deliverable") {
      return sendJson(res, 409, { error: "not_deliverable", reason: error.reason });
    }
    if (error.code === "invalid_step") {
      return sendJson(res, 400, { error: "invalid_step" });
    }
    if (error.status) {
      return sendJson(res, error.status, { error: error.code });
    }
    return sendJson(res, 500, { error: error.message });
  }
}
