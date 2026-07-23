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
    var H=parsed.headers;
    var cSub=findCol(H,A.subject), cBody=findCol(H,A.body), cEmail=findCol(H,A.email);

    if(!cEmail){ toast('That file has no Email column.', true); return; }

    window.S.headers=H;
    window.S.leads=parsed.rows;
    window.S.colMap={
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
    window.S.emails=[];
    parsed.rows.forEach(function(row){
      var to=(row[cEmail]||'').trim();
      var subject=(row[cSub]||'').trim();
      var body=(row[cBody]||'').trim();
      if(!to || !EMAIL_RX.test(to) || !subject || !body){ skipped++; return; }
      window.S.emails.push({
        id: window.S.emails.length,
        lead: row, subject: subject, body: body,
        approved: true, error: false, attachment: null
      });
    });

    if(!window.S.emails.length){
      toast('No usable emails found — need Email, Subject and Body with values.', true);
      return;
    }

    window.S.genProgress = window.S.emails.length;
    window.S.sendStatus={}; window.S.trackingStatus={}; window.S.messageIds={};
    window.S.validationDone=false; window.S.validationRunning=false;
    window.S.validationResults={summary:null,results:[]};
    if(!window.S.campaignName) window.S.campaignName='Imported '+new Date().toLocaleDateString();

    window.S.step=3; window.S.activeIdx=0;
    if(typeof window.draw==='function') window.draw();

    var msg=window.S.emails.length+' ready-to-send email'+(window.S.emails.length===1?'':'s')+' loaded';
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
    if(!window.S) return;
    var root=document.getElementById('root');
    if(!root) return;
    if(window.S.step!==0){ var old=document.getElementById('vr-resume-panel'); if(old) old.remove(); return; }
    if(document.getElementById('vr-resume-panel')) return;
    // the step content is the 2nd child (after the step bar)
    var target=root.children.length>1 ? root.children[1] : root;
    if(target && target.insertBefore) target.insertBefore(buildPanel(), target.firstChild);
  }

  // Re-mount after every redraw
  var _origDraw=null;
  function hook(){
    if(typeof window.draw!=='function'){ setTimeout(hook,300); return; }
    if(_origDraw) return;
    _origDraw=window.draw;
    window.draw=function(){ _origDraw.apply(this,arguments); try{ mount(); }catch(e){} };
    try{ window.draw(); }catch(e){}
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',hook);
  else hook();

  // Expose for debugging
  window.VelorahResume={ parseCSVStrict:parseCSVStrict, isCampaignExport:isCampaignExport, handleFile:handleFile };
})();
