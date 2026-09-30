import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Downloads the official MediaPipe task models this project uses.
 *
 * Deliberately downloaded at build time and gitignored, exactly as
 * `copy-transformation-wasm.mjs` handles the MediaPipe WASM. That keeps ~9 MB of
 * third-party binaries out of the repository while still serving them
 * same-origin, so the Studio needs no third-party request at runtime and works
 * through an HTTPS tunnel or offline once fetched.
 *
 * Both models are published by Google under Apache-2.0, which permits
 * redistribution with attribution — the manifest written beside them records the
 * exact URL, version and licence for each.
 *
 * Re-running is cheap: a file already present with a plausible size is skipped,
 * so `predev` and `prebuild` do not re-download on every start.
 */

/**
 * Pinned to the `latest/` channel Google publishes for each task.
 *
 * MediaPipe does not version model URLs the way the npm package is versioned;
 * `float16/latest` is the documented stable path. `expectedBytes` is the guard:
 * a truncated or redirected download is caught rather than cached as valid.
 */
const MODELS = [
  {
    id: "faceLandmarker",
    file: "face_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task",
    // Bundles the mesh, blendshapes and the facial transformation matrix, which
    // is what drives head pose without a separate solver.
    purpose: "Face landmarks, blendshapes and facial transformation matrices",
    licence: "Apache-2.0",
    expectedBytes: 3_758_596,
  },
  {
    id: "poseLandmarker",
    file: "pose_landmarker_lite.task",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
    // `lite` on purpose: this runs on a phone alongside the face model, and the
    // heavier variants buy accuracy this pipeline does not need for shoulders.
    purpose: "Upper-body pose landmarks and segmentation mask",
    licence: "Apache-2.0",
    expectedBytes: 5_454_784,
  },
];

/** A download is only trusted within this much of the documented size. */
const SIZE_TOLERANCE = 0.25;

const target = resolve("public/transformation/models");
await mkdir(target, { recursive: true });

function plausible(actual, expected) {
  return Math.abs(actual - expected) <= expected * SIZE_TOLERANCE;
}

async function existingSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

const results = [];
let downloaded = 0;

for (const model of MODELS) {
  const path = join(target, model.file);
  const present = await existingSize(path);

  if (present !== null && plausible(present, model.expectedBytes)) {
    results.push({ ...model, bytes: present, cached: true });
    continue;
  }

  process.stdout.write(`Fetching ${model.file}… `);
  const response = await fetch(model.url);
  if (!response.ok) {
    throw new Error(`${model.file}: ${response.status} ${response.statusText} from ${model.url}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!plausible(bytes.byteLength, model.expectedBytes)) {
    // A redirect to an error page, or a truncated body, would otherwise be
    // cached and then fail much later as an unreadable model.
    throw new Error(
      `${model.file}: expected about ${model.expectedBytes} bytes, received ${bytes.byteLength}. Refusing to cache it.`,
    );
  }

  await writeFile(path, bytes);
  results.push({ ...model, bytes: bytes.byteLength, cached: false });
  downloaded += 1;
  console.log(`${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB`);
}

/**
 * Final verification, after everything has been written.
 *
 * The generated TypeScript below hands the app a path for each model, and the
 * binaries themselves are gitignored. Without this check a clean checkout could
 * compile perfectly, start the Studio, and only fail as a 404 deep inside
 * MediaPipe once somebody pointed a camera at it. Refusing to emit paths for
 * files that are not on disk turns that into a build failure with a name.
 */
const missing = [];
for (const model of results) {
  const size = await existingSize(join(target, model.file));
  if (size === null) {
    missing.push(`${model.file} is not on disk`);
  } else if (!plausible(size, model.expectedBytes)) {
    missing.push(`${model.file} is ${size} bytes, expected about ${model.expectedBytes}`);
  }
}

if (missing.length > 0) {
  throw new Error(
    `Transformation models are not usable:\n  - ${missing.join("\n  - ")}\n` +
      `Run \`pnpm assets:transformation\` with network access. The Studio cannot start without them.`,
  );
}

/** Provenance, beside the files, so licence and origin are never guessed at. */
await writeFile(
  join(target, "manifest.json"),
  `${JSON.stringify(
    {
      note: "Downloaded by scripts/fetch-transformation-models.mjs. Not committed; regenerated by predev/prebuild.",
      models: results.map(({ id, file, url, purpose, licence, bytes }) => ({
        id,
        file,
        url,
        purpose,
        licence,
        bytes,
      })),
    },
    null,
    2,
  )}\n`,
);

const generated = results
  .map((model) => `  ${model.id}: "/transformation/models/${model.file}",`)
  .join("\n");

await writeFile(
  resolve("src/features/transformation/modelAssetPaths.generated.ts"),
  `// Generated by scripts/fetch-transformation-models.mjs. Do not edit by hand.
// Models are Apache-2.0, published by Google; see public/transformation/models/manifest.json.
//
// The binaries these paths point at are gitignored and fetched by predev/prebuild.
// The generator verifies every file is on disk at a plausible size before writing
// this, so a path present here means the model was really there at build time.
export const transformationModelPaths = {
${generated}
  imageSegmenter: null,
} as const;

/** When the generator last verified the binaries. Diagnostics only. */
export const transformationModelsPreparedAt = "${new Date().toISOString()}";
`,
);

const total = results.reduce((sum, model) => sum + model.bytes, 0);
console.log(
  `Transformation models ready in ${target} (${results.length} files, ${(total / 1024 / 1024).toFixed(1)} MB, ${downloaded} downloaded)`,
);
