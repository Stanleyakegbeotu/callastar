import { describe, expect, it } from 'vitest';
import { Euler, Vector3 } from 'three';
import { canonicalFaceLandmarks } from './faceLocalGeometry';
import { EyeControlFilter, EYE_ANCHORS, EYE_RENDER_CHANNELS, eyeStateFromGeometry, measureEyeGeometry, type EyeControlFrame } from './eyeControls';
import { eyeRegressionFixture, eyeRegressionFrame } from './fixtures/eyeRegression';
import { CalibrationCollector } from './calibrationCollector';
import { computeExpressionMotion } from './expressionMotion';
import { BlinkStateMachine } from './blinkState';
import { measureBinocularGaze, normalizeBinocularGaze } from './eyeGaze';

const neutral = (side: 'left' | 'right') => measureEyeGeometry(eyeRegressionFixture(), side)!;
const control = (left = {}, right = {}): EyeControlFrame => ({
  left: { ...eyeStateFromGeometry(neutral('left'), neutral('left'), 0, 1, null), ...left },
  right: { ...eyeStateFromGeometry(neutral('right'), neutral('right'), 0, 1, null), ...right },
});
export function captureEyeCalibration() {
  const collector = new CalibrationCollector();
  collector.start('face-only', { cameraFacing: 'user', trackingWidth: 640, trackingHeight: 640, mirrored: false }, 0);
  for (let t = 0; t <= 4000 && collector.getState().phase !== 'ready'; t += 100) collector.accept(eyeRegressionFrame(undefined,t), null, t);
  const profile = collector.getState().profile;
  if (!profile) throw new Error(JSON.stringify(collector.getState()));
  return profile;
}

describe('M8.6 LOCKED eye measurement and calibration', () => {
  it('pins anatomy against official MediaPipe eye/iris indices', () => {
    expect(EYE_ANCHORS.left.outer).toBe(263); expect(EYE_ANCHORS.left.iris).toBe(473);
    expect(EYE_ANCHORS.right.outer).toBe(33); expect(EYE_ANCHORS.right.iris).toBe(468);
    expect(EYE_RENDER_CHANNELS).toEqual({left:'right',right:'left'});
  });
  it('captures asymmetric apertures, lid contributions, widths and iris origins through existing calibration', () => {
    const profile = captureEyeCalibration();
    expect(profile.face.eyes?.left.aperture).toBeGreaterThan(profile.face.eyes!.right.aperture);
    expect(profile.face.eyes?.left.width).toBeCloseTo(.1);
    expect(profile.face.eyes?.left.irisX).toBeCloseTo(0);
    expect(profile.face.eyes?.right.irisY).toBeCloseTo(0);
  });
  it.each(['left','right'] as const)('a %s wink closes only that anatomical eye, including its matching blendshape', side => {
    const frame = eyeRegressionFrame(eyeRegressionFixture({[side]:{ratio:.25}}));
    frame.blendshapes = side === 'left' ? {eyeBlinkLeft:1,eyeBlinkRight:0} : {eyeBlinkLeft:0,eyeBlinkRight:1};
    const result = computeExpressionMotion(frame, captureEyeCalibration())!;
    const other = side === 'left' ? 'right' : 'left';
    expect(result.eyes![side].blink).toBeGreaterThan(.95);
    expect(result.eyes![side].openness).toBeLessThan(.05);
    expect(result.eyes![other].blink).toBeLessThan(.01);
  });
  it('slow closure remains continuous rather than promoting a half-close to a wink', () => {
    const baseline = captureEyeCalibration(), machine = new BlinkStateMachine();
    let previous = -1;
    for (const [i, closure] of [0,.25,.5,.75,1].entries()) {
      const result = machine.apply(computeExpressionMotion(eyeRegressionFrame(eyeRegressionFixture({left:{ratio:1-.75*closure}})), baseline), i*500)!;
      expect(result.blinkRight).toBeGreaterThanOrEqual(previous);
      expect(result.blinkRight).toBeCloseTo(closure, 5); previous = result.blinkRight;
      expect(result.blinkLeft).toBeCloseTo(0);
    }
  });
  it('a shallow fast blink under yaw closes independently and holds through measured jitter', () => {
    const baseline = captureEyeCalibration(), machine = new BlinkStateMachine();
    const motion = (closure: number) => computeExpressionMotion(eyeRegressionFrame(eyeRegressionFixture({left:{ratio:1-.75*closure}})), baseline);
    machine.apply(motion(0), 0);
    expect(machine.apply(motion(.45), 16)!.blinkRight).toBe(1);
    for(const [i, closure] of [.43,.46,.44,.45].entries()) {
      const result = machine.apply(motion(closure), 32+i*33)!;
      expect(result.blinkRight).toBe(1); expect(result.blinkLeft).toBe(0);
    }
    expect(machine.apply(motion(.2), 200)!.blinkRight).toBeCloseTo(.2);
    expect(machine.apply(motion(0), 233)!.blinkRight).toBe(0);
  });
  it('wide aperture is distinct from neutral and does not require raised brows', () => {
    const result = computeExpressionMotion(eyeRegressionFrame(eyeRegressionFixture({left:{ratio:1.4}})), captureEyeCalibration())!;
    expect(result.eyes!.left.wideOpen).toBeGreaterThan(.9);
    expect(result.eyes!.right.wideOpen).toBe(0);
    expect(result.browInnerUp).toBe(0);
  });
  it('iris Y remains unchanged through lid narrowing and widening', () => {
    for (const ratio of [.3,.6,1,1.4]) {
      const p = eyeRegressionFixture({left:{ratio,irisY:.04}});
      expect(measureEyeGeometry(p,'left')!.irisY).toBeCloseTo(.04);
      expect(measureBinocularGaze(p)!.right.y).toBeCloseTo(.04/.45);
    }
  });
  it('bounds both axes and preserves diagonal gaze', () => {
    const base = measureBinocularGaze(eyeRegressionFixture())!;
    const moved = normalizeBinocularGaze(measureBinocularGaze(eyeRegressionFixture({left:{irisX:.2,irisY:-.2}}))!, base);
    expect(moved.right.x).toBe(1); expect(moved.right.y).toBe(-1); expect(moved.left.x).toBeCloseTo(0);
  });
  it.each([[.4,0,0],[0,-.35,0],[0,0,.3],[.3,-.25,.2]])('isolates gaze, aperture and lid travel from rigid pose %j', (yaw,pitch,roll) => {
    const p = eyeRegressionFixture({left:{irisX:.07,irisY:-.03}});
    const aspect = 390/844;
    const posed = p.map(point => {
      const v = new Vector3(point.x-.5,-(point.y-.5),-(point.z+.05)).applyEuler(new Euler(pitch,yaw,roll,'XYZ')).multiplyScalar(1.3);
      return {x:.6+v.x,y:.4-v.y*aspect,z:-v.z};
    });
    const local = canonicalFaceLandmarks(posed,{yaw,pitch,roll},aspect);
    for (const side of ['left','right'] as const) {
      const actual = measureEyeGeometry(local,side)!, expected = measureEyeGeometry(p,side)!;
      for (const key of ['aperture','upper','lower','irisX','irisY'] as const) expect(actual[key]).toBeCloseTo(expected[key]!, 6);
    }
  });
});

