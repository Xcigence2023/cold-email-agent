/**
 * ai-call.js -- trigger an outbound AI voice agent call ("Nick")
 *
 * Include on any page:
 *   <script src="/ai-call.js"></script>
 *
 * Then call:
 *   VelorahAICall.call('+14165551234')           // fire an AI call to a lead
 *   VelorahAICall.call('+14165551234', {name:'Jane', company:'Acme'})
 *
 * It POSTs to your Fly.io voice agent's /start-call route. Nick (the disclosed
 * AI agent) then calls the number, qualifies, and tries to book a meeting.
 *
 * CONFIG: set the voice agent host once, before this script or on window:
 *   window.VELORAH_VOICE_AGENT_URL = 'https://velorah-voice-agent.fly.dev';
 * If unset, it defaults to the placeholder below -- change it after you deploy.
 */
(function(){
  'use strict';

  // CHANGE THIS to your deployed Fly.io app URL (or set window.VELORAH_VOICE_AGENT_URL)
  var DEFAULT_AGENT_URL = 'https://velorah-voice-agent.fly.dev';

  function agentUrl(){
    return (window.VELORAH_VOICE_AGENT_URL || DEFAULT_AGENT_URL).replace(/\/+$/, '');
  }

  function normalize(num){
    var n = String(num || '').replace(/[^\d+]/g, '');
    if (n.indexOf('+') !== 0) {
      if (n.length === 10) n = '+1' + n;
      else if (n.length === 11 && n.charAt(0) === '1') n = '+' + n;
      else n = '+' + n;
    }
    return n;
  }

  function toast(msg, isError){
    var t = document.getElementById('vac-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'vac-toast';
      t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#0e1730;color:#e8eefc;border:1px solid #1f2f55;padding:12px 20px;border-radius:10px;z-index:10000;font-family:-apple-system,sans-serif;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.4);max-width:90vw;text-align:center';
      document.body.appendChild(t);
    }
    t.style.borderColor = isError ? '#ef4444' : '#16c784';
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(t._timer);
    t._timer = setTimeout(function(){ t.style.display = 'none'; }, 5000);
  }

  window.VelorahAICall = {
    call: async function(number, meta){
      var to = normalize(number);
      if (!to || to.length < 8) { toast('Invalid phone number for AI call.', true); return; }

      // Confirm -- AI calls cost money and call a real person, so make it deliberate
      var who = (meta && meta.name) ? (' to ' + meta.name) : '';
      if (!window.confirm('Start an AI voice call (Nick)' + who + ' at ' + to + '?\n\nNick will identify as an automated assistant, qualify the lead, and try to book a meeting. This places a real phone call (carrier charges apply).')) {
        return;
      }

      toast('Starting AI call to ' + to + '...');
      try {
        var resp = await fetch(agentUrl() + '/start-call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: to,
            name: (meta && meta.name) || '',
            company: (meta && meta.company) || ''
          })
        });
        if (!resp.ok) {
          var detail = '';
          try { var ej = await resp.json(); detail = ej.error || ''; } catch(e){}
          throw new Error(resp.status === 404 ? 'Voice agent not reachable (check VELORAH_VOICE_AGENT_URL).' : (detail || ('Error ' + resp.status)));
        }
        var data = await resp.json();
        if (data.ok) toast('AI call started to ' + to + '. Nick is dialing now.');
        else throw new Error(data.error || 'Call did not start');
      } catch(e) {
        toast('Could not start AI call: ' + e.message, true);
      }
    }
  };
})();
