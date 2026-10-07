/** Protected documents and bundles always require the online access gate. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).then((registration) => registration.update()).catch(() => {
      console.warn("CallaStar could not update its service worker.");
    });
  }, { once: true });
}
