// 状态重算模块：纯领域逻辑，不碰 HTTP 也不碰磁盘。
// 负责样本/切片的状态推导、步骤演进、交付结论判定与交付快照生成。

export const SAMPLE_STATUSES = ["待切割", "制片中", "待观察", "已交付"];
export const STEPS = ["取样", "切割", "研磨", "染色", "观察"];

export function now() {
  return new Date().toISOString();
}

// 依据切片当前步骤重算样本状态与交付结论。
// 规则：
//  - 已交付  -> 已交付
//  - 所有切片都到「观察」-> 待观察（可交付）
//  - 任一切片仍在 取样/切割/研磨/染色 -> 制片中
//  - 其它 -> 待切割
export function recalcSample(sample) {
  const slices = Array.isArray(sample.slices) ? sample.slices : [];
  const allObserved = slices.length > 0 && slices.every((s) => s.status === "观察");
  const inProgress = slices.some((s) => ["取样", "切割", "研磨", "染色"].includes(s.status));

  let status;
  if (sample.delivery === "已交付") status = "已交付";
  else if (allObserved) status = "待观察";
  else if (inProgress) status = "制片中";
  else status = "待切割";

  sample.status = status;
  return {
    status,
    deliveryConclusion: {
      deliverable: allObserved,
      reason: allObserved ? "所有切片均已观察，具备交付条件" : "仍有切片未完成观察，暂不可交付",
    },
  };
}

// 新建样本（自带一条「取样」初始切片与日志）。
export function createSample(input) {
  const sample = {
    id: input.id,
    project: input.project,
    borehole: input.borehole,
    coreBox: input.coreBox,
    depth: input.depth,
    owner: input.owner,
    status: "待切割",
    delivery: "未交付",
    slices: [
      {
        id: input.sliceId,
        method: input.method || "未指定",
        observation: "",
        status: "取样",
        logs: [{ at: now(), step: "取样", note: "创建初始切片任务" }],
      },
    ],
  };
  recalcSample(sample);
  return sample;
}

// 追加切片任务。样本一旦交付过，新增切片会让交付结论失效。
export function addSlice(sample, input) {
  const slice = {
    id: input.id,
    method: input.method || "未指定",
    observation: "",
    status: "取样",
    logs: [{ at: now(), step: "取样", note: "新增切片任务" }],
  };
  sample.slices.push(slice);
  invalidateDelivery(sample);
  recalcSample(sample);
  return slice;
}

// 补录一个制片步骤。步骤非法时抛出，且不产生任何副作用。
export function applyStep(sample, slice, step, note) {
  if (!STEPS.includes(step)) {
    const err = new Error("invalid_step");
    err.code = "invalid_step";
    throw err;
  }
  slice.status = step;
  if (step === "观察") slice.observation = note || slice.observation;
  slice.logs.push({ at: now(), step, note: note || "" });
  invalidateDelivery(sample);
  recalcSample(sample);
}

// 样本或切片发生变化后，已交付结论失效：回到「未交付」，等待重新交付。
// 历史交付快照不受影响，仍保留可查。
export function invalidateDelivery(sample) {
  if (sample.delivery === "已交付") {
    sample.delivery = "未交付";
    sample.deliveryInvalidatedAt = now();
    return true;
  }
  return false;
}

// 生成交付时刻的完整快照（深拷贝切片与日志），追加到交付记录中。
export function buildSnapshot(sample) {
  return {
    id: `DLV-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    sampleId: sample.id,
    project: sample.project,
    borehole: sample.borehole,
    coreBox: sample.coreBox,
    depth: sample.depth,
    owner: sample.owner,
    status: sample.status,
    delivery: "已交付",
    sliceCount: sample.slices.length,
    slices: JSON.parse(JSON.stringify(sample.slices)),
    deliveredAt: now(),
  };
}

// 标记交付。已交付则直接返回既有快照（不重复生成）；
// 未达到交付条件则拒绝；交付后追加快照。
export function deliverSample(db, sample) {
  if (sample.delivery === "已交付") {
    const existing = db.deliveries.find((d) => d.sampleId === sample.id) || null;
    return { snapshot: existing, alreadyDelivered: true };
  }
  const { deliveryConclusion } = recalcSample(sample);
  if (!deliveryConclusion.deliverable) {
    const err = new Error("not_deliverable");
    err.code = "not_deliverable";
    err.reason = deliveryConclusion.reason;
    throw err;
  }
  sample.delivery = "已交付";
  sample.deliveredAt = now();
  delete sample.deliveryInvalidatedAt;
  recalcSample(sample);
  const snapshot = buildSnapshot(sample);
  db.deliveries.unshift(snapshot);
  return { snapshot, alreadyDelivered: false };
}
