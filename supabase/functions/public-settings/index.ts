import { corsHeaders, json, serviceClient } from "../_shared/utils.ts";

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const { data, error } = await serviceClient()
    .from("app_settings")
    .select("whatsapp_support_number,whatsapp_support_number_display")
    .eq("key", "global")
    .maybeSingle();
  if (error) return json({ error: "settings_unavailable" }, 500);
  return json({
    whatsappSupportNumber: typeof data?.whatsapp_support_number === "string" ? data.whatsapp_support_number : null,
    whatsappSupportNumberDisplay: typeof data?.whatsapp_support_number_display === "string" ? data.whatsapp_support_number_display : null,
  });
});
