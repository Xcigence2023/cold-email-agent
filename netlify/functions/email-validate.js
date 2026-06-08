/**
 * email-validate.js -- Pre-send Email Intelligence
 * Place in: netlify/functions/email-validate.js
 *
 * Validates recipients before send:
 *   - DNS/MX record existence
 *   - Disposable email detection
 *   - High-risk domain flags (gov/mil/edu strict filters)
 *   - Corporate firewall likelihood
 *   - Catchall domain detection
 *   - Email content spam scoring
 *   - Subject line analysis
 *   - Deliverability recommendations
 */

const dns = require('dns').promises;

const _rl = new Map();
function _rate(id, max, win) {
  const n = Date.now(), r = _rl.get(id) || { c: 0, t: n + (win || 60000) };
  if (n > r.t) { r.c = 0; r.t = n + (win || 60000); }
  r.c++; _rl.set(id, r);
  return r.c <= (max || 20);
}

const HDR = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type':                 'application/json',
  'X-Content-Type-Options':       'nosniff'
};

// -- KNOWN DISPOSABLE / THROWAWAY EMAIL PROVIDERS -------------
const DISPOSABLE = new Set([
  'mailinator.com','guerrillamail.com','temp-mail.org','throwaway.email',
  'yopmail.com','maildrop.cc','sharklasers.com','guerrillamailblock.com',
  'grr.la','guerrillamail.info','grr.la','spam4.me','trashmail.com',
  'fakeinbox.com','dispostable.com','tempr.email','discard.email',
  'spamgourmet.com','spamgourmet.net','jetable.fr.nf','noclickemail.com',
  'spamherelots.com','trashmail.io','mailnull.com','spamspot.com',
  '10minutemail.com','tempmail.com','throwam.com','getnada.com',
  'mailnesia.com','nowmymail.com','mailnull.com','spamgourmet.org'
]);

// -- HIGH RISK TLDS / DOMAINS ----------------------------------
const STRICT_FIREWALL_DOMAINS = new Set([
  // Government -- very strict inbound filters
  'gov','mil','fed.us','state.us',
  // Healthcare -- HIPAA compliance filters
  'nhs.uk','va.gov','cdc.gov','nih.gov',
  // Finance -- SEC/compliance filters
  'sec.gov','fdic.gov','federalreserve.gov',
  // Big tech -- aggressive spam filters
  'google.com','microsoft.com','apple.com','amazon.com','meta.com',
  'facebook.com','twitter.com','linkedin.com','salesforce.com'
]);

// -- SPAM TRIGGER WORDS (content) -----------------------------
const SPAM_TRIGGERS = [
  // Financial spam
  'make money','cash bonus','earn extra','extra income','financial freedom',
  'risk free','risk-free','no risk','guaranteed','promise','100% free',
  'double your','triple your','million dollars','earn $$','cash prize',
  // Urgency spam
  'act now','limited time','expires','urgent','immediate','don\'t delay',
  'last chance','order now','click here','click below','buy now',
  'order today','subscribe now','sign up free',
  // Authority/legal spam
  'as seen on','as seen in','dear friend','dear valued','to whom it may',
  'this is not spam','remove me','opt out','this email','this message',
  // Medical spam  
  'weight loss','lose weight','diet','miracle','cure','treatment',
  // Phishing signals
  'verify your','confirm your account','update your information',
  'bank account','routing number','social security','ssn',
  'password','login credentials','wire transfer',
  // Over-used marketing
  'amazing opportunity','once in a lifetime','exclusive offer',
  'special promotion','free gift','bonus offer','congratulations you',
  'you have been selected','you are a winner'
];

// -- SUBJECT LINE CHECKS ---------------------------------------
const SUBJECT_TRIGGERS = [
  'free','win','winner','congratulations','urgent','important','act now',
  'limited','offer','deal','discount','save','$','%off','no cost',
  'guaranteed','promise','risk-free','this is not','re:','fw:',
  '!!!','???','all caps'
];

