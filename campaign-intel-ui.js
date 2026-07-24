/* ============================================================
   VELORAH — Campaign Intelligence UI
   Load in app.html <head>:  <script src="/campaign-intel-ui.js"></script>

   Adds two features:
   1. "Use my own email"  (Configure step) — paste an email you wrote and have
      it adapted per recipient instead of generated from scratch.
   2. "Pre-send check"    (Review step)    — verifies each recipient is still
      reachable; flags deceased / departed contacts WITH SOURCES and suggests
      who to contact instead.

   Safety stance: flagged recipients are EXCLUDED by default but never deleted.
   Every claim shows its source. Suggested emails are pattern guesses, labelled.
   ============================================================ */
(function () {
  'use strict';

  /* app.html uses `const S` / `const _session`, which are NOT on window.
     They are reachable as bare globals once app.html's script has run. */
  function getS(){ try { return S; } catch (e) { return null; } }
  function getSession(){ try { return _session; } catch (e) { return null; } }
  function getDraw(){ try { return (typeof draw === 'function') ? draw : null; } catch (e) { return null; } }
  function getName_(lead){ try { return getName(lead); } catch (e) { return ''; } }

  var EP = '/.netlify/functions/campaign-intel';

  function authHeaders() {
    var s = getSession();
    var h = { 'Content-Type': 'application/json' };
    if (s && s.access_token) h['Authorization'] = 'Bearer ' + s.access_token;
    return h;
  }

  function toast(msg, kind) {
    var bg = kind === 'error' ? 'linear-gradient(135deg,#ef4444,#b91c1c)'
           : kind === 'warn'  ? 'linear-gradient(135deg,#f59e0b,#b45309)'
           : 'linear-gradient(135deg,#10b981,#059669)';
    var b = document.createElement('div');
    b.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);background:' + bg +
      ';color:#fff;padding:12px 22px;border-radius:10px;font-weight:700;z-index:99999;font-size:14px;' +
      'box-shadow:0 4px 20px rgba(0,0,0,.4);max-width:90vw;text-align:center';
    b.textContent = msg;
    document.body.appendChild(b);
    setTimeout(function () { b.remove(); }, 6000);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ============================================================
  // FEATURE 1 — Use my own email (adapt per recipient)
  // ============================================================
  var BASE = { subject: '', body: '', enabled: false, research: false };

  function buildComposer() {
    var box = document.createElement('div');
    box.id = 'vi-composer';
    box.className = 'card';
    box.style.cssText = 'margin-bottom:12px;border-color:rgba(6,182,212,.4);background:rgba(6,182,212,.05)';

    box.innerHTML =
      '<div class="card-title" style="color:var(--cyan)">Write it yourself — AI adapts it per recipient</div>' +
      '<p style="font-size:12px;color:var(--text2);margin-bottom:12px;line-height:1.55">' +
      'Paste an email you have already written. Instead of generating from scratch, the AI keeps your voice, ' +
      'your offer, your statistics and your call to action, and re-tailors the opening and framing to each ' +
      "recipient's role, industry and priorities.</p>";

    var row = document.createElement('div');
    row.className = 'toggle-row';
    row.style.cssText = 'padding-top:0';
    var lbl = document.createElement('div');
    lbl.innerHTML = '<p style="font-weight:700;margin-bottom:2px">Use my own email as the source</p>' +
      '<p style="font-size:12px;color:var(--text2)">Off = AI writes from scratch as usual</p>';
    var tw = document.createElement('div'); tw.className = 'toggle-wrap';
    var tog = document.createElement('div');
    tog.className = 'toggle ' + (BASE.enabled ? 'on' : 'off');
    tog.innerHTML = '<div class="toggle-knob"></div>';
    var tlabel = document.createElement('span');
    tlabel.className = 'toggle-label';
    tlabel.style.color = BASE.enabled ? 'var(--cyan)' : 'var(--text3)';
    tlabel.textContent = BASE.enabled ? 'ON' : 'OFF';
    tog.addEventListener('click', function () {
      BASE.enabled = !BASE.enabled;
      tog.className = 'toggle ' + (BASE.enabled ? 'on' : 'off');
      tlabel.textContent = BASE.enabled ? 'ON' : 'OFF';
      tlabel.style.color = BASE.enabled ? 'var(--cyan)' : 'var(--text3)';
      fields.style.display = BASE.enabled ? 'block' : 'none';
    });
    tw.appendChild(tog); tw.appendChild(tlabel);
    row.appendChild(lbl); row.appendChild(tw);
    box.appendChild(row);

    var fields = document.createElement('div');
    fields.style.display = BASE.enabled ? 'block' : 'none';

    var sl = document.createElement('label'); sl.className = 'lbl'; sl.textContent = 'Your subject line';
    var si = document.createElement('input'); si.type = 'text';
    si.placeholder = 'e.g. Xcigence | US-Patented Cyber Risk Intelligence';
    si.value = BASE.subject;
    si.addEventListener('input', function (e) { BASE.subject = e.target.value; });

    var bl = document.createElement('label'); bl.className = 'lbl';
    bl.style.marginTop = '12px'; bl.textContent = 'Your email body';
    var bt = document.createElement('textarea');
    bt.placeholder = 'Paste the email you wrote. Use the recipient\'s first name where you want it personalised — the AI will swap it per contact.';
    bt.style.minHeight = '200px';
    bt.value = BASE.body;
    bt.addEventListener('input', function (e) { BASE.body = e.target.value; });

    var rrow = document.createElement('div');
    rrow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px';
    var rcb = document.createElement('input'); rcb.type = 'checkbox'; rcb.checked = BASE.research;
    rcb.style.cssText = 'width:auto;margin:0';
    rcb.addEventListener('change', function (e) { BASE.research = e.target.checked; });
    var rtx = document.createElement('span');
    rtx.style.cssText = 'font-size:12px;color:var(--text2)';
    rtx.textContent = 'Research each company first (slower, more specific openings)';
    rrow.appendChild(rcb); rrow.appendChild(rtx);

    var note = document.createElement('div');
    note.className = 'tip';
    note.style.marginTop = '10px';
    note.innerHTML = 'Your statistics, links, patent numbers and sign-off are preserved exactly. ' +
      'Only the opening and the framing change per recipient.';

    fields.appendChild(sl); fields.appendChild(si);
    fields.appendChild(bl); fields.appendChild(bt);
    fields.appendChild(rrow); fields.appendChild(note);
    box.appendChild(fields);
    return box;
  }

  /* Adapt one recipient. Returns {subject, body} or throws. */
  async function adaptFor(lead) {
    var _S = getS();
    var res = await fetch(EP, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        action: 'adapt',
        payload: {
          baseEmail: { subject: BASE.subject, body: BASE.body },
          recipient: {
            name: getName_(lead),
            title: lead[_S.colMap.title] || '',
            company: lead[_S.colMap.company] || '',
            industry: lead[_S.colMap.industry] || ''
          },
          senderPrefs: _S.senderPrefs || {},
          research: BASE.research
        }
      })
    });
    var data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }

  /* Replaces the app's generation loop when "use my own email" is on. */
  async function runAdaptAll() {
    var _S = getS(), d = getDraw();
    for (var i = 0; i < _S.leads.length; i++) {
      try {
        var out = await adaptFor(_S.leads[i]);
        _S.emails.push({ id: i, lead: _S.leads[i], subject: out.subject, body: out.body, approved: true, error: false });
      } catch (err) {
        _S.emails.push({ id: i, lead: _S.leads[i], subject: '[Adaptation failed - Regenerate]', body: err.message, approved: false, error: true });
      }
      _S.genProgress = i + 1;
      if (d) d();
      await new Promise(function (r) { setTimeout(r, 1200); });
    }
    _S.step = 3; _S.activeIdx = 0;
    if (d) d();
  }

  // ============================================================
  // FEATURE 2 — Pre-send DO-NOT-SEND check
  // ============================================================
  var CHECK = { running: false, done: false, progress: 0, total: 0, results: {} };

  function knownEmailsForCompany(company) {
    var _S = getS();
    if (!_S || !company) return [];
    var out = [];
    (_S.leads || []).forEach(function (l) {
      var c = (l[_S.colMap.company] || '').toLowerCase().trim();
      var e = (l[_S.colMap.email] || '').trim();
      if (c && e && c === String(company).toLowerCase().trim()) out.push(e);
    });
    return out;
  }

  async function runPreSendCheck() {
    var _S = getS(), d = getDraw();
    if (!_S) return;
    var list = _S.emails.filter(function (e) { return !e.error; });
    if (!list.length) { toast('Nothing to check yet.', 'error'); return; }

    CHECK.running = true; CHECK.done = false; CHECK.progress = 0; CHECK.total = list.length; CHECK.results = {};
    if (d) d();

    var flagged = 0;
    for (var i = 0; i < list.length; i++) {
      var em = list[i];
      try {
        var res = await fetch(EP, {
          method: 'POST', headers: authHeaders(),
          body: JSON.stringify({
            action: 'verify',
            payload: {
              recipient: {
                name: getName_(em.lead),
                title: em.lead[_S.colMap.title] || '',
                company: em.lead[_S.colMap.company] || ''
              },
              knownEmails: knownEmailsForCompany(em.lead[_S.colMap.company] || '')
            }
          })
        });
        var data = await res.json();
        if (data.error) throw new Error(data.error);
        CHECK.results[em.id] = data;
        // SAFETY: exclude by default when flagged — visible and reversible.
        if (data.status === 'do_not_send' || data.status === 'verify') {
          em.approved = false;
          flagged++;
        }
      } catch (e) {
        CHECK.results[em.id] = { status: 'error', headline: e.message, findings: [], alternates: [], sources: [] };
      }
      CHECK.progress = i + 1;
      if (d) d();
      await new Promise(function (r) { setTimeout(r, 400); });
    }
    CHECK.running = false; CHECK.done = true;
    if (d) d();
    toast(flagged ? (flagged + ' recipient' + (flagged === 1 ? '' : 's') + ' flagged and excluded — review below') : 'All recipients look clear', flagged ? 'warn' : 'ok');
  }

  function buildCheckPanel() {
    var _S = getS();
    var box = document.createElement('div');
    box.id = 'vi-check';
    box.className = 'card';
    box.style.marginBottom = '14px';

    if (CHECK.running) {
      var pct = CHECK.total ? Math.round(CHECK.progress / CHECK.total * 100) : 0;
      box.style.borderColor = 'rgba(59,130,246,.35)';
      box.innerHTML =
        '<div style="font-weight:700;font-size:14px;margin-bottom:6px">Running pre-send check…</div>' +
        '<p style="font-size:12px;color:var(--text2);margin-bottom:8px">Checking ' + CHECK.progress + ' of ' + CHECK.total +
        ' recipients for role changes and other reasons not to send.</p>' +
        '<div class="pbar"><div class="pfill" style="width:' + pct + '%"></div></div>';
      return box;
    }

    if (!CHECK.done) {
      box.style.cssText = 'margin-bottom:14px;border-color:rgba(245,158,11,.4);background:rgba(245,158,11,.05);cursor:pointer';
      box.innerHTML =
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:220px">' +
        '<p style="font-weight:700;font-size:14px;color:var(--gold);margin-bottom:3px">Run pre-send check</p>' +
        '<p style="font-size:12px;color:var(--text2);line-height:1.5">Searches for evidence that a recipient has left their role or should not be contacted, ' +
        'and suggests who to reach instead. Anything flagged is excluded automatically — you can restore it in one click.</p></div>' +
        '<button class="btn btn-primary" style="white-space:nowrap">Check ' + _S.emails.filter(function(e){return !e.error;}).length + ' recipients</button>' +
        '</div>';
      box.addEventListener('click', runPreSendCheck);
      return box;
    }

    // Results
    var ids = Object.keys(CHECK.results);
    var flagged = ids.filter(function (id) { var r = CHECK.results[id]; return r.status === 'do_not_send' || r.status === 'verify'; });
    var clear = ids.length - flagged.length;

    box.style.borderColor = flagged.length ? 'rgba(245,158,11,.45)' : 'rgba(16,185,129,.35)';
    box.style.background = flagged.length ? 'rgba(245,158,11,.05)' : 'rgba(16,185,129,.04)';

    var html =
      '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:10px">' +
      '<div style="font-weight:700;font-size:14px">Pre-send check</div>' +
      '<div style="display:flex;gap:16px">' +
      '<div style="text-align:center"><div style="font-size:20px;font-weight:800;color:var(--green)">' + clear + '</div><div style="font-size:10px;color:var(--text2)">CLEAR</div></div>' +
      '<div style="text-align:center"><div style="font-size:20px;font-weight:800;color:var(--gold)">' + flagged.length + '</div><div style="font-size:10px;color:var(--text2)">FLAGGED</div></div>' +
      '</div></div>';

    flagged.forEach(function (id) {
      var r = CHECK.results[id];
      var em = (getS().emails || []).find(function (x) { return String(x.id) === String(id); });
      if (!em) return;
      var isHard = r.status === 'do_not_send';
      html += '<div style="border:1px solid ' + (isHard ? 'rgba(239,68,68,.4)' : 'rgba(245,158,11,.35)') +
        ';background:' + (isHard ? 'rgba(239,68,68,.06)' : 'rgba(245,158,11,.05)') +
        ';border-radius:10px;padding:12px 14px;margin-bottom:10px">';
      html += '<div style="font-weight:700;font-size:13px;color:' + (isHard ? 'var(--red)' : 'var(--gold)') + ';margin-bottom:4px">' +
        (isHard ? 'DO NOT SEND' : 'VERIFY BEFORE SENDING') + ' — ' + esc(getName_(em.lead)) + '</div>';
      if (r.headline) html += '<p style="font-size:12px;color:var(--text);margin-bottom:6px">' + esc(r.headline) + '</p>';

      if (r.findings && r.findings.length) {
        html += '<div style="margin:8px 0"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);margin-bottom:4px">Evidence</div>';
        r.findings.forEach(function (f) {
          html += '<div style="font-size:12px;color:var(--text2);margin-bottom:3px">• ' + esc(f.claim) +
            (f.source ? ' <a href="' + esc(f.source) + '" target="_blank" rel="noopener" style="color:var(--blue)">source</a>' : '') + '</div>';
        });
        html += '</div>';
      }

      if (r.alternates && r.alternates.length) {
        html += '<div style="margin:8px 0"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text3);margin-bottom:4px">Contact instead</div>';
        r.alternates.forEach(function (a) {
          html += '<div style="font-size:12px;color:var(--text2);margin-bottom:5px">— <strong style="color:var(--text)">' + esc(a.name) + '</strong>' +
            (a.title ? ', ' + esc(a.title) : '') +
            (a.why ? '<br><span style="color:var(--text3)">' + esc(a.why) + '</span>' : '') +
            (a.emailGuess ? '<br><code style="font-size:11px;color:var(--cyan)">' + esc(a.emailGuess) + '</code>' +
              '<span style="color:var(--gold);font-size:11px"> — unverified guess, confirm first</span>' : '') +
            (a.source ? ' <a href="' + esc(a.source) + '" target="_blank" rel="noopener" style="color:var(--blue)">source</a>' : '') +
            '</div>';
        });
        html += '</div>';
      }

      if (r.note) html += '<p style="font-size:12px;color:var(--text2);font-style:italic;margin-top:6px">' + esc(r.note) + '</p>';
      html += '<button class="btn" data-restore="' + esc(id) + '" style="font-size:11px;margin-top:8px">Restore this recipient</button>';
      html += '</div>';
    });

    if (!flagged.length) {
      html += '<p style="font-size:12px;color:var(--text2)">No recipients were flagged. Nothing found suggesting a role change or other reason not to send.</p>';
    }
    html += '<button class="btn" id="vi-recheck" style="font-size:12px;margin-top:4px">Re-run check</button>';
    box.innerHTML = html;

    box.querySelectorAll('[data-restore]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-restore');
        var _S2 = getS();
        var em = _S2.emails.find(function (x) { return String(x.id) === String(id); });
        if (em) { em.approved = true; delete CHECK.results[id]; }
        var d = getDraw(); if (d) d();
        toast('Recipient restored — they will be included.', 'ok');
      });
    });
    var rb = box.querySelector('#vi-recheck');
    if (rb) rb.addEventListener('click', runPreSendCheck);
    return box;
  }

  // ============================================================
  // Mounting
  // ============================================================
  function mount() {
    var _S = getS();
    if (!_S) return;
    var root = document.getElementById('root');
    if (!root || root.children.length < 2) return;
    var target = root.children[1];

    // Composer on the Configure step
    var comp = document.getElementById('vi-composer');
    if (_S.step === 1) {
      if (!comp) target.insertBefore(buildComposer(), target.firstChild);
    } else if (comp) { comp.remove(); }

    // Pre-send check on the Review step
    var chk = document.getElementById('vi-check');
    if (_S.step === 3 && _S.emails.length) {
      if (chk) chk.remove();
      target.insertBefore(buildCheckPanel(), target.firstChild);
    } else if (chk) { chk.remove(); }
  }

  /* Wrap draw() so our panels survive every re-render, and intercept the
     generate step so "use my own email" adapts instead of writing fresh. */
  var _wrapped = false;
  function hook() {
    var d = getDraw();
    if (!d) { setTimeout(hook, 300); return; }
    if (_wrapped) return;
    _wrapped = true;

    var origDraw = d;
    window.draw = function () { origDraw.apply(this, arguments); try { mount(); } catch (e) {} };
    try { draw = window.draw; } catch (e) {}

    // Intercept generation
    try {
      if (typeof runGenerate === 'function') {
        var origGen = runGenerate;
        window.runGenerate = async function () {
          if (BASE.enabled && BASE.body.trim()) {
            return runAdaptAll();
          }
          return origGen.apply(this, arguments);
        };
        try { runGenerate = window.runGenerate; } catch (e) {}
      }
    } catch (e) {}

    try { window.draw(); } catch (e) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook);
  else hook();

  window.VelorahIntel = {
    base: BASE, check: CHECK,
    runPreSendCheck: runPreSendCheck,
    adaptFor: adaptFor
  };
})();
