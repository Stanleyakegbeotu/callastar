import { useEffect, useState } from "react";

import { broadcastLocalEvent } from "@/lib/localEvents";
import { formatPhoneForDisplay, validateWhatsappNumber } from "@/lib/phone";
import { logDiagnostic } from "@/lib/utils";
import { settingsRepository } from "@/services/settings/repository";

import { useToast } from "../components/ToastProvider";
import { AdminPageHeader } from "../layout/AdminPageHeader";

/**
 * Admin → Settings.
 *
 * Exists so an operator can change where customers are sent for payment support
 * without editing source or an environment file. The value is saved through the
 * settings repository, and the payment screen reads the same seam — so a change
 * here reaches the next customer who opens the WhatsApp option, including one
 * already sitting on that screen in another tab.
 */
export function AdminSettingsPage() {
  const toast = useToast();
  const [number, setNumber] = useState("");
  const [formspreeEndpoint, setFormspreeEndpoint] = useState("");
  const [formspreeConfigured, setFormspreeConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedDigits, setSavedDigits] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void settingsRepository
      .getAppSettings()
      .then((settings) => {
        if (cancelled) return;
        setSavedDigits(settings.whatsappSupportNumber);
        setFormspreeConfigured(settings.formspreeConfigured);
        // Show back what they typed if we have it; otherwise group the digits so
        // a stored number is still readable.
        setNumber(
          settings.whatsappSupportNumberDisplay ??
            (settings.whatsappSupportNumber ? formatPhoneForDisplay(settings.whatsappSupportNumber) : ""),
        );
      })
      .catch((cause: unknown) => {
        logDiagnostic("admin-settings", cause);
        if (!cancelled) setError("Settings could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    const check = validateWhatsappNumber(number);
    setError(check.error);
    if (!check.valid) return;

    setSaving(true);
    try {
      const saved = await settingsRepository.updateAppSettings({
        whatsappSupportNumber: check.normalized,
        whatsappSupportNumberDisplay: number.trim(),
        ...(formspreeEndpoint.trim() ? { formspreeEndpoint: formspreeEndpoint.trim() } : {}),
      });
      setSavedDigits(saved.whatsappSupportNumber);
      setFormspreeConfigured(saved.formspreeConfigured);
      setFormspreeEndpoint("");
      // Any payment screen open in another tab re-reads the number.
      broadcastLocalEvent("settings-updated");
      toast.success("Support settings updated.");
    } catch (cause) {
      logDiagnostic("admin-settings-save", cause);
      setError("That change could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <AdminPageHeader title="Settings" description="Manage CallaStar support and application preferences." />

      <p className="admin-card-label">Customer care</p>

      <section className="admin-card">
        <div className="admin-card-heading">
          <h2>WhatsApp Support</h2>
        </div>
        <p className="admin-hint">
          Set the WhatsApp number users are directed to when they choose WhatsApp support.
        </p>

        <form
          className="admin-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="admin-field">
            <label htmlFor="whatsapp-number">WhatsApp Number</label>
            <input
              id="whatsapp-number"
              className="admin-input"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="+1 415 555 0123"
              aria-invalid={error !== null}
              aria-describedby="whatsapp-help"
              disabled={loading}
              value={number}
              onChange={(event) => {
                setNumber(event.currentTarget.value);
                if (error) setError(null);
              }}
            />
            <p className="admin-note" id="whatsapp-help">
              Include the country code.
            </p>
            {error && (
              <p className="admin-field-error" role="alert">
                {error}
              </p>
            )}
          </div>

          {savedDigits && (
            <p className="admin-note">
              Customers are currently sent to <strong>wa.me/{savedDigits}</strong>.
            </p>
          )}

          {!loading && !savedDigits && (
            <p className="admin-note">
              No number is configured, so the WhatsApp option is shown as unavailable and customers are offered in-app
              support instead.
            </p>
          )}

          <div className="admin-form-actions">
            <button type="submit" className="admin-button admin-button-primary" disabled={saving || loading}>
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </section>

      <section className="admin-card">
        <div className="admin-card-heading"><h2>Protected payment notification</h2></div>
        <p className="admin-hint">CallaStar sends selected payment and support events to this Formspree endpoint from the backend. The endpoint itself is never exposed to customers or returned to this browser.</p>
        <form className="admin-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <div className="admin-field">
            <label htmlFor="formspree-endpoint">Formspree endpoint</label>
            <input id="formspree-endpoint" className="admin-input" type="url" inputMode="url" autoComplete="off" placeholder={formspreeConfigured ? "Configured — enter a new endpoint to replace" : "https://formspree.io/f/..."} value={formspreeEndpoint} onChange={(event) => setFormspreeEndpoint(event.currentTarget.value)} disabled={loading} />
            <p className="admin-note">{formspreeConfigured ? "An endpoint is configured. Leave this blank to keep the saved endpoint." : "No endpoint is configured yet. Notifications remain in the admin dashboard."}</p>
          </div>
          <div className="admin-form-actions"><button type="submit" className="admin-button admin-button-primary" disabled={saving || loading}>{saving ? "Saving…" : "Save Support Settings"}</button></div>
        </form>
      </section>
    </>
  );
}

export default AdminSettingsPage;
