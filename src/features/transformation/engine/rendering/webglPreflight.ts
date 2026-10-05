export const FACE_WEBGL_UNAVAILABLE = 'Face renderer unavailable. Return to Raw preview and retry.';
/** Reuse this exact context in Three; probing a spare canvas consumes another GPU context. */
export function faceWebGLContext(canvas: HTMLCanvasElement): WebGL2RenderingContext {
  // Three blends straight shader output into a premultiplied-alpha drawing
  // buffer, which is the representation the browser expects for this canvas.
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl || gl.isContextLost()) throw new Error(FACE_WEBGL_UNAVAILABLE);
  for (const shader of [gl.VERTEX_SHADER, gl.FRAGMENT_SHADER]) {
    for (const precision of [gl.HIGH_FLOAT, gl.MEDIUM_FLOAT]) {
      if (!gl.getShaderPrecisionFormat(shader, precision)) throw new Error(FACE_WEBGL_UNAVAILABLE);
    }
  }
  return gl;
}
