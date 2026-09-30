import { copyText } from "@/lib/utils";

import { useToast } from "../components/ToastProvider";

interface CallIdCardProps {
  callId: string;
  /** Rendered under the code; used for Regenerate. */
  footer?: React.ReactNode;
  highlight?: boolean;
}

/**
 * The profile's one current Call ID.
 *
 * It is always shown in full: this is the string an administrator has to pass
 * to somebody, so hiding it behind a reveal would only get in the way.
 */
export function CallIdCard({ callId, footer, highlight = false }: CallIdCardProps) {
  const toast = useToast();

  const copy = async () => {
    const copied = await copyText(callId);
    if (copied) toast.success("Call ID copied.");
    else toast.error("Copying is blocked in this browser. Select the code and copy it manually.");
  };

  return (
    <section className={`admin-card admin-callid ${highlight ? "is-highlight" : ""}`}>
      <h2 className="admin-card-label">Call ID</h2>
      <p className="admin-callid-code">{callId}</p>
      <div className="admin-callid-actions">
        <button type="button" className="admin-button admin-button-secondary" onClick={() => void copy()}>
          Copy
        </button>
        {footer}
      </div>
      <p className="admin-hint">Share this ID with people who need to connect to this profile.</p>
    </section>
  );
}

export default CallIdCard;
