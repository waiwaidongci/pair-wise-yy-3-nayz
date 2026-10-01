// 端到端行为验证（启动 server 后运行：node test/e2e.mjs）
const BASE = process.env.BASE || "http://localhost:3025";
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ✅", name); }
  else { fail++; console.log("  ❌", name, extra ?? ""); }
}
async function api(path, { method = "GET", body, requestId, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(requestId ? { "X-Request-Id": requestId } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const getSample = async (id) => (await api("/api/samples")).data.samples.find(s => s.id === id);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 1. 建样本
console.log("1) 创建样本");
let env = (await api("/api/samples")).data;
const created = await api("/api/samples", { method: "POST", body: { project: "并发测试矿", borehole: "ZK-1", coreBox: "BX-1", depth: "10m", owner: "甲", sliceId: "SL-T-1", method: "常规", expectedRev: env.rev }, requestId: "req-create-1" });
check("创建 201 并回显 requestId", created.status === 201 && created.data.requestId === "req-create-1", created.data);
const sid = created.data.sample.id;
let sample = await getSample(sid);
let srev = sample.rev;
check("初始样本版本为 1", srev === 1, srev);
check("初始状态按切片重算为制片中", sample.status === "制片中", sample.status);

// 2. 同一 requestId 重试（模拟写入失败后重试）：不能重复追加
console.log("2) 请求编号重试幂等");
const retry2 = await api(`/api/samples/${sid}/slices/SL-T-1/logs`, { method: "POST", body: { step: "切割", note: "第一次切割", expectedRev: srev }, requestId: "req-log-qiege" });
check("首次提交成功", retry2.status === 200, retry2.data);
srev = retry2.data.sample.rev;
const retry3 = await api(`/api/samples/${sid}/slices/SL-T-1/logs`, { method: "POST", body: { step: "切割", note: "第一次切割", expectedRev: srev - 1 }, requestId: "req-log-qiege" });
check("同请求编号重试回放原结果", retry3.status === 200 && retry3.data.sample.rev === srev, retry3.data);
sample = await getSample(sid);
check("日志只有一条切割（没有重复追加）", sample.slices[0].logs.filter(l => l.step === "切割").length === 1);
check("重试回放带的旧版本号不触发冲突", retry3.status === 200);

// 3. 同一步骤重复提交（新请求编号）→ 沿用第一次结果
console.log("3) 同一步骤重复提交去重");
const dup = await api(`/api/samples/${sid}/slices/SL-T-1/logs`, { method: "POST", body: { step: "切割", note: "又交一次切割", expectedRev: srev }, requestId: "req-dup-step" });
check("同步骤重复提交 deduped=true", dup.status === 200 && dup.data.deduped === true, dup.data);
sample = await getSample(sid);
check("去重不推进版本", sample.rev === srev, { now: sample.rev, before: srev });
check("去重不追加日志", sample.slices[0].logs.filter(l => l.step === "切割").length === 1);

// 4. 并发两笔，同一 expectedRev，不同步骤 → 只让先到的写入
console.log("4) 并发版本冲突");
// 先推进到研磨
const yanmo = await api(`/api/samples/${sid}/slices/SL-T-1/logs`, { method: "POST", body: { step: "研磨", note: "研磨完成", expectedRev: srev }, requestId: "req-yanmo" });
check("研磨推进成功", yanmo.status === 200, yanmo.data);
srev = yanmo.data.sample.rev;
const [a, b] = await Promise.all([
  api(`/api/samples/${sid}/slices/SL-T-1/logs`, { method: "POST", body: { step: "染色", note: "甲的染色", expectedRev: srev }, requestId: "req-race-a" }),
  api(`/api/samples/${sid}/slices/SL-T-1/logs`, { method: "POST", body: { step: "观察", note: "乙的观察", expectedRev: srev }, requestId: "req-race-b" })
]);
const winner = a.status === 200 ? a : b;
const loser = a.status === 200 ? b : a;
check("先到一笔写入成功", winner.status === 200, { a: a.status, b: b.status });
check("后到一笔 409 version_conflict", loser.status === 409 && loser.data.error === "version_conflict", loser.data);
sample = await getSample(sid);
check("库里只有先到步骤", sample.slices[0].status === winner.data.slice.status, { actual: sample.slices[0].status });
const logsAfterRace = sample.slices[0].logs;
check("后到者没有写入日志", logsAfterRace.filter(l => l.note === "乙的观察" || l.note === "甲的染色").length === 1, logsAfterRace.map(l => l.note));

// 5. 未全部观察完成不能交付
console.log("5) 交付结论与快照");
if (sample.slices[0].status !== "观察") {
  const obs = await api(`/api/samples/${sid}/slices/SL-T-1/logs`, { method: "POST", body: { step: "观察", note: "观察结论：见矿", expectedRev: sample.rev }, requestId: "req-observe" });
  check("推进到观察", obs.status === 200, obs.data);
}
sample = await getSample(sid);
const deliverBad = await api(`/api/samples/${sid}/deliver`, { method: "POST", body: { expectedRev: sample.rev }, requestId: "req-deliver-bad" });
// 单切片已到观察，可以交付；再建一个两切片样本来验证 not_deliverable
env = (await api("/api/samples")).data;
const c2 = await api("/api/samples", { method: "POST", body: { project: "不可交付矿", borehole: "ZK-2", coreBox: "BX-2", depth: "11m", owner: "乙", sliceId: "SL-T-2", method: "常规", expectedRev: env.rev }, requestId: "req-create-2" });
const sid2 = c2.data.sample.id;
const bad = await api(`/api/samples/${sid2}/deliver`, { method: "POST", body: { expectedRev: c2.data.sample.rev }, requestId: "req-c2-deliver" });
check("切片未完成观察时交付被拒 409 not_deliverable", bad.status === 409 && bad.data.error === "not_deliverable", bad.data);
sample = await getSample(sid);
const d1 = await api(`/api/samples/${sid}/deliver`, { method: "POST", body: { expectedRev: sample.rev, handoverTo: "档案室" }, requestId: "req-deliver-1" });
check("全部观察完成后交付成功", d1.status === 200, d1.data);
check("样本状态变为已交付", d1.data.sample.status === "已交付");
check("交付快照已固化（含切片观察结果）", d1.data.sample.deliverySnapshots.length === 1 && d1.data.sample.deliverySnapshots[0].sample.slices[0].observation === "观察结论：见矿", JSON.stringify(d1.data.sample.deliverySnapshots[0]?.sample?.slices));
const d1Retry = await api(`/api/samples/${sid}/deliver`, { method: "POST", body: { expectedRev: d1.data.sample.rev, handoverTo: "档案室" }, requestId: "req-deliver-1" });
check("交付重试走幂等台账", d1Retry.status === 200 && d1Retry.data.sample.deliverySnapshots.length === 1);
const d1Dup = await api(`/api/samples/${sid}/deliver`, { method: "POST", body: { expectedRev: d1.data.sample.rev }, requestId: "req-deliver-dup" });
check("再次交付沿用不重复生成快照", d1Dup.status === 200 && d1Dup.data.deduped === true && d1Dup.data.sample.deliverySnapshots.length === 1);

// 6. 交付后样本/切片变化 → 结论失效重算，快照保留可查
console.log("6) 交付失效与快照留存");
sample = await getSample(sid);
const addMore = await api(`/api/samples/${sid}/slices`, { method: "POST", body: { id: "SL-T-1-B", method: "荧光", expectedRev: sample.rev }, requestId: "req-add-slice" });
check("新增切片后交付标记失效", addMore.status === 201 && addMore.data.sample.delivery === "未交付", { status: addMore.status, delivery: addMore.data.sample?.delivery });
check("样本状态重算回制片中", addMore.data.sample.status === "制片中", addMore.data.sample.status);
check("失效原因留痕", addMore.data.sample.deliveryInvalidReason && addMore.data.sample.deliveryInvalidReason.includes("SL-T-1-B"));
check("已交付快照保留 1 份可查", addMore.data.sample.deliverySnapshots.length === 1);
const dels = await api(`/api/samples/${sid}/deliveries`);
check("交付历史接口可查快照", dels.status === 200 && dels.data.snapshots.length === 1 && dels.data.delivery === "未交付", dels.data);
// 切片步骤变化同样使结论失效（重新交付后再改步骤）
const toObserve = async (sliceId, note, req) => {
  const stepIds = { "切割": "qiege", "研磨": "yanmo", "染色": "ranse", "观察": "guancha" };
  const s0 = await getSample(sid);
  const slice0 = s0.slices.find(x => x.id === sliceId);
  for (const step of ["切割", "研磨", "染色", "观察"]) {
    if (step === slice0.status) continue;
    const cur = await getSample(sid);
    const r = await api(`/api/samples/${sid}/slices/${sliceId}/logs`, { method: "POST", body: { step, note: note + step, expectedRev: cur.rev }, requestId: req + "-" + stepIds[step] });
    if (r.status !== 200) return r;
  }
  return { status: 200 };
};
await toObserve("SL-T-1-B", "补录", "req-fill-b");
let s = await getSample(sid);
const d2 = await api(`/api/samples/${sid}/deliver`, { method: "POST", body: { expectedRev: s.rev }, requestId: "req-deliver-2" });
check("补齐后再次交付成功", d2.status === 200, d2.data);
check("第二份快照生成，历史共 2 份", d2.data.sample.deliverySnapshots.length === 2);
s = await getSample(sid);
const stepChange = await api(`/api/samples/${sid}/slices/SL-T-1/logs`, { method: "POST", body: { step: "染色", note: "交付后退回重染", expectedRev: s.rev }, requestId: "req-step-after-delivery" });
check("交付后步骤变化 → 结论再次失效", stepChange.status === 200 && stepChange.data.sample.delivery === "未交付", stepChange.data);
check("状态重算为制片中", stepChange.data.sample.status === "制片中", stepChange.data.sample.status);
check("两份历史快照仍可查", stepChange.data.sample.deliverySnapshots.length === 2);

// 7. 创建样本的整库版本冲突
console.log("7) 整库版本冲突");
env = (await api("/api/samples")).data;
const [cA, cB] = await Promise.all([
  api("/api/samples", { method: "POST", body: { project: "并发甲", borehole: "Z", coreBox: "B", depth: "1m", owner: "甲", sliceId: "S-CA", method: "m", expectedRev: env.rev }, requestId: "req-create-race-a" }),
  api("/api/samples", { method: "POST", body: { project: "并发乙", borehole: "Z", coreBox: "B", depth: "2m", owner: "乙", sliceId: "S-CB", method: "m", expectedRev: env.rev }, requestId: "req-create-race-b" })
]);
check("并发创建：一成一冲突", (cA.status === 201 && cB.status === 409) || (cB.status === 201 && cA.status === 409), { a: cA.status, b: cB.status });

// 8. 请求编号被复用于不同请求体
console.log("8) 编号挪用防护");
env = (await api("/api/samples")).data;
const x1 = await api("/api/samples", { method: "POST", body: { project: "编号复用", borehole: "Z", coreBox: "B", depth: "3m", owner: "甲", sliceId: "S-X", method: "m", expectedRev: env.rev }, requestId: "req-reuse" });
const x2 = await api("/api/samples", { method: "POST", body: { project: "不同内容", borehole: "Z", coreBox: "B", depth: "4m", owner: "乙", sliceId: "S-Y", method: "m", expectedRev: env.rev }, requestId: "req-reuse" });
check("同一编号不同请求体 → 409 idempotency_key_conflict", x1.status === 201 && x2.status === 409 && x2.data.error === "idempotency_key_conflict", { x1: x1.status, x2: x2.data });

console.log(`\\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
