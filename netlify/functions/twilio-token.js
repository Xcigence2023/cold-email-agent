/**
 * twilio-token.js -- Netlify Function: mint a Twilio Voice access token
 * Place in: netlify/functions/twilio-token.js
 *
 * DEPENDENCY-FREE VERSION: builds the Twilio access-token JWT using only
 * Node's built-in 'crypto' module. No npm packages, nothing for Netlify to
 * install or bundle -- so "Cannot find module 'twilio'" cannot happen.
 *
 * The JWT it produces is byte-compatible with what twilio.jwt.AccessToken
 * generates (same header cty, same grants shape, HS256 signature).
 *
 * REQUIRED ENV VARS (set in Netlify):
 *   TWILIO_ACCOUNT_SID     (starts AC...)
 *   TWILIO_API_KEY         (starts SK... -- create at console Account > API keys)
 *   TWILIO_API_SECRET      (the secret shown once when you create the API key)
 *   TWILIO_TWIML_APP_SID   (starts AP...)
 */

const crypto = require('crypto');

const HDR = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Content-Type': 'application/json'
};

function ok(d){ return { statusCode: 200, headers: HDR, body: JSON.stringify(d) }; }
function err(m, c){ return { statusCode: c || 400, headers: HDR, body: JSON.stringify({ error: m }) }; }

// base64url encode (JWT uses URL-safe base64 with no padding)
function b64url(input){
  var b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Build a Twilio Voice AccessToken JWT using HMAC-SHA256, no SDK.
function buildTwilioJwt(accountSid, apiKey, apiSecret, appSid, identity, ttlSeconds){
  var nowSec = Math.floor(Date.now() / 1000);
  var ttl = ttlSeconds || 3600;

  var header = {
    alg: 'HS256',
    typ: 'JWT',
    cty: 'twilio-fpa;v=1'   // Twilio-specific content type (required)
  };

  var payload = {
    jti: apiKey + '-' + nowSec,
    grants: {
      identity: identity,
      voice: {
        incoming: { allow: true },
        outgoing: { application_sid: appSid }
      }
    },
    iat: nowSec,
    exp: nowSec + ttl,
    iss: apiKey,        // the API Key SID signs/issues the token
    sub: accountSid     // the Account SID is the subject
  };

  var encodedHeader = b64url(JSON.stringify(header));
  var encodedPayload = b64url(JSON.stringify(payload));
  var signingInput = encodedHeader + '.' + encodedPayload;

  var signature = crypto.createHmac('sha256', apiSecret).update(signingInput).digest();
  var encodedSignature = b64url(signature);

  return signingInput + '.' + encodedSignature;
}

exports.handler = async function(event){
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };

  const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const API_KEY     = process.env.TWILIO_API_KEY;
  const API_SECRET  = process.env.TWILIO_API_SECRET;
  const APP_SID     = process.env.TWILIO_TWIML_APP_SID;

  var missing = [];
  if (!ACCOUNT_SID) missing.push('TWILIO_ACCOUNT_SID');
  if (!API_KEY)     missing.push('TWILIO_API_KEY');
  if (!API_SECRET)  missing.push('TWILIO_API_SECRET');
  if (!APP_SID)     missing.push('TWILIO_TWIML_APP_SID');
  if (missing.length) {
    return err('Twilio is not fully configured. Missing env var(s): ' + missing.join(', ')
      + '. Set these in Netlify > Site settings > Environment variables, then redeploy.', 500);
  }

  try {
    var identity = 'velorah_agent';
    try {
      if (event.body) {
        var b = JSON.parse(event.body);
        if (b && b.identity) identity = String(b.identity).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 60);
      }
    } catch(e) {}

    var token = buildTwilioJwt(ACCOUNT_SID, API_KEY, API_SECRET, APP_SID, identity, 3600);
    return ok({ token: token, identity: identity });
  } catch(e) {
    return err('Failed to generate token: ' + (e && e.message ? e.message : 'unknown error'), 500);
  }
};
