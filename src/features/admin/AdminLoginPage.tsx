import { useEffect, useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"

import { CallaStarMark } from "@/components/branding/CallaStarMark"
import { AppHeader } from "@/components/layout/AppHeader"
import { Button } from "@/components/ui/Button"
import { supabase } from "@/lib/supabase/client"

import { hasActiveAdminAccess } from "./auth/adminAccess"

interface PasswordFieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  autoComplete: string
  error?: string | null
  required?: boolean
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  error,
  required = true,
}: PasswordFieldProps) {
  const [visible, setVisible] = useState(false)
  const errorId = `${id}-error`

  return (
    <div className="admin-login-field">
      <label className="admin-login-label" htmlFor={id}>
        {label}
      </label>
      <div className="admin-login-password-wrap">
        <input
          id={id}
          className="cs-input admin-login-input"
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          required={required}
        />
        <button
          type="button"
          className="admin-login-password-toggle"
          aria-label={`${visible ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-controls={id}
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
      {error && (
        <p className="admin-login-field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export function AdminLoginPage() {
  const navigate = useNavigate()
  const client = supabase
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [displayName, setDisplayName] = useState("")
  const [bootstrapSecret, setBootstrapSecret] = useState("")
  const [adminExists, setAdminExists] = useState<boolean | null>(null)
  const [creating, setCreating] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [confirmPasswordError, setConfirmPasswordError] =
    useState<string | null>(null)
  const [setupSecretError, setSetupSecretError] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!client) return
    let active = true
    void (async () => {
      try {
        const { data, error: lookupError } = await client.rpc("admin_exists")
        if (!active) return
        setAdminExists(lookupError ? true : data === true)
        if (lookupError)
          setPageError(
            "Admin setup is unavailable. Please check the connection and try again.",
          )
      } catch {
        if (!active) return
        setAdminExists(true)
        setPageError(
          "Admin setup is unavailable. Please check the connection and try again.",
        )
      }
    })()
    return () => {
      active = false
    }
  }, [client])

  const clearErrors = () => {
    setPasswordError(null)
    setConfirmPasswordError(null)
    setSetupSecretError(null)
    setPageError(null)
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!client || submitting) return
    clearErrors()

    const isCreating = creating && adminExists === false
    if (isCreating && password !== confirmPassword) {
      setConfirmPasswordError("Passwords do not match.")
      return
    }

    setSubmitting(true)
    try {
      if (isCreating) {
        const { error: bootstrapError } = await client.functions.invoke(
          "bootstrap-admin",
          {
            body: { email, password, displayName, bootstrapSecret },
          },
        )
        if (bootstrapError) {
          const status = (bootstrapError as typeof bootstrapError & {
            context?: { status?: number }
          }).context?.status
          if (status === 409 || bootstrapError.message.includes("409")) {
            setAdminExists(true)
            setCreating(false)
            setPageError(
              "Admin setup is already complete. Sign in with the existing account.",
            )
          } else {
            setSetupSecretError(
              "Admin setup could not be completed. Check the setup secret and try again.",
            )
          }
          return
        }
        setBootstrapSecret("")
      }

      const { data, error: authError } = await client.auth.signInWithPassword({
        email,
        password,
      })
      if (authError || !data.user) {
        if (isCreating) {
          setAdminExists(true)
          setCreating(false)
          setPageError(
            "Your admin account was created. Sign in with the email and password you just set.",
          )
        } else {
          setPasswordError("We couldn’t sign you in with those details.")
        }
        return
      }

      const { data: profile, error: profileError } = await client
        .from("admin_profiles")
        .select("user_id, role, is_active")
        .eq("user_id", data.user.id)
        .maybeSingle()
      if (profileError || !hasActiveAdminAccess(profile)) {
        await client.auth.signOut()
        setPageError(
          "This account is not authorized for the CallaStar admin workspace.",
        )
        return
      }

      navigate("/admin", { replace: true })
    } catch {
      setPageError(
        "We couldn’t complete that request. Check your connection and try again.",
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (!client) {
    return (
      <main className="admin-auth-page">
        <AppHeader minimal />
        <section
          className="admin-login-content"
          aria-labelledby="admin-login-title"
        >
          <div className="admin-login-heading">
            <CallaStarMark size={48} />
            <p className="admin-login-eyebrow">CallaStar administration</p>
            <h1 id="admin-login-title">Admin access</h1>
            <p className="admin-login-copy">
              Admin sign-in is not configured yet. Please check the application
              setup.
            </p>
          </div>
        </section>
      </main>
    )
  }

  const showCreate = adminExists === false && creating

  return (
    <main className="admin-auth-page">
      <AppHeader minimal />
      <section
        className="admin-login-content"
        aria-labelledby="admin-login-title"
      >
        <div className="admin-login-heading">
          <CallaStarMark size={48} />
          <p className="admin-login-eyebrow">CallaStar administration</p>
          <h1 id="admin-login-title">
            {showCreate ? "Create admin account" : "Admin access"}
          </h1>
          <p className="admin-login-copy">
            {showCreate
              ? "Set up the first administrator for your CallaStar workspace."
              : "Sign in to continue to your CallaStar workspace."}
          </p>
        </div>

        <form
          className="admin-login-form"
          onSubmit={(event) => void submit(event)}
        >
          {showCreate && (
            <div className="admin-login-field">
              <label className="admin-login-label" htmlFor="admin-display-name">
                Display name
              </label>
              <input
                id="admin-display-name"
                className="cs-input admin-login-input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
                minLength={2}
                maxLength={80}
                required
              />
            </div>
          )}

          <div className="admin-login-field">
            <label className="admin-login-label" htmlFor="admin-email">
              Email
            </label>
            <input
              id="admin-email"
              className="cs-input admin-login-input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              inputMode="email"
              required
            />
          </div>

          <PasswordField
            id="admin-password"
            label="Password"
            value={password}
            onChange={setPassword}
            autoComplete={showCreate ? "new-password" : "current-password"}
            error={passwordError}
          />

          {showCreate && (
            <>
              <PasswordField
                id="admin-confirm-password"
                label="Confirm password"
                value={confirmPassword}
                onChange={(value) => {
                  setConfirmPassword(value)
                  if (confirmPasswordError) setConfirmPasswordError(null)
                }}
                autoComplete="new-password"
                error={confirmPasswordError}
              />
              <PasswordField
                id="admin-bootstrap-secret"
                label="Bootstrap secret"
                value={bootstrapSecret}
                onChange={setBootstrapSecret}
                autoComplete="off"
                error={setupSecretError}
              />
            </>
          )}

          {pageError && (
            <p className="admin-login-page-error" role="alert">
              {pageError}
            </p>
          )}

          <Button
            type="submit"
            withArrow={false}
            className="admin-login-submit"
            disabled={submitting || adminExists === null}
          >
            {submitting
              ? showCreate
                ? "Creating Admin…"
                : "Signing In…"
              : showCreate
                ? "Create Admin"
                : "Sign In"}
          </Button>
        </form>

        {adminExists === false && (
          <p className="admin-login-switch-row">
            {showCreate
              ? "Already have an admin account?"
              : "First-time setup?"}{" "}
            <button
              type="button"
              className="admin-auth-switch"
              onClick={() => {
                setCreating((current) => !current)
                setConfirmPassword("")
                setBootstrapSecret("")
                clearErrors()
              }}
            >
              {showCreate ? "Sign in" : "Create Admin"}
            </button>
          </p>
        )}
      </section>
    </main>
  )
}

export default AdminLoginPage
