# CallaStar PWA

CallaStar is installable from supported browsers and includes an offline app shell.
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

The service worker caches the app document, current JavaScript and CSS entry
points, manifest, and brand icons. A previously loaded route can open to the app
shell while offline. Calls, remote profiles, and other network-backed features
still require an internet connection. The worker does not cache API responses,
call media, or user attachments.
