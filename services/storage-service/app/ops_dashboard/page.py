"""Self-contained ops dashboard HTML.

Kept as a Python string (not a Jinja template file) on purpose: storage-service
templates are baked into the Docker image and would need a rebuild to update,
whereas this string ships with the app code. No CDN / external requests — the
page is fully self-contained so it works even when offline or behind a strict
CSP.
"""

OPS_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ops Dashboard</title>
<style>
  :root {
    --bg:#0d1117; --surface:#161b22; --surface2:#1c2330; --border:#30363d;
    --fg:#e6edf3; --muted:#8b949e; --ok:#3fb950; --warn:#d29922; --err:#f85149;
    --info:#58a6ff; --accent:#bc8cff;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  header { display:flex; align-items:center; justify-content:space-between;
    padding:14px 20px; border-bottom:1px solid var(--border); background:var(--surface); }
  header h1 { font-size:16px; margin:0; font-weight:600; letter-spacing:.2px; }
  header .meta { color:var(--muted); font-size:12px; }
  main { display:grid; grid-template-columns:repeat(auto-fit,minmax(420px,1fr));
    gap:16px; padding:20px; max-width:1600px; margin:0 auto; }
  .card { background:var(--surface); border:1px solid var(--border); border-radius:10px;
    overflow:hidden; }
  .card > h2 { font-size:13px; margin:0; padding:10px 14px; border-bottom:1px solid var(--border);
    background:var(--surface2); font-weight:600; text-transform:uppercase; letter-spacing:.5px;
    color:var(--muted); display:flex; justify-content:space-between; align-items:center; }
  .card .body { padding:12px 14px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:500; font-size:11px; text-transform:uppercase; letter-spacing:.4px; }
  tr:last-child td { border-bottom:none; }
  td.num,th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600;
    text-transform:uppercase; letter-spacing:.4px; }
  .pill.ok { background:rgba(63,185,80,.15); color:var(--ok); }
  .pill.stale { background:rgba(248,81,73,.15); color:var(--err); }
  .pill.error { background:rgba(248,81,73,.18); color:var(--err); }
  .pill.unknown { background:rgba(139,148,158,.15); color:var(--muted); }
  .pill.disabled { background:rgba(139,148,158,.12); color:var(--muted); }
  .pill.healthy { background:rgba(63,185,80,.15); color:var(--ok); }
  .pill.unhealthy,.pill.unavailable { background:rgba(248,81,73,.15); color:var(--err); }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:4px 16px; }
  .kv .k { color:var(--muted); }
  .kv .v { text-align:right; font-variant-numeric:tabular-nums; }
  .bar { height:8px; background:var(--surface2); border-radius:999px; overflow:hidden; margin-top:4px; }
  .bar > span { display:block; height:100%; background:var(--info); }
  .bar > span.warn { background:var(--warn); }
  .bar > span.err { background:var(--err); }
  .alert { color:var(--err); font-weight:600; }
  .err-text { color:var(--err); font-size:12px; white-space:pre-wrap; word-break:break-word; }
  .muted { color:var(--muted); }
  .center { text-align:center; padding:40px; color:var(--muted); }
  code { background:var(--surface2); padding:1px 5px; border-radius:4px; font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>Storage Ops Dashboard</h1>
  <div class="meta"><span id="updated">loading…</span> &middot; auto-refresh 15s</div>
</header>
<main id="root"><div class="center">Loading…</div></main>
<script>
const REFRESH_MS = 15000;
const fmtBytes = (n) => {
  if (n == null) return "—";
  const u = ["B","KB","MB","GB","TB","PB"]; let i = 0; let v = Number(n);
  while (v >= 1024 && i < u.length-1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + " " + u[i];
};
const fmtAge = (s) => {
  if (s == null) return "—";
  s = Math.floor(s);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s/60) + "m " + (s%60) + "s";
  if (s < 86400) return Math.floor(s/3600) + "h " + Math.floor((s%3600)/60) + "m";
  return Math.floor(s/86400) + "d " + Math.floor((s%86400)/3600) + "h";
};
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function panel(title, inner, badge) {
  return `<section class="card"><h2>${esc(title)}${badge?`<span>${badge}</span>`:""}</h2><div class="body">${inner}</div></section>`;
}
function pill(state) { return `<span class="pill ${esc(state)}">${esc(state)}</span>`; }
function sectionErr(s) { return s && s.error ? `<div class="err-text">error: ${esc(s.error)}</div>` : null; }

function renderWorkers(w) {
  const e = sectionErr(w); if (e) return e;
  const rows = (w.workers||[]).map(x => `<tr>
    <td>${esc(x.name)}</td>
    <td>${pill(x.state)}</td>
    <td class="num">${x.last_run ? fmtAge(x.age_seconds)+" ago" : "—"}</td>
    <td>${x.counts && Object.keys(x.counts).length
      ? Object.entries(x.counts).map(([k,v])=>`${esc(k)}=${esc(v)}`).join(" ") : "—"}</td>
    <td class="err-text">${esc(x.last_error||"")}</td>
  </tr>`).join("");
  return `<table><thead><tr><th>Worker</th><th>State</th><th class="num">Last run</th>
    <th>Last cycle</th><th>Error</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function distTable(title, dist, withBytes) {
  if (!dist) return "";
  const rows = Object.entries(dist).map(([k,v]) => {
    const count = withBytes ? v.count : v;
    const bytes = withBytes ? v.bytes : null;
    const alert = (title==="backup_status" && k==="failed" && count>0)
      || (title==="health_status" && k==="broken" && count>0);
    return `<tr><td class="${alert?"alert":""}">${esc(k)}</td>
      <td class="num ${alert?"alert":""}">${esc(count)}</td>
      ${withBytes?`<td class="num muted">${fmtBytes(bytes)}</td>`:""}</tr>`;
  }).join("");
  return `<table><thead><tr><th>${esc(title)}</th><th class="num">count</th>
    ${withBytes?`<th class="num">size</th>`:""}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderInventory(inv) {
  const e = sectionErr(inv); if (e) return e;
  return `<div style="display:grid;gap:12px">
    ${distTable("backup_status", inv.backup_status)}
    ${distTable("health_status", inv.health_status)}
    ${distTable("storage_tier", inv.storage_tier, true)}
    ${distTable("storage_type", inv.storage_type, true)}
    <div class="kv"><div class="k">Quarantined</div>
      <div class="v ${inv.quarantined>0?"alert":""}">${esc(inv.quarantined)}</div></div>
    ${inv.video_queue && Object.keys(inv.video_queue).length
      ? distTable("video_processing", inv.video_queue) : ""}
  </div>`;
}

function renderInfra(infra) {
  const e = sectionErr(infra); if (e) return e;
  const sys = infra.system||{}, redis = infra.redis||{}, db = infra.db||{};
  const cpu = sys.cpu ? sys.cpu.percent : null;
  const mem = sys.memory||{}, disk = sys.disk||{};
  const barCls = (p) => p>=90?"err":p>=70?"warn":"";
  const pool = db.connection_pool||{};
  const dbStat = (db.database&&db.database.size_human) ? db.database.size_human : null;
  return `<div class="kv">
    <div class="k">CPU</div><div class="v">${cpu!=null?cpu+"%":"—"}</div>
    <div class="k">Memory</div><div class="v">${mem.used||"—"} / ${mem.total||"—"} (${mem.percent!=null?mem.percent+"%":"—"})</div>
    <div class="k">Disk</div><div class="v">${disk.used||"—"} / ${disk.total||"—"} (${disk.percent!=null?disk.percent+"%":"—"})</div>
    <div class="k">Redis</div><div class="v">${pill(redis.status||"unknown")} ${redis.used_memory?("· "+redis.used_memory):""}</div>
    <div class="k">Database</div><div class="v">${db.status?pill(db.status):"—"} ${dbStat?("· "+dbStat):""}</div>
    <div class="k">DB pool</div><div class="v">${pool.size!=null?`${pool.checked_out||0}/${pool.size} (${pool.utilization_percent!=null?pool.utilization_percent+"%":"—"})`:"—"}</div>
  </div>
  <div class="bar"><span class="${barCls(mem.percent)}" style="width:${mem.percent||0}%"></span></div>`;
}

function renderUsers(u) {
  const e = sectionErr(u); if (e) return e;
  const planRows = (u.by_plan||[]).map(p => `<tr><td>${esc(p.plan_type||"—")}</td>
    <td class="num">${esc(p.users)}</td><td class="num muted">${fmtBytes(p.storage_used)}</td></tr>`).join("");
  const topRows = (u.top_consumers||[]).map(t => `<tr><td>${esc(t.email)}</td>
    <td class="num">${fmtBytes(t.storage_used)}</td><td class="num muted">${fmtBytes(t.storage_quota)}</td></tr>`).join("");
  return `<div class="kv" style="margin-bottom:10px">
      <div class="k">Total users</div><div class="v">${esc(u.total_users)}</div>
      <div class="k">Total used</div><div class="v">${fmtBytes(u.total_used)}</div>
      <div class="k">Total quota</div><div class="v">${fmtBytes(u.total_quota)}</div>
    </div>
    <table><thead><tr><th>Plan</th><th class="num">users</th><th class="num">used</th></tr></thead>
      <tbody>${planRows}</tbody></table>
    <h2 style="margin:12px 0 4px;background:none;border:none;padding:0">Top consumers</h2>
    <table><thead><tr><th>User</th><th class="num">used</th><th class="num">quota</th></tr></thead>
      <tbody>${topRows}</tbody></table>`;
}

function renderCapacity(cap) {
  const e = sectionErr(cap); if (e) return e;
  const rows = (cap.volumes||[]).map(v => {
    const pct = v.total ? Math.round(100*v.used/v.total) : 0;
    const cls = pct>=90?"err":pct>=70?"warn":"";
    return `<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between">
        <span>${esc(v.label)} <span class="muted">${esc(v.mount||"")}</span></span>
        <span class="muted">${fmtBytes(v.used)} / ${fmtBytes(v.total)} (${pct}%)</span>
      </div>
      <div class="bar"><span class="${cls}" style="width:${pct}%"></span></div>
      <div class="muted" style="font-size:12px">free ${fmtBytes(v.free)}</div>
    </div>`;
  }).join("");
  const head = cap.quota_headroom != null ? `<div class="kv" style="margin-bottom:12px">
      <div class="k">Quota headroom (quota − used)</div>
      <div class="v ${cap.quota_headroom<0?"alert":""}">${fmtBytes(cap.quota_headroom)}</div>
    </div>` : "";
  return head + rows;
}

async function load() {
  let d;
  try {
    const r = await fetch("/api/v1/admin/ops/data", { credentials: "include" });
    if (r.status === 401 || r.status === 403) {
      document.getElementById("root").innerHTML =
        `<div class="center">Not authorized — log in as an admin.</div>`;
      return;
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    d = await r.json();
  } catch (err) {
    document.getElementById("root").innerHTML =
      `<div class="center err-text">Failed to load: ${esc(err.message)}</div>`;
    return;
  }
  document.getElementById("root").innerHTML = [
    panel("Worker health", renderWorkers(d.workers||{})),
    panel("Object inventory", renderInventory(d.inventory||{})),
    panel("Infra health", renderInfra(d.infra||{})),
    panel("Users & storage", renderUsers(d.users||{})),
    panel("Capacity / storage available", renderCapacity(d.capacity||{})),
  ].join("");
  document.getElementById("updated").textContent =
    "updated " + new Date().toLocaleTimeString();
}
load();
setInterval(load, REFRESH_MS);
</script>
</body>
</html>
"""
