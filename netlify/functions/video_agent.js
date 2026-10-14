// Alias: campaign-video.html calls /.netlify/functions/video_agent (underscore) but the
// implementation lives in video-agent.js (hyphen), so every call 404'd.
exports.handler = require('./video-agent.js').handler;
