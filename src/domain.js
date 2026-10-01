// 业务模块：状态重算
// 纯函数：样本/切片的业务规则、交付结论、步骤推进都在这里，
// 不接触 HTTP 请求，也不接触存储文件。

export const STATUSES = ["待切割", "制片中", "待观察", "已交付"];
export const TASK_STEPS = ["取样", "切割", "研磨", "染色", "观察"];
const IN_PROGRESS_STEPS = ["取样", "切割", "研磨", "染色"];

export class HttpError extends Error {
  constructor(status, code, details) {
    super(code);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function nextId(prefix) {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function assertStep(step) {
  if (!TASK_STEPS.includes(step)) {
    throw new HttpError(400, "invalid_step", { allowed: TASK_STEPS });
  }
}

function findSample(state, sampleId) {
  const sample = state.samples.find((item) => item.id === sampleId);
  if (!sample) throw new HttpError(404, "sample_not_found");
  return sample;
}

function findSlice(sample, sliceId) {
  const slice = sample.slices.find((item) => item.id === sliceId);
  if (!slice) throw new HttpError(404, "slice_not_found");
  return slice;
}

// 根据切片状态重算样本状态。交付结论由 evaluateDelivery 单独决定，
// 这里只在结论仍然成立时把样本标成“已交付”。
export function recomputeStatus(sample) {
  const steps = sample.slices.map((slice) => slice.status);
  if (sample.delivery === "已交付" && deliveryHolds(sample)) {
    sample.status = "已交付";
  } else if (steps.length && steps.every((step) => step === "观察")) {
    sample.status = "待观察";
  } else if (steps.some((step) => IN_PROGRESS_STEPS.includes(step))) {
    sample.status = "制片中";
  } else {
    sample.status = "待切割";
  }
  return sample;
}

// 交付结论：所有切片都完成观察才算数。
export function evaluateDelivery(sample) {
  const ready = sample.slices.length > 0 &&
    sample.slices.every((slice) => slice.status === "观察");
  const pending = ready ? [] : sample.slices
    .filter((slice) => slice.status !== "观察")
    .map((slice) => ({ id: slice.id, status: slice.status }));
  return { ready, pending };
}

function deliveryHolds(sample) {
  return evaluateDelivery(sample).ready;
}

// 样本或切片发生变化时，交付结论失效：解除交付标记，后续重算不再保留“已交付”。
// 已交付快照保存在 deliverySnapshots，不会被改动，仍然可查。
export function invalidateDelivery(sample, reason) {
  if (sample.delivery !== "已交付") return false;
  sample.delivery = "未交付";
  sample.deliveryInvalidatedAt = nowIso();
  sample.deliveryInvalidReason = reason;
  return true;
}

export function createSample(input) {
  for (const field of ["project", "borehole", "coreBox", "depth", "owner"]) {
    if (!input || !input[field]) throw new HttpError(400, "missing_field", { field });
  }
  if (!input.sliceId) throw new HttpError(400, "missing_field", { field: "sliceId" });
  const sample = {
    id: nextId("CORE"),
    project: input.project,
    borehole: input.borehole,
    coreBox: input.coreBox,
    depth: input.depth,
    owner: input.owner,
    status: "待切割",
    delivery: "未交付",
    slices: [{
      id: input.sliceId,
      method: input.method || "未指定",
      observation: "",
      status: "取样",
      logs: [{ at: nowIso(), step: "取样", note: "创建初始切片任务" }]
    }],
    deliverySnapshots: []
  };
  return recomputeStatus(sample);
}

export function appendSlice(state, sampleId, input) {
  const sample = findSample(state, sampleId);
  if (!input || !input.id) throw new HttpError(400, "missing_field", { field: "id" });
  if (sample.slices.some((slice) => slice.id === input.id)) {
    throw new HttpError(409, "slice_id_exists");
  }
  // 新增切片属于样本变化，已有交付结论随之失效。
  invalidateDelivery(sample, `新增切片 ${input.id}`);
  sample.slices.push({
    id: input.id,
    method: input.method || "未指定",
    observation: "",
    status: "取样",
    logs: [{ at: nowIso(), step: "取样", note: "新增切片任务" }]
  });
  return recomputeStatus(sample);
}

// 记录制片步骤。
// 返回 { sample, slice, deduped }：同一步骤重复提交（同一切片已处于该步骤）
// 沿用第一次结果，不追加记录、不推进状态。
export function recordStep(state, sampleId, sliceId, input) {
  const sample = findSample(state, sampleId);
  const slice = findSlice(sample, sliceId);
  const step = input && input.step;
  assertStep(step);
  const note = (input && input.note) || "";

  if (slice.status === step) {
    // 同一步骤重复提交：沿用第一次结果，声明无写入（不追加记录、不推进版本）。
    return { sample, slice, deduped: true, noWrite: true };
  }

  slice.status = step;
  if (step === "观察") slice.observation = note || slice.observation;
  slice.logs.push({ at: nowIso(), step, note });

  // 切片步骤变化属于切片变化，交付结论失效重算。
  invalidateDelivery(sample, `切片 ${slice.id} 步骤推进为 ${step}`);
  recomputeStatus(sample);
  return { sample, slice, deduped: false };
}

// 交付：结论不成立时拒绝；成立则固化快照。
export function markDelivered(state, sampleId, input, ctx = {}) {
  const sample = findSample(state, sampleId);
  const verdict = evaluateDelivery(sample);
  if (!verdict.ready) {
    throw new HttpError(409, "not_deliverable", { pending: verdict.pending });
  }

  // 幂等：已经处于已交付状态且结论仍成立时沿用，不重复生成快照、不推进版本。
  const alreadyDelivered = sample.delivery === "已交付";
  if (!alreadyDelivered) {
    sample.delivery = "已交付";
    delete sample.deliveryInvalidatedAt;
    delete sample.deliveryInvalidReason;
    recomputeStatus(sample);
    sample.deliverySnapshots.push(buildSnapshot(sample, (input && input.handoverTo) || "", ctx.nextSampleRev));
  }
  return { sample, deduped: alreadyDelivered, ...(alreadyDelivered ? { noWrite: true } : {}) };
}

function buildSnapshot(sample, handoverTo, rev) {
  return {
    deliveredAt: nowIso(),
    // 交付生效后的样本版本（ctx 给出；旧调用路径缺省回退到当前 rev）。
    rev: rev || sample.rev,
    handoverTo,
    sample: structuredClone({
      ...sample,
      rev: rev || sample.rev,
      deliverySnapshots: undefined
    })
  };
}
