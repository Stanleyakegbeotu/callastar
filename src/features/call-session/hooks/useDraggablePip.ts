import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/**
 * The floating self-view tile: draggable, and parked in a corner.
 *
 * It snaps rather than resting wherever it is dropped. A tile left mid-edge
 * covers the other person's face and drifts out of reach on a rotation; four
 * known corners always leave the centre of the call clear and always put the
 * tile somewhere the next person to pick it up can find it.
 *
 * Dragging and tapping share one pointer, so they are told apart by distance:
 * under the threshold is a tap that swaps the participants, over it is a drag
 * and the click that follows is suppressed.
 */
export type PipCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Far enough to be a deliberate drag, close enough that a tap still taps. */
const DRAG_THRESHOLD = 8;

export interface DraggablePip {
  corner: PipCorner;
  dragging: boolean;
  /** Live offset while dragging; null when parked. */
  offset: { x: number; y: number } | null;
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  };
  /** Wrap the tile's click so a drag never counts as a tap. */
  guardClick: (onTap: () => void) => () => void;
}

export function useDraggablePip(initial: PipCorner = "top-right"): DraggablePip {
  const [corner, setCorner] = useState<PipCorner>(initial);
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // Primary pointer only: a right-click or a second finger is not a drag.
    if (event.button !== 0) return;
    origin.current = { x: event.clientX, y: event.clientY };
    moved.current = false;
    setDragging(true);
    // Keep receiving moves even when the pointer leaves the small tile.
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const start = origin.current;
    if (!start) return;

    const next = { x: event.clientX - start.x, y: event.clientY - start.y };
    if (!moved.current && Math.hypot(next.x, next.y) > DRAG_THRESHOLD) moved.current = true;
    if (moved.current) setOffset(next);
  }, []);

  const finish = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const start = origin.current;
    origin.current = null;
    setDragging(false);
    setOffset(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!start || !moved.current) return;

    // Snap to whichever corner the tile's centre ended up nearest.
    const box = event.currentTarget.getBoundingClientRect();
    const centreX = box.left + box.width / 2;
    const centreY = box.top + box.height / 2;
    const left = centreX < window.innerWidth / 2;
    const top = centreY < window.innerHeight / 2;
    setCorner(top ? (left ? "top-left" : "top-right") : left ? "bottom-left" : "bottom-right");
  }, []);

  const guardClick = useCallback(
    (onTap: () => void) => () => {
      // A drag ends in a click too; only a tap should swap the participants.
      if (moved.current) {
        moved.current = false;
        return;
      }
      onTap();
    },
    [],
  );

  return {
    corner,
    dragging,
    offset,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
    },
    guardClick,
  };
}
