/**
 * twilio-token.js -- Netlify Function: mint a Twilio Voice access token
 * Place in: netlify/functions/twilio-token.js
 *
 * The browser calls this to get a short-lived JWT that authorizes the
 * Twilio.Device to make outbound calls. The token embeds a VoiceGrant
 * tied to your TwiML App SID.
 *
 * REQUIRED ENV VARS (set in Netlify):
 *   TWILIO_ACCOUNT_SID     (starts AC...)
 *   TWILIO_API_KEY         (starts SK... -- create at console Account > API keys)
 *   TWILIO_API_SECRET      (the secret shown once when you create the API key)
 *   TWILIO_TWIML_APP_SID   (starts AP...)
 *
 * NOTE: The API Key + Secret are used to SIGN the token (more secure than the
 * Auth Token). If you only have the Auth Token, create an API Key in the console.
 *
 * Requires the 'twilio' npm package. Add to package.json: "twilio": "^5.0.0"
 */

const twilio = require('twilio');

const HDR = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Content-Type': 'application/json'
};

function ok(d){ return { statusCode: 200, headers: HDR, body: JSON.stringify(d) }; }
function err(m, c){ return { statusCode: c || 400, headers: HDR, body: JSON.stringify({ error: m }) }; }

exports.handler = async function(event){
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: HDR, body: '' };

  const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const API_KEY     = process.env.TWILIO_API_KEY;
  const API_SECRET  = process.env.TWILIO_API_SECRET;
  const APP_SID     = process.env.TWILIO_TWIML_APP_SID;

  // Clear diagnostics if anything is missing (so it never fails silently)
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
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant  = AccessToken.VoiceGrant;

    // A stable-ish identity for this browser user. Could be the logged-in user's email.
    var identity = 'velorah_agent';
    try {
      if (event.body) {
        var b = JSON.parse(event.body);
        if (b && b.identity) identity = String(b.identity).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 60);
      }
    } catch(e) {}

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: APP_SID,
      incomingAllow: true
    });

    const token = new AccessToken(ACCOUNT_SID, API_KEY, API_SECRET, { identity: identity, ttl: 3600 });
    token.addGrant(voiceGrant);

    return ok({ token: token.toJwt(), identity: identity });
  } catch(e) {
    return err('Failed to generate token: ' + (e && e.message ? e.message : 'unknown error'), 500);
  }
};
