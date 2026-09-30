import { EXPRESSION_KEYS, type ExpressionKey } from "../engine/expressionMotion";

/**
 * Matching a model's morph vocabulary to CallaStar's eight expressions.
 *
 * There is no standard. A GLB from Ready Player Me, one from Blender's ARKit
 * add-on, one from VRoid and one modelled by hand will each name a left blink
 * differently, and some name it in Japanese. So a single hardcoded vocabulary
 * would work for exactly one pipeline and silently fail for every other — which
 * on screen looks identical to a broken rig.
 *
 * Matching is therefore by normalised alias: case, separators and common
 * prefixes are stripped before comparison, so `eyeBlinkLeft`, `EyeBlink_L`,
 * `blink.L` and `Fcl_EYE_Close_L` all resolve without needing to be listed in
 * every spelling.
 *
 * Only the eight expressions CallaStar drives are mapped. A model with all 52
 * ARKit shapes keeps the other 44; they are reported as unmapped rather than
 * quietly dropped.
 */

/**
 * Reduces a morph name to a comparable form.
 *
 * Lowercased, with separators and decorative prefixes removed. `mixamorig` and
 * VRoid's `Fcl_` prefix are stripped because they carry no meaning about which
 * expression a morph is.
 */
export function normalizeMorphName(name: string): string {
  return name
    .toLowerCase()
    .replace(/^fcl[_.]?/, "")
    .replace(/^mixamorig[:_]?/, "")
    .replace(/^(blendshape|morph|shape|bs)[_.]?/, "")
    .replace(/[\s_.\-:|]/g, "");
}

/**
 * Aliases per expression, in normalised form.
 *
 * Ordered most-specific first, because `blinkleft` must win over a bare `blink`
 * on a model that has both. Side markers are handled by the suffix rules below
 * rather than by listing every combination.
 */
const ALIASES: Record<ExpressionKey, readonly string[]> = {
  blinkLeft: ["eyeblinkleft", "blinkleft", "eyeclosedleft", "eyecloseleft", "eyeclosel", "eyeblinkl", "blinkl", "eyeshutleft", "closeeyeleft"],
  blinkRight: ["eyeblinkright", "blinkright", "eyeclosedright", "eyecloseright", "eyecloser", "eyeblinkr", "blinkr", "eyeshutright", "closeeyeright"],
  jawOpen: ["jawopen", "mouthopen", "openmouth", "jawdrop", "aa", "moutha", "vrc.v_aa", "jaw"],
  smileLeft: ["mouthsmileleft", "smileleft", "mouthsmilel", "smilel", "mouthcornerupleft", "happyleft"],
  smileRight: ["mouthsmileright", "smileright", "mouthsmiler", "smiler", "mouthcornerupright", "happyright"],
  browInnerUp: ["browinnerup", "browsinnerup", "browinnerupleft", "browup", "browsup", "eyebrowup", "surprised"],
  browOuterUpLeft: ["browouterupleft", "browouterupl", "browupleft", "eyebrowupleft", "browoutterupleft"],
  browOuterUpRight: ["browouterupright", "browouterupr", "browupright", "eyebrowupright", "browoutterupright"],
};

/**
 * Which expressions are side-specific, and the markers that identify a side.
 *
 * A model naming its blinks `eyeBlink_L` / `eyeBlink_R` is extremely common, and
 * getting the sides the wrong way round would make a wink work backwards — a
 * failure that looks like a tracking bug.
 */
const LEFT_MARKERS = ["left", "l"] as const;
const RIGHT_MARKERS = ["right", "r"] as const;

const SIDED: Partial<Record<ExpressionKey, { base: readonly string[]; side: "left" | "right" }>> = {
  blinkLeft: { base: ["eyeblink", "blink", "eyeclosed", "eyeclose"], side: "left" },
  blinkRight: { base: ["eyeblink", "blink", "eyeclosed", "eyeclose"], side: "right" },
  smileLeft: { base: ["mouthsmile", "smile"], side: "left" },
  smileRight: { base: ["mouthsmile", "smile"], side: "right" },
  browOuterUpLeft: { base: ["browouterup", "browup"], side: "left" },
  browOuterUpRight: { base: ["browouterup", "browup"], side: "right" },
};