// -- CORPORATE DOMAINS LIKELY TO USE STRICT FILTERING --------
function corporateRiskLevel(domain) {
  const tld = domain.split('.').pop().toLowerCase();
  const name = domain.split('.').slice(0, -1).join('.').toLowerCase();

  if (['gov','mil'].includes(tld)) return { level: 'high', reason: 'Government domain -- very strict inbound filtering and likely rejects cold outreach' };
  if (tld === 'edu') return { level: 'medium', reason: 'Educational institution -- often has strict spam filters' };
  if (STRICT_FIREWALL_DOMAINS.has(domain)) return { level: 'high', reason: 'Large enterprise -- aggressive spam filtering and likely uses allowlists' };

  // Healthcare indicators
  if (/hospital|health|clinic|medical|pharma|biotech/.test(name)) return { level: 'medium', reason: 'Healthcare domain -- HIPAA-compliant filters may block cold email' };
  // Finance indicators
  if (/bank|finance|capital|insurance|invest|fund|asset/.test(name)) return { level: 'medium', reason: 'Financial domain -- compliance email filtering likely active' };
  // Legal indicators
  if (/law|legal|attorney|counsel|llp|llc/.test(name)) return { level: 'low', reason: 'Legal firm -- professional email expected, moderate filter risk' };

  return { level: 'low', reason: null };
}

