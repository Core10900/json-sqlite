export function getAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>JSONSQLite Admin</title>
  <style>
    :root { --bg:#0f1419; --card:#1a2332; --text:#e7ecf3; --accent:#3d9cf0; --muted:#8b9bb4; }
    body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--text); }
    header { padding:1.25rem 1.5rem; border-bottom:1px solid #243044; display:flex; justify-content:space-between; align-items:center; }
    h1 { margin:0; font-size:1.25rem; letter-spacing:.02em; }
    .live { font-size:.75rem; color:var(--muted); }
    .live.on { color:#3dd68c; }
    main { padding:1.5rem; display:grid; gap:1rem; max-width:1100px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:1rem; }
    .card { background:var(--card); padding:1rem; border-radius:8px; }
    .label { font-size:.75rem; opacity:.7; }
    .value { font-size:1.5rem; margin-top:.35rem; color:var(--accent); }
    h2 { margin:0 0 .75rem; font-size:1rem; }
    textarea, input { width:100%; box-sizing:border-box; background:#0c1018; color:var(--text); border:1px solid #2a3a52; border-radius:6px; padding:.75rem; font-family:ui-monospace,monospace; }
    textarea { min-height:100px; }
    button { margin-top:.75rem; margin-right:.5rem; background:var(--accent); color:#041018; border:0; padding:.5rem 1rem; border-radius:6px; font-weight:600; cursor:pointer; }
    button.secondary { background:#2a3a52; color:var(--text); }
    pre { background:#0c1018; padding:1rem; border-radius:6px; overflow:auto; max-height:240px; font-size:.8rem; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
    @media (max-width:720px) { .row { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>JSONSQLite Admin</h1>
    <span class="live" id="live">SSE: connecting…</span>
  </header>
  <main>
    <div class="grid" id="metrics"></div>
    <div class="row">
      <div class="card">
        <h2>Tables</h2>
        <pre id="tables">[]</pre>
        <button class="secondary" id="refreshTables">Refresh</button>
      </div>
      <div class="card">
        <h2>Slow queries</h2>
        <pre id="slow">[]</pre>
        <button class="secondary" id="refreshSlow">Refresh</button>
      </div>
    </div>
    <div class="row">
      <div class="card">
        <h2>Advise (JsonQuery)</h2>
        <textarea id="adviseQ">{"collection":"users","filter":{"age":{"$gte":18}}}</textarea>
        <button id="runAdvise">Advise</button>
        <pre id="adviseOut">{}</pre>
      </div>
      <div class="card">
        <h2>Backup / Time travel</h2>
        <button id="runBackup">Full backup</button>
        <pre id="backupOut">{}</pre>
        <label class="label">collection</label>
        <input id="ttCol" value="users" />
        <label class="label">timestamp (ms)</label>
        <input id="ttTs" value="" placeholder="Date.now()" />
        <button id="runTT">Query at time</button>
        <pre id="ttOut">{}</pre>
      </div>
    </div>
    <div class="card">
      <h2>Query (JSON)</h2>
      <textarea id="q">{"collection":"users","filter":{},"limit":20}</textarea>
      <button id="run">Run</button>
      <pre id="out">{}</pre>
    </div>
  </main>
  <script>
    function auth() {
      const t = localStorage.getItem('jsql_token');
      return t ? { Authorization: 'Bearer '+t } : {};
    }
    async function refreshMetrics(m) {
      const data = m || await fetch('/admin/metrics', { headers: auth() }).then(r => r.json());
      document.getElementById('metrics').innerHTML = [
        ['Queries', data.queriesTotal],
        ['Writes', data.writesTotal],
        ['Cache hit', ((data.cacheHitRate||0)*100).toFixed(1)+'%'],
        ['Errors', data.errorsTotal],
        ['Slow', (data.recentSlow||[]).length],
      ].map(([l,v]) => '<div class="card"><div class="label">'+l+'</div><div class="value">'+v+'</div></div>').join('');
    }
    async function refreshTables() {
      const r = await fetch('/admin/tables', { headers: auth() }).then(r => r.json());
      document.getElementById('tables').textContent = JSON.stringify(r.tables||r, null, 2);
    }
    async function refreshSlow() {
      const r = await fetch('/admin/slow', { headers: auth() }).then(r => r.json());
      document.getElementById('slow').textContent = JSON.stringify(r.slow||r, null, 2);
    }
    document.getElementById('refreshTables').onclick = refreshTables;
    document.getElementById('refreshSlow').onclick = refreshSlow;
    document.getElementById('run').onclick = async () => {
      const body = document.getElementById('q').value;
      const res = await fetch('/query', { method:'POST', headers:{ 'Content-Type':'application/json', ...auth() }, body });
      document.getElementById('out').textContent = JSON.stringify(await res.json(), null, 2);
      refreshMetrics();
      refreshSlow();
    };
    document.getElementById('runAdvise').onclick = async () => {
      const body = document.getElementById('adviseQ').value;
      const res = await fetch('/admin/advise', { method:'POST', headers:{ 'Content-Type':'application/json', ...auth() }, body });
      document.getElementById('adviseOut').textContent = JSON.stringify(await res.json(), null, 2);
    };
    document.getElementById('runBackup').onclick = async () => {
      const res = await fetch('/admin/backup', { method:'POST', headers:{ ...auth() } });
      document.getElementById('backupOut').textContent = JSON.stringify(await res.json(), null, 2);
    };
    document.getElementById('runTT').onclick = async () => {
      const collection = document.getElementById('ttCol').value;
      const timestamp = Number(document.getElementById('ttTs').value || Date.now());
      const res = await fetch('/admin/timetravel', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', ...auth() },
        body: JSON.stringify({ collection, timestamp })
      });
      document.getElementById('ttOut').textContent = JSON.stringify(await res.json(), null, 2);
    };
    try {
      const t = localStorage.getItem('jsql_token');
      const es = new EventSource('/admin/events' + (t ? '?token='+encodeURIComponent(t) : ''));
      const live = document.getElementById('live');
      es.onopen = () => { live.textContent = 'SSE: live'; live.className = 'live on'; };
      es.onerror = () => { live.textContent = 'SSE: reconnecting…'; live.className = 'live'; };
      es.addEventListener('metrics', (e) => refreshMetrics(JSON.parse(e.data)));
      es.addEventListener('dataChanged', () => { refreshTables(); refreshSlow(); });
    } catch (e) {
      document.getElementById('live').textContent = 'SSE: unavailable';
    }
    refreshMetrics();
    refreshTables();
    refreshSlow();
    document.getElementById('ttTs').value = String(Date.now());
  </script>
</body>
</html>`;
}
