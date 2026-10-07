import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

import { Icon } from "@/components/ui/Icon";

interface CountryOption {
  code: CountryCode;
  name: string;
  callingCode: string;
  flag: string;
}

interface CountryPhoneFieldProps {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  invalid?: boolean;
  describedBy?: string;
}

const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const COUNTRY_OPTIONS: CountryOption[] = getCountries()
  .map((code) => ({
    code,
    name: countryNames.of(code) ?? code,
    callingCode: getCountryCallingCode(code),
    flag: code.toUpperCase().replace(/[A-Z]/g, (letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
const COUNTRIES_BY_CODE = new Map(COUNTRY_OPTIONS.map((option) => [option.code, option]));

function getDefaultCountry(): CountryCode {
  const region = typeof navigator === "undefined" ? "NG" : navigator.language.split("-").at(-1)?.toUpperCase();
  return COUNTRY_OPTIONS.some((country) => country.code === region) ? (region as CountryCode) : "NG";
}

function initialPhone(value: string): { country: CountryCode; nationalNumber: string } {
  const parsed = value.startsWith("+") ? parsePhoneNumberFromString(value) : undefined;
  if (parsed) {
    return {
      country: parsed.country ?? getDefaultCountry(),
      nationalNumber: parsed.nationalNumber,
    };
  }
  return { country: getDefaultCountry(), nationalNumber: value.replace(/\D/g, "") };
}

function fullPhoneNumber(country: CountryCode, nationalNumber: string): string {
  const digits = nationalNumber.replace(/\D/g, "");
  if (!digits) return "";
  const parsed = parsePhoneNumberFromString(nationalNumber, country);
  if (parsed) return parsed.number;
  return `+${getCountryCallingCode(country)}${digits}`;
}

export function CountryPhoneField({ value, onChange, onBlur, invalid = false, describedBy }: CountryPhoneFieldProps) {
  const [initial] = useState(() => initialPhone(value));
  const [countryCode, setCountryCode] = useState<CountryCode>(initial.country);
  const [nationalNumber, setNationalNumber] = useState(initial.nationalNumber);
  const [countryMenuOpen, setCountryMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeOption, setActiveOption] = useState(0);
  const pickerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const country = COUNTRIES_BY_CODE.get(countryCode) ?? COUNTRY_OPTIONS[0]!;

  const suggestions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return COUNTRY_OPTIONS;
    const dialQuery = normalizedQuery.replace(/^\+/, "");
    return COUNTRY_OPTIONS.filter((option) =>
      option.name.toLocaleLowerCase().includes(normalizedQuery) ||
      option.code.toLocaleLowerCase().includes(normalizedQuery) ||
      (dialQuery.length > 0 && option.callingCode.startsWith(dialQuery)),
    );
  }, [query]);

  useEffect(() => {
    if (!countryMenuOpen) return;
    searchRef.current?.focus();
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setCountryMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [countryMenuOpen]);

  const chooseCountry = (option: CountryOption) => {
    setCountryCode(option.code);
    setCountryMenuOpen(false);
    setQuery("");
    setActiveOption(0);
    onChange(fullPhoneNumber(option.code, nationalNumber));
  };

  const handleNumberChange = (event: ChangeEvent<HTMLInputElement>) => {
    const number = event.target.value.replace(/[^\d\s().-]/g, "");
    setNationalNumber(number);
    onChange(fullPhoneNumber(countryCode, number));
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveOption((index) => Math.min(index + 1, suggestions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveOption((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && suggestions[activeOption]) {
      event.preventDefault();
      chooseCountry(suggestions[activeOption]);
    } else if (event.key === "Escape") {
      setCountryMenuOpen(false);
    }
  };

  return (
    <div className={`cs-phone-picker ${invalid ? "is-invalid" : ""}`} ref={pickerRef}>
      <div className="cs-phone-input-row">
        <button
          type="button"
          className="cs-country-trigger"
          aria-label={`Select country. ${country.name}, +${country.callingCode}`}
          aria-haspopup="listbox"
          aria-expanded={countryMenuOpen}
          onClick={() => setCountryMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">{country.flag}</span>
          <span>+{country.callingCode}</span>
          <Icon name="chevron" className="cs-country-chevron" />
        </button>
        <input
          className="cs-phone-number"
          type="tel"
          inputMode="tel"
          value={nationalNumber}
          onChange={handleNumberChange}
          onBlur={onBlur}
          placeholder="Phone Number"
          aria-label="Phone number"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          autoComplete="tel-national"
        />
      </div>

      {countryMenuOpen && (
        <div className="cs-country-menu">
          <input
            ref={searchRef}
            className="cs-country-search"
            type="search"
            role="combobox"
            aria-label="Search countries and calling codes"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="cs-country-suggestions"
            aria-activedescendant={suggestions[activeOption] ? `cs-country-${suggestions[activeOption].code}` : undefined}
            placeholder="Search country or code"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveOption(0);
            }}
            onKeyDown={handleSearchKeyDown}
          />
          <ul className="cs-country-suggestions" id="cs-country-suggestions" role="listbox">
            {suggestions.length > 0 ? suggestions.map((option, index) => (
              <li key={option.code} role="presentation">
                <button
                  id={`cs-country-${option.code}`}
                  type="button"
                  role="option"
                  aria-selected={option.code === countryCode}
                  className={index === activeOption ? "is-suggested" : ""}
                  onMouseEnter={() => setActiveOption(index)}
                  onClick={() => chooseCountry(option)}
                >
                  <span aria-hidden="true">{option.flag}</span>
                  <span className="cs-country-name">{option.name}</span>
                  <span className="cs-country-dial">+{option.callingCode}</span>
                </button>
              </li>
            )) : (
              <li className="cs-country-empty" role="presentation">No matching country</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

export default CountryPhoneField;
