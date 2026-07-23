/* ============================================================
   RESUME CAMPAIGN FROM EXPORT
   Lets you re-upload a CSV previously exported from this app
   (Name,Email,Company,Title,Industry,Subject,Body) and jump
   straight to Review/Send — no AI regeneration.

   Self-contained: paste this whole block near the end of the
   <script>, just BEFORE the line `initAuth();`.
   It redefines readFile() and dlSample(), which overrides the
   earlier versions — no other edits needed.
   ============================================================ */

/* RFC4180-compliant parser: correctly handles quoted fields that
   contain commas, quotes ("" escapes) AND newlines. The original
   parseCSV split on newlines first, which corrupted email bodies. */
function parseCSVStrict(text){
  var rows=[], row=[], cur='', q=false, i=0;
  text=String(text||'').replace(/^\uFEFF/,''); // strip BOM
  while(i<text.length){
    var ch=text[i];
    if(q){
      if(ch==='"'){
        if(text[i+1]==='"'){cur+='"';i+=2;continue;}
        q=false;i++;continue;
      }
      cur+=ch;i++;continue;
    }
    if(ch==='"'){q=true;i++;continue;}
    if(ch===','){row.push(cur);cur='';i++;continue;}
    if(ch==='\r'){i++;continue;}
    if(ch==='\n'){row.push(cur);rows.push(row);row=[];cur='';i++;continue;}
    cur+=ch;i++;
  }
  if(cur.length||row.length){row.push(cur);rows.push(row);}
  // drop fully-empty rows
  rows=rows.filter(function(r){return r.some(function(v){return String(v).trim()!=='';});});
  if(!rows.length) return {headers:[],rows:[]};
  var headers=rows[0].map(function(h){return String(h).trim();});
  var out=rows.slice(1).map(function(r){
    var o={};headers.forEach(function(h,idx){o[h]=(r[idx]!==undefined?String(r[idx]):'');});return o;
  });
  return {headers:headers, rows:out};
}

/* Find a header by any of several aliases, case-insensitively. */
function _findCol(headers, aliases){
  for(var i=0;i<headers.length;i++){
    var h=headers[i].toLowerCase().trim();
    for(var j=0;j<aliases.length;j++){ if(h===aliases[j]) return headers[i]; }
  }
  return '';
}

/* A CSV is a "finished campaign" if it has both a subject and a body column. */
function looksLikeGeneratedExport(headers){
  return !!(_findCol(headers,['subject','subject line']) &&
            _findCol(headers,['body','email body','message']));
}

/* Load an exported campaign straight into the review step. */
function importGeneratedCampaign(parsed){
  var H=parsed.headers;
  var cSub=_findCol(H,['subject','subject line']);
  var cBody=_findCol(H,['body','email body','message']);
  var cEmail=_findCol(H,['email','e-mail','recipient email','mail']);
  var cName=_findCol(H,['name','full name','recipient name','contact name']);
  var cFirst=_findCol(H,['first name','firstname','first']);
  var cLast=_findCol(H,['last name','lastname','surname']);
  var cCo=_findCol(H,['company','organization','org','account']);
  var cTitle=_findCol(H,['title','job title','position','role']);
  var cInd=_findCol(H,['industry','sector','vertical']);

  S.headers=H;
  S.leads=parsed.rows;
  S.colMap={
    email:cEmail, fullName:cName, firstName:cFirst, lastName:cLast,
    company:cCo, title:cTitle, industry:cInd, companySize:'', revenue:''
  };

  var skipped=0;
  S.emails=[];
  parsed.rows.forEach(function(row,idx){
    var to=(row[cEmail]||'').trim();
    var subject=(row[cSub]||'').trim();
    var body=(row[cBody]||'').trim();
    if(!to||!emailRx.test(to)||!subject||!body){ skipped++; return; }
    S.emails.push({
      id:S.emails.length, lead:row, subject:subject, body:body,
      approved:true, error:false, attachment:null
    });
  });

  S.genProgress=S.emails.length;
  S.sendStatus={}; S.trackingStatus={}; S.messageIds={};
  S.validationDone=false; S.validationRunning=false;
  S.validationResults={summary:null,results:[]};
  if(!S.campaignName) S.campaignName='Imported '+new Date().toLocaleDateString();

  if(!S.emails.length){
    alert('No usable emails found in that file.\n\nA campaign export needs Email, Subject and Body columns with values.');
    return;
  }

  S.step=3; S.activeIdx=0;
  draw();

  var msg=S.emails.length+' ready-to-send email'+(S.emails.length===1?'':'s')+' imported';
  if(skipped) msg+=' \u00b7 '+skipped+' row'+(skipped===1?'':'s')+' skipped (missing email/subject/body)';
  var b=document.createElement('div');
  b.style.cssText='position:fixed;top:64px;left:50%;transform:translateX(-50%);background:linear-gradient(135deg,var(--green),#059669);color:#fff;padding:12px 24px;border-radius:10px;font-weight:700;z-index:9999;font-size:14px;box-shadow:0 4px 20px rgba(16,185,129,.45)';
  b.textContent=msg;
  document.body.appendChild(b);
  setTimeout(function(){b.remove();},5000);
}

/* OVERRIDES the earlier readFile(): routes an exported campaign to the
   review step, and any other CSV to the normal lead-mapping flow. */
function readFile(f){
  if(!f) return;
  var rd=new FileReader();
  rd.onload=function(e){
    var text=e.target.result;
    var parsed=parseCSVStrict(text);
    if(!parsed.headers.length){ alert('That file does not look like a CSV.'); return; }

    if(looksLikeGeneratedExport(parsed.headers)){
      importGeneratedCampaign(parsed);
      return;
    }
    // Normal path: raw leads -> configure -> generate
    S.headers=parsed.headers;
    S.leads=parsed.rows;
    S.colMap=autoMap(parsed.headers);
    draw();
    scheduleDraftSave();
  };
  rd.readAsText(f);
}

/* OVERRIDES dlSample(): mentions the resume feature in the tip text. */
function dlSample(){
  var csv='First Name,Last Name,Email,Company,Job Title,Industry,Company Size\n'
    +'John,Smith,john@acme.com,Acme Financial,CISO,Financial Services,2500\n'
    +'Sarah,Chen,sarah@health.io,HealthTech Inc,Chief Compliance Officer,Healthcare,800\n'
    +'Mike,Johnson,mike@retail.com,RetailCo,VP of IT,Retail,150';
  var a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download='sample_leads.csv';a.click();
}
