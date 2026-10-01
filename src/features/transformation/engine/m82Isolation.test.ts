import { describe, expect, it } from 'vitest';
import { Euler, Vector3 } from 'three';
import { canonicalFaceLandmarks, localBrowHeights } from './faceLocalGeometry';
import { eyeOpenness, mouthOpenness, mouthCornerLift } from './faceGeometry';
import { computeExpressionMotion, EXPRESSION_KEYS, NEUTRAL_EXPRESSION } from './expressionMotion';
import { buildSourceFaceMesh } from './rendering/sourceMesh';
import { ExpressionDeformer } from './rendering/expressionDeformer';
import type { FaceTrackingResult, Point3 } from './faceTypes';
import type { TransformationCalibrationProfile } from './calibrationTypes';

function fixture() {
 const p=Array.from({length:478},()=>({x:.5,y:.5,z:0}));
 const set=(i:number,x:number,y:number,z=0)=>{p[i]={x,y,z};};
 set(1,.5,.5,-.09);set(234,.28,.5,0);set(454,.72,.5,0);
 set(33,.35,.4);set(133,.45,.4);set(159,.4,.38);set(145,.4,.42);
 set(263,.65,.4);set(362,.55,.4);set(386,.6,.39);set(374,.6,.41);
 set(61,.4,.65);set(291,.6,.65);set(13,.5,.64);set(14,.5,.66);set(152,.5,.82);
 set(107,.45,.32);set(336,.55,.32);set(70,.38,.3);set(300,.62,.3);
 return p;
}
const rad=(n:number)=>n*Math.PI/180;
/**
 * Landmarks of the fixture face as MediaPipe would report it at (yaw, pitch,
 * roll). The face rotates by Three Euler(+pitch, yaw, roll): measured, a face
 * rendered at rotation.x = +p is read back by MediaPipe as pitch +p
 * (transformation-m83-roundtrip). This used -pitch — the code's own belief,
 * so the tests agreed with the bug.
 */
function transform(points:Point3[],yaw:number,pitch:number,roll:number,scale=1,aspect=1,tx=.5,ty=.5) {
 return points.map(p=>{
  const v=new Vector3(p.x-.5,-(p.y-.5),-(p.z+.09));
  v.applyEuler(new Euler(pitch,yaw,roll,'XYZ')).multiplyScalar(scale);
  return {x:tx+v.x,y:ty-v.y*aspect,z:-v.z};
 });
}
const cases=[['pitch +15',0,15,0],['pitch -15',0,-15,0],['yaw +15',15,0,0],['yaw -15',-15,0,0],['roll +15',0,0,15],['roll -15',0,0,-15],['combined',12,-10,15]] as const;
describe('M8.2 face-local isolation',()=>{
 for(const [label,y,p,r] of cases) it(`neutral expression remains neutral under ${label}, translation, scale and portrait aspect`,()=>{
  const points=fixture(); const local=canonicalFaceLandmarks(points,{yaw:0,pitch:0,roll:0});
  const baseline={face:{neutralBrowHeights:localBrowHeights(local)!,neutralEyeOpenness:.7,neutralEyeOpennessLeft:eyeOpenness(local,'left'),neutralEyeOpennessRight:eyeOpenness(local,'right'),neutralMouthOpenness:mouthOpenness(local),neutralSmileLeft:mouthCornerLift(local,'left'),neutralSmileRight:mouthCornerLift(local,'right'),expressionNeutral:{...NEUTRAL_EXPRESSION}},trackingSpace:{width:390,height:844}} as TransformationCalibrationProfile;
  const yaw=rad(y),pitch=rad(p),roll=rad(r);
  const landmarks=transform(points,yaw,pitch,roll,1.3,390/844,.62,.41);
  const result=computeExpressionMotion({detected:true,derived:{yaw,pitch,roll},landmarks,blendshapes:{}} as unknown as FaceTrackingResult,baseline)!;
  for(const key of EXPRESSION_KEYS) expect(result[key],key).toBeCloseTo(0,6);
  const mesh=buildSourceFaceMesh(landmarks,{yaw,pitch,roll},390/844);
  const neutral=buildSourceFaceMesh(points);
  for(let i=0;i<mesh.positions.length;i++) expect(mesh.positions[i]!).toBeCloseTo(neutral.positions[i]!,6);
 });
 it('keeps the source nose in front of cheeks without attenuating measured depth',()=>{
  const m=buildSourceFaceMesh(fixture());
  expect(m.positions[1*3+2]! - m.positions[234*3+2]!).toBeCloseTo(.09);
  // 468 landmarks plus the two 21-vertex mouth fans; every vertex is used.
  expect(new Set(m.indices).size).toBe(468 + 42);
 });
 it('closes left/right independently without lid crossing or brow movement',()=>{
  const p=fixture(),mesh=buildSourceFaceMesh(p),d=new ExpressionDeformer(mesh,p);
  for(const [key,upper,lower,other,brow] of [['blinkLeft',159,145,386,70],['blinkRight',386,374,159,300]] as const){
   let previous=Infinity;
   for(const amount of [0,.25,.5,1]){
    const out=d.update({...NEUTRAL_EXPRESSION,[key]:amount});
    const gap=out[upper*3+1]!-out[lower*3+1]!;
    expect(gap).toBeGreaterThanOrEqual(0);expect(gap).toBeLessThanOrEqual(previous);previous=gap;
    expect(out[other*3+1]).toBe(mesh.positions[other*3+1]);expect(out[brow*3+1]).toBe(mesh.positions[brow*3+1]);
   }
   expect(previous).toBeLessThan(.001);
  }
 });
 it('mouth opening is monotonic from closed through quarter, half and wide; chin follows',()=>{
  const p=fixture(),mesh=buildSourceFaceMesh(p),d=new ExpressionDeformer(mesh,p);
  let previous=-Infinity;
  for(const amount of [0,.25,.5,1]){
   const out=d.update({...NEUTRAL_EXPRESSION,jawOpen:amount});
   const gap=out[13*3+1]!-out[14*3+1]!;
   expect(gap).toBeGreaterThan(previous);previous=gap;
   if(amount)expect(out[152*3+1]).toBeLessThan(mesh.positions[152*3+1]!);
  }
 });
});


