/**
 * VELORAH WEBSITE VISITOR TRACKER
 * Add this script to every page of your website (xcigence.com)
 * Place before </body> tag
 * 
 * <script src="https://portal.xcigence.com/velorah-tracker.js"></script>
 */
(function() {
  // Don't track in development
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') return;

  // Collect UTM params
  const params = new URLSearchParams(window.location.search);
  const utm = {
    source:   params.get('utm_source')   || '',
    medium:   params.get('utm_medium')   || '',
    campaign: params.get('utm_campaign') || '',
    term:     params.get('utm_term')     || '',
    content:  params.get('utm_content')  || ''
  };

  // Send visit event
  const payload = {
    page:     window.location.href,
    referrer: document.referrer || '',
    utm,
    title:    document.title,
    screen:   window.screen.width + 'x' + window.screen.height,
    tz:       Intl.DateTimeFormat().resolvedOptions().timeZone
  };

  fetch('https://portal.xcigence.com/.netlify/functions/visitor-track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    keepalive: true
  }).catch(function() {});

  // Track time on page
  var startTime = Date.now();
  window.addEventListener('beforeunload', function() {
    var timeSpent = Math.round((Date.now() - startTime) / 1000);
    if (timeSpent > 5) {
      fetch('https://portal.xcigence.com/.netlify/functions/visitor-track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({}, payload, { event: 'exit', timeSpent: timeSpent })),
        keepalive: true
      }).catch(function() {});
    }
  });
})();
