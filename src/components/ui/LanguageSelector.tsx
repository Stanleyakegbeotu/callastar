import { useTranslation } from "react-i18next";

import { Icon } from "@/components/ui/Icon";
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES, changeLanguage, type SupportedLanguage } from "@/i18n";

/**
 * Changing the language.
 *
 * Deliberately restrained and deliberately a native `<select>`: it is a list of
 * six options nobody needs to browse, and the platform control is already
 * accessible, searchable by keyboard and familiar on every device.
 *
 * Each language is named in itself — "Español", not "Spanish" — so it is legible
 * to the person who needs it, whatever the interface is currently showing.
 */
export function LanguageSelector({ className = "" }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const current = (SUPPORTED_LANGUAGES as readonly string[]).includes(i18n.language)
    ? (i18n.language as SupportedLanguage)
    : "en";

  return (
    <label className={`language-selector ${className}`.trim()}>
      <Icon name="globe" className="size-4" />
      <span className="admin-visually-hidden">{t("language.label")}</span>
      <select
        value={current}
        onChange={(event) => changeLanguage(event.currentTarget.value as SupportedLanguage)}
        aria-label={t("language.label")}
      >
        {SUPPORTED_LANGUAGES.map((language) => (
          <option key={language} value={language}>
            {LANGUAGE_NAMES[language]}
          </option>
        ))}
      </select>
    </label>
  );
}

export default LanguageSelector;
