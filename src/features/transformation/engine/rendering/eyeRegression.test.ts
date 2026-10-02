import { describe, expect, it } from 'vitest';
import { eyeRegressionFixture } from '../fixtures/eyeRegression';
import { EYE_ANCHORS, eyeStateFromGeometry, measureEyeGeometry, type EyeControlFrame } from '../eyeControls';
import { NEUTRAL_EXPRESSION } from '../expressionMotion';
import { buildSourceFaceMesh } from './sourceMesh';
import { ExpressionDeformer, EYELIDS } from './expressionDeformer';
import { EyeGazeWarper } from './eyeGazeWarper';

const eyes = (left = {}, right = {}): EyeControlFrame => {
  const p = eyeRegressionFixture();
  const l = measureEyeGeometry(p,'left')!, r = measureEyeGeometry(p,'right')!;
  return { left: { ...eyeStateFromGeometry(l,l,0,1,null), ...left }, right: { ...eyeStateFromGeometry(r,r,0,1,null), ...right } };
};
const y = (p: Float32Array,i: number) => p[i*3+1]!;
describe('M8.6 LOCKED source eye deformation', () => {
  it.each(['left','right'] as const)('measured %s closure moves both lids to one line without touching the other eye', side => {
    const p = eyeRegressionFixture(), mesh = buildSourceFaceMesh(p), d = new ExpressionDeformer(mesh,p);
    const e = eyes(); e[side] = { ...e[side], blink:1, upperLid:.7, lowerLid:.3 };
    const out = d.update({...NEUTRAL_EXPRESSION, blinkLeft:side==='right'?1:0,blinkRight:side==='left'?1:0,eyes:e});
    const a=EYE_ANCHORS[side], u=a.upper[1], l=a.lower[1];
    expect(y(out,u)).toBeLessThan(y(mesh.positions,u)); expect(y(out,l)).toBeGreaterThan(y(mesh.positions,l));
    expect(Math.abs(y(out,u)-y(out,l))).toBeLessThan(1e-6);
    const other=EYE_ANCHORS[side==='left'?'right':'left'];
    for(const index of [...other.upper,...other.lower]) expect(y(out,index)).toBe(y(mesh.positions,index));
  });
  it('different measured lower-lid travel changes the meeting line rather than using one universal ratio', () => {
    const p=eyeRegressionFixture(),mesh=buildSourceFaceMesh(p),d=new ExpressionDeformer(mesh,p);
    const a=eyes({upperLid:.9,lowerLid:.1}), b=eyes({upperLid:.65,lowerLid:.35});
    const first=y(d.update({...NEUTRAL_EXPRESSION,blinkRight:1,eyes:a}),386);
    const second=y(d.update({...NEUTRAL_EXPRESSION,blinkRight:1,eyes:b}),386);
    expect(second).toBeGreaterThan(first);
  });
  it('wide eyes increase aperture independently while source corners, brows, nose and mouth stay fixed', () => {
    const p=eyeRegressionFixture(),mesh=buildSourceFaceMesh(p),d=new ExpressionDeformer(mesh,p);
    const out=d.update({...NEUTRAL_EXPRESSION,eyes:eyes({wideOpen:1})});
    expect(y(out,386)-y(out,374)).toBeGreaterThan((y(mesh.positions,386)-y(mesh.positions,374))*1.15);
    for(const index of [1,33,133,263,362,159,145,70,107,300,336,13,14,61,291,152]) expect(y(out,index),String(index)).toBe(y(mesh.positions,index));
  });
  it('closure never crosses and widens back monotonically at every continuous aperture', () => {
    const p=eyeRegressionFixture(),mesh=buildSourceFaceMesh(p),d=new ExpressionDeformer(mesh,p);
    let gap=Infinity;
    for(const blink of [0,.25,.5,.75,1]) {
      const out=d.update({...NEUTRAL_EXPRESSION,blinkRight:blink,eyes:eyes({upperLid:.7*blink,lowerLid:.3*blink})});
      const next=y(out,386)-y(out,374); expect(next).toBeGreaterThanOrEqual(-1e-6); expect(next).toBeLessThanOrEqual(gap); gap=next;
    }
    expect(gap).toBeLessThan(1e-6);
  });
  it('source lashes on the upper/lower boundaries follow those lids, not iris gaze', () => {
    const p=eyeRegressionFixture(),mesh=buildSourceFaceMesh(p),d=new ExpressionDeformer(mesh,p);
    const out=d.update({...NEUTRAL_EXPRESSION,blinkRight:1,eyes:eyes({upperLid:.7,lowerLid:.3})});
    expect(y(out,385)).not.toBe(y(mesh.positions,385)); expect(y(out,380)).not.toBe(y(mesh.positions,380));
    const warp=new EyeGazeWarper(mesh.uvs,p,mesh.eyeInterior);
    const uv=warp.update({left:{x:1,y:1},right:{x:1,y:1},clamped:false});
    for(const index of [...EYELIDS.left.upper,...EYELIDS.left.lower,...EYELIDS.right.upper,...EYELIDS.right.lower]) {
      expect(uv[index*2]).toBe(mesh.uvs[index*2]); expect(uv[index*2+1]).toBe(mesh.uvs[index*2+1]);
    }
  });
  it.each([[1,0],[-1,0],[0,1],[0,-1],[1,1]])('gaze %j actually changes interior texture coordinates but leaves face/mouth/glasses rim UVs byte-identical', (x,y) => {
    const p=eyeRegressionFixture(),mesh=buildSourceFaceMesh(p),warp=new EyeGazeWarper(mesh.uvs,p,mesh.eyeInterior);
    const uv=warp.update({left:{x,y},right:{x,y},clamped:false});
    expect(Array.from(uv.slice(0,mesh.eyeInterior!.start*2))).toEqual(Array.from(mesh.uvs.slice(0,mesh.eyeInterior!.start*2)));
    let changed=0;
    for(let i=mesh.eyeInterior!.start*2;i<uv.length;i++) if(Math.abs(uv[i]!-mesh.uvs[i]!)>1e-6) changed++;
    expect(changed).toBeGreaterThan(10);
    expect(Array.from(uv).every(Number.isFinite)).toBe(true);
  });
  it('full-eye gaze returns to exactly original texture coordinates', () => {
    const p=eyeRegressionFixture(),mesh=buildSourceFaceMesh(p),warp=new EyeGazeWarper(mesh.uvs,p,mesh.eyeInterior);
    warp.update({left:{x:1,y:1},right:{x:-1,y:-1},clamped:false});
    expect(Array.from(warp.update(null))).toEqual(Array.from(mesh.uvs));
  });
});
