import { describe, expect, it } from "vitest";

import {
  expressionForMorph,
  findHeadBone,
  findJawBone,
  matchMorphTargets,
  normalizeMorphName,
  unmappedMorphNames,
} from "./morphAliases";

/**
 * Matching a model's morph vocabulary to CallaStar's expressions.
 *
 * There is no standard, so the failure this guards against is a model whose rig
 * is perfectly good and whose morphs are simply spelled differently — which on
 * screen is indistinguishable from a broken rig, and would be "fixed" by
 * hunting the tracker.
 *
 * The sides matter more than anything else here. A left blink matched to the
 * right morph makes a wink work backwards, which reads as a tracking fault.
 */

describe("name normalisation", () => {
  it("ignores case, separators and decorative prefixes", () => {
    expect(normalizeMorphName("eyeBlinkLeft")).toBe("eyeblinkleft");
    expect(normalizeMorphName("Eye_Blink_Left")).toBe("eyeblinkleft");
    expect(normalizeMorphName("eye.blink.left")).toBe("eyeblinkleft");
    expect(normalizeMorphName("Fcl_EYE_Close_L")).toBe("eyeclosel");
    expect(normalizeMorphName("blendShape_jawOpen")).toBe("jawopen");
  });

  it("survives an empty or decorative-only name", () => {
    expect(normalizeMorphName("")).toBe("");
    expect(normalizeMorphName("___")).toBe("");
  });
});

describe("blink, across vocabularies", () => {
  it("recognises the ARKit spelling", () => {
    expect(expressionForMorph("eyeBlinkLeft")).toBe("blinkLeft");
    expect(expressionForMorph("eyeBlinkRight")).toBe("blinkRight");
  });

  it("recognises side-suffixed families without listing every spelling", () => {
    /*
     * `eyeBlink_L` / `_R` is extremely common and is handled by the suffix rule
     * rather than by an alias entry, so a rig using `blink.L` works too.
     */
    for (const [name, key] of [
      ["eyeBlink_L", "blinkLeft"],
      ["eyeBlink_R", "blinkRight"],
      ["blink.L", "blinkLeft"],
      ["blink.R", "blinkRight"],
      ["EyeClose_L", "blinkLeft"],
      ["EyeClose_R", "blinkRight"],
    ] as const) {
      expect(expressionForMorph(name), name).toBe(key);
    }
  });

  it("never swaps the sides", () => {
    // The failure that looks like a tracking bug.
    for (const name of ["eyeBlinkLeft", "eyeBlink_L", "blink_L", "eyeClosedLeft"]) {
      expect(expressionForMorph(name), name).not.toBe("blinkRight");
    }
    for (const name of ["eyeBlinkRight", "eyeBlink_R", "blink_R", "eyeClosedRight"]) {
      expect(expressionForMorph(name), name).not.toBe("blinkLeft");
    }
  });

  it("does not take a sideless blink for either eye", () => {
    // Driving both eyes from one morph would make every wink a blink.
    expect(expressionForMorph("blink")).toBeNull();
  });
});

describe("jaw, smile and brows", () => {
  it("recognises jaw across vocabularies", () => {
    for (const name of ["jawOpen", "JawOpen", "mouthOpen", "MouthOpen", "jaw_drop"]) {
      expect(expressionForMorph(name), name).toBe("jawOpen");
    }
  });

  it("recognises smile per side", () => {
    expect(expressionForMorph("mouthSmileLeft")).toBe("smileLeft");
    expect(expressionForMorph("mouthSmile_R")).toBe("smileRight");
    expect(expressionForMorph("smile_L")).toBe("smileLeft");
  });

  it("recognises brows, inner and outer", () => {
    expect(expressionForMorph("browInnerUp")).toBe("browInnerUp");
    expect(expressionForMorph("browOuterUpLeft")).toBe("browOuterUpLeft");
    expect(expressionForMorph("browOuterUp_R")).toBe("browOuterUpRight");
  });

  it("leaves morphs this pipeline does not drive alone", () => {
    // A model may have all 52 ARKit shapes; CallaStar drives eight.
    for (const name of ["cheekPuff", "noseSneerLeft", "tongueOut", "eyeLookUpLeft", "mouthPucker"]) {
      expect(expressionForMorph(name), name).toBeNull();
    }
  });
});

describe("matching a mesh's dictionary", () => {
  it("maps the expressions a rigged head offers", () => {
    const matches = matchMorphTargets({
      eyeBlinkLeft: 0,
      eyeBlinkRight: 1,
      jawOpen: 2,
      mouthSmileLeft: 3,
      mouthSmileRight: 4,
      browInnerUp: 5,
      cheekPuff: 6,
    });

    expect(matches.map((match) => match.key).sort()).toEqual(
      ["blinkLeft", "blinkRight", "browInnerUp", "jawOpen", "smileLeft", "smileRight"].sort(),
    );
    expect(matches.find((match) => match.key === "jawOpen")?.index).toBe(2);
  });

  it("takes one morph per expression, even when a model offers two", () => {
    /*
     * A model with both `eyeBlinkLeft` and `eyeClosedLeft` would otherwise have
     * both driven at full influence — doubling the deformation and shutting the
     * eye through the skull.
     */
    const matches = matchMorphTargets({ eyeBlinkLeft: 0, eyeClosedLeft: 1 });
    expect(matches.filter((match) => match.key === "blinkLeft")).toHaveLength(1);
  });

  it("returns nothing for a model with no facial morphs", () => {
    expect(matchMorphTargets({})).toEqual([]);
    expect(matchMorphTargets({ cheekPuff: 0, tongueOut: 1 })).toEqual([]);
  });

  it("reports what it could not use", () => {
    const unmapped = unmappedMorphNames(["eyeBlinkLeft", "cheekPuff", "noseSneerLeft"]);
    expect(unmapped).toEqual(["cheekPuff", "noseSneerLeft"]);
  });
});

describe("bone discovery", () => {
  it("finds a head bone across rig conventions", () => {
    expect(findHeadBone(["Hips", "Spine", "Neck", "Head"])).toBe("Head");
    expect(findHeadBone(["mixamorigNeck", "mixamorigHead"])).toBe("mixamorigHead");
    expect(findHeadBone(["J_Bip_C_Neck", "J_Bip_C_Head"])).toBe("J_Bip_C_Head");
  });

  it("does not mistake the crown for the head", () => {
    /*
     * `HeadTop_End` is a leaf at the top of the skull. Rotating about it would
     * swing the whole head from the crown, which reads as a nod originating in
     * the forehead rather than the neck.
     */
    expect(findHeadBone(["Head", "HeadTop_End"])).toBe("Head");
    expect(findHeadBone(["mixamorigHeadTop_End"])).toBeNull();
  });

  it("finds a jaw bone, which can open a mouth with no morph for it", () => {
    expect(findJawBone(["Head", "Jaw"])).toBe("Jaw");
    expect(findJawBone(["Head", "CC_Base_JawRoot"])).toBe("CC_Base_JawRoot");
    expect(findJawBone(["Head", "Chin"])).toBe("Chin");
  });

  it("reports honestly when a rig has neither", () => {
    expect(findHeadBone([])).toBeNull();
    expect(findHeadBone(["Hips", "Spine", "LeftArm"])).toBeNull();
    expect(findJawBone(["Head", "Neck"])).toBeNull();
  });
});
