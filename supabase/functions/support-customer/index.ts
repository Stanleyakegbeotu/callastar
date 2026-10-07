import { corsHeadersFor, isAllowedCorsOrigin, jsonForRequest, serviceClient } from "../_shared/utils.ts";

const normalizeEmail = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";
const safeGuestId = (value: unknown) => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : "";
const preview = (body: string, attachment: boolean) => body.trim().slice(0, 120) || (attachment ? "Sent an image" : "");

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeadersFor(request) });
  if (!isAllowedCorsOrigin(request)) return jsonForRequest({ error: "origin_not_allowed" }, 403, request);
  if (request.method !== "POST") return jsonForRequest({ error: "method_not_allowed" }, 405, request);
  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const guestId = safeGuestId(body.guestSessionId);
  if ((!email && !guestId) || (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))))
    return jsonForRequest({ error: "customer_identity_required" }, 400, request);
  const client = serviceClient();
  const scoped = async (id: unknown) => {
    if (typeof id !== "string" || id.length > 100) return null;
    let query = client.from("support_conversations").select("*").eq("id", id);
    query = email ? query.eq("customer_email_normalized", email) : query.eq("guest_session_id", guestId);
    const { data } = await query.maybeSingle();
    return data;
  };
  try {
    if (body.action === "link_guest") {
      if (!guestId) return jsonForRequest({ linked: false }, 200, request);
      const { data: guest } = await client.from("support_conversations").select("id").eq("guest_session_id", guestId).maybeSingle();
      if (!guest) return jsonForRequest({ linked: false }, 200, request);
      body.action = "resolve";
    }
    switch (body.action) {
      case "subscription_list": {
        if (!email) return jsonForRequest({ requests: [] }, 200, request);
        let query = client.from("subscription_requests").select("*").eq("customer_email_normalized", email).order("created_at", { ascending: false });
        if (typeof body.sessionId === "string") query = query.eq("session_id", body.sessionId);
        if (typeof body.id === "string") query = query.eq("id", body.id);
        const { data, error } = await query;
        if (error) throw error;
        return jsonForRequest({ requests: data ?? [] }, 200, request);
      }
      case "subscription_create": {
        if (!email) return jsonForRequest({ error: "customer_email_required" }, 400, request);
        const { data: plan, error: planError } = await client.from("subscription_plans").select("id,display_name,price_minor_units,currency_code,is_active").eq("id", body.planId).eq("is_active", true).maybeSingle();
        if (planError || !plan || typeof body.sessionId !== "string" || typeof body.profileId !== "string") return jsonForRequest({ error: "plan_unavailable" }, 400, request);
        const { data: host } = await client.from("hosts").select("id,display_name").eq("id", body.profileId).maybeSingle();
        if (!host) return jsonForRequest({ error: "profile_unavailable" }, 400, request);
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        const bytes = crypto.getRandomValues(new Uint8Array(6));
        const reference = `CS-REQ-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")}`;
        const { data, error } = await client.from("subscription_requests").insert({
          id: crypto.randomUUID(), reference, session_id: body.sessionId, profile_id: host.id, profile_name: host.display_name,
          customer_email: String(body.displayEmail ?? email).trim(), customer_email_normalized: email,
          plan_id: plan.id, plan_name_snapshot: plan.display_name, amount_minor_units: plan.price_minor_units,
          currency_code: plan.currency_code, channel: body.channel === "whatsapp" ? "whatsapp" : "in_app", status: "awaiting_payment",
        }).select("*").single();
        if (error) throw error;
        return jsonForRequest({ request: data }, 200, request);
      }
      case "subscription_cancel": {
        if (!email || typeof body.id !== "string") return jsonForRequest({ request: null }, 200, request);
        const { data, error } = await client.from("subscription_requests").update({ status: "cancelled", updated_at: new Date().toISOString() })
          .eq("id", body.id).eq("customer_email_normalized", email).not("status", "in", "(confirmed,cancelled)").select("*").maybeSingle();
        if (error) throw error;
        return jsonForRequest({ request: data }, 200, request);
      }
      case "resolve": {
        let conversation = null;
        if (email) {
          const { data } = await client.from("support_conversations").select("*").eq("customer_email_normalized", email).order("last_message_at", { ascending: false }).limit(1).maybeSingle();
          conversation = data;
        }
        if (conversation && email && guestId) {
          const { data: guest } = await client.from("support_conversations").select("*").eq("guest_session_id", guestId).maybeSingle();
          if (guest && guest.id !== conversation.id) {
            const { data: guestAssets, error: assetsQueryError } = await client.from("support_assets").select("id,storage_path").eq("conversation_id", guest.id);
            if (assetsQueryError) throw assetsQueryError;
            for (const asset of guestAssets ?? []) {
              const oldPath = asset.storage_path as string;
              const newPath = `${conversation.id}/${String(asset.id)}`;
              const { error: copyError } = await client.storage.from("support-attachments").copy(oldPath, newPath);
              if (copyError) throw copyError;
              const { error: updateAssetError } = await client.from("support_assets").update({ conversation_id: conversation.id, storage_path: newPath }).eq("id", asset.id);
              if (updateAssetError) throw updateAssetError;
              await client.storage.from("support-attachments").remove([oldPath]);
            }
            const { error: messagesError } = await client.from("support_messages").update({ conversation_id: conversation.id }).eq("conversation_id", guest.id);
            if (messagesError) throw messagesError;
            await client.from("support_conversations").update({
              last_message_at: new Date(Math.max(Date.parse(conversation.last_message_at), Date.parse(guest.last_message_at))).toISOString(),
              unread_for_admin: conversation.unread_for_admin + guest.unread_for_admin,
              last_message_preview: Date.parse(guest.last_message_at) > Date.parse(conversation.last_message_at) ? guest.last_message_preview : conversation.last_message_preview,
              last_message_sender: Date.parse(guest.last_message_at) > Date.parse(conversation.last_message_at) ? guest.last_message_sender : conversation.last_message_sender,
              checkout_draft: conversation.checkout_draft ?? guest.checkout_draft,
              package_brief_seen_at: conversation.package_brief_seen_at ?? guest.package_brief_seen_at,
              subscription_request_id: conversation.subscription_request_id ?? guest.subscription_request_id,
              updated_at: new Date().toISOString(),
            }).eq("id", conversation.id);
            const { error: removeError } = await client.from("support_conversations").delete().eq("id", guest.id);
            if (removeError) throw removeError;
          }
        }
        if (!conversation && guestId) {
          const { data } = await client.from("support_conversations").select("*").eq("guest_session_id", guestId).order("last_message_at", { ascending: false }).limit(1).maybeSingle();
          conversation = data;
          if (conversation && email) {
            const { data: guestAssets, error: assetsQueryError } = await client.from("support_assets").select("id,storage_path").eq("conversation_id", conversation.id);
            if (assetsQueryError) throw assetsQueryError;
            for (const asset of guestAssets ?? []) {
              const oldPath = asset.storage_path as string;
              const newPath = `${conversation.id}/${String(asset.id)}`;
              const { error: copyError } = await client.storage.from("support-attachments").copy(oldPath, newPath);
              if (copyError) throw copyError;
              const { error: updateAssetError } = await client.from("support_assets").update({ storage_path: newPath }).eq("id", asset.id);
              if (updateAssetError) throw updateAssetError;
              await client.storage.from("support-attachments").remove([oldPath]);
            }
            const { data: linked, error } = await client.from("support_conversations").update({
              customer_email: String(body.displayEmail ?? email).trim(), customer_email_normalized: email,
              customer_name: String(body.name ?? "").slice(0, 120), customer_phone: String(body.phone ?? "").slice(0, 40),
              guest_session_id: null, updated_at: new Date().toISOString(),
            }).eq("id", conversation.id).select("*").single();
            if (error) throw error;
            conversation = linked;
          }
        }
        if (!conversation) {
          const timestamp = new Date().toISOString();
          const { data, error } = await client.from("support_conversations").insert({
            id: crypto.randomUUID(), customer_email: email ? String(body.displayEmail ?? email).trim() : null,
            customer_email_normalized: email || null, customer_name: String(body.name ?? "").slice(0, 120),
            customer_phone: String(body.phone ?? "").slice(0, 40), guest_session_id: email ? null : guestId,
            subject: String(body.subject ?? "CallaStar support").slice(0, 180), status: "open",
            subscription_request_id: typeof body.subscriptionRequestId === "string" ? body.subscriptionRequestId : null,
            last_message_preview: "", last_message_at: timestamp,
            last_message_sender: "customer", unread_for_admin: 0, unread_for_customer: 0,
            created_at: timestamp, updated_at: timestamp,
          }).select("*").single();
          if (error) throw error;
          conversation = data;
        } else if (typeof body.subscriptionRequestId === "string" && conversation.subscription_request_id !== body.subscriptionRequestId) {
          const { data, error } = await client.from("support_conversations").update({ subscription_request_id: body.subscriptionRequestId, updated_at: new Date().toISOString() }).eq("id", conversation.id).select("*").single();
          if (error) throw error;
          conversation = data;
        }
        if (conversation && email) {
          const identityPatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
          const displayEmail = String(body.displayEmail ?? "").trim();
          const displayName = String(body.name ?? "").trim().slice(0, 120);
          const phone = String(body.phone ?? "").trim().slice(0, 40);
          if (displayEmail) identityPatch.customer_email = displayEmail;
          if (displayName) identityPatch.customer_name = displayName;
          if (phone) identityPatch.customer_phone = phone;
          const { data, error } = await client.from("support_conversations").update(identityPatch).eq("id", conversation.id).select("*").single();
          if (error) throw error;
          conversation = data;
        }
        return jsonForRequest({ conversation, linked: true }, 200, request);
      }
      case "get": {
        const conversation = await scoped(body.conversationId);
        return jsonForRequest({ conversation }, 200, request);
      }
      case "update": {
        const existing = await scoped(body.conversationId);
        if (!existing) return jsonForRequest({ conversation: null }, 200, request);
        const patch: Record<string, unknown> = {};
        const allowed: Record<string, string> = { subscriptionRequestId: "subscription_request_id", packageBriefSeenAt: "package_brief_seen_at", checkoutDraft: "checkout_draft", status: "status" };
        for (const [key, column] of Object.entries(allowed)) if (Object.hasOwn(body.patch ?? {}, key)) patch[column] = body.patch[key];
        if (!Object.keys(patch).length) return jsonForRequest({ conversation: existing }, 200, request);
        patch.updated_at = new Date().toISOString();
        const { data, error } = await client.from("support_conversations").update(patch).eq("id", existing.id).select("*").single();
        if (error) throw error;
        return jsonForRequest({ conversation: data }, 200, request);
      }
      case "messages": {
        const conversation = await scoped(body.conversationId);
        if (!conversation) return jsonForRequest({ messages: [] }, 200, request);
        const [{ data: messages, error: messageError }, { data: assets, error: assetError }] = await Promise.all([
          client.from("support_messages").select("*").eq("conversation_id", conversation.id).order("created_at").order("id"),
          client.from("support_assets").select("*").eq("conversation_id", conversation.id),
        ]);
        if (messageError || assetError) throw messageError ?? assetError;
        return jsonForRequest({ messages: messages ?? [], assets: assets ?? [] }, 200, request);
      }
      case "mark_read": {
        const conversation = await scoped(body.conversationId);
        if (!conversation || typeof body.lastReadMessageId !== "string") return jsonForRequest({ ok: true }, 200, request);
        const { error } = await client.rpc("mark_support_conversation_read", {
          p_conversation_id: conversation.id,
          p_reader: "customer",
          p_last_read_message_id: body.lastReadMessageId,
        });
        if (error) throw error;
        return jsonForRequest({ ok: true }, 200, request);
      }
      case "send": {
        const conversation = await scoped(body.conversationId);
        if (!conversation) return jsonForRequest({ error: "conversation_unavailable" }, 404, request);
        const sender = body.sender === "assistant" ? "assistant" : "customer";
        const automationKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey : "";
        if (sender === "assistant" && !/^(intro-(welcome|plan|question)|return:|payment-(reply|confirmed|method-prompt|help-reply|method-selected|method-specialist):|package-change:)/.test(automationKey))
          return jsonForRequest({ error: "invalid_automation_event" }, 400, request);
        const messageBody = typeof body.body === "string" ? body.body.trim().slice(0, 2000) : "";
        const file = body.attachment;
        if (!messageBody && !file) return jsonForRequest({ error: "message_required" }, 400, request);
        if (file && (typeof file.base64 !== "string" || !["image/jpeg", "image/png", "image/webp", "image/heic"].includes(file.mimeType) || !Number.isInteger(file.fileSize) || file.fileSize <= 0 || file.fileSize > 10 * 1024 * 1024)) return jsonForRequest({ error: "invalid_attachment" }, 400, request);
        const id = typeof body.idempotencyKey === "string" ? `event:${conversation.id}:${body.idempotencyKey}` : crypto.randomUUID();
        const assetId = file ? crypto.randomUUID() : null;
        let storagePath: string | null = null;
        if (file && assetId) {
          const binary = atob(file.base64);
          if (binary.length !== file.fileSize) return jsonForRequest({ error: "invalid_attachment" }, 400, request);
          const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
          storagePath = `${conversation.id}/${assetId}`;
          const { error } = await client.storage.from("support-attachments").upload(storagePath, bytes, { contentType: file.mimeType, upsert: false });
          if (error) throw error;
        }
        const { data: message, error: insertError } = await client.from("support_messages").insert({ id, conversation_id: conversation.id, sender, body: messageBody, action_type: null, action_value: null, attachment_id: assetId, reply_to_message_id: null }).select("*").single();
        if (insertError?.code === "23505") {
          const { data: existing } = await client.from("support_messages").select("*").eq("id", id).single();
          return jsonForRequest({ message: existing, asset: null, conversation }, 200, request);
        }
        if (insertError) { if (storagePath) await client.storage.from("support-attachments").remove([storagePath]); throw insertError; }
        let asset = null;
        if (file && assetId && storagePath) {
          const { data, error } = await client.from("support_assets").insert({ id: assetId, conversation_id: conversation.id, message_id: id,
            file_name: String(file.fileName ?? "image").slice(0, 180), mime_type: file.mimeType, file_size: file.fileSize,
            width: Number.isInteger(file.width) ? file.width : null, height: Number.isInteger(file.height) ? file.height : null,
            storage_path: storagePath }).select("*").single();
          if (error) throw error;
          asset = data;
        }
        const { data: updated, error } = await client.from("support_conversations").update({ last_message_preview: preview(messageBody, Boolean(file)), last_message_at: message.created_at, last_message_sender: sender, unread_for_admin: sender === "customer" ? conversation.unread_for_admin + 1 : conversation.unread_for_admin, unread_for_customer: sender === "admin" ? conversation.unread_for_customer + 1 : conversation.unread_for_customer, status: sender === "customer" ? "open" : sender === "admin" ? "pending" : conversation.status, updated_at: message.created_at }).eq("id", conversation.id).select("*").single();
        if (error) throw error;
        return jsonForRequest({ message, asset, conversation: updated }, 200, request);
      }
      case "select_payment_method": {
        const { data, error } = await client.rpc("select_support_payment_method_accountless", {
          p_conversation_id: body.conversationId, p_customer_email: email, p_guest_session_id: guestId || null,
          p_plan_id: body.planId, p_checkout_intent_id: body.checkoutIntentId, p_method: body.method,
        });
        if (error) throw error;
        return jsonForRequest({ selected: data === true }, 200, request);
      }
      case "attachment": {
        const { data: asset, error } = await client.from("support_assets").select("storage_path,conversation_id").eq("id", body.assetId).maybeSingle();
        if (error || !asset || !(await scoped(asset.conversation_id)) || !asset.storage_path) return jsonForRequest({ error: "attachment_unavailable" }, 404, request);
        const { data, error: downloadError } = await client.storage.from("support-attachments").download(asset.storage_path);
        if (downloadError || !data) return jsonForRequest({ error: "attachment_unavailable" }, 404, request);
        const bytes = new Uint8Array(await data.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        return jsonForRequest({ base64: btoa(binary), mimeType: data.type || "application/octet-stream" }, 200, request);
      }
      default: return jsonForRequest({ error: "unknown_action" }, 400, request);
    }
  } catch (error) {
    console.error("support-customer failed", error instanceof Error ? error.message : "unknown");
    return jsonForRequest({ error: "support_unavailable" }, 500, request);
  }
});