describe('M8.2 brows: head pitch and brow raise are independent (Part AI)',()=>{
 const aspect=390/844;
 const calibrate=()=>{
  const local=canonicalFaceLandmarks(fixture(),{yaw:0,pitch:0,roll:0});
  return {face:{neutralBrowHeights:localBrowHeights(local)!,neutralEyeOpenness:.7,neutralEyeOpennessLeft:eyeOpenness(local,'left'),neutralEyeOpennessRight:eyeOpenness(local,'right'),neutralMouthOpenness:mouthOpenness(local),neutralSmileLeft:mouthCornerLift(local,'left'),neutralSmileRight:mouthCornerLift(local,'right'),expressionNeutral:{...NEUTRAL_EXPRESSION}},trackingSpace:{width:390,height:844}} as TransformationCalibrationProfile;
 };
 // Brow points 0.03 image units higher: ~7% of face width, most of a full raise.
 const raised=()=>{const p=fixture();for(const i of [107,336,70,300])p[i]={...p[i]!,y:p[i]!.y-.03};return p;};
 const measure=(points:Point3[],pitchDeg:number,calibration:TransformationCalibrationProfile,blendshapes:Record<string,number>={})=>{
  const pitch=rad(pitchDeg);
  return computeExpressionMotion({detected:true,derived:{yaw:0,pitch,roll:0},landmarks:transform(points,0,pitch,0,1,aspect),blendshapes} as unknown as FaceTrackingResult,calibration)!;
 };
 it('A: a nod with neutral brows leaves every brow neutral',()=>{
  const c=calibrate();
  for(const pitch of [-15,15]){const r=measure(fixture(),pitch,c);
   expect(r.browInnerUp).toBeCloseTo(0,6);expect(r.browOuterUpLeft).toBeCloseTo(0,6);expect(r.browOuterUpRight).toBeCloseTo(0,6);}
 });
 it('B: raising the brows with the head still reads strongly',()=>{
  const r=measure(raised(),0,calibrate());
  expect(r.browInnerUp).toBeGreaterThan(.6);expect(r.browOuterUpLeft).toBeGreaterThan(.6);expect(r.browOuterUpRight).toBeGreaterThan(.6);
 });
 it('C: the same raise reads the same while pitched up or down',()=>{
  const c=calibrate(),still=measure(raised(),0,c);
  for(const pitch of [-15,15]){const r=measure(raised(),pitch,c);
   for(const key of ['browInnerUp','browOuterUpLeft','browOuterUpRight'] as const) expect(r[key],`${key} at ${pitch}`).toBeCloseTo(still[key],4);}
 });
 it('flags, without correcting, a blendshape brow that rides a nod with no local brow change',()=>{
  const c=calibrate();
  measure(fixture(),0,c,{browInnerUp:0});
  const leak=measure(fixture(),15,c,{browInnerUp:.6});
  expect(leak.leakage).toBe(true);
  // Observational only: the fused value still carries the blendshape.
  expect(leak.browInnerUp).toBeGreaterThan(.3);
  const c2=calibrate();
  measure(fixture(),0,c2,{browInnerUp:0});
  expect(measure(raised(),15,c2,{browInnerUp:.6}).leakage).toBe(false);
 });
});
