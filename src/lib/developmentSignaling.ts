export const DEVELOPMENT_SIGNALING_PATH = "/__callastar_signaling";

/** An explicit development proxy follows the app's HTTP/HTTPS origin. */
export function developmentSignalingUrl(configuredUrl: string, appOrigin: string | undefined, useProxy: boolean): string {
  if (!configuredUrl || !appOrigin || !useProxy) return configuredUrl;
  const url = new URL(DEVELOPMENT_SIGNALING_PATH, appOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}