describe('M8.6 LOCKED adaptive eye stability', () => {
  it('closes promptly, holds three seconds without flutter, and reopens promptly', () => {
    const filter = new EyeControlFilter(); filter.update(control(),0);
    expect(filter.update(control({blink:1}),33).left.blink).toBe(1);
    for (let t=66;t<3100;t+=33) expect(filter.update(control({blink:1}),t).left.blink).toBe(1);
    const open = filter.update(control(),3133); expect(open.left.blink).toBeLessThan(.02); expect(open.right.blink).toBe(0);
  });
  it('stabilizes neutral jitter more strongly than intentional gaze steps', () => {
    const filter = new EyeControlFilter(); filter.update(control(),0);
    const noise = filter.update(control({gazeX:.01}),33).left.gazeX;
    const move = filter.update(control({gazeX:.8}),66).left.gazeX;
    expect(noise).toBeLessThan(.005); expect(move).toBeGreaterThan(.75);
  });
  it('holds weak confidence briefly, decays, then recovers independently', () => {
    const filter = new EyeControlFilter(); filter.update(control({blink:1}),0);
    const hold = filter.update(control({blink:0,confidence:0}),50);
    expect(hold.left.blink).toBe(1); expect(hold.right.blink).toBe(0);
    const decay = filter.update(null,500); expect(decay.left.blink).toBeLessThan(hold.left.blink);
    for(let t=600;t<2000;t+=100) filter.update(null,t);
    expect(filter.update(control({blink:1}),2033).left.blink).toBe(1);
  });
  it('reset drops the previous controller and calibration state', () => {
    const filter = new EyeControlFilter(); filter.update(control({blink:1}),0); filter.reset();
    expect(filter.update(null,100).left.blink).toBe(0);
  });
});
