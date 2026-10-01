// 页面：浏览器端。每次提交生成请求编号（X-Request-Id），携带读到的版本号；
// 409 版本冲突时刷新数据，其他写入失败可用同一编号重试，不会重复追加记录。

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --warn:#a05a1f; --ok:#3f6b4b; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:60px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.delivered { background:var(--ok); color:#fff; border-color:var(--ok); } .pill.invalid { background:var(--warn); color:#fff; border-color:var(--warn); }
    .slice { border-top:1px solid var(--line); padding-top:10px; }
    .snapshots { margin-top:8px; border-top:1px dashed var(--line); padding-top:8px; } .snap { font-size:12px; color:var(--muted); margin:4px 0; }
    .toast { position:fixed; right:18px; bottom:18px; max-width:420px; display:grid; gap:8px; z-index:10; }
    .toast div { background:#2c332a; color:#fff; border-radius:8px; padding:10px 14px; font-size:13px; box-shadow:0 6px 20px rgba(0,0,0,.18); }
    .toast .conflict { background:var(--warn); } .toast .dup { background:var(--muted); }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯样本切片实验室</h1><div class="meta">样本、切片任务、制片步骤和交付 · 请求编号 + 版本号防重复/防覆盖</div></div><button id="reload">刷新</button></header>
  <main>
    <form id="form">
      <h2>创建岩芯样本</h2>
      <label>项目</label><input name="project" required>
      <label>钻孔编号</label><input name="borehole" required>
      <label>岩芯箱号</label><input name="coreBox" required>
      <label>取样深度</label><input name="depth" required>
      <label>负责人</label><input name="owner" required>
      <label>初始切片编号</label><input name="sliceId" required>
      <label>染色方法</label><input name="method" required>
      <button>保存样本</button>
    </form>
    <section>
      <div class="stats" id="stats"></div>
      <div class="grid" id="samples"></div>
    </section>
  </main>
  <div class="toast" id="toast"></div>
  <script>
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    const toastEl = document.querySelector("#toast");
    let env = { rev: 0, statuses: [], steps: [], samples: [] };

    function newRequestId() {
      return (crypto.randomUUID && crypto.randomUUID()) ||
        "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }
    function escapeHtml(value) {
      return String(value == null ? "" : value).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
    }
    function toast(message, kind) {
      const el = document.createElement("div");
      if (kind) el.className = kind;
      el.textContent = message;
      toastEl.appendChild(el);
      setTimeout(() => el.remove(), 5000);
    }

    // 带请求编号的提交：失败时可用同一编号重试（按钮上挂着当前 requestId）。
    async function submit(path, payload, retryEl) {
      const requestId = retryEl.dataset.requestId || newRequestId();
      retryEl.dataset.requestId = requestId;
      let res, data;
      try {
        res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Request-Id": requestId }, body: JSON.stringify(payload) });
        data = await res.json();
      } catch (networkError) {
        throw Object.assign(new Error("network"), { requestId, retryable: true });
      }
      if (res.ok) return data;
      if (res.status === 409 && data.error === "version_conflict") {
        throw Object.assign(new Error("version_conflict"), { conflict: true });
      }
      throw Object.assign(new Error(data.error || "请求失败"), { requestId, code: data.error, details: data.details, retryable: res.status >= 500 || res.status === 429 });
    }

    async function mutate(path, payload, retryEl) {
      try {
        const data = await submit(path, payload, retryEl);
        if (data.deduped) toast("同一步骤已提交过，沿用第一次结果（未重复追加）", "dup");
        await load();
      } catch (error) {
        if (error.conflict) {
          toast("版本冲突：已有另一笔提交先写入，数据已刷新，请在最新版本上重试", "conflict");
          await load();
          return;
        }
        const msg = error.code === "not_deliverable"
          ? "还不能交付：仍有切片未完成观察"
          : "提交失败：" + error.message + "（请求编号 " + error.requestId + "）。再点一次可用同一编号重试，不会重复记录";
        toast(msg, "conflict");
      }
    }

    function render() {
      stats.innerHTML = env.statuses.map(s => '<div class="stat"><span>'+s+'</span><strong>'+env.samples.filter(item => item.status === s).length+'</strong></div>').join("");
      samplesEl.innerHTML = env.samples.map(sample => {
        const deliverPill = sample.delivery === "已交付"
          ? '<span class="pill delivered">已交付 v'+sample.rev+'</span>'
          : (sample.deliveryInvalidatedAt
              ? '<span class="pill invalid">交付已失效 · 重算中</span>'
              : '<span class="pill">未交付</span>');
        const invalidNote = sample.deliveryInvalidReason
          ? '<div class="meta">失效原因：'+escapeHtml(sample.deliveryInvalidReason)+'</div>' : "";
        const snapshots = (sample.deliverySnapshots || []).map(snap =>
          '<div class="snap">📦 交付快照 '+new Date(snap.deliveredAt).toLocaleString()+' · 版本 '+snap.rev+(snap.handoverTo ? ' · 接收人 '+escapeHtml(snap.handoverTo) : '')+'</div>'
        ).join("");
        return '<article class="card"><h3>'+escapeHtml(sample.project)+'</h3>'
          + '<div><span class="pill">'+escapeHtml(sample.status)+'</span> '+deliverPill+' <span class="meta">样本版本 '+sample.rev+'</span></div>'
          + '<div class="meta">'+escapeHtml(sample.borehole)+' · '+escapeHtml(sample.coreBox)+' · '+escapeHtml(sample.depth)+' · '+escapeHtml(sample.owner)+'</div>'
          + invalidNote
          + '<label>新增切片</label><input data-new-slice="'+sample.id+'" placeholder="切片编号"><input data-method="'+sample.id+'" placeholder="染色方法"><button data-add="'+sample.id+'">添加切片</button>'
          + sample.slices.map(slice =>
            '<div class="slice"><b>'+escapeHtml(slice.id)+'</b><div class="meta">'+escapeHtml(slice.method)+' · 当前步骤 '+escapeHtml(slice.status)+'</div>'
            + '<select data-step="'+sample.id+'|'+slice.id+'">'+env.steps.map(step => '<option'+(step===slice.status?' selected':'')+'>'+step+'</option>').join("")+'</select>'
            + '<textarea data-note="'+sample.id+'|'+slice.id+'" placeholder="步骤备注或观察结果"></textarea>'
            + '<button data-log="'+sample.id+'|'+slice.id+'">记录步骤</button>'
            + '<div class="meta">'+slice.logs.map(log => escapeHtml(log.step)+"："+escapeHtml(log.note)).join(" / ")+'</div></div>'
          ).join("")
          + '<button data-deliver="'+sample.id+'">标记交付</button>'
          + (snapshots ? '<div class="snapshots"><div class="meta">历史交付快照（样本变化后仍可查）</div>'+snapshots+'</div>' : "")
          + '</article>';
      }).join("");

      document.querySelectorAll("[data-add]").forEach(btn => btn.onclick = () => {
        const id = btn.dataset.add;
        const sample = env.samples.find(s => s.id === id);
        mutate('/api/samples/'+id+'/slices', {
          id: document.querySelector('[data-new-slice="'+id+'"]').value,
          method: document.querySelector('[data-method="'+id+'"]').value || "未指定",
          expectedRev: sample.rev
        }, btn);
      });
      document.querySelectorAll("[data-log]").forEach(btn => btn.onclick = () => {
        const [sampleId, sliceId] = btn.dataset.log.split("|");
        const sample = env.samples.find(s => s.id === sampleId);
        mutate('/api/samples/'+sampleId+'/slices/'+sliceId+'/logs', {
          step: document.querySelector('[data-step="'+sampleId+'|'+sliceId+'"]').value,
          note: document.querySelector('[data-note="'+sampleId+'|'+sliceId+'"]').value || "步骤完成",
          expectedRev: sample.rev
        }, btn);
      });
      document.querySelectorAll("[data-deliver]").forEach(btn => btn.onclick = () => {
        const sample = env.samples.find(s => s.id === btn.dataset.deliver);
        mutate('/api/samples/'+btn.dataset.deliver+'/deliver', { expectedRev: sample.rev }, btn);
      });
    }

    async function load() {
      const res = await fetch("/api/samples");
      env = await res.json();
      render();
    }
    document.querySelector("#reload").onclick = load;
    form.onsubmit = async event => {
      event.preventDefault();
      const btn = form.querySelector("button");
      // 重试时以当前最新整库版本号提交（首次提交后若他人已写入，旧版本号本就该冲突）。
      await mutate("/api/samples", { ...Object.fromEntries(new FormData(form).entries()), expectedRev: env.rev }, btn);
      form.reset();
    };
    load();
  </script>
</body>
</html>`;

export { page };
