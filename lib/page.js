// 页面模块：返回单页前端（样本/切片/步骤录入 + 交付快照查询）。

export const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>岩芯样本切片实验室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#242822; --muted:#687062; --line:#d7ddd1; --accent:#526f43; --stone:#73706a; --warn:#b25a2e; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:16px; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:390px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(310px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .pill.done { background:#eef3ea; color:var(--accent); border-color:var(--accent); }
    .slice { border-top:1px solid var(--line); padding-top:10px; } .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
    .banner { background:#fdf1e8; border:1px solid var(--warn); color:var(--warn); border-radius:8px; padding:10px 14px; margin-bottom:14px; font-size:14px; }
    .snap { border-top:1px dashed var(--line); padding:10px 0; } .snap:first-of-type { border-top:0; padding-top:0; }
    @media (max-width:950px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .stats{grid-template-columns:1fr 1fr;} }
  </style>
</head>
<body>
  <header><div><h1>岩芯样本切片实验室</h1><div class="meta">样本、切片任务、制片步骤和交付 · 提交带请求编号，重复提交不重复入账</div></div><button id="reload" class="ghost">刷新</button></header>
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
      <div id="banner"></div>
      <div class="stats" id="stats"></div>
      <div class="grid" id="samples"></div>
      <div class="panel" style="margin-top:18px">
        <h2>交付快照（已交付样本留档，可随时查询）</h2>
        <div id="deliveries" class="meta">暂无交付记录</div>
      </div>
    </section>
  </main>
  <script>
    const statuses = ${JSON.stringify(["待切割", "制片中", "待观察", "已交付"])};
    const steps = ${JSON.stringify(["取样", "切割", "研磨", "染色", "观察"])};
    const form = document.querySelector("#form");
    const stats = document.querySelector("#stats");
    const samplesEl = document.querySelector("#samples");
    const deliveriesEl = document.querySelector("#deliveries");
    const bannerEl = document.querySelector("#banner");
    let samples = [];
    let version = 0;

    function rid() { return (crypto.randomUUID && crypto.randomUUID()) || ("req-" + Date.now() + "-" + Math.random().toString(36).slice(2)); }
    function banner(msg) { bannerEl.innerHTML = msg ? '<div class="banner">'+msg+'</div>' : ''; }

    async function api(path, options) {
      const headers = { "Content-Type": "application/json" };
      if (options && options.body) {
        headers["X-Request-Id"] = options.requestId || rid();
        headers["X-Expected-Version"] = String(version);
      }
      const res = await fetch(path, { ...options, headers });
      const data = await res.json();
      if (res.status === 409 && data.error === "version_conflict") {
        banner("版本冲突：有更新的写入先到一步（当前版本 " + data.currentVersion + "）。已为你刷新，请核对后重新提交。");
        await load();
        const err = new Error("version_conflict"); err.conflict = true; throw err;
      }
      if (!res.ok) throw new Error(data.error || "请求失败");
      if (typeof data.version === "number") version = data.version;
      return data;
    }

    function render() {
      stats.innerHTML = statuses.map(s => '<div class="stat"><span>'+s+'</span><strong>'+samples.filter(item => item.status === s).length+'</strong></div>').join("");
      samplesEl.innerHTML = samples.map(sample => {
        const delivered = sample.delivery === "已交付";
        return '<article class="card"><h3>'+sample.project+'</h3>'+
          '<span class="pill '+(delivered?'done':'')+'">'+sample.status+' · '+(delivered?'已交付':'未交付')+'</span>'+
          '<div class="meta">'+sample.borehole+' · '+sample.coreBox+' · '+sample.depth+' · '+sample.owner+'</div>'+
          (sample.deliveryInvalidatedAt ? '<div class="meta" style="color:var(--warn)">交付结论已于 '+new Date(sample.deliveryInvalidatedAt).toLocaleString()+' 失效，需重新交付</div>' : '')+
          '<label>新增切片</label><input data-new-slice="'+sample.id+'" placeholder="切片编号"><input data-method="'+sample.id+'" placeholder="染色方法"><button data-add="'+sample.id+'">添加切片</button>'+
          sample.slices.map(slice => '<div class="slice"><b>'+slice.id+'</b><div class="meta">'+slice.method+' · 当前步骤 '+slice.status+'</div><select data-step="'+sample.id+'|'+slice.id+'">'+steps.map(step => '<option>'+step+'</option>').join("")+'</select><textarea data-note="'+sample.id+'|'+slice.id+'" placeholder="步骤备注或观察结果"></textarea><button data-log="'+sample.id+'|'+slice.id+'">记录步骤</button><div class="meta">'+slice.logs.map(log => log.step+"："+log.note).join(" / ")+'</div></div>').join("")+
          '<button data-deliver="'+sample.id+'" '+(delivered?'disabled':'')+'>'+(delivered?'已交付':'标记交付')+'</button></article>';
      }).join("");
      document.querySelectorAll("[data-step]").forEach(sel => {
        const [sampleId, sliceId] = sel.dataset.step.split("|");
        const slice = samples.find(s => s.id === sampleId).slices.find(s => s.id === sliceId);
        sel.value = slice.status;
      });
      document.querySelectorAll("[data-add]").forEach(btn => btn.onclick = async () => {
        const id = btn.dataset.add;
        try {
          await api('/api/samples/'+id+'/slices', { method:'POST', requestId: rid(), body: JSON.stringify({ id: document.querySelector('[data-new-slice="'+id+'"]').value, method: document.querySelector('[data-method="'+id+'"]').value || "未指定" }) });
          banner(""); await load();
        } catch (e) { if (!e.conflict) alert(e.message); }
      });
      document.querySelectorAll("[data-log]").forEach(btn => btn.onclick = async () => {
        const [sampleId, sliceId] = btn.dataset.log.split("|");
        try {
          await api('/api/samples/'+sampleId+'/slices/'+sliceId+'/logs', { method:'POST', requestId: rid(), body: JSON.stringify({ step: document.querySelector('[data-step="'+sampleId+'|'+sliceId+'"]').value, note: document.querySelector('[data-note="'+sampleId+'|'+sliceId+'"]').value || "步骤完成" }) });
          banner(""); await load();
        } catch (e) { if (!e.conflict) alert(e.message); }
      });
      document.querySelectorAll("[data-deliver]").forEach(btn => btn.onclick = async () => {
        try {
          await api('/api/samples/'+btn.dataset.deliver+'/deliver', { method:'POST', requestId: rid(), body: JSON.stringify({}) });
          banner(""); await load();
        } catch (e) { if (!e.conflict) alert(e.message); }
      });
    }

    async function loadDeliveries() {
      const data = await api("/api/deliveries");
      const list = data.deliveries || [];
      if (!list.length) { deliveriesEl.textContent = "暂无交付记录"; return; }
      deliveriesEl.innerHTML = list.map(d => '<div class="snap"><b>'+d.sampleId+'</b> · '+d.project+
        '<div class="meta">交付于 '+new Date(d.deliveredAt).toLocaleString()+' · 切片 '+d.sliceCount+' 条 · 状态 '+d.status+'</div>'+
        '<div class="meta">快照切片：'+d.slices.map(s => s.id+'('+s.status+')').join("、")+'</div></div>').join("");
    }
    async function load(){ samples = (await api("/api/samples")).samples; render(); await loadDeliveries(); }
    document.querySelector("#reload").onclick = () => { banner(""); load(); };
    form.onsubmit = async event => {
      event.preventDefault();
      try {
        await api("/api/samples", { method:"POST", requestId: rid(), body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset(); banner(""); await load();
      } catch (e) { if (!e.conflict) alert(e.message); }
    };
    load();
  </script>
</body>
</html>`;
