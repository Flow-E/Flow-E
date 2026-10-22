/**
 * The control panel page: static HTML, CSS and JS, served by the panel app. No build step and
 * no inline script (the Content-Security-Policy forbids it). Everything that comes from the
 * ledger, including text an agent wrote, is inserted with textContent, never as HTML.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flow-E control panel</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header class="top">
  <div>
    <h1>Flow-E</h1>
    <p class="sub">Local control panel · authorizes payments, never moves money</p>
  </div>
  <div class="kill" id="kill"></div>
</header>
<main>
  <p class="banner error" id="error" hidden></p>
  <section>
    <h2>Waiting for approval <span class="count" id="pending-count"></span></h2>
    <div id="pending"></div>
  </section>
  <section>
    <h2>Cooling-off <span class="count" id="cooling-count"></span></h2>
    <p class="hint">First payments to a new supplier can be cancelled for 10 minutes.</p>
    <div id="cooling"></div>
  </section>
  <section>
    <h2>Agents</h2>
    <div id="agents"></div>
  </section>
  <section>
    <div class="row-between">
      <h2>Ledger</h2>
      <button type="button" id="export" class="secondary">Export CSV</button>
    </div>
    <p class="audit" id="audit"></p>
    <div class="table-wrap"><table id="payments"></table></div>
  </section>
</main>
<footer><span id="issuer"></span> · <span id="updated"></span></footer>
</body>
</html>
`;

export const APP_CSS = `:root {
  color-scheme: light dark;
  --bg: #f7f7f5; --surface: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e3e2de;
  --accent: #1f5f8b; --ok: #1e7a46; --ok-bg: #e5f3ea; --warn: #8a5a00; --warn-bg: #fbf0d9;
  --bad: #a3262a; --bad-bg: #f8e3e3; --idle-bg: #ecebe8;
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --surface: #1f1f1d; --text: #ecebe7; --muted: #9b9a94; --line: #34332f;
    --accent: #7fb6dd; --ok: #7ccf9b; --ok-bg: #1d3326; --warn: #e7bd6a; --warn-bg: #3a2f17;
    --bad: #f08f8f; --bad-bg: #3d1f1f; --idle-bg: #2b2a27;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
.top { display: flex; justify-content: space-between; align-items: center; gap: 16px;
  padding: 20px 24px; border-bottom: 1px solid var(--line); background: var(--surface); flex-wrap: wrap; }
h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
h2 { margin: 0 0 10px; font-size: 16px; }
.sub, .hint, footer, .audit { color: var(--muted); font-size: 13px; }
.sub { margin: 2px 0 0; }
.hint { margin: -4px 0 10px; }
main { max-width: 1100px; margin: 0 auto; padding: 16px 24px 40px; }
section { background: var(--surface); border: 1px solid var(--line); border-radius: 10px;
  padding: 16px 18px; margin-top: 16px; }
.count { color: var(--muted); font-weight: 400; }
.empty { color: var(--muted); margin: 0; }
.card { border-top: 1px solid var(--line); padding: 12px 0; display: flex; gap: 16px;
  justify-content: space-between; align-items: flex-start; flex-wrap: wrap; }
.card:first-child { border-top: 0; padding-top: 0; }
.card .what { font-weight: 600; }
.card .meta { color: var(--muted); font-size: 13px; }
.card .why { margin-top: 4px; }
.card .memo { margin-top: 4px; font-style: italic; color: var(--muted); }
.actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
button { font: inherit; border-radius: 7px; border: 1px solid transparent; padding: 6px 14px;
  cursor: pointer; background: var(--accent); color: #fff; }
button:hover { filter: brightness(1.08); }
button:disabled { opacity: 0.5; cursor: default; }
button.secondary { background: transparent; color: var(--text); border-color: var(--line); }
button.danger { background: var(--bad); }
button.approve { background: var(--ok); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.pill { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px;
  font-weight: 600; background: var(--idle-bg); color: var(--muted); white-space: nowrap; }
.pill.approved, .pill.active, .pill.off { background: var(--ok-bg); color: var(--ok); }
.pill.review, .pill.paused { background: var(--warn-bg); color: var(--warn); }
.pill.declined, .pill.frozen, .pill.on, .pill.cancelled { background: var(--bad-bg); color: var(--bad); }
.kill { display: flex; align-items: center; gap: 12px; }
.kill.engaged { padding: 8px 12px; border-radius: 8px; background: var(--bad-bg); }
.agent-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.agent { border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
.agent .name { font-weight: 600; display: flex; justify-content: space-between; gap: 8px; }
.agent dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 10px 0; font-size: 13px; }
.agent dt { color: var(--muted); }
.agent dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.row-between { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 7px 8px; border-top: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; border-top: 0; }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.reason { max-width: 380px; }
.banner { padding: 10px 14px; border-radius: 8px; margin: 16px 0 0; }
.banner.error { background: var(--bad-bg); color: var(--bad); }
.audit.bad { color: var(--bad); font-weight: 600; }
footer { max-width: 1100px; margin: 0 auto; padding: 0 24px 32px; }
@media (max-width: 600px) {
  .top, main, footer { padding-left: 16px; padding-right: 16px; }
  .card { flex-direction: column; }
}
`;

export const APP_JS = `'use strict';
(function () {
  var TOKEN_KEY = 'flow-e-panel-token';
  var token = '';
  // Take the token from the link's #fragment (never sent to the server), keep it for this tab
  // only, and remove it from the address bar. Also runs when the link is pasted into an open tab.
  function readToken() {
    var match = /(?:^|[#&])token=([A-Za-z0-9_-]+)/.exec(location.hash);
    try {
      if (match) {
        token = match[1];
        sessionStorage.setItem(TOKEN_KEY, token);
        history.replaceState(null, '', location.pathname);
      } else if (!token) {
        token = sessionStorage.getItem(TOKEN_KEY) || '';
      }
    } catch (e) {
      if (match) token = match[1];
    }
  }
  readToken();

  function el(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      for (var key in props) {
        if (key === 'text') node.textContent = props[key];
        else if (key === 'className') node.className = props[key];
        else if (key === 'onclick') node.addEventListener('click', props[key]);
        else node.setAttribute(key, props[key]);
      }
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }
  function $(id) { return document.getElementById(id); }
  function replace(id) {
    var node = $(id);
    while (node.firstChild) node.removeChild(node.firstChild);
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) node.appendChild(arguments[i]);
  }
  function pill(text, kind) { return el('span', { className: 'pill ' + (kind || text), text: text }); }
  function time(iso) { return iso ? new Date(iso).toLocaleString() : ''; }
  function showError(message) {
    var box = $('error');
    box.textContent = message || '';
    box.hidden = !message;
  }

  function api(method, path, body) {
    var init = { method: method, headers: { Authorization: 'Bearer ' + token } };
    if (body) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (res) {
      if (res.status === 401) throw new Error('The panel token is missing or wrong. Open the link printed by "flow-e panel".');
      return res;
    });
  }

  function act(path, confirmText, askNote) {
    if (confirmText && !window.confirm(confirmText)) return;
    var note = askNote ? window.prompt('Note for the ledger (optional):', '') : '';
    if (note === null) return;
    api('POST', path, note ? { note: note } : null)
      .then(function (res) { return res.json().then(function (j) { return { res: res, j: j }; }); })
      .then(function (r) {
        if (!r.res.ok) showError(r.j.error || 'Action failed.');
        else showError('');
        refresh();
      })
      .catch(function (e) { showError(e.message); });
  }

  function paymentCard(p, buttons) {
    return el('div', { className: 'card' },
      el('div', null,
        el('div', { className: 'what', text: p.amount + ' to ' + p.merchant }),
        el('div', { className: 'meta', text: p.agent_id + ' · ' + time(p.created_at) + ' · ' + p.payment_id +
          (p.amount_base && p.amount_base !== p.amount ? ' · ' + p.amount_base : '') }),
        el('div', { className: 'why', text: p.reason }),
        p.memo ? el('div', { className: 'memo', text: '“' + p.memo + '”' }) : null),
      el.apply(null, ['div', { className: 'actions' }].concat(buttons)));
  }

  function render(s) {
    var kill = $('kill');
    var on = s.kill_switch && s.kill_switch.on;
    kill.className = 'kill' + (on ? ' engaged' : '');
    replace('kill',
      el('div', null,
        el('div', null, 'Kill switch ', pill(on ? 'ON' : 'off', on ? 'on' : 'off')),
        s.kill_switch ? el('div', { className: 'sub', text: 'Last set by ' + s.kill_switch.by + ', ' + time(s.kill_switch.at) }) : null),
      on
        ? el('button', { className: 'approve', text: 'Release kill switch',
            onclick: function () { act('/api/kill-switch/off', 'Release the kill switch? Agents frozen one by one stay frozen.', true); } })
        : el('button', { className: 'danger', text: 'Stop all agents',
            onclick: function () { act('/api/kill-switch/on', 'Stop ALL agents now? Every payment request will be declined until you release it.', true); } }));

    showError(s.config_error ? 'mandate.yaml cannot be read: ' + s.config_error : '');

    $('pending-count').textContent = s.pending.length ? '(' + s.pending.length + ')' : '';
    replace('pending', s.pending.length
      ? el.apply(null, ['div', null].concat(s.pending.map(function (p) {
          return paymentCard(p, [
            el('button', { className: 'approve', text: 'Approve',
              onclick: function () { act('/api/payments/' + encodeURIComponent(p.payment_id) + '/approve', 'Approve ' + p.amount + ' to ' + p.merchant + '?', true); } }),
            el('button', { className: 'secondary', text: 'Decline',
              onclick: function () { act('/api/payments/' + encodeURIComponent(p.payment_id) + '/decline', null, true); } })
          ]);
        })))
      : el('p', { className: 'empty', text: 'Nothing is waiting for you.' }));

    $('cooling-count').textContent = s.cooling_off.length ? '(' + s.cooling_off.length + ')' : '';
    replace('cooling', s.cooling_off.length
      ? el.apply(null, ['div', null].concat(s.cooling_off.map(function (p) {
          return paymentCard(p, [
            el('span', { className: 'sub', text: 'until ' + time(p.cancellable_until) }),
            el('button', { className: 'danger', text: 'Cancel',
              onclick: function () { act('/api/payments/' + encodeURIComponent(p.payment_id) + '/cancel', 'Cancel ' + p.amount + ' to ' + p.merchant + '?', true); } })
          ]);
        })))
      : el('p', { className: 'empty', text: 'No payments in their cooling-off window.' }));

    replace('agents', s.agents.length
      ? el.apply(null, ['div', { className: 'agent-grid' }].concat(s.agents.map(function (a) {
          var frozen = a.effective_status === 'frozen' && a.frozen_by_human;
          return el('div', { className: 'agent' },
            el('div', { className: 'name' }, el('span', { text: a.id }),
              on ? pill('stopped', 'frozen') : pill(a.effective_status)),
            el('div', { className: 'sub', text: a.owner }),
            el('dl', null,
              el('dt', { text: 'Budget today' }), el('dd', { text: a.today.budget }),
              el('dt', { text: 'Approved' }), el('dd', { text: a.today.approved }),
              el('dt', { text: 'Pending' }), el('dd', { text: a.today.pending }),
              el('dt', { text: 'Remaining' }), el('dd', { text: a.today.remaining })),
            a.configured_status !== 'active'
              ? el('div', { className: 'sub', text: 'Set to ' + a.configured_status + ' in mandate.yaml' })
              : frozen
                ? el('button', { className: 'approve', text: 'Unfreeze',
                    onclick: function () { act('/api/agents/' + encodeURIComponent(a.id) + '/unfreeze', 'Unfreeze ' + a.id + '?', true); } })
                : el('button', { className: 'danger', text: 'Freeze',
                    onclick: function () { act('/api/agents/' + encodeURIComponent(a.id) + '/freeze', 'Freeze ' + a.id + '? Its payment requests will be declined.', true); } }));
        })))
      : el('p', { className: 'empty', text: 'No agents configured.' }));

    var audit = $('audit');
    audit.textContent = (s.audit.ok ? '✔ ' : '✖ ') + s.audit.message;
    audit.className = 'audit' + (s.audit.ok ? '' : ' bad');

    var head = el('tr', null, el('th', { text: 'When' }), el('th', { text: 'Agent' }), el('th', { text: 'Supplier' }),
      el('th', { text: 'Amount' }), el('th', { text: 'Status' }), el('th', { text: 'Reason' }), el('th', { text: 'By' }));
    var rows = s.payments.map(function (p) {
      return el('tr', null,
        el('td', { text: time(p.created_at) }), el('td', { text: p.agent_id }), el('td', { text: p.merchant }),
        el('td', { className: 'num', text: p.amount }), el('td', null, pill(p.status)),
        el('td', { className: 'reason', text: p.note ? p.reason + ' — note: ' + p.note : p.reason }),
        el('td', { text: p.decided_by }));
    });
    replace('payments', el.apply(null, ['thead', null, head]), el.apply(null, ['tbody', null].concat(
      rows.length ? rows : [el('tr', null, el('td', { colspan: '7', className: 'empty', text: 'No payments yet.' }))])));

    $('issuer').textContent = 'Issuer ' + s.issuer;
  }

  // Redraw only when the data changed, so polling never steals a click, focus or a selection.
  var lastState = '';
  function refresh() {
    if (!token) { showError('No panel token. Open the link printed by "flow-e panel".'); return; }
    api('GET', '/api/state')
      .then(function (res) { return res.text(); })
      .then(function (body) {
        var s = JSON.parse(body);
        var key = JSON.stringify(Object.assign({}, s, { now: null }));
        if (key !== lastState) {
          lastState = key;
          render(s);
        }
        $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
      })
      .catch(function (e) { lastState = ''; showError(e.message); });
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('export').addEventListener('click', function () {
      api('GET', '/api/export.csv')
        .then(function (res) {
          var name = (/filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || 'flow-e-ledger.csv';
          return res.blob().then(function (blob) { return { blob: blob, name: name }; });
        })
        .then(function (r) {
          var url = URL.createObjectURL(r.blob);
          var a = el('a', { href: url, download: r.name });
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        })
        .catch(function (e) { showError(e.message); });
    });
    window.addEventListener('hashchange', function () {
      readToken();
      refresh();
    });
    refresh();
    setInterval(refresh, 2000);
  });
})();
`;
