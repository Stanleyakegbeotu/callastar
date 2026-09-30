import { transformationModelPaths } from "./modelAssetPaths.generated";

/**
 * Where the MediaPipe task models live.
 *
 * Served from this application's own origin rather than a third-party CDN, so
 * the Studio makes no external request at runtime and works through an HTTPS
 * tunnel or offline once the assets are in place. That matters for a feature
 * pointed at somebody's camera: nothing about a session should depend on, or be
 * observable by, a host we do not control.
 *
 * The binaries are downloaded by `scripts/fetch-transformation-models.mjs` and
 * gitignored, exactly as the MediaPipe WASM is copied and gitignored — ~9 MB of
 * third-party files stay out of the repository while still being self-hosted.
 * `predev` and `prebuild` fetch them; `public/transformation/models/manifest.json`
 * records each model's source URL, purpose and licence.
 *
 * Both models are Apache-2.0, published by Google.
 */
export interface TransformationModelAssets {
  faceLandmarker: string | null;
  poseLandmarker: string | null;
  /**
   * Deliberately unset.
   *
   * Pose Landmarker already returns a segmentation mask, and a second segmenter
   * would be another model to download, hold in memory and run per frame on a
   * phone. It is only worth adding if experiments prove the pose mask
   * insufficient — see the segmentation note in the foundation document.
   */
  imageSegmenter: string | null;
}

export const transformationModelAssets: Readonly<TransformationModelAssets> = transformationModelPaths;

/** Whether the models needed for tracking are present in this build. */
export function hasRequiredTransformationModels(
  assets: Readonly<TransformationModelAssets> = transformationModelAssets,
): boolean {
  return assets.faceLandmarker !== null && assets.poseLandmarker !== null;
}

/** Generated from the installed package's exact version during predev/prebuild. */
export { transformationWasmBasePath } from "./wasmAssetPath.generated";
