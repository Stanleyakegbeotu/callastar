import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { supabase } from "@/lib/supabase/client";

import { isDevelopmentAdminEnabled, startDevelopmentSession } from "./auth/adminAuth";

/** No signup path is exposed: administrators are provisioned in Supabase Auth. */
export function AdminLoginPage() {
  const navigate = useNavigate();
  const client = supabase;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * Development entry. This branch only exists in a dev build with
   * VITE_ADMIN_AUTH_MODE=development, and it is labelled so nobody mistakes it
   * for a real sign-in.
   */
  if (isDevelopmentAdminEnabled()) {
    return (
      <main className="admin-auth">
        <section className="admin-card">
          <div className="join-progress">CallaStar administration</div>
          <h1>Development access</h1>
          <p>
            Supabase is not connected yet. This build opens the dashboard against local browser storage so profiles and
            media can be built out. Production builds always require a provisioned Supabase administrator.
          </p>
          <Button
            withArrow={false}
            onClick={() => {
              startDevelopmentSession();
              navigate("/admin", { replace: true });
            }}
          >
            Continue to dashboard
          </Button>
        </section>
      </main>
    );
  }

  if (!client) {
    return (
      <main className="admin-auth">
        <section className="admin-card">
          <h1>Admin setup required</h1>
          <p>Configure the safe public Supabase environment variables before signing in.</p>
        </section>
      </main>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error: authError } = await client.auth.signInWithPassword({ email, password });
    setSubmitting(false);
    if (authError) {
      setError("We couldn’t sign you in with those details.");
      return;
    }
    navigate("/admin", { replace: true });
  };

  return (
    <main className="admin-auth">
      <form className="admin-card" onSubmit={submit}>
        <div className="join-progress">CallaStar administration</div>
        <h1>Sign in</h1>
        <p>Only provisioned administrators can access this workspace.</p>
        <Input
          label="Email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
        />
        <Input
          label="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />
        <div className="admin-error" role="alert">
          {error}
        </div>
        <Button type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}

export default AdminLoginPage;
