import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { logDiagnostic } from "@/lib/utils";

import { SupportChat } from "./SupportChat";
import { SupportIdentifyForm } from "./SupportIdentifyForm";
import { useSupportConversation } from "./hooks/useSupportConversation";
import { resolveConversation } from "./supportEntry";

/**
 * `/support` — customer care reached on its own, rather than from a payment.
 *
 * Identifying by email leads to a real URL for the thread, so a customer can
 * come back to `/support/:id` directly. The email itself is never in the URL.
 */
export function SupportIdentifyPage() {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="support-page">
      {error && (
        <p className="cs-error" role="alert">
          {error}
        </p>
      )}
      <SupportIdentifyForm
        busy={busy}
        showLanguage
        onSubmit={({ email, name }) => {
          setBusy(true);
          setError(null);
          void resolveConversation({ email, name, subject: "CallaStar support" })
            .then((conversation) => navigate(`/support/${conversation.id}`, { replace: true }))
            .catch((cause: unknown) => {
              logDiagnostic("support-identify", cause);
              setError("We could not open your conversation. Please try again.");
            })
            .finally(() => setBusy(false));
        }}
        onCancel={() => navigate("/")}
      />
    </main>
  );
}

/** `/support/:conversationId` — one customer's thread. */
export function SupportThreadPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const state = useSupportConversation(conversationId ?? null, "customer");

  // A thread that is not in this browser's storage cannot be shown, and guessing
  // at an id must not produce somebody else's conversation.
  if (!state.loading && !state.conversation) {
    return (
      <main className="support-page">
        <div className="support-missing">
          <h1 className="cs-display">Conversation not found</h1>
          <p className="cs-lede">
            This support conversation is not available on this device. Enter your email address to find it again.
          </p>
          <button type="button" className="primary-button" onClick={() => navigate("/support", { replace: true })}>
            <span>Find my conversation</span>
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="support-page support-page-chat">
      <SupportChat
        state={state}
        viewer="customer"
        title="CallaStar Support"
        subtitle={state.conversation?.subject ?? "Customer care"}
        onBack={() => navigate("/")}
        backLabel="Back to CallaStar"
      />
    </main>
  );
}

export default SupportIdentifyPage;
