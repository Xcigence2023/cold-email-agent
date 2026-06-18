/**
 * twilio-voice.js -- Netlify Function: TwiML webhook for outbound calls
 * Place in: netlify/functions/twilio-voice.js
 *
 * Your TwiML App's "Voice Request URL" must point to this function:
 *   https://portal.xcigence.com/.netlify/functions/twilio-voice
 *
 * When the browser's Twilio.Device.connect({ To: '+1...' }) fires, Twilio
 * calls THIS endpoint. It returns TwiML that tells Twilio to dial the
 * target phone number, using your Twilio number as the caller ID.
 *
 * REQUIRED ENV VAR:
 *   TWILIO_PHONE_NUMBER   (your Twilio number in +1... E.164 format -- caller ID)
 *
 * Twilio sends parameters as application/x-www-form-urlencoded.
 * The 'To' parameter is whatever you passed to .connect({ To: ... }).
 */

const XML_HDR = {
  'Content-Type': 'text/xml',
  'Access-Control-Allow-Origin': '*'
};

function xmlEscape(s){
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Parse application/x-www-form-urlencoded body
function parseForm(body){
  var out = {};
  if (!body) return out;
  String(body).split('&').forEach(function(pair){
    var idx = pair.indexOf('=');
    if (idx < 0) { out[decodeURIComponent(pair)] = ''; return; }
    var k = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
    var v = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    out[k] = v;
  });
  return out;
}

exports.handler = async function(event){
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: XML_HDR, body: '' };
  }

  const CALLER_ID = process.env.TWILIO_PHONE_NUMBER;

  // Twilio posts form-encoded data; the dialed number is in 'To'
  var params = parseForm(event.body);
  var to = params.To || params.to || '';

  // Basic sanitization: keep + and digits only
  to = String(to).replace(/[^\d+]/g, '');

  var twiml;

  if (!CALLER_ID) {
    // Misconfiguration -- speak a clear message instead of failing silently
    twiml = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Response><Say>Calling is not configured. The Twilio phone number environment variable is missing.</Say></Response>';
    return { statusCode: 200, headers: XML_HDR, body: twiml };
  }

  if (!to || to.length < 5) {
    twiml = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<Response><Say>No valid destination number was provided.</Say></Response>';
    return { statusCode: 200, headers: XML_HDR, body: twiml };
  }

  // Dial the target number, using your Twilio number as caller ID.
  // answerOnBridge keeps the caller hearing ringback until the callee answers.
  twiml = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Response>'
    +   '<Dial answerOnBridge="true" callerId="' + xmlEscape(CALLER_ID) + '">'
    +     '<Number>' + xmlEscape(to) + '</Number>'
    +   '</Dial>'
    + '</Response>';

  return { statusCode: 200, headers: XML_HDR, body: twiml };
};