function sideOf(normalized: string, base: string): "left" | "right" | null {
  if (!normalized.startsWith(base)) return null;
  const suffix = normalized.slice(base.length);
  if (suffix.length === 0) return null;
  if (LEFT_MARKERS.includes(suffix as (typeof LEFT_MARKERS)[number])) return "left";
  if (RIGHT_MARKERS.includes(suffix as (typeof RIGHT_MARKERS)[number])) return "right";
  return null;
}

/**
 * Which CallaStar expression a morph name serves, if any.
 *
 * Returns null for a morph this pipeline does not drive — `cheekPuff`,
 * `noseSneer` and the rest — which the profile reports as unmapped.
 */
export function expressionForMorph(morphName: string): ExpressionKey | null {
  const normalized = normalizeMorphName(morphName);
  if (!normalized) return null;

  // Exact alias first, so a precise name always beats a pattern.
  for (const key of EXPRESSION_KEYS) {
    if (ALIASES[key].includes(normalized)) return key;
  }

  // Then base-plus-side, which covers the `_L` / `_R` families without listing
  // every spelling of every combination.
  for (const key of EXPRESSION_KEYS) {
    const sided = SIDED[key];
    if (!sided) continue;
    for (const base of sided.base) {
      if (sideOf(normalized, base) === sided.side) return key;
    }
  }

  return null;
}

export interface MorphMatch {
  key: ExpressionKey;
  morphName: string;
  index: number;
}

/**
 * Every CallaStar expression a single mesh's morph dictionary can serve.
 *
 * Takes the dictionary Three.js builds (`morphTargetDictionary`), so this needs
 * no Three.js import and stays unit-testable with a plain object.
 */
export function matchMorphTargets(dictionary: Readonly<Record<string, number>>): MorphMatch[] {
  const matches: MorphMatch[] = [];
  const claimed = new Set<ExpressionKey>();

  for (const [morphName, index] of Object.entries(dictionary)) {
    const key = expressionForMorph(morphName);
    if (!key) continue;
    /*
     * One morph per expression per mesh.
     *
     * A model with both `eyeBlinkLeft` and `eyeClosedLeft` would otherwise have
     * both driven at full influence, doubling the deformation and shutting the
     * eye through the skull.
     */
    if (claimed.has(key)) continue;
    claimed.add(key);
    matches.push({ key, morphName, index });
  }

  return matches;
}

/** Morph names no CallaStar expression drives. Reported in diagnostics. */
export function unmappedMorphNames(names: readonly string[]): string[] {
  return names.filter((name) => expressionForMorph(name) === null);
}

/**
 * Bone-name candidates for the head and the jaw.
 *
 * Matched by normalised containment rather than equality, because rigs prefix
 * and suffix freely — `mixamorigHead`, `Head_M`, `J_Bip_C_Head`, `CC_Base_Head`.
 * Ordered so a more specific name wins: `HeadTop_End` must not be taken for the
 * head bone, since rotating about the crown looks like a nod from the forehead.
 */
const HEAD_BONE_EXCLUSIONS = ["headtop", "headend", "headtopend"] as const;

export function findHeadBone(boneNames: readonly string[]): string | null {
  const scored = boneNames
    .map((name) => ({ name, normalized: normalizeMorphName(name) }))
    .filter((entry) => entry.normalized.includes("head"))
    .filter((entry) => !HEAD_BONE_EXCLUSIONS.some((bad) => entry.normalized.includes(bad)));

  if (scored.length === 0) return null;
  // The shortest remaining name is the head itself rather than a child of it.
  return scored.sort((a, b) => a.normalized.length - b.normalized.length)[0]!.name;
}

export function findJawBone(boneNames: readonly string[]): string | null {
  const scored = boneNames
    .map((name) => ({ name, normalized: normalizeMorphName(name) }))
    .filter((entry) => entry.normalized.includes("jaw") || entry.normalized.includes("chin"));

  if (scored.length === 0) return null;
  return scored.sort((a, b) => a.normalized.length - b.normalized.length)[0]!.name;
}
