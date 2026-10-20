import { useState } from "react"
import { adminRepository } from "@/services/admin/repository"
import type { HostProfile } from "@/services/admin/types"
import { useAssetMeta } from "../hooks/useAdminData"
import { useToast } from "../components/ToastProvider"
import { ConfirmDialog } from "../components/ConfirmDialog"

export default function CallTicketControls({
  profile,
  onChanged,
}: {
  profile: HostProfile
  onChanged: (profile: HostProfile) => void
}) {
  const [pending, setPending] =
    useState<"free" | "premium" | "regenerate" | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const { data: video } = useAssetMeta(profile.remoteVideoAssetId)
  const mode = profile.profileMode ?? "premium"
  const ticket = profile.ticket
  const settingsUnavailable = adminRepository.mode === "supabase" &&
    (!profile.profileMode || !profile.callIdMaxUses || !ticket?.mode || !ticket.maxUses)
  const save = async (
    change: {
      mode?: "free" | "premium"
      maxUses?: 1 | 2 | 3 | 5
    } | "regenerate",
  ) => {
    setBusy(true)
    try {
      onChanged(
        await (change === "regenerate"
          ? adminRepository.regenerateCallId(profile.id)
          : adminRepository.configureCallTicket(profile.id, change)),
      )
      setPending(null)
      toast.success("Call ID settings saved.")
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not save Call ID settings.",
      )
    } finally {
      setBusy(false)
    }
  }
  if (profile.callIdLoadError) return (
    <section className="call-ticket-controls" aria-label={`Call ID settings for ${profile.displayName}`}>
      <p className="admin-hint" role="status">{profile.callIdLoadError}</p>
    </section>
  )
  return (
    <section
      className="call-ticket-controls"
      aria-label={`Call ID settings for ${profile.displayName}`}
    >
      {settingsUnavailable && <p className="admin-hint" role="status">Free/Premium settings are awaiting the server update.</p>}
      <fieldset disabled={busy || settingsUnavailable}>
        <legend>Mode</legend>
        <div className="call-ticket-modes">
          {(["free", "premium"] as const).map((value) => (
            <label key={value} className={mode === value ? "is-selected" : ""}>
              <input
                type="radio"
                name={`mode-${profile.id}`}
                value={value}
                checked={mode === value}
                onChange={() => setPending(value)}
              />
              {value === "free" ? "Free Mode" : "Premium Mode"}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="admin-hint">
        {mode === "free"
          ? "Callers can use a valid Call ID without a subscription. Access is controlled by the Call ID's allowed-use limit."
          : "First-time callers receive the complimentary call. Returning callers require valid subscription access."}
      </p>
      <div className="call-ticket-facts">
        <span>
          Status: <strong>{ticket?.status ?? "active"}</strong>{" "}
          {ticket?.useCount === 0 && (
            <span className="call-ticket-new">New Call ID</span>
          )}
        </span>
        <span>
          Uses:{" "}
          <strong>
            {ticket?.useCount ?? 0} /{" "}
            {ticket?.maxUses ?? profile.callIdMaxUses ?? 1}
          </strong>
        </span>
        <span>
          Remaining:{" "}
          <strong>
            {Math.max(
              0,
              (ticket?.maxUses ?? profile.callIdMaxUses ?? 1) -
                (ticket?.useCount ?? 0),
            )}
          </strong>
        </span>
        {ticket && (
          <span>
            Generated:{" "}
            <time dateTime={ticket.generatedAt}>
              {new Date(ticket.generatedAt).toLocaleString()}
            </time>
            {ticket.generationReason === "initial" ||
            ticket.generationReason === "manual"
              ? ""
              : " · Auto-generated"}
          </span>
        )}
      </div>
      <div className="call-ticket-actions">
        <label>
          Allowed Uses{" "}
          <select
            aria-label={`Allowed Uses for ${profile.displayName}`}
            disabled={busy || settingsUnavailable}
            value={ticket?.maxUses ?? profile.callIdMaxUses ?? 1}
            onChange={(event) =>
              void save({
                maxUses: Number(event.target.value) as 1 | 2 | 3 | 5,
              })
            }
          >
            {[1, 2, 3, 5].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="admin-button admin-button-ghost"
          disabled={busy}
          onClick={() => setPending("regenerate")}
        >
          Regenerate ID
        </button>
      </div>
      <p className="admin-hint">
        Controls how many successful call sessions this Call ID can start before
        it expires and a new ID is generated.
      </p>
      <p className="admin-hint">
        {video?.durationSeconds
          ? `Selected source: ${video.fileName} · ${Math.floor(
              video.durationSeconds / 60,
            )
              .toString()
              .padStart(2, "0")}:${Math.floor(video.durationSeconds % 60)
              .toString()
              .padStart(2, "0")}`
          : "Source video required"}
      </p>
      <ConfirmDialog
        open={pending !== null}
        title={
          pending === "regenerate"
            ? "Regenerate Call ID?"
            : "Change profile mode?"
        }
        confirmLabel={
          pending === "regenerate" ? "Regenerate ID" : "Change Mode"
        }
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending)
            void save(pending === "regenerate" ? pending : { mode: pending })
        }}
      >
        {pending === "regenerate"
          ? "The current Call ID will stop working immediately. Continue?"
          : "Changing this profile's mode will retire its current Call ID and generate a new one."}
      </ConfirmDialog>
    </section>
  )
}
