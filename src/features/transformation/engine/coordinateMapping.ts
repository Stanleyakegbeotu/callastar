/**
 * Mapping tracker coordinates onto the displayed video.
 *
 * MediaPipe returns normalised coordinates in the space of the frame it was
 * given. Getting those onto the screen correctly is the difference between an
 * overlay that sits on someone's face and one that floats 20px off it, and the
 * places it goes wrong are all invisible until you look: the video's intrinsic
 * size differs from its displayed size, `object-fit: cover` crops one axis, the
 * front camera is mirrored for the viewer but not for the model, and a phone's
 * device pixel ratio scales everything again.
 *
 * The design decision that removes most of the difficulty: the tracking frame is
 * always the SAME ASPECT RATIO as the camera frame, merely smaller. A tracking
 * canvas of a different shape would either stretch faces — which changes what
 * the model sees — or need letterbox padding unwound on every landmark. Keeping
 * the aspect identical means normalised tracking coordinates are already
 * normalised camera coordinates, and only the display step remains.
 */

export type ObjectFit = "cover" | "contain";

export interface DisplayGeometry {
  /** The camera's intrinsic frame size. */
  sourceWidth: number;
  sourceHeight: number;
  /** The video element's laid-out size, in CSS pixels. */
  displayWidth: number;
  displayHeight: number;
  /** How the element fits the frame. `cover` is the studio default. */
  objectFit: ObjectFit;
  /**
   * Whether the PREVIEW is mirrored.
   *
   * A front camera is shown mirrored because that is what people expect of a
   * selfie view. The tracker never sees the mirrored image, so the flip belongs
   * here, at the display boundary, and nowhere else — mirroring the video with
   * CSS *and* the landmarks separately is how an overlay ends up correct on one
   * axis and inverted on the other.
   */
  mirrored: boolean;
}

export interface DisplayPoint {
  x: number;
  y: number;
}

/**
 * How the source frame is laid out inside the display box.
 *
 * Exposed because the overlay canvas needs the same rectangle to know which
 * parts of itself are showing camera and which are letterbox.
 */
export interface FitRect {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
  scale: number;
}

export function computeFitRect(geometry: DisplayGeometry): FitRect {
  const { sourceWidth, sourceHeight, displayWidth, displayHeight, objectFit } = geometry;

  if (sourceWidth <= 0 || sourceHeight <= 0 || displayWidth <= 0 || displayHeight <= 0) {
    return { offsetX: 0, offsetY: 0, width: 0, height: 0, scale: 0 };
  }

  const scaleX = displayWidth / sourceWidth;
  const scaleY = displayHeight / sourceHeight;

  // `cover` fills the box and crops the overflow; `contain` fits inside it and
  // leaves bars. Which one is chosen decides the sign of the offsets below.
  const scale = objectFit === "cover" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);

  const width = sourceWidth * scale;
  const height = sourceHeight * scale;

  return {
    offsetX: (displayWidth - width) / 2,
    offsetY: (displayHeight - height) / 2,
    width,
    height,
    scale,
  };
}

/**
 * A normalised tracker coordinate to a CSS pixel on the video element.
 *
 * Mirroring is applied last, in display space, because that is the only place it
 * is true: the model worked on an unmirrored frame.
 */
export function mapNormalizedToDisplay(
  point: { x: number; y: number },
  geometry: DisplayGeometry,
): DisplayPoint {
  const rect = computeFitRect(geometry);
  if (rect.scale === 0) return { x: 0, y: 0 };

  const x = rect.offsetX + point.x * rect.width;
  const y = rect.offsetY + point.y * rect.height;

  return {
    x: geometry.mirrored ? geometry.displayWidth - x : x,
    y,
  };
}

/**
 * Whether a mapped point is actually on screen.
 *
 * With `object-fit: cover` a landmark can be perfectly valid and still fall
 * outside the visible box, because the crop threw that part of the frame away.
 * Drawing it anyway puts a dot on the bezel.
 */
export function isPointVisible(point: DisplayPoint, geometry: DisplayGeometry): boolean {
  return (
    point.x >= 0 && point.x <= geometry.displayWidth && point.y >= 0 && point.y <= geometry.displayHeight
  );
}

/**
 * The tracking frame size for a camera frame.
 *
 * Deliberately preserves aspect ratio. Feeding a 720×1280 portrait camera into a
 * 640×480 landscape surface would squash every face by 40% before the model ever
 * saw it, and the landmarks would be wrong in a way no amount of careful mapping
 * afterwards could fix.
 *
 * `maxDimension` caps the longest side, so a portrait phone camera and a
 * landscape webcam both come out at a comparable pixel budget.
 */
export function computeTrackingSize(
  sourceWidth: number,
  sourceHeight: number,
  maxDimension: number,
): { width: number; height: number } {
  if (sourceWidth <= 0 || sourceHeight <= 0 || maxDimension <= 0) {
    return { width: 0, height: 0 };
  }

  // Never upscale: a small camera frame gains nothing from being enlarged, and
  // inference would cost more for no extra detail.
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));

  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

/**
 * Backing-store size for the overlay canvas.
 *
 * A canvas laid out at 390 CSS pixels on a 3× phone needs a 1170 pixel backing
 * store, or every line is drawn soft. Capped because 3× of a large desktop
 * canvas is a lot of pixels to clear sixty times a second for a few dots.
 */
export function computeOverlayCanvasSize(
  displayWidth: number,
  displayHeight: number,
  devicePixelRatio: number,
  maxRatio = 2,
): { width: number; height: number; ratio: number } {
  const ratio = Math.max(1, Math.min(devicePixelRatio || 1, maxRatio));
  return {
    width: Math.max(1, Math.round(displayWidth * ratio)),
    height: Math.max(1, Math.round(displayHeight * ratio)),
    ratio,
  };
}
