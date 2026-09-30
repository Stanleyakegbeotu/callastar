import type { ReactNode } from "react";

import { Icon } from "@/components/ui/Icon";
import type { DraggablePip } from "@/features/call-session/hooks/useDraggablePip";

interface ParticipantTileProps {
  /** Name shown on the tile, which is whoever is *in* the tile. */
  label: string;
  onSwap: () => void;
  /** Position, drag state and pointer handlers from `useDraggablePip`. */
  pip: DraggablePip;
  children: ReactNode;
}

/**
 * The picture-in-picture tile.
 *
 * Tapping it swaps the two participants between the tile and the main surface;
 * the local stream object is unchanged by the swap, so no second camera is ever
 * opened. Dragging it parks it in another corner — it stays a button, so the
 * swap is still reachable by keyboard, and the drag is an enhancement on top
 * rather than the only way to use it.
 */
export function ParticipantTile({ label, onSwap, pip, children }: ParticipantTileProps) {
  return (
    <button
      type="button"
      className={`video-pip video-pip-${pip.corner} ${pip.dragging ? "video-pip-dragging" : ""}`.trim()}
      style={pip.offset ? { transform: `translate(${pip.offset.x}px, ${pip.offset.y}px)` } : undefined}
      onClick={pip.guardClick(onSwap)}
      aria-label={`${label} — tap to swap, drag to move`}
      {...pip.handlers}
    >
      {children}
      <span className="pip-name">{label}</span>
      <span className="swap-chip" aria-hidden="true">
        <Icon name="flip" className="size-3.5" />
      </span>
    </button>
  );
}

export default ParticipantTile;
