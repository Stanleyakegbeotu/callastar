import { useNavigate } from "react-router-dom";

import { Icon } from "@/components/ui/Icon";

interface CallaStarLogoProps {
  /** White treatment for use over imagery. */
  inverse?: boolean;
  /** Mark only, no wordmark. */
  compact?: boolean;
}

/**
 * The wordmark doubles as the way home, as in the prototype. Unmounting the
 * call screen releases the camera and the landing screen clears the session, so
 * this is always a safe exit mid-call.
 */
export function CallaStarLogo({ inverse = false, compact = false }: CallaStarLogoProps) {
  const navigate = useNavigate();

  return (
    <button
      type="button"
      className={`brand ${inverse ? "brand-inverse" : ""}`.trim()}
      onClick={() => navigate("/")}
      aria-label="Return to CallaStar home"
    >
      <span className="brand-mark">
        <Icon name="video" className="size-5" />
      </span>
      {!compact && <span>CallaStar</span>}
    </button>
  );
}

export default CallaStarLogo;
