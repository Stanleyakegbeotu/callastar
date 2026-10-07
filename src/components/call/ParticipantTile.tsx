import type { ReactNode } from "react";

import type { DraggablePip } from "@/features/call-session/hooks/useDraggablePip";

interface ParticipantTileProps {
  /** Draggable picture-in-picture showing the caller camera. */
  label: string;
  pip: DraggablePip;
  children: ReactNode;
}

export function ParticipantTile({ label, pip, children }: ParticipantTileProps) {
  return (
    <div
      className={`video-pip video-pip-${pip.corner} ${pip.dragging ? "video-pip-dragging" : ""}`.trim()}
      style={pip.offset ? { transform: `translate(${pip.offset.x}px, ${pip.offset.y}px)` } : undefined}
      aria-label={label}
      {...pip.handlers}
    >
      {children}
      <span className="pip-name">{label}</span>
    </div>
  );
}

export default ParticipantTile;
