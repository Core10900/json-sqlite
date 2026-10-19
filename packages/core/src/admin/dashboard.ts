export function getAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>JSONSQLite Admin</title>
  <style>
    :root { --bg:#0f1419; --card:#1a2332; --text:#e7ecf3; --accent:#3d9cf0; }
    body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:var(--bg); color:var(--text); }
    header { padding:1.25rem 1.5rem; border-bottom:1px solid #243044; }
    h1 { margin:0; font-size:1.25rem; letter-spacing:.02em; }
    main { padding:1.5rem; display:grid; gap:1rem; max-width:960px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:1rem; }
    .card { background:var(--card); padding:1rem; border-radius:8px; }
    .label { font-size:.75rem; opacity:.7; }
    .value { font-size:1.5rem; margin-top:.35rem; color:var(--accent); }
    textarea { width:100%; min-height:120px; background:#0c1018; color:var(--text); border:1px solid #2a3a52; border-radius:6px; padding:.75rem; font-family:ui-monospace,monospace; }
    button { margin-top:.75rem; background:var(--accent); color:#041018; border:0; padding:.5rem 1rem; border-radius:6px; font-weight:600; cursor:pointer; }
    pre { background:#0c1018; padding:1rem; border-radius:6px; overflow:auto; }
  </style>
</head>
<body>
  <header><h1>JSONSQLite Admin</h1></header>
  <main>
    <div class="grid" id="metrics"></div>
    <div class="card">
      <div class="label">Query (JSON)</div>
      <textarea id="q">{"collection":"users","filter":{},"limit":20}</textarea>
      <button id="run">Run</button>
      <pre id="out">{}</pre>
    </div>
  </main>
  <script>
    async function refresh() {
      const m = await fetch('/admin/metrics', { headers: auth() }).then(r => r.json());
      document.getElementById('metrics').innerHTML = [
        ['Queries', m.queriesTotal],
        ['Writes', m.writesTotal],
        ['Cache hit', ((m.cacheHitRate||0)*100).toFixed(1)+'%'],
        ['Errors', m.errorsTotal],
      ].map(([l,v]) => '<div class="card"><div class="label">'+l+'</div><div class="value">'+v+'</div></div>').join('');
    }
    function auth() {
      const t = localStorage.getItem('jsql_token');
      return t ? { Authorization: 'Bearer '+t } : {};
    }
    document.getElementById('run').onclick = async () => {
      const body = document.getElementById('q').value;
      const res = await fetch('/query', { method:'POST', headers:{ 'Content-Type':'application/json', ...auth() }, body });
      document.getElementById('out').textContent = JSON.stringify(await res.json(), null, 2);
      refresh();
    };
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}
