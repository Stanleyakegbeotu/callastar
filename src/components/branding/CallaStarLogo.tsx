import type { MouseEventHandler } from "react";
import { useNavigate } from "react-router-dom";

import { CallaStarMark } from "./CallaStarMark";

interface CallaStarLogoProps {
  /** Kept for existing call surfaces that need the white treatment. */
  inverse?: boolean;
  compact?: boolean;
  variant?: "horizontal" | "mark";
  theme?: "light" | "dark";
  size?: number;
  className?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}

/**
 * The wordmark doubles as the way home, as in the prototype. Unmounting the
 * call screen releases the camera and the landing screen clears the session, so
 * this is always a safe exit mid-call.
 */
export function CallaStarLogo({
  inverse = false,
  compact = false,
  variant = "horizontal",
  theme,
  size,
  className = "",
  onClick,
}: CallaStarLogoProps) {
  const navigate = useNavigate();
  const treatment = theme ?? (inverse ? "dark" : "light");
  const markOnly = compact || variant === "mark";

  return (
    <button
      type="button"
      className={`brand ${className}`.trim()}
      onClick={onClick ?? (() => navigate("/"))}
      aria-label="Return to CallaStar home"
    >
      {markOnly ? (
        <CallaStarMark theme={treatment} size={size ?? 36} />
      ) : (
        <img
          className="brand-image brand-image-horizontal"
          src={
            treatment === "dark"
              ? "/branding/callastar-logo-horizontal-light.svg"
              : "/branding/callastar-logo-horizontal.svg"
          }
          width="280"
          height="72"
          style={{ height: size ?? 36 }}
          alt=""
          aria-hidden="true"
        />
      )}
    </button>
  );
}

export default CallaStarLogo;