// -- CONTENT SPAM SCORER ---------------------------------------
function scoreContent(subject, body) {
  const issues = [];
  const suggestions = [];
  let score = 0;

  const text = ((subject || '') + ' ' + (body || '')).toLowerCase();
  const subjectLower = (subject || '').toLowerCase();

  // Spam triggers in content
  const foundTriggers = SPAM_TRIGGERS.filter(function(t) { return text.includes(t); });
  if (foundTriggers.length > 0) {
    score += foundTriggers.length * 8;
    issues.push('Contains ' + foundTriggers.length + ' spam trigger word(s): ' + foundTriggers.slice(0, 3).join(', ') + (foundTriggers.length > 3 ? '...' : ''));
    suggestions.push('Replace trigger phrases: ' + foundTriggers.slice(0, 2).map(function(t) { return '"' + t + '"'; }).join(', ') + ' with natural language');
  }

  // Subject length
  if (subject && subject.length > 60) { score += 10; issues.push('Subject too long (' + subject.length + ' chars) -- aim for under 50'); suggestions.push('Shorten subject to 5-8 words for better open rates'); }
  if (subject && subject.length < 5)  { score += 15; issues.push('Subject too short -- looks like spam'); }

  // Subject spam signals
  if (/[A-Z]{3,}/.test(subject)) { score += 12; issues.push('ALLCAPS words in subject -- major spam signal'); suggestions.push('Use sentence case in subject lines only'); }
  if ((subject || '').split('!').length > 2) { score += 10; issues.push('Multiple exclamation marks in subject'); }
  if ((subject || '').includes('$') || (subject || '').includes('%')) { score += 8; issues.push('Currency/percentage symbols in subject line'); }
  if (/re:|fw:/i.test(subjectLower)) { score += 5; issues.push('Fake Re:/Fw: prefix is a known spam tactic'); }

  // Body checks
  if (body) {
    const wordCount = body.split(/\s+/).length;
    if (wordCount < 20) { score += 8; issues.push('Email body too short -- looks automated'); suggestions.push('Add 2-3 personalised sentences specific to the recipient'); }
    if (wordCount > 300) { score += 5; issues.push('Email body very long -- cold emails should be under 200 words'); suggestions.push('Cut to 3-5 short paragraphs or bullet points'); }

    // Link density
    const linkCount = (body.match(/https?:\/\//g) || []).length;
    if (linkCount > 3) { score += linkCount * 5; issues.push('Too many links (' + linkCount + ') -- spam filters penalise link-heavy emails'); suggestions.push('Limit to 1-2 links maximum in cold email'); }

    // No personalisation signals
    if (!body.includes('{{') && !/\b(your|you|we noticed|i saw|i read|reached out)\b/i.test(body)) {
      score += 8; issues.push('No personalisation detected -- generic emails get filtered');
      suggestions.push('Add recipient name and a specific observation about their company');
    }

    // Unsubscribe
    if (!/unsubscribe|opt.?out/i.test(body)) {
      score += 5; issues.push('Missing unsubscribe option -- CAN-SPAM/GDPR compliance risk');
      suggestions.push('Add a simple "Reply STOP to unsubscribe" line at the bottom');
    }

    // HTML only (no plain text equivalent likely)
    if (/<[a-z]/i.test(body) && body.includes('<img')) {
      score += 8; issues.push('Image-heavy HTML email -- image-only emails heavily filtered');
      suggestions.push('Use mostly text with minimal images; always include alt text');
    }
  }

  const rating = score === 0 ? 'excellent' : score < 15 ? 'good' : score < 30 ? 'fair' : score < 50 ? 'poor' : 'critical';
  return { score: Math.min(score, 100), rating: rating, issues: issues, suggestions: suggestions };
}

// -- MAIN HANDLER ----------------------------------------------
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };

  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!_rate(ip, 20, 60000)) return { statusCode: 429, headers: HDR, body: JSON.stringify({ error: 'Too many requests' }) };

  let emails, subject, body, action;
  try {
    const parsed = JSON.parse(event.body || '{}');
    emails  = Array.isArray(parsed.emails) ? parsed.emails.slice(0, 100) : [];
    subject = parsed.subject || '';
    body    = parsed.body    || '';
    action  = parsed.action  || 'validate';
  } catch(e) {
    return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // -- ACTION: VALIDATE EMAILS -------------------------------
  if (action === 'validate' || action === 'full') {
    const results = [];
    const domainCache = new Map();

    for (var i = 0; i < emails.length; i++) {
      var email = String(emails[i]).trim().toLowerCase();
      var result = { email: email, status: 'valid', risk: 'low', warnings: [], deliverabilityScore: 100 };

      // 1. Syntax check
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        result.status = 'invalid';
        result.risk = 'critical';
        result.warnings.push('Invalid email format');
        result.deliverabilityScore = 0;
        results.push(result);
        continue;
      }

      const parts = email.split('@');
      const domain = parts[1];

      // 2. Disposable email
      if (DISPOSABLE.has(domain)) {
        result.status = 'invalid';
        result.risk = 'critical';
        result.warnings.push('Disposable email provider -- will bounce or ignore');
        result.deliverabilityScore = 0;
        results.push(result);
        continue;
      }

      // 3. Corporate firewall risk
      const corpRisk = corporateRiskLevel(domain);
      if (corpRisk.level === 'high') {
        result.risk = 'high';
        result.warnings.push(corpRisk.reason);
        result.deliverabilityScore -= 40;
      } else if (corpRisk.level === 'medium') {
        result.risk = 'medium';
        result.warnings.push(corpRisk.reason);
        result.deliverabilityScore -= 20;
      }

      // 4. DNS / MX record check (with cache)
      if (!domainCache.has(domain)) {
        try {
          const mxRecords = await dns.resolveMx(domain);
          const hasMx = mxRecords && mxRecords.length > 0;
          domainCache.set(domain, { hasMx: hasMx, mx: hasMx ? mxRecords[0].exchange : null });
        } catch(e) {
          domainCache.set(domain, { hasMx: false, mx: null, error: e.code });
        }
      }

      const dnsResult = domainCache.get(domain);
      if (!dnsResult.hasMx) {
        if (dnsResult.error === 'ENOTFOUND') {
          result.status = 'invalid';
          result.risk = 'critical';
          result.warnings.push('Domain does not exist (DNS lookup failed)');
          result.deliverabilityScore = 0;
        } else if (dnsResult.error === 'ENODATA') {
          result.status = 'warning';
          result.risk = 'high';
          result.warnings.push('No MX records found -- domain may not accept email');
          result.deliverabilityScore -= 60;
        } else {
          result.status = 'warning';
          result.risk = 'medium';
          result.warnings.push('Could not verify mail server (DNS timeout)');
          result.deliverabilityScore -= 15;
        }
      } else {
        // Check SPF record exists
        try {
          const txtRecords = await dns.resolveTxt(domain);
          const spf = txtRecords.flat().find(function(t) { return t.startsWith('v=spf1'); });
          if (!spf) {
            result.warnings.push('No SPF record -- domain may be more likely to land in spam');
            result.deliverabilityScore -= 10;
          }
        } catch(e) {}

        // Flag common consumer providers -- great for personal, variable for B2B
        if (['gmail.com','yahoo.com','hotmail.com','outlook.com','live.com','aol.com','icloud.com'].includes(domain)) {
          result.warnings.push('Personal email account -- may indicate non-decision-maker or personal address');
          result.deliverabilityScore -= 5;
        }

        // Note the MX provider for intelligence
        const mx = dnsResult.mx || '';
        if (mx.includes('google') || mx.includes('googlemail')) result.provider = 'Google Workspace';
        else if (mx.includes('microsoft') || mx.includes('outlook') || mx.includes('office365')) result.provider = 'Microsoft 365';
        else if (mx.includes('mimecast')) { result.provider = 'Mimecast'; result.warnings.push('Mimecast gateway detected -- strict spam filtering, ensure DKIM/SPF is set on sender'); result.deliverabilityScore -= 15; }
        else if (mx.includes('proofpoint')) { result.provider = 'Proofpoint'; result.warnings.push('Proofpoint gateway detected -- enterprise-grade email filtering active'); result.deliverabilityScore -= 15; }
        else if (mx.includes('barracuda')) { result.provider = 'Barracuda'; result.warnings.push('Barracuda gateway detected -- requires sender reputation, warm up sending volume slowly'); result.deliverabilityScore -= 10; }
        else if (mx.includes('ironport') || mx.includes('cisco')) { result.provider = 'Cisco IronPort'; result.warnings.push('Cisco IronPort gateway detected -- very strict enterprise filter'); result.deliverabilityScore -= 20; }
      }

      // 5. Role-based email check
      const localPart = parts[0];
      if (/^(info|admin|support|noreply|no-reply|postmaster|webmaster|sales|marketing|contact|hello|team|hr|careers|jobs|abuse|spam|unsubscribe|feedback|billing|payments|accounts|office|reception|enquiries|general)$/.test(localPart)) {
        result.warnings.push('Role-based address (info@, admin@, etc.) -- likely handled by a group or auto-responder, low personal engagement probability');
        result.deliverabilityScore -= 20;
        if (result.risk === 'low') result.risk = 'medium';
      }

      result.deliverabilityScore = Math.max(0, Math.min(100, result.deliverabilityScore));
      if (result.status === 'valid' && result.deliverabilityScore < 50) result.status = 'warning';
      if (result.warnings.length === 0) result.warnings.push('No issues found');

      results.push(result);
    }

    // -- CONTENT ANALYSIS --------------------------------------
    const contentAnalysis = (subject || body) ? scoreContent(subject, body) : null;

    // -- SUMMARY -----------------------------------------------
    const summary = {
      total:          results.length,
      valid:          results.filter(function(r) { return r.status === 'valid'; }).length,
      warnings:       results.filter(function(r) { return r.status === 'warning'; }).length,
      invalid:        results.filter(function(r) { return r.status === 'invalid'; }).length,
      highRisk:       results.filter(function(r) { return r.risk === 'high' || r.risk === 'critical'; }).length,
      avgDelivScore:  Math.round(results.reduce(function(s, r) { return s + r.deliverabilityScore; }, 0) / Math.max(results.length, 1)),
      contentScore:   contentAnalysis ? contentAnalysis.score : null,
      contentRating:  contentAnalysis ? contentAnalysis.rating : null,
      readyToSend:    results.filter(function(r) { return r.status !== 'invalid'; }).length
    };

    return {
      statusCode: 200,
      headers: HDR,
      body: JSON.stringify({ results: results, summary: summary, contentAnalysis: contentAnalysis })
    };
  }

  return { statusCode: 400, headers: HDR, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
};
