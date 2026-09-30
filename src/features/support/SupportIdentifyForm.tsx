import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { LanguageSelector } from "@/components/ui/LanguageSelector";

import { validateSupportEmail } from "./supportEntry";

interface IdentifyFormProps {
  /** Prefilled when the caller already gave an email to join a call. */
  initialEmail?: string;
  initialName?: string;
  busy?: boolean;
  /** The standalone page offers the language control; the overlay does not. */
  showLanguage?: boolean;
  onSubmit: (values: { email: string; name: string }) => void;
  onCancel?: () => void;
}

/**
 * The way into customer care.
 *
 * One field that matters, because that is all this needs: an email to look a
 * conversation up by. No password, no code, no link in an inbox — and the copy
 * says what is actually happening rather than implying an account exists.
 */
export function SupportIdentifyForm({
  initialEmail = "",
  initialName = "",
  busy = false,
  showLanguage = false,
  onSubmit,
  onCancel,
}: IdentifyFormProps) {
  const { t } = useTranslation();
  const [email, setEmail] = useState(initialEmail);
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="support-identify"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const problem = validateSupportEmail(email);
        setError(problem === null ? null : t(problem));
        if (problem) return;
        onSubmit({ email: email.trim(), name: name.trim() });
      }}
    >
      <span className="support-identify-icon" aria-hidden="true">
        <Icon name="chat" className="size-8" />
      </span>

      <h1 className="cs-display">{t("support.title")}</h1>
      <p className="cs-lede">{t("support.identifyCopy")}</p>

      <label className="cs-field">
        <span className="cs-field-icon">
          <Icon name="mail" className="size-5" />
        </span>
        <input
          className="cs-input"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder={t("support.emailPlaceholder")}
          aria-label={t("support.emailPlaceholder")}
          aria-invalid={error !== null}
          value={email}
          onChange={(event) => {
            setEmail(event.currentTarget.value);
            if (error) setError(null);
          }}
        />
      </label>

      <label className="cs-field">
        <span className="cs-field-icon">
          <Icon name="user" className="size-5" />
        </span>
        <input
          className="cs-input"
          type="text"
          autoComplete="name"
          placeholder={t("support.namePlaceholder")}
          aria-label={t("support.namePlaceholder")}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>

      {error && (
        <p className="cs-error" role="alert">
          {error}
        </p>
      )}

      <p className="cs-note">
        <span className="cs-note-icon">
          <Icon name="shield" className="size-6" />
        </span>
        <span>{t("support.privacyNote")}</span>
      </p>

      <Button type="submit" disabled={busy} withArrow={false}>
        {/* Checking the format and looking for a previous conversation. It is
            never a check on the mailbox, so it never says "verified". */}
        {busy ? t("support.checking") : t("support.continueToSupport")}
      </Button>

      {onCancel && (
        <button type="button" className="join-text-action" onClick={onCancel}>
          {t("support.notNow")}
        </button>
      )}

      {showLanguage && <LanguageSelector />}
    </form>
  );
}

export default SupportIdentifyForm;
