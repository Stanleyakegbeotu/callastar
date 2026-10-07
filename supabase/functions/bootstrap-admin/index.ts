import {
  corsHeadersFor,
  isAllowedCorsOrigin,
  jsonForRequest,
  serviceClient,
} from "../_shared/utils.ts"

type BootstrapInput = {
  email?: unknown
  password?: unknown
  displayName?: unknown
  bootstrapSecret?: unknown
}

function sameSecret(left: string, right: string) {
  const encoder = new TextEncoder()
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  let diff = a.length ^ b.length
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0)
  }
  return diff === 0
}

function diagnostic(
  event: string,
  fields: Record<string, string | number | boolean | null> = {},
) {
  // Keep this allowlisted record free of submitted credentials and provider secrets.
  console.info(JSON.stringify({ scope: "bootstrap-admin", event, ...fields }))
}

function failure(code: string, status: number, request: Request) {
  return jsonForRequest(
    {
      success: false,
      code,
      message: "Admin setup could not be completed.",
    },
    status,
    request,
  )
}

Deno.serve(async (request) => {
  diagnostic("request_received", { method: request.method })
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeadersFor(request) })
  }
  if (!isAllowedCorsOrigin(request)) {
    diagnostic("origin_rejected", { allowed: false })
    return new Response(null, { status: 403 })
  }
  if (request.method !== "POST")
    return failure("METHOD_NOT_ALLOWED", 405, request)

  const expectedSecret = Deno.env.get("ADMIN_BOOTSTRAP_SECRET")
  diagnostic("secret_configuration", {
    secretConfigured: Boolean(expectedSecret),
  })
  if (!expectedSecret) return failure("BOOTSTRAP_UNAVAILABLE", 422, request)

  let input: BootstrapInput
  try {
    input = await request.json()
  } catch {
    diagnostic("request_rejected", { reason: "malformed_json" })
    return failure("INVALID_REQUEST", 400, request)
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    diagnostic("request_rejected", { reason: "invalid_body" })
    return failure("INVALID_REQUEST", 400, request)
  }

  const receivedSecret =
    typeof input.bootstrapSecret === "string" ? input.bootstrapSecret : ""
  const secretMatch = sameSecret(receivedSecret, expectedSecret)
  diagnostic("secret_check", {
    receivedSecretLength: receivedSecret.length,
    configuredSecretLength: expectedSecret.length,
    secretMatch,
  })
  if (!secretMatch) return failure("INVALID_BOOTSTRAP_SECRET", 401, request)

  const email =
    typeof input.email === "string" ? input.email.trim().toLowerCase() : ""
  const password = typeof input.password === "string" ? input.password : ""
  const displayName =
    typeof input.displayName === "string" ? input.displayName.trim() : ""
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return failure("INVALID_EMAIL", 400, request)
  }
  if (password.length < 12 || password.length > 128) {
    return failure("INVALID_PASSWORD", 400, request)
  }
  if (displayName.length < 2 || displayName.length > 80) {
    return failure("INVALID_DISPLAY_NAME", 400, request)
  }

  if (
    !Deno.env.get("SUPABASE_URL") ||
    !Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ) {
    diagnostic("service_configuration", { configured: false })
    return failure("BOOTSTRAP_UNAVAILABLE", 422, request)
  }

  let stage = "service_client"
  let client: ReturnType<typeof serviceClient>
  try {
    client = serviceClient()
    stage = "admin_lookup"
    const { data: existing, error: lookupError } = await client
      .from("admin_profiles")
      .select("user_id")
      .eq("role", "admin")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()
    if (lookupError) {
      diagnostic("operation_failed", {
        operation: stage,
        errorCode: lookupError.code ?? null,
      })
      return failure("BOOTSTRAP_UNAVAILABLE", 422, request)
    }
    const adminExistsBefore = Boolean(existing)
    diagnostic("admin_state", {
      stage: "before_create",
      adminExists: adminExistsBefore,
    })
    if (adminExistsBefore) return failure("ADMIN_ALREADY_EXISTS", 409, request)

    stage = "auth_create"
    diagnostic("operation_started", { operation: stage })
    const { data: created, error: createError } =
      await client.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { display_name: displayName },
      })
    if (createError || !created.user) {
      diagnostic("operation_failed", {
        operation: stage,
        errorCode: createError?.code ?? null,
      })
      return failure("ADMIN_CREATION_FAILED", 422, request)
    }
    diagnostic("operation_succeeded", { operation: stage })

    stage = "profile_create"
    diagnostic("operation_started", { operation: stage })
    const { error: profileError } = await client.from("admin_profiles").insert({
      user_id: created.user.id,
      display_name: displayName,
      role: "admin",
      is_active: true,
    })
    if (profileError) {
      diagnostic("operation_failed", {
        operation: stage,
        errorCode: profileError.code ?? null,
      })
      stage = "auth_rollback"
      const { error: rollbackError } = await client.auth.admin.deleteUser(
        created.user.id,
      )
      if (rollbackError) {
        diagnostic("operation_failed", {
          operation: stage,
          errorCode: rollbackError.code ?? null,
        })
        return failure("ADMIN_CREATION_FAILED", 500, request)
      }
      if (profileError.code === "23505")
        return failure("ADMIN_ALREADY_EXISTS", 409, request)
      return failure("ADMIN_CREATION_FAILED", 422, request)
    }
    diagnostic("operation_succeeded", { operation: stage })

    const { data: after, error: afterError } = await client
      .from("admin_profiles")
      .select("user_id")
      .eq("role", "admin")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()
    diagnostic("admin_state", {
      stage: "after_create",
      adminExists: afterError ? null : Boolean(after),
    })
    diagnostic("bootstrap_succeeded")
    return jsonForRequest({ success: true }, 201, request)
  } catch (error) {
    diagnostic("operation_failed", {
      operation: stage,
      errorType: error instanceof Error ? error.name : "UnknownError",
    })
    return failure("INTERNAL_ERROR", 500, request)
  }
})
