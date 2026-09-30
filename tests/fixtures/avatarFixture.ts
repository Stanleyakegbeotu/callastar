import * as three from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

/**
 * Synthetic GLB fixtures, built in the browser at test time.
 *
 * TEST-ONLY, and deliberately not committed as a binary. Generating them keeps a
 * multi-megabyte asset out of the repository, makes the rig deterministic, and —
 * because the file goes out through a real `GLTFExporter` and back in through the
 * real `GLTFLoader` — exercises the actual loader rather than a hand-rolled
 * approximation of one.
 *
 * Served and transformed by Vite, which is why this lives in a module rather than
 * inside a `page.evaluate`: a bare `import("three")` evaluated in the page cannot
 * be resolved by the browser, because nothing has rewritten the specifier.
 *
 * Two rigs, because the milestone's central requirement is that the three model
 * classes are told apart honestly:
 *   `rigged` — facial morph targets in ARKit naming, plus Head and Jaw bones.
 *   `static` — one bare mesh, no morphs, no skeleton.
 */

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]!);
  return btoa(binary);
}

function exportGlb(root: three.Object3D): Promise<string> {
  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      root,
      (result) => resolve(toBase64(result as ArrayBuffer)),
      (error) => reject(error),
      { binary: true },
    );
  });
}

/**
 * The morph target order the tests assert against.
 *
 * Index 0 is the LEFT blink and index 1 the RIGHT, so an influence check is also
 * the left/right independence check — a mapping that crossed the sides would make
 * a wink work backwards, which reads as a tracking fault.
 */
export const FIXTURE_MORPH_ORDER = [
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "jawOpen",
  "mouthSmileLeft",
  "mouthSmileRight",
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
] as const;

export const FIXTURE_HEAD_MESH_NAME = "HeadMesh";

function buildRigged(): three.Group {
  const root = new three.Group();
  const geometry = new three.SphereGeometry(0.5, 16, 12);
  const base = geometry.getAttribute("position");

  // Each morph displaces a different slab of the sphere, so a test can tell one
  // from another by which vertices moved rather than trusting the name alone.
  const morph = (
    predicate: (x: number, y: number, z: number) => boolean,
    offset: readonly [number, number, number],
  ) => {
    const array = new Float32Array(base.count * 3);
    for (let index = 0; index < base.count; index += 1) {
      const hit = predicate(base.getX(index), base.getY(index), base.getZ(index));
      array[index * 3] = hit ? offset[0] : 0;
      array[index * 3 + 1] = hit ? offset[1] : 0;
      array[index * 3 + 2] = hit ? offset[2] : 0;
    }
    return new three.BufferAttribute(array, 3);
  };

  geometry.morphAttributes.position = [
    morph((x, y) => x < -0.1 && y > 0.05, [0, -0.08, 0]),
    morph((x, y) => x > 0.1 && y > 0.05, [0, -0.08, 0]),
    morph((_x, y) => y < -0.1, [0, -0.12, 0]),
    morph((x, y) => x < -0.1 && y < 0, [-0.06, 0.04, 0]),
    morph((x, y) => x > 0.1 && y < 0, [0.06, 0.04, 0]),
    morph((_x, y) => y > 0.25, [0, 0.07, 0]),
    morph((x, y) => x < -0.1 && y > 0.25, [0, 0.07, 0]),
    morph((x, y) => x > 0.1 && y > 0.25, [0, 0.07, 0]),
  ];

  /*
   * A SKINNED mesh, not a plain one.
   *
   * `GLTFExporter` only writes a skeleton that is bound to a `SkinnedMesh`; loose
   * `Bone` objects sitting in a group are dropped, so an earlier version of this
   * fixture produced a file with no bones at all and could not exercise head-bone
   * discovery or the head pivot. Every vertex is weighted entirely to the head
   * bone, which is enough to make the skeleton real without modelling a
   * deformation nobody tests.
   */
  const vertexCount = base.count;
  geometry.setAttribute("skinIndex", new three.Uint16BufferAttribute(new Uint16Array(vertexCount * 4), 4));
  const weights = new Float32Array(vertexCount * 4);
  for (let index = 0; index < vertexCount; index += 1) weights[index * 4] = 1;
  geometry.setAttribute("skinWeight", new three.Float32BufferAttribute(weights, 4));

  const mesh = new three.SkinnedMesh(geometry, new three.MeshStandardMaterial({ color: 0xcc9977 }));
  mesh.name = FIXTURE_HEAD_MESH_NAME;
  mesh.morphTargetDictionary = Object.fromEntries(
    FIXTURE_MORPH_ORDER.map((name, index) => [name, index]),
  );
  mesh.morphTargetInfluences = new Array(FIXTURE_MORPH_ORDER.length).fill(0);

  // `Neck` is present specifically so the test can check that `Head` wins
  // discovery rather than the first bone found.
  const head = new three.Bone();
  head.name = "Head";
  const neck = new three.Bone();
  neck.name = "Neck";
  const jaw = new three.Bone();
  jaw.name = "Jaw";
  jaw.position.y = -0.15;

  head.add(jaw);
  neck.add(head);
  head.position.y = 0.2;

  // Bone 0 is the head, which is what every vertex above is weighted to.
  const skeleton = new three.Skeleton([head, neck, jaw]);
  root.add(neck);
  root.add(mesh);
  mesh.bind(skeleton);
  return root;
}

function buildStatic(): three.Group {
  const root = new three.Group();
  const mesh = new three.Mesh(
    new three.BoxGeometry(0.4, 0.5, 0.4),
    new three.MeshStandardMaterial({ color: 0x8899aa }),
  );
  mesh.name = "PlainHead";
  root.add(mesh);
  return root;
}

export interface AvatarFixtures {
  /** base64 GLB with facial morphs and a head bone. */
  rigged: string;
  /** base64 GLB with neither. */
  static: string;
}

let cached: Promise<AvatarFixtures> | null = null;

/** Built once per page: exporting is the slow part and the output never varies. */
export function buildAvatarFixtures(): Promise<AvatarFixtures> {
  cached ??= (async () => ({
    rigged: await exportGlb(buildRigged()),
    static: await exportGlb(buildStatic()),
  }))();
  return cached;
}

/** base64 → a File, as a file picker would hand one over. */
export function fixtureFile(base64: string, name: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new File([bytes], name, { type: "model/gltf-binary" });
}
