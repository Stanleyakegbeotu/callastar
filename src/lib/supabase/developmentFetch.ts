/** Route only this project's Edge Functions through the local Vite server. */
export function developmentSupabaseFetch(
  supabaseUrl: string,
  pageOrigin: string,
  fetcher: typeof fetch = globalThis.fetch,
): typeof fetch {
  const projectOrigin = new URL(supabaseUrl).origin;
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), pageOrigin);
    if (url.origin !== projectOrigin || url.origin === pageOrigin || !url.pathname.startsWith("/functions/v1/")) {
      return fetcher(input, init);
    }
    const localUrl = new URL(`/__supabase${url.pathname}${url.search}`, pageOrigin);
    return fetcher(input instanceof Request ? new Request(localUrl, input) : localUrl.href, init);
  };
}
