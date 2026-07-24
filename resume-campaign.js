/* ============================================================
   VELORAH — RESUME CAMPAIGN FROM EXPORT   (v2)
   Load with ONE line in app.html, after the main </script>:
       <script src="/resume-campaign.js"></script>

   If this file is loading correctly you WILL SEE a green
   "Resume a saved campaign" panel at the top of the Upload step.
   If you do not see that panel, the file is not being served —
   it is not a code problem.
   ============================================================ */
(function(){
  'use strict';

  var _imported=false;

  /* app.html declares `const S = {...}` and `const emailRx`. const/let at top
     level are NOT attached to window, so window.S is undefined. They ARE
     reachable as bare globals from another script once that script has run. */
  function getS(){ try{ return S; }catch(e){ return null; } }
  function getDraw(){ try{ return (typeof draw==='function') ? draw : null; }catch(e){ return null; } }


  /* ---------- RFC4180 CSV parser (handles newlines inside quoted fields) ---------- */
  function parseCSVStrict(text){
    var rows=[], row=[], cur='', q=false, i=0;
    text=String(text||'').replace(/^\uFEFF/,'');
    while(i<text.length){
      var ch=text[i];
      if(q){
        if(ch==='"'){ if(text[i+1]==='"'){cur+='"';i+=2;continue;} q=false;i++;continue; }
        cur+=ch;i++;continue;
      }
      if(ch==='"'){q=true;i++;continue;}
      if(ch===','){row.push(cur);cur='';i++;continue;}
      if(ch==='\r'){i++;continue;}
      if(ch==='\n'){row.push(cur);rows.push(row);row=[];cur='';i++;continue;}
      cur+=ch;i++;
    }
    if(cur.length||row.length){row.push(cur);rows.push(row);}
    rows=rows.filter(function(r){return r.some(function(v){return String(v).trim()!=='';});});
    if(!rows.length) return {headers:[],rows:[]};
    var headers=rows[0].map(function(h){return String(h).trim();});
    var out=rows.slice(1).map(function(r){
      var o={};headers.forEach(function(h,idx){o[h]=(r[idx]!==undefined?String(r[idx]):'');});return o;
    });
    return {headers:headers, rows:out};
  }

  function findCol(headers, aliases){
    for(var i=0;i<headers.length;i++){
      var h=headers[i].toLowerCase().trim();
      for(var j=0;j<aliases.length;j++) if(h===aliases[j]) return headers[i];
    }
    return '';
  }
  var A={
    subject:['subject','subject line','email subject'],
    body:['body','email body','message','content'],
    email:['email','e-mail','recipient email','mail','contact email'],
    name:['name','full name','recipient name','contact name'],
    first:['first name','firstname','first'],
    last:['last name','lastname','surname'],
    company:['company','organization','organisation','org','account'],
    title:['title','job title','position','role'],
    industry:['industry','sector','vertical']
  };

  function isCampaignExport(headers){
    return !!(findCol(headers,A.subject) && findCol(headers,A.body));
  }

  var EMAIL_RX=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  /* ---------- Load a parsed export straight into the Review step ---------- */
  function loadCampaign(parsed){
    var _S=getS(); if(!_S){ toast('App not ready — reload the page.', true); return; }
    var H=parsed.headers;
    var cSub=findCol(H,A.subject), cBody=findCol(H,A.body), cEmail=findCol(H,A.email);

    if(!cEmail){ toast('That file has no Email column.', true); return; }

    _S.headers=H;
    _S.leads=parsed.rows;
    _S.colMap={
      email:cEmail,
      fullName:findCol(H,A.name),
      firstName:findCol(H,A.first),
      lastName:findCol(H,A.last),
      company:findCol(H,A.company),
      title:findCol(H,A.title),
      industry:findCol(H,A.industry),
      companySize:'', revenue:''
    };

    var skipped=0;
    _S.emails=[];
    parsed.rows.forEach(function(row){
      var to=(row[cEmail]||'').trim();
      var subject=(row[cSub]||'').trim();
      var body=(row[cBody]||'').trim();
      if(!to || !EMAIL_RX.test(to) || !subject || !body){ skipped++; return; }
      _S.emails.push({
        id: _S.emails.length,
        lead: row, subject: subject, body: body,
        approved: true, error: false, attachment: null
      });
    });

    if(!_S.emails.length){
      toast('No usable emails found — need Email, Subject and Body with values.', true);
      return;
    }

    _S.genProgress = _S.emails.length;
    _S.sendStatus={}; _S.trackingStatus={}; _S.messageIds={};
    _S.validationDone=false; _S.validationRunning=false;
    _S.validationResults={summary:null,results:[]};
    if(!_S.campaignName) _S.campaignName='Imported '+new Date().toLocaleDateString();

    _imported=true;
    _S.step=3; _S.activeIdx=0;
    var d=getDraw(); if(d) d();

    var msg=_S.emails.length+' ready-to-send email'+(_S.emails.length===1?'':'s')+' loaded';
    if(skipped) msg+=' · '+skipped+' row'+(skipped===1?'':'s')+' skipped';
    toast(msg, false);
  }

  function toast(msg, isError){
    var b=document.createElement('div');
    b.style.cssText='position:fixed;top:64px;left:50%;transform:translateX(-50%);'+
      'background:'+(isError?'linear-gradient(135deg,#ef4444,#b91c1c)':'linear-gradient(135deg,#10b981,#059669)')+';'+
      'color:#fff;padding:12px 24px;border-radius:10px;font-weight:700;z-index:99999;'+
      'font-size:14px;box-shadow:0 4px 20px rgba(0,0,0,.4);max-width:90vw;text-align:center';
    b.textContent=msg;
    document.body.appendChild(b);
    setTimeout(function(){b.remove();}, 6000);
  }

  function handleFile(file){
    if(!file) return;
    var rd=new FileReader();
    rd.onload=function(e){
      var parsed=parseCSVStrict(e.target.result);
      if(!parsed.headers.length){ toast('That file does not look like a CSV.', true); return; }
      if(!isCampaignExport(parsed.headers)){
        toast('No Subject/Body columns — that looks like a raw lead list, not a saved campaign.', true);
        return;
      }
      loadCampaign(parsed);
    };
    rd.readAsText(file);
  }


  /* ---------- Intercept the app's OWN upload paths ----------
     The main drop zone and "Upload CSV" button both call the global
     readFile(). We wrap it so a saved campaign is detected no matter
     which control the user uses. Raw lead files fall through to the
     original behaviour untouched. */
  function wrapReadFile(){
    if(typeof window.readFile!=='function'){ setTimeout(wrapReadFile,300); return; }
    if(window.readFile.__vrWrapped) return;
    var orig=window.readFile;
    var wrapped=function(f){
      if(!f){ return orig.apply(this,arguments); }
      var args=arguments, self=this;
      var rd=new FileReader();
      rd.onload=function(e){
        var parsed;
        try{ parsed=parseCSVStrict(e.target.result); }catch(err){ parsed={headers:[],rows:[]}; }
        if(parsed.headers.length && isCampaignExport(parsed.headers)){
          loadCampaign(parsed);           // saved campaign -> straight to Review
        }else{
          orig.apply(self,args);          // raw leads -> original flow
        }
      };
      rd.onerror=function(){ orig.apply(self,args); };
      rd.readAsText(f);
    };
    wrapped.__vrWrapped=true;
    window.readFile=wrapped;
  }


  /* ---------- Sender guard ----------
     Importing skips the Configure step, where sender name/email are set.
     launchCampaign() sends fromEmail/fromName from S.sender, so if those are
     empty the send fails. Show an inline form on Review/Send until filled. */
  function buildSenderForm(){
    var _S=getS()||{sender:{}};
    var box=document.createElement('div');
    box.id='vr-sender-box';
    box.style.cssText='border:1px solid rgba(245,158,11,.45);background:rgba(245,158,11,.08);'+
      'border-radius:12px;padding:14px 16px;margin-bottom:12px';
    var t=document.createElement('div');
    t.style.cssText='font-weight:700;font-size:13px;color:#f59e0b;margin-bottom:8px';
    t.textContent='Sender details needed before you can send';
    box.appendChild(t);

    var note=document.createElement('div');
    note.style.cssText='font-size:12px;color:#7b91b4;margin-bottom:10px;line-height:1.5';
    note.textContent='Imported campaigns skip the setup step, so we still need the name and address these emails are sent from.';
    box.appendChild(note);

    var row=document.createElement('div');
    row.style.cssText='display:flex;gap:8px;flex-wrap:wrap;align-items:center';

    function mkInput(ph,val,w){
      var i=document.createElement('input'); i.type='text'; i.placeholder=ph; i.value=val||'';
      i.style.cssText='flex:1;min-width:'+w+';font-size:13px;padding:8px 10px;border:1px solid rgba(59,130,246,.3);'+
        'border-radius:8px;background:rgba(13,21,38,.85);color:#e8f0fe;font-family:inherit';
      return i;
    }
    var nameI=mkInput('Your name (e.g. Yomi Olalere)', (_S.sender&&_S.sender.name)||'','160px');
    var mailI=mkInput('Sender email (e.g. you@company.com)', (_S.sender&&_S.sender.email)||'','200px');

    var save=document.createElement('button');
    save.textContent='Save';
    save.style.cssText='cursor:pointer;font-size:13px;font-weight:700;padding:9px 18px;border:none;'+
      'border-radius:8px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;font-family:inherit';
    save.addEventListener('click',function(){
      var nm=nameI.value.trim(), em=mailI.value.trim();
      if(!EMAIL_RX.test(em)){ toast('Enter a valid sender email address.', true); return; }
      if(!nm){ toast('Enter the name these emails are sent from.', true); return; }
      _S.sender.name=nm; _S.sender.email=em;
      try{ if(typeof window.saveUserKeys==='function') window.saveUserKeys(); }catch(e){}
      toast('Sender saved — you can send now.', false);
      var d=getDraw(); if(d) d();
    });

    row.appendChild(nameI); row.appendChild(mailI); row.appendChild(save);
    box.appendChild(row);
    return box;
  }

  function senderMissing(){
    var _S=getS();
    return !(_S && _S.sender && _S.sender.email && EMAIL_RX.test(_S.sender.email));
  }

  /* ---------- The visible panel (also proves this file loaded) ---------- */
  function buildPanel(){
    var wrap=document.createElement('div');
    wrap.id='vr-resume-panel';
    wrap.style.cssText='border:2px dashed rgba(16,185,129,.5);background:rgba(16,185,129,.06);'+
      'border-radius:14px;padding:16px 18px;margin-bottom:14px;display:flex;align-items:center;'+
      'gap:14px;flex-wrap:wrap;justify-content:space-between';

    var left=document.createElement('div');
    left.style.cssText='flex:1;min-width:240px';
    left.innerHTML='<div style="font-weight:700;font-size:14px;color:#10b981;margin-bottom:3px">'+
      'Resume a saved campaign</div>'+
      '<div style="font-size:12px;color:#7b91b4;line-height:1.5">'+
      'Upload a CSV you exported from Velorah (with Subject &amp; Body columns). '+
      'Your emails load ready to send — no regeneration, no AI credits used.</div>';

    var input=document.createElement('input');
    input.type='file'; input.accept='.csv,text/csv'; input.style.display='none';
    input.addEventListener('change',function(e){
      if(e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
      e.target.value='';
    });

    var btn=document.createElement('button');
    btn.textContent='Upload exported campaign';
    btn.style.cssText='cursor:pointer;font-size:13px;font-weight:700;padding:10px 18px;'+
      'border:none;border-radius:10px;background:linear-gradient(135deg,#10b981,#059669);'+
      'color:#fff;font-family:Outfit,sans-serif;white-space:nowrap;box-shadow:0 4px 14px rgba(16,185,129,.35)';
    btn.addEventListener('click',function(){ input.click(); });

    wrap.appendChild(left); wrap.appendChild(btn); wrap.appendChild(input);

    // Drag & drop onto the panel
    wrap.addEventListener('dragover',function(e){e.preventDefault();wrap.style.background='rgba(16,185,129,.16)';});
    wrap.addEventListener('dragleave',function(){wrap.style.background='rgba(16,185,129,.06)';});
    wrap.addEventListener('drop',function(e){
      e.preventDefault(); wrap.style.background='rgba(16,185,129,.06)';
      if(e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    return wrap;
  }

  /* Insert the panel at the top of the Upload step whenever it's showing. */
  function mount(){
    var _S=getS(); if(!_S) return;
    var root=document.getElementById('root');
    if(!root) return;
    var target=root.children.length>1 ? root.children[1] : root;

    // Resume panel: only on the Upload step
    var existing=document.getElementById('vr-resume-panel');
    if(_S.step===0){
      if(!existing && target && target.insertBefore) target.insertBefore(buildPanel(), target.firstChild);
    }else if(existing){ existing.remove(); }

    // Sender guard: on Review/Send, only for imported campaigns missing a sender
    var sbox=document.getElementById('vr-sender-box');
    var needSender = _imported && (_S.step===3 || _S.step===4) && senderMissing();
    if(needSender){
      if(!sbox && target && target.insertBefore) target.insertBefore(buildSenderForm(), target.firstChild);
    }else if(sbox){ sbox.remove(); }
  }

  // Re-mount after every redraw
  var _origDraw=null;
  function hook(){
    if(typeof window.draw!=='function'){ setTimeout(hook,300); return; }
    if(_origDraw) return;
    _origDraw=window.draw;
    window.draw=function(){ _origDraw.apply(this,arguments); try{ mount(); }catch(e){} };
    try{ window.draw(); }catch(e){}
    wrapReadFile();
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',function(){hook();wrapReadFile();});
  else { hook(); wrapReadFile(); }

  // Expose for debugging
  window.VelorahResume={ parseCSVStrict:parseCSVStrict, isCampaignExport:isCampaignExport, handleFile:handleFile };
})();
