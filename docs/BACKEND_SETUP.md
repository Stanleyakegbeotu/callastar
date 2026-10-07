# Supabase and Netlify setup

## Browser configuration

Set only the Supabase project URL and public anon key in local `.env.local` and the Netlify site environment. Copy the names from `.env.example`; never put a service-role key in a `VITE_` variable.

## Supabase deployment

From this repository, link the intended Supabase project, review the additive migrations, and apply them with `supabase db push`. Deploy the functions in `supabase/functions/` after the schema is applied. The functions use Supabase's server-side service-role environment; no service-role key belongs in this repository or the browser bundle.

Generate a unique 32-byte key for this project, base64-encode it, and add it to Supabase Edge Function secrets as `CALL_ID_ENCRYPTION_KEY` before creating new Call IDs. Call IDs remain hashed for resolution and encrypted at rest so an authenticated admin can retrieve the active share code. Keep the encryption key backed up securely; losing it means active codes must be rotated.

Edge Function CORS uses the exact origin in the server-only `CALLASTAR_PUBLIC_ORIGIN` setting. Values contain only scheme and host, with no path or trailing slash. The linked project is currently configured for `http://localhost:8443`; update it to the production HTTPS origin before hosting the frontend. `bootstrap-admin` also supports an optional comma-separated `CALLASTAR_PUBLIC_ORIGINS` allowlist when that function needs multiple origins, and rejects requests outside it.

The first administrator is created from `/admin/login` using the one-time `bootstrap-admin` function. The bootstrap secret is server-only and is also available to the local operator at `%LOCALAPPDATA%\CallaStar\admin-bootstrap-secret.txt`; enter it only during first setup, then delete that file. The database enforces one active admin, and admin authorization requires an active `admin_profiles` record connected to Supabase Auth.

After sign-in, configure the customer WhatsApp number and Formspree endpoint in Admin → Settings. Formspree is stored in `app_settings` and is returned to the browser only as a configured/not-configured flag. `notify-admin` sends selected events, deduplicates them, and treats delivery failure as non-blocking.

The `call-evidence` bucket is private. Admin evidence images are uploaded through short-lived signed upload URLs and viewed through short-lived signed URLs issued only after an admin check. New captures are not queued in IndexedDB.

Evidence that was already stored in older browser IndexedDB databases is not automatically imported by this change. Leave those legacy browser records untouched until a project is linked and a deliberate one-time transfer can be run; local development captures are now memory-only and disappear on reload.

## Netlify deployment

`netlify.toml` builds with `pnpm build`, publishes `dist`, uses the Node 22 LTS line, and routes SPA URLs to `index.html`. Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to the Netlify environment, deploy over HTTPS, and verify customer and admin flows against the linked project.

No SMTP configuration is required. Customer email-link sign-in uses Supabase Auth.
