/**
 * dialer-widget.js -- Velorah in-app voice dialer (Twilio Voice SDK)
 *
 * Drop-in floating dialer. Include on any page with:
 *   <script src="https://sdk.twilio.com/js/voice/releases/2.11.0/twilio.min.js"></script>
 *   <script src="/dialer-widget.js"></script>
 *
 * Then call VelorahDialer.call('+14165551234') from anywhere, or use the
 * floating dial pad. The widget self-injects its UI and handles everything.
 *
 * Backend it depends on (must be deployed):
 *   /.netlify/functions/twilio-token   (mints the access token)
 *   /.netlify/functions/twilio-voice   (the TwiML App's Voice URL)
 *
 * Requires Twilio Voice SDK (twilio.min.js) loaded BEFORE this script.
 */
(function(){
  'use strict';

  var device = null;
  var activeCall = null;
  var _onEndCb = null;
  var _callStartMs = 0;
  var _callTo = null;
  var deviceReady = false;
  var initializing = false;
  var TOKEN_ENDPOINT = '/.netlify/functions/twilio-token';

  // ---------- UI injection ----------
  function injectUI(){
    if (document.getElementById('vd-root')) return;

    var style = document.createElement('style');
    style.textContent =
      '#vd-fab{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#16c784,#0ea968);border:none;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35);z-index:9998;display:flex;align-items:center;justify-content:center;transition:transform .15s}' +
      '#vd-fab:hover{transform:scale(1.06)}' +
      '#vd-fab svg{width:26px;height:26px;fill:#fff}' +
      '#vd-panel{position:fixed;bottom:90px;right:24px;width:300px;background:#0e1730;border:1px solid #1f2f55;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.5);z-index:9999;padding:18px;display:none;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e8eefc}' +
      '#vd-panel.open{display:block}' +
      '#vd-status{font-size:12px;color:#9fb0d4;margin-bottom:10px;min-height:16px;text-align:center}' +
      '#vd-status.connected{color:#16c784}#vd-status.error{color:#ef4444}#vd-status.ringing{color:#f5a524}' +
      '#vd-num{width:100%;padding:11px 12px;background:rgba(255,255,255,.05);border:1px solid #1f2f55;border-radius:10px;color:#e8eefc;font-size:18px;text-align:center;letter-spacing:1px;font-family:inherit;margin-bottom:12px}' +
      '#vd-num:focus{outline:none;border-color:#3b82f6}' +
      '.vd-pad{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}' +
      '.vd-key{padding:12px 0;background:rgba(255,255,255,.04);border:1px solid #1f2f55;border-radius:10px;color:#e8eefc;font-size:17px;cursor:pointer;font-family:inherit;transition:background .12s}' +
      '.vd-key:hover{background:rgba(255,255,255,.1)}' +
      '.vd-actions{display:flex;gap:8px}' +
      '#vd-call,#vd-hangup{flex:1;padding:12px;border:none;border-radius:10px;font-weight:700;font-size:14px;cursor:pointer;font-family:inherit}' +
      '#vd-call{background:#16c784;color:#fff}#vd-call:disabled{opacity:.5;cursor:not-allowed}' +
      '#vd-hangup{background:#ef4444;color:#fff;display:none}' +
      '#vd-close{position:absolute;top:10px;right:12px;background:none;border:none;color:#6b7da6;font-size:18px;cursor:pointer}' +
      '#vd-mute{background:rgba(255,255,255,.06);border:1px solid #1f2f55;color:#e8eefc;border-radius:10px;padding:0 14px;cursor:pointer;font-family:inherit;display:none}' +
      '#vd-mute.active{background:#f5a524;color:#1a1206}';
    document.head.appendChild(style);

    var root = document.createElement('div');
    root.id = 'vd-root';
    root.innerHTML =
      '<button id="vd-fab" title="Open dialer"><svg viewBox="0 0 24 24"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg></button>' +
      '<div id="vd-panel">' +
        '<button id="vd-close">&times;</button>' +
        '<div id="vd-status">Tap a number to start</div>' +
        '<input id="vd-num" type="tel" placeholder="+1 416 555 1234" />' +
        '<div class="vd-pad">' +
          ['1','2','3','4','5','6','7','8','9','*','0','#'].map(function(k){
            return '<button class="vd-key" data-k="'+k+'">'+k+'</button>';
          }).join('') +
        '</div>' +
        '<div class="vd-actions">' +
          '<button id="vd-call">Call</button>' +
          '<button id="vd-mute">Mute</button>' +
          '<button id="vd-hangup">Hang up</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);

    // Wire UI events
    document.getElementById('vd-fab').addEventListener('click', togglePanel);
    document.getElementById('vd-close').addEventListener('click', function(){ document.getElementById('vd-panel').classList.remove('open'); });
    document.querySelectorAll('.vd-key').forEach(function(btn){
      btn.addEventListener('click', function(){
        var inp = document.getElementById('vd-num');
        inp.value += btn.getAttribute('data-k');
        // If in a call, send DTMF
        if (activeCall) { try { activeCall.sendDigits(btn.getAttribute('data-k')); } catch(e){} }
      });
    });
    document.getElementById('vd-call').addEventListener('click', function(){
      var num = document.getElementById('vd-num').value.trim();
      if (num) startCall(num);
    });
    document.getElementById('vd-hangup').addEventListener('click', endCall);
    document.getElementById('vd-mute').addEventListener('click', toggleMute);
  }

  function togglePanel(){
    var panel = document.getElementById('vd-panel');
    panel.classList.toggle('open');
    if (panel.classList.contains('open') && !deviceReady && !initializing) {
      initDevice();
    }
  }

  function setStatus(msg, cls){
    var el = document.getElementById('vd-status');
    if (!el) return;
    el.textContent = msg;
    el.className = cls || '';
  }

  // ---------- Twilio device lifecycle ----------
  async function initDevice(){
    if (initializing || deviceReady) return;
    if (typeof Twilio === 'undefined' || !Twilio.Device) {
      setStatus('Voice SDK not loaded. Add the Twilio script tag.', 'error');
      return;
    }
    initializing = true;
    setStatus('Connecting to phone service...');

    try {
      var identity = 'velorah_agent';
      try { if (window.VELORAH_USER_EMAIL) identity = window.VELORAH_USER_EMAIL; } catch(e){}

      var resp = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: identity })
      });
      if (!resp.ok) {
        var detail = '';
        try { var ej = await resp.json(); detail = ej.error || ''; } catch(e){}
        throw new Error(resp.status === 404 ? 'Token service not deployed.' : (detail || ('Token error ' + resp.status)));
      }
      var data = await resp.json();
      if (!data.token) throw new Error(data.error || 'No token returned');

      // Twilio Voice SDK 2.x: new Device(token, options)
      device = new Twilio.Device(data.token, { codecPreferences: ['opus', 'pcmu'], logLevel: 'error' });

      device.on('registered', function(){ deviceReady = true; setStatus('Ready to call'); });
      device.on('error', function(err){
        var code = err && (err.code || (err.originalError && err.originalError.code));
        var msg = (err && err.message) ? err.message : 'unknown error';
        if (code === 53000 || (msg && msg.indexOf('53000') >= 0)) {
          msg = 'Twilio rejected the connection (token/credentials). Check that TWILIO_API_SECRET matches TWILIO_API_KEY, and that the TwiML App SID is correct.';
        } else if (code === 31204 || code === 20151) {
          msg = 'Access token invalid — the API Key Secret likely does not match the API Key.';
        } else if (code === 31402 || (msg && msg.toLowerCase().indexOf('microphone') >= 0)) {
          msg = 'Microphone access is required. Allow the mic for this site and reload.';
        }
        setStatus('Error: ' + msg, 'error');
      });
      device.on('tokenWillExpire', async function(){
        // Refresh the token to keep the device alive
        try {
          var r = await fetch(TOKEN_ENDPOINT, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ identity: identity }) });
          var d = await r.json();
          if (d.token) device.updateToken(d.token);
        } catch(e){}
      });
      device.on('incoming', function(call){
        // Auto-reject incoming for an outbound-only dialer (or you could accept)
        setStatus('Incoming call (rejected by dialer)');
        try { call.reject(); } catch(e){}
      });

      await device.register();
    } catch(e) {
      var em = (e && e.message) ? e.message : (typeof e === 'string' ? e : 'Could not start dialer');
      setStatus(em, 'error');
    } finally {
      initializing = false;
    }
  }

  function normalizeNumber(num){
    var n = String(num).replace(/[^\d+]/g, '');
    // If it has no + and looks like a NANP 10-digit, prepend +1
    if (n.indexOf('+') !== 0) {
      if (n.length === 10) n = '+1' + n;
      else if (n.length === 11 && n.charAt(0) === '1') n = '+' + n;
      else n = '+' + n;
    }
    return n;
  }

  async function startCall(num){
    if (!deviceReady) {
      setStatus('Dialer not ready yet, starting...', 'ringing');
      await initDevice();
      if (!deviceReady) { setStatus('Could not connect. Check setup.', 'error'); return; }
    }
    var to = normalizeNumber(num);
    setStatus('Calling ' + to + '...', 'ringing');

    try {
      // Twilio Voice SDK 2.x: device.connect({ params: {...} }) returns a Promise<Call>
      activeCall = await device.connect({ params: { To: to } });

      document.getElementById('vd-call').style.display = 'none';
      document.getElementById('vd-hangup').style.display = 'block';
      document.getElementById('vd-mute').style.display = 'block';

      activeCall.on('accept', function(){ _callStartMs = Date.now(); setStatus('Connected to ' + to, 'connected'); });
      activeCall.on('disconnect', function(){ fireOnEnd(); resetCallUI('Call ended'); });
      activeCall.on('cancel', function(){ resetCallUI('Call canceled'); });
      activeCall.on('reject', function(){ resetCallUI('Call rejected'); });
      activeCall.on('error', function(err){ setStatus('Call error: ' + (err && err.message ? err.message : ''), 'error'); resetCallUI('Call failed'); });
    } catch(e) {
      setStatus('Call failed: ' + (e && e.message ? e.message : 'unknown'), 'error');
      resetCallUI();
    }
  }

  function endCall(){
    if (activeCall) { try { activeCall.disconnect(); } catch(e){} }
    if (device) { try { device.disconnectAll(); } catch(e){} }
    fireOnEnd();
    resetCallUI('Call ended');
  }

  function toggleMute(){
    if (!activeCall) return;
    var btn = document.getElementById('vd-mute');
    var muted = activeCall.isMuted();
    try {
      activeCall.mute(!muted);
      if (!muted) { btn.classList.add('active'); btn.textContent = 'Unmute'; }
      else { btn.classList.remove('active'); btn.textContent = 'Mute'; }
    } catch(e){}
  }

  function fireOnEnd(){
    if (typeof _onEndCb === 'function') {
      var durationSeconds = _callStartMs ? Math.round((Date.now() - _callStartMs) / 1000) : 0;
      var cb = _onEndCb;
      _onEndCb = null; // fire once
      try { cb({ durationSeconds: durationSeconds, to: _callTo }); } catch(e){}
    }
    _callStartMs = 0;
  }

  function resetCallUI(msg){
    activeCall = null;
    var c = document.getElementById('vd-call');
    var h = document.getElementById('vd-hangup');
    var m = document.getElementById('vd-mute');
    if (c) c.style.display = 'block';
    if (h) h.style.display = 'none';
    if (m) { m.style.display = 'none'; m.classList.remove('active'); m.textContent = 'Mute'; }
    if (msg) setStatus(msg, deviceReady ? '' : '');
    if (deviceReady && !msg) setStatus('Ready to call');
  }

  // ---------- Public API ----------
  window.VelorahDialer = {
    // Programmatically place a call: VelorahDialer.call('+14165551234')
    call: function(number, opts){
      injectUI();
      document.getElementById('vd-panel').classList.add('open');
      var inp = document.getElementById('vd-num');
      if (inp) inp.value = number || '';
      _onEndCb = (opts && typeof opts.onEnd === 'function') ? opts.onEnd : null;
      _callTo = number || null;
      if (number) startCall(number);
    },
    // Just open the dialer
    open: function(){ injectUI(); document.getElementById('vd-panel').classList.add('open'); if(!deviceReady && !initializing) initDevice(); },
    isReady: function(){ return deviceReady; }
  };

  // Auto-inject the floating button on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectUI);
  } else {
    injectUI();
  }
})();
