import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import { logDiagnostic } from "@/lib/utils";

import { de } from "./locales/de";
import { en } from "./locales/en";
import { es } from "./locales/es";
import { fr } from "./locales/fr";
import { it } from "./locales/it";
import { pt } from "./locales/pt";

/**
 * Language for the public app.
 *
 * Chosen from what the browser already says the person reads — no permission
 * prompt, no geolocation, and no IP lookup, because none of those are needed to
 * pick a language and all of them cost the user something.
 *
 * An explicit choice always wins over the browser, and is remembered in
 * `localStorage`. That is appropriate here and only here: a language preference
 * is not personal data, not a credential and not a message. Nothing else in
 * CallaStar is allowed in that store.
 *
 * Currency is deliberately NOT tied to any of this. Prices are USD in every
 * language, because translating an interface and charging a different currency
 * are separate decisions and only one of them has been made.
 */

export const SUPPORTED_LANGUAGES = ["en", "es", "fr", "de", "pt", "it"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  it: "Italiano",
};

const STORAGE_KEY = "callastar.language";

function isSupported(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * The best supported match for a browser tag.
 *
 * Region is dropped rather than treated as a different language: `es-MX`,
 * `pt-BR` and `fr-CA` are all served, because a Mexican reader is far better
 * off with Spanish than with English.
 */
export function matchLanguage(tags: readonly string[]): SupportedLanguage | null {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (isSupported(lower)) return lower;

    const base = lower.split("-")[0];
    if (base && isSupported(base)) return base;
  }
  return null;
}

export function readStoredLanguage(): SupportedLanguage | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && isSupported(stored) ? stored : null;
  } catch (error) {
    // Private windows and blocked storage: fall back to the browser.
    logDiagnostic("language-storage", error);
    return null;
  }
}

export function storeLanguage(language: SupportedLanguage): void {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch (error) {
    logDiagnostic("language-storage", error);
  }
}

/** A saved choice, else the browser, else English. */
export function detectLanguage(): SupportedLanguage {
  const stored = readStoredLanguage();
  if (stored) return stored;

  if (typeof navigator === "undefined") return "en";
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  return matchLanguage(tags.filter(Boolean)) ?? "en";
}

const resources = {
  en: { translation: en },
  es: { translation: es },
  fr: { translation: fr },
  de: { translation: de },
  pt: { translation: pt },
  it: { translation: it },
};

export function initI18n(): typeof i18next {
  if (i18next.isInitialized) return i18next;

  void i18next.use(initReactI18next).init({
    resources,
    lng: detectLanguage(),
    fallbackLng: "en",
    supportedLngs: SUPPORTED_LANGUAGES,
    interpolation: {
      // React escapes everything it renders; doing it again would double-encode.
      escapeValue: false,
    },
    returnNull: false,
  });

  applyDocumentLanguage(i18next.language);
  return i18next;
}

/** Keep `<html lang>` truthful, for screen readers and for hyphenation. */
function applyDocumentLanguage(language: string): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language;
}

export function changeLanguage(language: SupportedLanguage): void {
  storeLanguage(language);
  void i18next.changeLanguage(language);
  applyDocumentLanguage(language);
}

export { i18next };
