# CallaStar PWA

CallaStar is installable from supported browsers.
The service worker is registered in production builds from `/sw.js` at the site
root. The site must be served over HTTPS; `localhost` is also a secure context
for development.

## Install

- **iPhone and iPad:** Open CallaStar in Safari, tap Share, choose **Add to Home
  Screen**, then tap **Add**. The in-app install card shows these steps.
- **Android and supported desktop browsers:** Use the **Get the app** control and
  select **Install CallaStar** when the browser offers its native install prompt.
  The browser menu also offers **Install app** or **Add to Home Screen**.

## Offline behavior

The service worker caches only the favicon assets. Every document navigation
and `/assets/*.js` or `/assets/*.css` request goes to the network so Netlify's
private-access edge gate remains authoritative. If offline, navigation shows a
plain 503 message instead of a previously cached application page. The worker
also removes caches created by older versions that stored HTML or application
bundles. Calls, remote profiles, and other network-backed features require an
internet connection. The worker does not cache API responses, call media, user
attachments, application documents, or JavaScript/CSS bundles.
