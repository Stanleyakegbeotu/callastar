/** Keep the app shell available offline without caching calls, API data or media. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
      console.warn("CallaStar could not register its offline app shell.", error);
    });
  }, { once: true });
}
