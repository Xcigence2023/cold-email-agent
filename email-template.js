/**
 * Velorah email templates — engine + visual designer.
 *
 * Users type their content into a form; this produces a polished, email-safe HTML
 * message (tables + inline styles, hidden inbox-preview text, Outlook-safe button)
 * and a matching plain-text version. Everything user-typed is HTML-escaped, so lead
 * data from a CSV can never inject markup into an email.
 *
 * Public API  (window.VelorahEmailTemplate):
 *   defaults() / presets            starter content (Velorah launch, Insight AI Careers)
 *   loadSettings() / saveSettings() remembered in this browser (localStorage)
 *   build(cfg, vars)                -> { subject, html, text }   one finished email
 *   validate(cfg, opts)             -> { errors:[], warnings:[] } things to fix before sending
 *   openDesigner({cfg, onSave})     full-screen editor with live preview
 *
 * Merge fields (usable in any text box):
 *   {{first_name}} {{last_name}} {{full_name}} {{company}} {{title}} {{industry}} {{email}}
 *   {{sender_name}} {{sender_title}} {{sender_company}} {{sender_email}} {{unsubscribe_url}}
 *
 * Text conventions: a blank line starts a new paragraph, a single line break stays a
 * line break, and **double asterisks** make bold.
 */
(function (root) {
  'use strict';

  var STORE_KEY = 'velorah_email_template_v2';
  var MERGE_FIELDS = ['first_name', 'last_name', 'full_name', 'company', 'title', 'industry', 'email',
    'sender_name', 'sender_title', 'sender_company', 'sender_email', 'unsubscribe_url'];
  // What a merge field shows when a lead has no value for it, so mail never says "Hi {{first_name}},"
  var FALLBACKS = { first_name: 'there', full_name: 'there', company: 'your company', industry: 'your industry' };

  var PALETTES = {
    violet: { name: 'Velorah violet', primary: '#6D28D9', primaryDark: '#2E1065', accent: '#F472B6', accentText: '#2A0A22', pageBg: '#F3F0FF', cardBg: '#F8F5FF', text: '#1B1630', muted: '#4B4566' },
    indigo: { name: 'Indigo + amber', primary: '#0A0A86', primaryDark: '#05052A', accent: '#F29E4C', accentText: '#14123A', pageBg: '#EEF0F7', cardBg: '#F5F6FC', text: '#1B1D3A', muted: '#464B68' },
    emerald: { name: 'Emerald', primary: '#047857', primaryDark: '#022C22', accent: '#FBBF24', accentText: '#1F2937', pageBg: '#ECF6F1', cardBg: '#F2FAF6', text: '#10231B', muted: '#41584D' },
    crimson: { name: 'Crimson', primary: '#9F1239', primaryDark: '#4C0519', accent: '#FDBA74', accentText: '#3B0A14', pageBg: '#FBEFF2', cardBg: '#FDF4F6', text: '#2A0E16', muted: '#6B4651' },
    slate: { name: 'Slate + sky', primary: '#1E293B', primaryDark: '#0B1220', accent: '#38BDF8', accentText: '#06202E', pageBg: '#EEF2F6', cardBg: '#F4F7FA', text: '#111827', muted: '#475569' }
  };
  var THEME_KEYS = ['primary', 'primaryDark', 'accent', 'accentText', 'pageBg', 'cardBg', 'text', 'muted'];

  /* ───────────────────────── starter content ───────────────────────── */

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function theme(key) { var p = clone(PALETTES[key]); delete p.name; return p; }

  var PRESETS = {
    velorah: {
      label: 'Velorah — AI growth platform (default)',
      cfg: function () {
        return {
          v: 2, theme: theme('violet'),
          content: {
            subject: 'A faster way to grow, {{first_name}}',
            brand: 'VELORAH', badge: 'NEW · EARLY ACCESS',
            headline: 'Your AI growth team, in one platform.',
            subhead: 'Find buyers, write the outreach, call leads and close, without juggling five tools.',
            preheader: 'See how teams book more meetings with one AI-run outbound system.',
            greeting: 'Hi {{first_name}},',
            intro: 'Most outbound stacks are five tools taped together. Velorah replaces them with one platform that runs the whole motion.\n\nHere is what that means for {{company}}:',
            highlights: [
              { title: 'Up to 10x more conversations per rep', text: 'AI finds, writes to and follows up with the right buyers, so your team spends its time talking, not prospecting.' },
              { title: 'About 60% lower cost than a typical tool stack', text: 'One platform instead of separate lead, email, dialer and CRM subscriptions.' }
            ],
            sectionTitle: 'One platform, five stages',
            sectionIntro: 'Every stage runs as one continuous flow.',
            cards: [
              { title: 'Find', text: 'Discover and enrich buyers who fit.' },
              { title: 'Write', text: 'Personalised outreach in your voice.' },
              { title: 'Send', text: 'Tracked campaigns that reach the inbox.' },
              { title: 'Call', text: 'Consent-first AI and human calling.' },
              { title: 'Close', text: 'A built-in CRM keeps every deal moving.' }
            ],
            stepsTitle: 'How it works',
            steps: ['Book a short demo.', 'We set Velorah up on your pipeline.', 'Start booking meetings, usually within a day.'],
            ctaText: 'Book a demo', ctaUrl: 'https://velorahflow.io/contact.html', ctaNote: '20 minutes, tailored to your use case.',
            closing: 'If you would rather see it on your own pipeline than read about it, just reply to this email and we will set it up.',
            signoff: 'Best,', senderName: '{{sender_name}}', senderTitle: '{{sender_title}}, {{sender_company}}',
            footerReason: 'You are receiving this email because we thought Velorah could be relevant to {{company}}.',
            address: '', contactEmail: '', website: 'https://velorahflow.io'
          }
        };
      }
    },
    insight: {
      label: 'Insight — AI Careers early access (example)',
      cfg: function () {
        return {
          v: 2, theme: theme('indigo'),
          content: {
            subject: "Your early access to Insight's AI Career Toolbox",
            brand: 'INSIGHT', badge: 'EARLY ACCESS · LIMITED PLACES',
            headline: "Your next career is in AI. Let's get you there.",
            subhead: "You signed up with Insight, so you're among the first we're inviting into our new AI Career Toolbox.",
            preheader: 'Limited early access to Intelligent Resume and the AI Career Toolbox, plus four AI career pathways. Places are limited.',
            greeting: 'Hi {{first_name}},',
            intro: 'AI is creating new jobs faster than people are being trained to fill them. We built the Insight AI Career Toolbox so you can be one of the people who do.\n\nFor a limited time, registered Insight members get **free early access** to:',
            highlights: [
              { title: 'Intelligent Resume', text: 'A résumé that updates itself as you learn and is tailored to the role you want.' },
              { title: 'The AI Career Toolbox', text: "**PathFinder** maps your route. **VisionTrack** tracks your progress. **MarketWorth** shows what your skills are worth in today's job market." }
            ],
            sectionTitle: 'Choose your AI career pathway',
            sectionIntro: "Pick one of four roles employers are hiring for now. We'll build a personal plan from where you are today.",
            cards: [
              { title: 'AI Subject Matter Expert', text: 'Use what you already know to train, test and guide AI in your field.' },
              { title: 'AI Security Engineer', text: 'Protect AI systems, models and data from new kinds of threats.' },
              { title: 'AI Process Engineer', text: 'Redesign how work gets done with AI and automation.' },
              { title: 'AI Project Manager', text: 'Lead AI projects from idea to launch and deliver results.' }
            ],
            stepsTitle: 'How it works',
            steps: ['Claim your place and log in.', 'Pick a pathway. PathFinder builds your plan in minutes.', 'Learn, prove your skills, and watch your Intelligent Resume and MarketWorth grow.'],
            ctaText: 'Claim my early access',
            ctaUrl: 'https://www.insight-learning.org/?utm_source=email&utm_medium=campaign&utm_campaign=ai_careers_early_access',
            ctaNote: 'Only [number] places are available. Access closes on [date].',
            closing: "I started Insight because I believe nobody should have to downgrade their dream. If you've been thinking about moving into AI, this is a good time to start, and we'll be with you at every step.",
            signoff: 'See you inside,', senderName: 'Yomi Olalere', senderTitle: 'Founder and CEO, Insight',
            footerReason: "You're receiving this because you registered an account at insight-learning.org.",
            address: '[Company mailing address]', contactEmail: 'aao@insight-learning.org', website: 'https://www.insight-learning.org'
          }
        };
      }
    }
  };

  function defaults() { return PRESETS.velorah.cfg(); }

  /* ───────────────────────── helpers ───────────────────────── */

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function hexOk(v) { return /^#[0-9a-fA-F]{6}$/.test(v || ''); }
  function col(v, fallback) { return hexOk(v) ? v.toUpperCase() : fallback; }
  function rgb(h) { return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)]; }
  function mix(a, b, w) { // move colour a toward colour b by fraction w
    var x = rgb(a), y = rgb(b);
    return '#' + [0, 1, 2].map(function (i) {
      var v = Math.round(x[i] * (1 - w) + y[i] * w); return ('0' + v.toString(16)).slice(-2);
    }).join('').toUpperCase();
  }
  function lum(h) {
    var c = rgb(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) { var l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
  function safeUrl(u) { u = String(u == null ? '' : u).trim(); return /^(https?:\/\/|mailto:)/i.test(u) ? u : ''; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function str(v) { return v == null ? '' : String(v); }

  /** Fill in anything missing so rendering never throws on a half-edited template. */
  function normalize(cfg) {
    var base = defaults(), out = { v: 2, theme: {}, content: {} };
    cfg = cfg || {};
    THEME_KEYS.forEach(function (k) { out.theme[k] = col(cfg.theme && cfg.theme[k], base.theme[k]); });
    var c = cfg.content || {};
    Object.keys(base.content).forEach(function (k) {
      var d = base.content[k];
      if (Array.isArray(d)) {
        out.content[k] = (k === 'steps') ? arr(c[k]).map(str).filter(function (s) { return s.trim(); })
          : arr(c[k]).map(function (it) { return { title: str(it && it.title), text: str(it && it.text) }; })
              .filter(function (it) { return it.title.trim() || it.text.trim(); });
      } else out.content[k] = (c[k] === undefined) ? '' : str(c[k]);
    });
    return out;
  }

  /* ───────────────────────── merge + text formatting ───────────────────────── */

  function makeCtx(vars) {
    var v = {};
    vars = vars || {};
    MERGE_FIELDS.forEach(function (k) {
      var val = vars[k]; val = (val == null) ? '' : String(val).trim();
      v[k] = val || FALLBACKS[k] || '';
    });
    if (!vars.unsubscribe_url) {
      var to = vars.sender_email || vars.contact_email || '';
      v.unsubscribe_url = to ? 'mailto:' + to + '?subject=Unsubscribe' : '';
    }
    return { vars: v, opening: str(vars.opening) };
  }
  // escape first, then merge (merged values are escaped too), then **bold**
  function inline(s, ctx) {
    return esc(s).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, function (m, k) {
      k = k.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ctx.vars, k) ? esc(ctx.vars[k]) : m;
    }).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  }
  function plain(s, ctx) { // same merge, no HTML (for the text version and the subject)
    return String(s == null ? '' : s).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, function (m, k) {
      k = k.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ctx.vars, k) ? ctx.vars[k] : m;
    }).replace(/\*\*([^*\n]+)\*\*/g, '$1');
  }
  function paragraphs(text, ctx, style) {
    return String(text || '').replace(/\r/g, '').split(/\n{2,}/).map(function (b) { return b.trim(); })
      .filter(Boolean).map(function (b) {
        return '<p style="' + style + '">' + inline(b, ctx).replace(/\n/g, '<br>') + '</p>';
      }).join('');
  }
  // wordmarks are shouted in the header (INSIGHT) but read naturally in the footer (Insight)
  function brandName(b) { b = String(b || '').trim(); return (b && b === b.toUpperCase() && /[A-Z]/.test(b)) ? b.toLowerCase().replace(/\b[a-z]/g, function (m) { return m.toUpperCase(); }) : b; }
  function trimSeparators(s) { return String(s).replace(/^\s*[,·|-]\s*/, '').replace(/\s*[,·|-]\s*$/, ''); }

  /* ───────────────────────── render: HTML ───────────────────────── */

  function render(cfg, vars) {
    var n = normalize(cfg), t = n.theme, c = n.content, ctx = makeCtx(vars);
    var F = 'font-family:Arial,Helvetica,sans-serif;';
    var soft = mix(t.primary, '#FFFFFF', 0.84), line = mix(t.primary, '#FFFFFF', 0.87), faint = mix(t.muted, '#FFFFFF', 0.2);
    var P = function (m, size, color, extra) { return 'margin:' + m + ';font-size:' + size + 'px;line-height:1.6;color:' + color + ';' + (extra || ''); };
    var h = [];

    h.push('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="x-apple-disable-message-reformatting"><title>' + esc(plain(c.subject, ctx)) + '</title></head>',
      '<body style="margin:0;padding:0;background:' + t.pageBg + ';' + F + 'color:' + t.text + ';">');
    if (c.preheader.trim()) {
      h.push('<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">' + inline(c.preheader, ctx) + '</div>');
    }
    h.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + t.pageBg + ';"><tr><td align="center" style="padding:24px 12px;">',
      '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:14px;overflow:hidden;">');

    // header
    h.push('<tr><td bgcolor="' + t.primary + '" style="background:' + t.primary + ';background-image:linear-gradient(115deg,' + t.primary + ',' + t.primaryDark + ');padding:32px 36px 36px;">');
    if (c.brand.trim()) h.push('<p style="margin:0 0 20px;font-size:22px;font-weight:bold;letter-spacing:2px;color:#FFFFFF;">' + inline(c.brand, ctx) + '</p>');
    if (c.badge.trim()) h.push('<p style="margin:0 0 10px;font-size:13px;font-weight:bold;letter-spacing:3px;color:' + t.accent + ';">' + inline(c.badge, ctx) + '</p>');
    if (c.headline.trim()) h.push('<h1 style="margin:0 0 14px;font-size:30px;line-height:1.2;color:#FFFFFF;">' + inline(c.headline, ctx) + '</h1>');
    if (c.subhead.trim()) h.push('<p style="' + P('0', 16, soft) + '">' + inline(c.subhead, ctx) + '</p>');
    h.push('</td></tr>');

    // greeting + personalised opening + intro
    var bodyStyle = P('0 0 16px', 16, t.text).replace('line-height:1.6', 'line-height:1.65');
    var top = '';
    if (c.greeting.trim()) top += '<p style="' + bodyStyle + '">' + inline(c.greeting, ctx) + '</p>';
    if (ctx.opening.trim()) top += paragraphs(ctx.opening, { vars: ctx.vars }, bodyStyle);
    top += paragraphs(c.intro, ctx, bodyStyle);
    if (top) h.push('<tr><td style="padding:32px 36px 8px;font-size:16px;line-height:1.65;color:' + t.text + ';">' + top + '</td></tr>');

    // highlight boxes
    if (c.highlights.length) {
      h.push('<tr><td style="padding:0 36px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">');
      c.highlights.forEach(function (it, i) {
        if (i) h.push('<tr><td style="height:10px;line-height:10px;font-size:10px;">&nbsp;</td></tr>');
        h.push('<tr><td bgcolor="' + t.cardBg + '" style="background:' + t.cardBg + ';border-left:4px solid ' + t.accent + ';border-radius:8px;padding:16px 18px;">');
        if (it.title.trim()) h.push('<p style="margin:0 0 4px;font-size:16px;font-weight:bold;color:' + t.primary + ';">' + inline(it.title, ctx) + '</p>');
        if (it.text.trim()) h.push('<p style="margin:0;font-size:15px;line-height:1.55;color:' + t.muted + ';">' + inline(it.text, ctx) + '</p>');
        h.push('</td></tr>');
      });
      h.push('</table></td></tr>');
    }

    // card grid
    if (c.sectionTitle.trim() || c.sectionIntro.trim()) {
      h.push('<tr><td style="padding:28px 36px 8px;font-size:16px;line-height:1.65;">');
      if (c.sectionTitle.trim()) h.push('<h2 style="margin:0 0 8px;font-size:20px;color:' + t.primary + ';">' + inline(c.sectionTitle, ctx) + '</h2>');
      if (c.sectionIntro.trim()) h.push('<p style="margin:0 0 16px;color:' + t.muted + ';">' + inline(c.sectionIntro, ctx) + '</p>');
      h.push('</td></tr>');
    }
    if (c.cards.length) {
      // The border lives on the <td> itself: cells in one row always stretch to the same
      // height, so side-by-side cards line up even when their text wraps differently.
      var cell = function (it, wide) {
        return '<td ' + (wide ? 'colspan="3" ' : 'width="48%" ') + 'valign="top" style="border:1px solid ' + line + ';border-top:4px solid ' + t.primary + ';border-radius:8px;padding:14px 16px;">' +
          (it.title.trim() ? '<p style="margin:0 0 4px;font-size:15px;font-weight:bold;color:' + t.text + ';">' + inline(it.title, ctx) + '</p>' : '') +
          (it.text.trim() ? '<p style="margin:0;font-size:14px;line-height:1.5;color:' + t.muted + ';">' + inline(it.text, ctx) + '</p>' : '') +
          '</td>';
      };
      var gap = '<tr><td colspan="3" style="height:12px;line-height:12px;font-size:12px;">&nbsp;</td></tr>';
      h.push('<tr><td style="padding:0 36px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">');
      for (var i = 0; i < c.cards.length; i += 2) {
        if (i) h.push(gap);
        if (i + 1 < c.cards.length) h.push('<tr>' + cell(c.cards[i], false) + '<td width="4%" style="font-size:0;line-height:0;">&nbsp;</td>' + cell(c.cards[i + 1], false) + '</tr>');
        else h.push('<tr>' + cell(c.cards[i], true) + '</tr>');
      }
      h.push(gap, '</table></td></tr>');
    }

    // steps
    if (c.steps.length || c.stepsTitle.trim()) {
      h.push('<tr><td style="padding:16px 36px 8px;font-size:16px;line-height:1.65;">');
      if (c.stepsTitle.trim()) h.push('<p style="margin:0 0 6px;font-weight:bold;color:' + t.text + ';">' + inline(c.stepsTitle, ctx) + '</p>');
      c.steps.forEach(function (s, i) {
        h.push('<p style="margin:0 0 ' + (i === c.steps.length - 1 ? '16' : '4') + 'px;color:' + t.muted + ';">' + (i + 1) + '. ' + inline(s, ctx) + '</p>');
      });
      h.push('</td></tr>');
    }

    // call to action
    var url = safeUrl(plain(c.ctaUrl, ctx));
    if (c.ctaText.trim() && url) {
      h.push('<tr><td align="center" style="padding:8px 36px 12px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>',
        '<td bgcolor="' + t.accent + '" style="background:' + t.accent + ';border-radius:999px;">',
        '<a href="' + esc(url) + '" style="display:inline-block;padding:15px 34px;font-size:16px;font-weight:bold;color:' + t.accentText + ';text-decoration:none;">' + inline(c.ctaText, ctx) + '</a>',
        '</td></tr></table>');
      if (c.ctaNote.trim()) h.push('<p style="margin:14px 0 0;font-size:14px;color:' + faint + ';">' + inline(c.ctaNote, ctx) + '</p>');
      h.push('</td></tr>');
    }

    // closing + signature
    var sig = trimSeparators(plain(c.senderTitle, ctx));
    var close = paragraphs(c.closing, ctx, 'margin:0 0 16px;');
    if (c.signoff.trim()) close += '<p style="margin:0;">' + inline(c.signoff, ctx) + '</p>';
    if (c.senderName.trim()) close += '<p style="margin:0;font-weight:bold;">' + inline(c.senderName, ctx) + '</p>';
    if (sig) close += '<p style="margin:0;color:' + t.muted + ';">' + esc(sig) + '</p>';
    if (close) h.push('<tr><td style="padding:20px 36px 32px;font-size:16px;line-height:1.65;color:' + t.text + ';">' + close + '</td></tr>');

    // footer
    var fl = [];
    if (c.footerReason.trim()) fl.push('<p style="margin:0 0 6px;">' + inline(c.footerReason, ctx) + '</p>');
    var addr = [];
    if (c.brand.trim()) addr.push(esc(brandName(plain(c.brand, ctx))));
    if (c.address.trim()) addr.push(inline(c.address, ctx));
    if (safeUrl('mailto:' + c.contactEmail.trim()) && c.contactEmail.trim()) addr.push('<a href="mailto:' + esc(c.contactEmail.trim()) + '" style="color:' + t.primary + ';">' + esc(c.contactEmail.trim()) + '</a>');
    if (addr.length) fl.push('<p style="margin:0 0 6px;">' + addr.join(' · ') + '</p>');
    var links = [];
    if (ctx.vars.unsubscribe_url) links.push('<a href="' + esc(ctx.vars.unsubscribe_url) + '" style="color:' + t.primary + ';">Unsubscribe</a>');
    else links.push('To unsubscribe, reply with the word Unsubscribe.');
    var site = safeUrl(c.website);
    if (site) links.push('<a href="' + esc(site) + '" style="color:' + t.primary + ';">' + esc(site.replace(/^https?:\/\//i, '').replace(/\/$/, '')) + '</a>');
    fl.push('<p style="margin:0;">' + links.join(' · ') + '</p>');
    h.push('<tr><td bgcolor="' + t.cardBg + '" style="background:' + t.cardBg + ';padding:20px 36px;font-size:12px;line-height:1.6;color:' + faint + ';">' + fl.join('') + '</td></tr>');

    h.push('</table></td></tr></table></body></html>');
    return h.join('');
  }

  /* ───────────────────────── render: plain text ───────────────────────── */

  function toText(cfg, vars) {
    var n = normalize(cfg), c = n.content, ctx = makeCtx(vars), P = function (s) { return plain(s, ctx).trim(); };
    var out = [];
    var add = function (s) { if (s && s.trim()) out.push(s.trim()); };
    add(P(c.headline)); add(P(c.subhead));
    add(P(c.greeting)); add(ctx.opening); add(P(c.intro));
    c.highlights.forEach(function (it) { add('* ' + [P(it.title), P(it.text)].filter(Boolean).join(': ')); });
    if (c.sectionTitle.trim()) add(P(c.sectionTitle) + (c.sectionIntro.trim() ? '\n' + P(c.sectionIntro) : ''));
    c.cards.forEach(function (it) { add('- ' + [P(it.title), P(it.text)].filter(Boolean).join(': ')); });
    if (c.steps.length) add((P(c.stepsTitle) ? P(c.stepsTitle) + '\n' : '') + c.steps.map(function (s, i) { return (i + 1) + '. ' + P(s); }).join('\n'));
    var url = safeUrl(plain(c.ctaUrl, ctx));
    if (c.ctaText.trim() && url) add(P(c.ctaText) + ': ' + url + (c.ctaNote.trim() ? '\n' + P(c.ctaNote) : ''));
    add(P(c.closing));
    add([P(c.signoff), P(c.senderName), trimSeparators(P(c.senderTitle))].filter(Boolean).join('\n'));
    var foot = [P(c.footerReason), [brandName(P(c.brand)), P(c.address), c.contactEmail.trim()].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    add(foot);
    add(ctx.vars.unsubscribe_url ? 'Unsubscribe: reply to this email with the word Unsubscribe.' : 'To unsubscribe, reply with the word Unsubscribe.');
    return out.join('\n\n');
  }

  function build(cfg, vars) {
    var ctx = makeCtx(vars), n = normalize(cfg);
    return { subject: plain(n.content.subject, ctx).trim(), html: render(cfg, vars), text: toText(cfg, vars) };
  }

  /* ───────────────────────── validation ───────────────────────── */

  function allStrings(n) {
    var s = [];
    Object.keys(n.content).forEach(function (k) {
      var v = n.content[k];
      if (typeof v === 'string') s.push([k, v]);
      else if (k === 'steps') v.forEach(function (x) { s.push([k, x]); });
      else v.forEach(function (x) { s.push([k, x.title]); s.push([k, x.text]); });
    });
    return s;
  }
  /**
   * opts.needSubject  require a subject line (designed email with no AI)
   * Returns { errors: [] (block sending), warnings: [] (worth a look) }
   */
  function validate(cfg, opts) {
    opts = opts || {};
    var n = normalize(cfg), c = n.content, errors = [], warnings = [], seen = {};
    allStrings(n).forEach(function (p) {
      (p[1].match(/\[[^\[\]\n]{2,60}\]/g) || []).forEach(function (m) {
        if (!seen[m]) { seen[m] = 1; errors.push('Replace the placeholder ' + m + ' with real text (it is still in your template).'); }
      });
      (p[1].match(/\{\{\s*[^}]*\}\}/g) || []).forEach(function (m) {
        var k = m.replace(/[{}\s]/g, '').toLowerCase();
        if (MERGE_FIELDS.indexOf(k) < 0 && !seen[m]) { seen[m] = 1; errors.push('Unknown merge field ' + m + '. Allowed: ' + MERGE_FIELDS.map(function (f) { return '{{' + f + '}}'; }).join(' ')); }
      });
    });
    if (!c.headline.trim()) errors.push('Add a headline.');
    if (opts.needSubject && !c.subject.trim()) errors.push('Add a subject line.');
    if (!c.address.trim()) errors.push('Add your business mailing address in the footer. Marketing email laws (CAN-SPAM, CASL, GDPR) expect one.');
    if (c.ctaText.trim() && !safeUrl(c.ctaUrl.replace(/\{\{[^}]*\}\}/g, 'x'))) errors.push('The button link must start with https:// (or mailto:).');
    if (!c.ctaText.trim() && c.ctaUrl.trim()) warnings.push('You entered a button link but no button text, so no button will show.');
    if (!c.ctaText.trim()) warnings.push('There is no call-to-action button. Emails with one clear action usually perform better.');
    if (c.contactEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.contactEmail.trim())) warnings.push('The contact email in the footer does not look like an email address.');
    if (contrast(n.theme.accent, n.theme.accentText) < 4.5) warnings.push('The button text is hard to read on the button colour. Pick a darker or lighter text colour.');
    if (contrast(n.theme.primary, '#FFFFFF') < 4.5) warnings.push('White header text is hard to read on the header colour. Pick a darker header colour.');
    var size = render(cfg, {}).length;
    if (size > 90000) warnings.push('This email is large (' + Math.round(size / 1024) + ' KB). Gmail cuts messages off at about 102 KB.');
    return { errors: errors, warnings: warnings };
  }

  /* ───────────────────────── remembered settings ───────────────────────── */

  function loadSettings() {
    var d = { enabled: false, ai: true, cfg: defaults() };
    try {
      var raw = root.localStorage && root.localStorage.getItem(STORE_KEY);
      if (!raw) return d;
      var p = JSON.parse(raw);
      return { enabled: !!p.enabled, ai: p.ai !== false, cfg: normalize(p.cfg) };
    } catch (e) { return d; }
  }
  function saveSettings(s) {
    try { root.localStorage && root.localStorage.setItem(STORE_KEY, JSON.stringify({ enabled: !!s.enabled, ai: s.ai !== false, cfg: normalize(s.cfg) })); } catch (e) { /* private mode: fine */ }
  }

  /* ───────────────────────── designer UI ───────────────────────── */

  var CSS = '' +
    '.vet-ov{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.74);display:flex;justify-content:center;align-items:stretch;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px}' +
    '.vet-dlg{background:#1c1c1e;color:#f5f5f0;border:1px solid #3a3a3c;border-radius:14px;width:min(1320px,100%);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5)}' +
    '.vet-top{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid #3a3a3c}' +
    '.vet-top h2{font-size:16px;margin:0}.vet-top p{margin:2px 0 0;color:#aeaeb2;font-size:12px}' +
    '.vet-main{flex:1;display:grid;grid-template-columns:minmax(330px,450px) 1fr;min-height:0}' +
    '.vet-form{overflow:auto;padding:12px 14px;border-right:1px solid #3a3a3c}' +
    '.vet-form details{border:1px solid #3a3a3c;border-radius:10px;margin-bottom:10px;background:#242426}' +
    '.vet-form summary{cursor:pointer;padding:10px 12px;font-weight:700;list-style:none;display:flex;justify-content:space-between;align-items:center}' +
    '.vet-form summary::-webkit-details-marker{display:none}.vet-form summary:after{content:"+";color:#aeaeb2;font-size:16px}.vet-form details[open] summary:after{content:"\\2212"}' +
    '.vet-body{padding:2px 12px 12px;display:flex;flex-direction:column;gap:10px}' +
    '.vet-f label{display:block;font-size:12px;font-weight:600;color:#aeaeb2;margin-bottom:4px}' +
    '.vet-f small{display:block;color:#8e8e93;font-size:11px;margin-top:3px;line-height:1.4}' +
    '.vet-f input[type=text],.vet-f textarea{width:100%;box-sizing:border-box;font:inherit;font-size:13px;padding:8px 10px;border:1px solid #48484a;border-radius:8px;background:#1c1c1e;color:#f5f5f0}' +
    '.vet-f textarea{resize:vertical;line-height:1.5}' +
    '.vet-f input:focus,.vet-f textarea:focus{outline:none;border-color:#93c5fd;box-shadow:0 0 0 3px rgba(59,130,246,.18)}' +
    '.vet-row{border:1px dashed #48484a;border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px;position:relative}' +
    '.vet-row .vet-x{position:absolute;top:4px;right:6px}' +
    '.vet-b{cursor:pointer;font:inherit;font-weight:600;font-size:12px;padding:7px 12px;border:1px solid #48484a;border-radius:8px;background:#2c2c2e;color:#f5f5f0}' +
    '.vet-b:hover{background:#3a3a3c}.vet-b:disabled{opacity:.45;cursor:not-allowed}' +
    '.vet-b.pri{background:#1e3a5f;border-color:#1e40af;color:#93c5fd}.vet-b.ok{background:#14532d;border-color:#166534;color:#86efac}' +
    '.vet-b.x{padding:2px 8px;background:transparent;border-color:transparent;color:#fca5a5}' +
    '.vet-pal{display:flex;gap:8px;flex-wrap:wrap}.vet-sw{cursor:pointer;border:2px solid #48484a;border-radius:10px;padding:0;overflow:hidden;width:54px;height:34px;display:flex;background:none}' +
    '.vet-sw.on{border-color:#93c5fd}.vet-sw i{flex:1;display:block}' +
    '.vet-cols{display:grid;grid-template-columns:1fr 1fr;gap:8px}.vet-cols label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0}' +
    '.vet-cols input[type=color]{width:38px;height:26px;border:1px solid #48484a;border-radius:6px;background:none;padding:0}' +
    '.vet-prev{display:flex;flex-direction:column;min-height:0;background:#2c2c2e}' +
    '.vet-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid #3a3a3c}' +
    '.vet-bar .sp{flex:1}.vet-wrap{flex:1;overflow:auto;padding:14px;display:flex;justify-content:center;min-height:0}' +
    '.vet-frame{border:0;background:#fff;border-radius:10px;width:660px;max-width:100%;height:100%;min-height:560px;transition:width .2s}' +
    '.vet-frame.mob{width:390px}' +
    '.vet-iss{padding:10px 14px;border-top:1px solid #3a3a3c;max-height:150px;overflow:auto;font-size:12px;line-height:1.5}' +
    '.vet-iss .e{color:#fca5a5}.vet-iss .w{color:#fcd34d}.vet-iss .g{color:#86efac}' +
    '.vet-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid #3a3a3c}' +
    '@media(max-width:900px){.vet-main{grid-template-columns:1fr;overflow:auto}.vet-form{max-height:none;border-right:0;border-bottom:1px solid #3a3a3c}.vet-frame{min-height:480px}.vet-ov{padding:0}.vet-dlg{border-radius:0}}';

  var SECTIONS = [
    { id: 'header', title: 'Header', fields: [
      { k: 'brand', label: 'Brand name', t: 'text' },
      { k: 'badge', label: 'Badge line', t: 'text', hint: 'Small coloured line above the headline.' },
      { k: 'headline', label: 'Headline', t: 'text' },
      { k: 'subhead', label: 'Subheadline', t: 'area', rows: 2 },
      { k: 'preheader', label: 'Inbox preview text', t: 'area', rows: 2, hint: 'Shown beside the subject in most inboxes.' }] },
    { id: 'message', title: 'Message', open: true, fields: [
      { k: 'subject', label: 'Subject line', t: 'text', hint: 'Used for every recipient when AI writing is off.' },
      { k: 'greeting', label: 'Greeting', t: 'text' },
      { k: 'intro', label: 'Intro text', t: 'area', rows: 6, hint: 'Blank line = new paragraph. **bold** works. Merge fields like {{first_name}} and {{company}} personalise each email.' }] },
    { id: 'highlights', title: 'Highlight boxes', list: 'highlights', max: 4, noun: 'highlight' },
    { id: 'cards', title: 'Card grid', fields: [
      { k: 'sectionTitle', label: 'Section title', t: 'text' },
      { k: 'sectionIntro', label: 'Section intro', t: 'area', rows: 2 }], list: 'cards', max: 8, noun: 'card' },
    { id: 'steps', title: 'Steps', fields: [
      { k: 'stepsTitle', label: 'Steps title', t: 'text' },
      { k: 'steps', label: 'Steps (one per line)', t: 'lines', rows: 4 }] },
    { id: 'cta', title: 'Button', fields: [
      { k: 'ctaText', label: 'Button text', t: 'text' },
      { k: 'ctaUrl', label: 'Button link', t: 'text', hint: 'Must start with https://' },
      { k: 'ctaNote', label: 'Small note under the button', t: 'text' }] },
    { id: 'sign', title: 'Closing & signature', fields: [
      { k: 'closing', label: 'Closing paragraph', t: 'area', rows: 3 },
      { k: 'signoff', label: 'Sign-off', t: 'text' },
      { k: 'senderName', label: 'Name', t: 'text', hint: 'Default {{sender_name}} uses the name from your sender details.' },
      { k: 'senderTitle', label: 'Title / company', t: 'text' }] },
    { id: 'footer', title: 'Footer', fields: [
      { k: 'footerReason', label: 'Why they are getting this email', t: 'text' },
      { k: 'address', label: 'Business mailing address', t: 'text', hint: 'Required by marketing-email laws.' },
      { k: 'contactEmail', label: 'Contact email', t: 'text' },
      { k: 'website', label: 'Website', t: 'text' }] }
  ];
  var COLOR_FIELDS = [['primary', 'Header'], ['primaryDark', 'Header (dark end)'], ['accent', 'Accent / button'], ['accentText', 'Button text'], ['pageBg', 'Page background'], ['cardBg', 'Card background'], ['text', 'Body text'], ['muted', 'Soft text']];

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function openDesigner(opts) {
    opts = opts || {};
    if (!root.document) return;
    var draft = normalize(opts.cfg || defaults());
    var sample = Object.assign({
      first_name: 'Alex', last_name: 'Rivera', full_name: 'Alex Rivera', company: 'Acme Co', title: 'VP of Sales', industry: 'Software',
      email: 'alex@acme.com', sender_name: 'Jordan Lee', sender_title: 'Account Executive', sender_company: 'Velorah', sender_email: 'jordan@example.com'
    }, opts.sampleVars || {});
    var dirty = false, timer = null;

    if (!document.getElementById('vet-style')) document.head.appendChild(el('style', { id: 'vet-style', text: CSS }));
    var prev = document.activeElement;

    var frame = el('iframe', { class: 'vet-frame', title: 'Email preview', sandbox: '' });
    var issues = el('div', { class: 'vet-iss' });
    function refresh() {
      frame.srcdoc = render(draft, Object.assign({}, sample, opts.sampleOpening ? { opening: opts.sampleOpening } : {}));
      var v = validate(draft, { needSubject: !opts.ai });
      issues.innerHTML = '';
      v.errors.forEach(function (m) { issues.appendChild(el('div', { class: 'e', text: '\u2716 ' + m })); });
      v.warnings.forEach(function (m) { issues.appendChild(el('div', { class: 'w', text: '\u26A0 ' + m })); });
      if (!v.errors.length && !v.warnings.length) issues.appendChild(el('div', { class: 'g', text: '\u2714 Ready to send. Nothing needs fixing.' }));
    }
    function changed() { dirty = true; clearTimeout(timer); timer = setTimeout(refresh, 160); }

    var form = el('div', { class: 'vet-form' });

    function fieldInput(f, host) {
      var val = draft.content[f.k];
      var inp;
      if (f.t === 'area' || f.t === 'lines') {
        inp = el('textarea', { rows: f.rows || 3 });
        inp.value = f.t === 'lines' ? (val || []).join('\n') : val;
        inp.addEventListener('input', function () { draft.content[f.k] = f.t === 'lines' ? inp.value.split('\n') : inp.value; changed(); });
      } else {
        inp = el('input', { type: 'text' });
        inp.value = val;
        inp.addEventListener('input', function () { draft.content[f.k] = inp.value; changed(); });
      }
      var wrap = el('div', { class: 'vet-f' }, [el('label', { text: f.label }), inp, f.hint ? el('small', { text: f.hint }) : null]);
      host.appendChild(wrap);
    }
    function listEditor(sec, host) {
      var box = el('div', { class: 'vet-body', style: 'padding:0' });
      function paint() {
        box.innerHTML = '';
        draft.content[sec.list].forEach(function (it, i) {
          var t = el('input', { type: 'text', placeholder: 'Title' }); t.value = it.title;
          var x = el('textarea', { rows: 2, placeholder: 'Text' }); x.value = it.text;
          t.addEventListener('input', function () { it.title = t.value; changed(); });
          x.addEventListener('input', function () { it.text = x.value; changed(); });
          var row = el('div', { class: 'vet-row vet-f' }, [
            el('button', { class: 'vet-b x', type: 'button', title: 'Remove', 'aria-label': 'Remove ' + sec.noun, text: '\u2715', onclick: function () { draft.content[sec.list].splice(i, 1); changed(); paint(); } }),
            t, x]);
          box.appendChild(row);
        });
        var add = el('button', { class: 'vet-b', type: 'button', text: '+ Add ' + sec.noun, onclick: function () { draft.content[sec.list].push({ title: '', text: '' }); changed(); paint(); } });
        if (draft.content[sec.list].length >= sec.max) { add.disabled = true; add.textContent = 'Maximum ' + sec.max + ' ' + sec.noun + 's'; }
        box.appendChild(add);
      }
      paint(); host.appendChild(box);
    }
    function buildForm() {
      form.innerHTML = '';
      SECTIONS.forEach(function (sec) {
        var d = el('details', sec.open ? { open: '' } : {}); d.appendChild(el('summary', { text: sec.title }));
        var body = el('div', { class: 'vet-body' });
        (sec.fields || []).forEach(function (f) { fieldInput(f, body); });
        if (sec.list) listEditor(sec, body);
        d.appendChild(body); form.appendChild(d);
      });
      var cd = el('details', {}); cd.appendChild(el('summary', { text: 'Colours' }));
      var cb = el('div', { class: 'vet-body' });
      var pal = el('div', { class: 'vet-pal' });
      Object.keys(PALETTES).forEach(function (key) {
        var p = PALETTES[key];
        var sw = el('button', { class: 'vet-sw', type: 'button', title: p.name, 'aria-label': p.name, onclick: function () {
          THEME_KEYS.forEach(function (k) { draft.theme[k] = p[k]; }); changed(); buildForm();
          form.querySelectorAll('details').forEach(function (x) { if (x.firstChild.textContent === 'Colours') x.setAttribute('open', ''); });
        } }, [el('i', { style: 'background:' + p.primary }), el('i', { style: 'background:' + p.accent })]);
        pal.appendChild(sw);
      });
      cb.appendChild(el('div', { class: 'vet-f' }, [el('label', { text: 'Colour themes' }), pal]));
      var grid = el('div', { class: 'vet-cols' });
      COLOR_FIELDS.forEach(function (cf) {
        var i = el('input', { type: 'color' }); i.value = draft.theme[cf[0]];
        i.addEventListener('input', function () { draft.theme[cf[0]] = i.value.toUpperCase(); changed(); });
        grid.appendChild(el('label', {}, [el('span', { text: cf[1] }), i]));
      });
      cb.appendChild(grid); cd.appendChild(cb); form.appendChild(cd);
    }
    buildForm();

    var presetSel = el('select', { 'aria-label': 'Start from an example', style: 'background:#2c2c2e;color:#f5f5f0;border:1px solid #48484a;border-radius:8px;padding:7px 8px;font:inherit;font-size:12px' },
      [el('option', { value: '', text: 'Start from an example\u2026' })].concat(Object.keys(PRESETS).map(function (k) { return el('option', { value: k, text: PRESETS[k].label }); })));
    presetSel.addEventListener('change', function () {
      if (!presetSel.value) return;
      if (dirty && !root.confirm('Replace what you have typed with this example?')) { presetSel.value = ''; return; }
      draft = normalize(PRESETS[presetSel.value].cfg()); dirty = true; presetSel.value = ''; buildForm(); refresh();
    });
    var dBtn = el('button', { class: 'vet-b pri', type: 'button', text: 'Desktop' }), mBtn = el('button', { class: 'vet-b', type: 'button', text: 'Mobile' });
    dBtn.onclick = function () { frame.classList.remove('mob'); dBtn.className = 'vet-b pri'; mBtn.className = 'vet-b'; };
    mBtn.onclick = function () { frame.classList.add('mob'); mBtn.className = 'vet-b pri'; dBtn.className = 'vet-b'; };

    var ov = el('div', { class: 'vet-ov', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Design your email' });
    function close(saved) {
      document.removeEventListener('keydown', onKey, true); ov.remove(); if (prev && prev.focus) prev.focus();
      if (!saved && opts.onCancel) opts.onCancel();
    }
    function cancel() { if (dirty && !root.confirm('Close without saving your changes?')) return; close(false); }
    function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }
    document.addEventListener('keydown', onKey, true);

    var saveBtn = el('button', { class: 'vet-b ok', type: 'button', text: 'Save & use this design', onclick: function () {
      var v = validate(draft, { needSubject: !opts.ai });
      if (v.errors.length && !root.confirm('Some things still need fixing before you can send:\n\n' + v.errors.join('\n') + '\n\nSave anyway? You can finish them later.')) return;
      var out = normalize(draft); close(true); if (opts.onSave) opts.onSave(out);
    } });
    ov.appendChild(el('div', { class: 'vet-dlg' }, [
      el('div', { class: 'vet-top' }, [
        el('div', {}, [el('h2', { text: 'Design your email' }), el('p', { text: 'Type your content on the left. The preview updates as you type, so what you see is what recipients get.' })]),
        el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [presetSel])]),
      el('div', { class: 'vet-main' }, [form,
        el('div', { class: 'vet-prev' }, [
          el('div', { class: 'vet-bar' }, [el('strong', { text: 'Live preview' }), el('span', { class: 'sp' }), dBtn, mBtn]),
          el('div', { class: 'vet-wrap' }, [frame]), issues])]),
      el('div', { class: 'vet-foot' }, [
        el('span', { style: 'color:#aeaeb2;font-size:12px', text: 'Preview uses sample recipient details. Real emails use each lead\u2019s own.' }),
        el('div', { style: 'display:flex;gap:8px' }, [el('button', { class: 'vet-b', type: 'button', text: 'Cancel', onclick: cancel }), saveBtn])])
    ]));
    document.body.appendChild(ov);
    refresh();
    var first = form.querySelector('input,textarea'); if (first) first.focus();
  }

  root.VelorahEmailTemplate = {
    MERGE_FIELDS: MERGE_FIELDS, PALETTES: PALETTES, presets: PRESETS, defaults: defaults,
    normalize: normalize, render: render, toText: toText, build: build, validate: validate,
    loadSettings: loadSettings, saveSettings: saveSettings, openDesigner: openDesigner
  };
})(typeof window !== 'undefined' ? window : globalThis);
