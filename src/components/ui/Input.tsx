import { useId, type InputHTMLAttributes } from "react";

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "id"> {
  label: string;
  /** Inline validation message; also flags the field as invalid for assistive tech. */
  error?: string | null;
  className?: string;
}

export function Input({ label, error, className = "", ...rest }: InputProps) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`field-input ${className}`.trim()}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        {...rest}
      />
      {error && (
        <span className="field-error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export default Input;
