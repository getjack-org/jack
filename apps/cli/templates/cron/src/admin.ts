export function adminHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Uptime Monitor</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0d1117; color: #e6edf3; }
  .container { max-width: 960px; margin: 0 auto; padding: 48px 24px; }

  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; }
  h1 { font-size: 1.25rem; font-weight: 600; letter-spacing: -0.02em; }
  button { font-family: inherit; font-size: 0.8125rem; cursor: pointer; transition: all 0.15s; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; border-radius: 6px; font-weight: 500; }
  .btn-primary { background: #238636; color: #fff; border: 1px solid #2ea043; }
  .btn-primary:hover { background: #2ea043; }

  /* Global status banner */
  .banner { display: flex; align-items: center; gap: 10px; padding: 14px 18px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 28px; }
  .banner .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .banner .dot.up { background: #3fb950; box-shadow: 0 0 8px rgba(63,185,80,0.4); }
  .banner .dot.down { background: #f85149; box-shadow: 0 0 8px rgba(248,81,73,0.4); }
  .banner .dot.unknown { background: #484f58; }
  .banner-text { font-size: 0.875rem; font-weight: 500; }
  .banner-sub { font-size: 0.75rem; color: #8b949e; margin-left: auto; }

  /* Monitor group card */
  .group-card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; margin-bottom: 20px; overflow: hidden; }
  .group-header { display: flex; align-items: center; gap: 10px; padding: 18px 20px 0; }
  .group-name { font-size: 1rem; font-weight: 600; }
  .group-endpoints { font-size: 0.75rem; color: #8b949e; margin-left: auto; }
  .group-badge { font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; padding: 2px 8px; border-radius: 9999px; }
  .group-badge.up { background: rgba(63,185,80,0.15); color: #3fb950; border: 1px solid rgba(63,185,80,0.3); }
  .group-badge.down { background: rgba(248,81,73,0.15); color: #f85149; border: 1px solid rgba(248,81,73,0.3); }
  .group-streak { padding: 4px 20px 16px; font-size: 0.75rem; color: #8b949e; }

  /* Status bar (24h checks) */
  .status-bar-section { padding: 0 20px 16px; }
  .status-bar-label { display: flex; justify-content: space-between; font-size: 0.75rem; color: #8b949e; margin-bottom: 6px; }
  .status-bar { display: flex; gap: 2px; height: 28px; align-items: flex-end; }
  .status-block { flex: 1; min-width: 3px; border-radius: 2px; transition: opacity 0.15s; }
  .status-block.up { background: #238636; }
  .status-block.down { background: #f85149; }
  .status-block:hover { opacity: 0.7; }

  /* Period cards row */
  .periods { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid #30363d; }
  .period { padding: 16px 20px; }
  .period:not(:last-child) { border-right: 1px solid #30363d; }
  .period-label { font-size: 0.6875rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  .period-value { font-size: 1.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .period-detail { font-size: 0.6875rem; color: #8b949e; margin-top: 2px; }
  .pct-good { color: #3fb950; }
  .pct-warn { color: #d29922; }
  .pct-bad { color: #f85149; }
  .pct-none { color: #484f58; }

  /* Response time section */
  .response-section { border-top: 1px solid #30363d; padding: 16px 20px; }
  .response-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .response-title { font-size: 0.8125rem; font-weight: 500; }
  .response-stats { display: flex; gap: 16px; font-size: 0.6875rem; color: #8b949e; }
  .response-stats span { font-variant-numeric: tabular-nums; }
  .response-stats .val { color: #e6edf3; font-weight: 600; }
  .sparkline { display: flex; align-items: flex-end; gap: 1px; height: 40px; }
  .spark-bar { flex: 1; min-width: 2px; border-radius: 1px 1px 0 0; background: #238636; transition: opacity 0.15s; }
  .spark-bar.slow { background: #d29922; }
  .spark-bar.timeout { background: #f85149; }
  .spark-bar:hover { opacity: 0.7; }

  /* Recent checks table */
  .section { margin-top: 28px; }
  .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .section-header h2 { font-size: 0.875rem; font-weight: 500; }
  .section-header .count { font-size: 0.75rem; color: #8b949e; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; overflow: hidden; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
  th { text-align: left; padding: 10px 16px; font-weight: 500; font-size: 0.75rem; color: #8b949e; border-bottom: 1px solid #30363d; }
  td { padding: 10px 16px; border-bottom: 1px solid #21262d; color: #c9d1d9; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #1c2129; }
  .mono { font-family: 'SF Mono', SFMono-Regular, ui-monospace, monospace; font-size: 0.75rem; }
  .ok { color: #3fb950; }
  .fail { color: #f85149; }

  .empty-state { padding: 48px 24px; text-align: center; }
  .empty-state p { color: #8b949e; font-size: 0.875rem; margin-bottom: 4px; }
  .empty-state .hint { color: #484f58; font-size: 0.8125rem; }

  .toast { position: fixed; bottom: 24px; right: 24px; background: #e6edf3; color: #0d1117; padding: 10px 20px; border-radius: 8px; font-size: 0.8125rem; font-weight: 500; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
  .toast.show { opacity: 1; }
  .toast.error { background: #f85149; color: #fff; }

  @media (max-width: 640px) {
    .periods { grid-template-columns: 1fr; }
    .period:not(:last-child) { border-right: none; border-bottom: 1px solid #30363d; }
    .container { padding: 24px 16px; }
    header { flex-direction: column; align-items: flex-start; gap: 12px; }
    .response-stats { flex-wrap: wrap; gap: 8px; }
  }
</style>
</head>
<body>
<div class="container">

<header>
  <h1>Uptime Monitor</h1>
  <button class="btn btn-primary" onclick="trigger()">Check now</button>
</header>

<div class="banner" id="banner">
  <div class="dot unknown" id="status-dot"></div>
  <span class="banner-text" id="status-text">Loading...</span>
  <span class="banner-sub">Checked every 15 min</span>
</div>

<div id="monitors"></div>

<div class="section">
  <div class="section-header">
    <h2>Recent Checks</h2>
    <span class="count" id="checks-count"></span>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>Time</th><th>Group</th><th>Status</th><th>Latency</th><th>Source</th></tr></thead>
      <tbody id="checks"></tbody>
    </table>
    <div class="empty-state" id="checks-empty">
      <p>No checks yet</p>
      <p class="hint">Click "Check now" or wait for the first automatic check.</p>
    </div>
  </div>
</div>

</div>

<div class="toast" id="toast"></div>

<script>
function toast(msg, isError) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(function() { el.className = 'toast'; }, 2500);
}

function timeAgo(unix) {
  var diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 5) return 'just now';
  if (diff < 60) return diff + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}

function duration(seconds) {
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  if (seconds < 86400) {
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    return h + 'h ' + m + 'm';
  }
  var d = Math.floor(seconds / 86400);
  var hrs = Math.floor((seconds % 86400) / 3600);
  return d + 'd ' + hrs + 'h';
}

function pctClass(pct) {
  if (pct === null) return 'pct-none';
  if (pct >= 99.5) return 'pct-good';
  if (pct >= 95) return 'pct-warn';
  return 'pct-bad';
}

function renderStatusBar(checks) {
  if (!checks.length) return '<div class="status-bar"></div>';
  return '<div class="status-bar">' + checks.map(function(c) {
    return '<div class="status-block ' + (c.ok ? 'up' : 'down') + '" title="' + c.latency_ms + 'ms"></div>';
  }).join('') + '</div>';
}

function renderSparkline(checks) {
  if (!checks.length) return '';
  var maxMs = Math.max.apply(null, checks.map(function(c) { return c.latency_ms; }));
  if (maxMs === 0) maxMs = 1;
  return '<div class="sparkline">' + checks.map(function(c) {
    var h = Math.max(3, Math.round(40 * c.latency_ms / maxMs));
    var cls = 'spark-bar';
    if (c.latency_ms > 5000) cls += ' timeout';
    else if (c.latency_ms > 1000) cls += ' slow';
    return '<div class="' + cls + '" style="height:' + h + 'px" title="' + c.latency_ms + 'ms"></div>';
  }).join('') + '</div>';
}

function renderPeriod(label, p) {
  var val = p.uptime_pct !== null ? p.uptime_pct + '%' : '--.--%';
  var detail = p.total_checks > 0
    ? p.failed_checks + ' failed / ' + p.total_checks + ' checks'
    : 'No data';
  return '<div class="period">'
    + '<div class="period-label">' + label + '</div>'
    + '<div class="period-value ' + pctClass(p.uptime_pct) + '">' + val + '</div>'
    + '<div class="period-detail">' + detail + '</div>'
    + '</div>';
}

async function refresh() {
  try {
    var responses = await Promise.all([
      fetch('/api/status'), fetch('/api/checks')
    ]);
    var statusData = await responses[0].json();
    var checksData = await responses[1].json();

    var monitors = statusData.monitors || [];
    var checks = checksData.checks || [];

    // Banner
    var dot = document.getElementById('status-dot');
    var statusText = document.getElementById('status-text');
    if (monitors.length === 0) {
      dot.className = 'dot unknown';
      statusText.textContent = 'No data yet';
    } else {
      var allUp = monitors.every(function(m) { return m.all_up; });
      dot.className = 'dot ' + (allUp ? 'up' : 'down');
      statusText.textContent = allUp ? 'All systems operational' : 'Issues detected';
    }

    // Group cards
    var monitorsEl = document.getElementById('monitors');
    if (monitors.length === 0) {
      monitorsEl.innerHTML = '';
    } else {
      monitorsEl.innerHTML = monitors.map(function(m) {
        var endpoints = m.endpoint_count || 1;
        var streakText = m.all_up
          ? 'Currently up for ' + duration(m.streak_seconds)
          : 'Currently experiencing issues';
        var pct24 = m.periods['24h'].uptime_pct;
        var barLabel = pct24 !== null ? pct24 + '%' : 'No data';

        return '<div class="group-card">'
          + '<div class="group-header">'
          + '<span class="group-badge ' + (m.all_up ? 'up' : 'down') + '">' + (m.all_up ? 'Up' : 'Down') + '</span>'
          + '<span class="group-name">' + m.group_name + '</span>'
          + '<span class="group-endpoints">' + endpoints + ' endpoint' + (endpoints === 1 ? '' : 's') + '</span>'
          + '</div>'
          + '<div class="group-streak">' + streakText + '</div>'

          + '<div class="status-bar-section">'
          + '<div class="status-bar-label"><span>Last 24 hours</span><span>' + barLabel + '</span></div>'
          + renderStatusBar(m.recent_checks)
          + '</div>'

          + '<div class="periods">'
          + renderPeriod('24 hours', m.periods['24h'])
          + renderPeriod('7 days', m.periods['7d'])
          + renderPeriod('30 days', m.periods['30d'])
          + '</div>'

          + '<div class="response-section">'
          + '<div class="response-header">'
          + '<span class="response-title">Response time</span>'
          + '<div class="response-stats">'
          + '<span>avg <span class="val">' + m.latency.avg + 'ms</span></span>'
          + '<span>min <span class="val">' + m.latency.min + 'ms</span></span>'
          + '<span>max <span class="val">' + m.latency.max + 'ms</span></span>'
          + '</div></div>'
          + renderSparkline(m.recent_checks)
          + '</div>'

          + '</div>';
      }).join('');
    }

    // Checks table
    var checksBody = document.getElementById('checks');
    var checksEmpty = document.getElementById('checks-empty');
    var checksCount = document.getElementById('checks-count');
    if (checks.length) {
      checksEmpty.style.display = 'none';
      checksCount.textContent = checks.length + ' recent';
      checksBody.innerHTML = checks.map(function(c) { return '<tr>'
        + '<td>' + timeAgo(c.created_at) + '</td>'
        + '<td>' + c.group_name + '</td>'
        + '<td>' + (c.ok ? '<span class="ok">' + (c.status_code || 'OK') + '</span>' : '<span class="fail">' + (c.error || c.status_code || 'FAIL') + '</span>') + '</td>'
        + '<td class="mono">' + c.latency_ms + 'ms</td>'
        + '<td>' + (c.source === 'manual' ? '<span style="color:#d29922">manual</span>' : '<span style="color:#3fb950">cron</span>') + '</td>'
        + '</tr>'; }).join('');
    } else {
      checksEmpty.style.display = '';
      checksCount.textContent = '';
      checksBody.innerHTML = '';
    }
  } catch (e) {
    console.error('Refresh error:', e);
  }
}

async function trigger() {
  try {
    var res = await fetch('/api/trigger', { method: 'POST' });
    var data = await res.json();
    if (res.ok) {
      toast(data.all_ok ? 'All ' + data.checked + ' checks passed' : 'Issues detected');
      refresh();
    } else toast('Check failed', true);
  } catch (e) { toast('Network error', true); }
}

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;
}
