import {describe,it,expect} from 'vitest';
import {mouthNoseFixture} from '../fixtures/mouthNoseRegression';
import {measureMouthControls,measureMouthGeometry,smoothMouth} from '../mouthControls';
import {buildSourceFaceMesh} from './sourceMesh';
import {ExpressionDeformer,EYELIDS} from './expressionDeformer';
import {NEUTRAL_EXPRESSION} from '../expressionMotion';
import {mouthMaskMetrics,mouthTextureTarget,oralInsetScale,oralFrameFresh,oralFeedAllowed,oralContentFit} from './liveMouthCompositor';
import {admitTongueMask,type TongueSegmentation} from './tongueSegmenter';
import {noseCavityData,nostrilVisibility} from './noseCavities';

const fixture=()=>{
  const p=mouthNoseFixture(),g=measureMouthGeometry(p)!,mesh=buildSourceFaceMesh(p,{yaw:0,pitch:0,roll:0}),d=new ExpressionDeformer(mesh,p);
  const controls=(shapes:Record<string,number>={},jaw=0,points=p)=>measureMouthControls(points,shapes,{geometry:g,shapes:{}},jaw,1,100)!;
  return {p,g,mesh,d,controls};
};
const ring=Array.from({length:20},(_,i)=>({x:.5-.1*Math.cos(i*Math.PI/10),y:.5+.03*Math.sin(i*Math.PI/10)}));
describe('M8.8 locked oral corrections',()=>{
  it('kiss moves both corners inward by a visible measured amount, rounds source lips, keeps jaw closed',()=>{
    const {d,controls}=fixture();const m=controls({mouthPucker:1}),p=d.update({...NEUTRAL_EXPRESSION,mouth:m});
    expect(p[291*3]!-p[61*3]!).toBeLessThan((d.basePositions[291*3]!-d.basePositions[61*3]!)*.7);
    expect(p[0*3+2]!-d.basePositions[0*3+2]!).toBeGreaterThan(.008);
    expect(m.jaw.open).toBe(0);expect(m.corners.smileLeft).toBe(0);expect(m.lips.stretchLeft).toBe(0);
  });
  it('O, EE and press remain distinct from jaw opening',()=>{
    const {d,controls}=fixture(),width=(p:Float32Array)=>p[291*3]!-p[61*3]!,gap=(p:Float32Array)=>p[13*3+1]!-p[14*3+1]!;
    const o=d.update({...NEUTRAL_EXPRESSION,mouth:controls({mouthFunnel:1})}).slice();
    const ee=d.update({...NEUTRAL_EXPRESSION,mouth:controls({mouthStretchLeft:1,mouthStretchRight:1})}).slice();
    const press=d.update({...NEUTRAL_EXPRESSION,mouth:controls({mouthPressLeft:1,mouthPressRight:1})}).slice();
    expect(width(o)).toBeLessThan(width(d.basePositions)*.7);expect(gap(o)).toBeGreaterThan(gap(d.basePositions)+.01);
    expect(width(ee)).toBeGreaterThan(width(d.basePositions)*1.2);expect(Math.abs(gap(press))).toBeLessThan(.001);
  });
  it('independent measured upper/lower lip motion supports missing model names',()=>{
    const {p,controls}=fixture(),raised=p.map(v=>({...v}));for(const i of [312,311,310])raised[i]!.y-=.025;
    const up=controls({},0,raised);expect(up.lips.upperRaiseLeft).toBeGreaterThan(.5);expect(up.lips.upperRaiseRight).toBe(0);
    const lowered=p.map(v=>({...v}));for(const i of [87,178,88])lowered[i]!.y+=.025;
    const lo=controls({},0,lowered);expect(lo.lips.lowerDownRight).toBeGreaterThan(.5);expect(lo.lips.lowerDownLeft).toBe(0);
    expect(up.missing).toContain('mouthUpperUpLeft');expect(lo.jaw.open).toBe(0);
  });
  it('jaw opening stays progressive and isolated from nose and locked eyes',()=>{
    const {d,controls}=fixture();let gap=-Infinity;
    for(const jaw of [0,.25,.5,.75,1]){
      const p=d.update({...NEUTRAL_EXPRESSION,mouth:controls({},jaw)});
      expect(p[13*3+1]!-p[14*3+1]!).toBeGreaterThan(gap+.005);gap=p[13*3+1]!-p[14*3+1]!;
      for(const i of [1,2,6,168,...EYELIDS.left.upper,...EYELIDS.right.lower])expect(p.slice(i*3,i*3+3)).toEqual(d.basePositions.slice(i*3,i*3+3));
    }
  });
  it('speech filter responds fast and confidence loss expires',()=>{
    const {controls}=fixture(),neutral=controls(),target=controls({mouthPucker:1});
    expect(smoothMouth(neutral,target,33)!.lips.pucker).toBeGreaterThan(.85);
    let lost=target;for(let i=0;i<20;i++)lost=smoothMouth(lost,undefined,33)!;
    expect(lost.lips.pucker).toBeLessThan(.03);
  });
  it.each([2,4,12,30])('safety inset preserves narrow aperture radius %s pixels',r=>{
    expect(oralInsetScale(r)).toBeGreaterThanOrEqual(.75);expect((1-oralInsetScale(r))*r).toBeLessThanOrEqual(.650001);expect((1-oralInsetScale(r))*r).toBeGreaterThanOrEqual(.499999);
  });
  it('mouth polygon rejects collapse, nonfinite and off-camera crops',()=>{
    expect(mouthMaskMetrics(ring,640,480)?.valid).toBe(true);
    expect(mouthMaskMetrics(ring.map(p=>({...p,y:.5})),640,480)?.valid).toBe(false);
    expect(mouthMaskMetrics([{x:NaN,y:0},...ring.slice(1)],640,480)).toBeNull();
    expect(mouthMaskMetrics(ring.map(p=>({...p,x:p.x+1})),640,480)?.valid).toBe(false);
  });
  it('iris-independent mouth atlas preserves tooth aspect through roll and scale',()=>{
    const target=mouthTextureTarget(ring,640,480,256,192);
    const angle=.4,transformed=ring.map(p=>{const x=(p.x-.5)*640,y=(p.y-.5)*480;return{x:.5+(x*Math.cos(angle)-y*Math.sin(angle))*1.3/640,y:.5+(x*Math.sin(angle)+y*Math.cos(angle))*1.3/480};});
    const rolled=mouthTextureTarget(transformed,640,480,256,192);
    for(let i=0;i<target.length;i++){expect(rolled[i]!.x).toBeCloseTo(target[i]!.x,8);expect(rolled[i]!.y).toBeCloseTo(target[i]!.y,8);}
    const sx=(target[10]!.x-target[0]!.x)*256/128;
    const sy=(target[5]!.y-target[15]!.y)*192/(.06*480);
    expect(sx).toBeCloseTo(sy,8);
  });
  it.each([0,100,399])('fresh mouth frame age %s is accepted',age=>expect(oralFrameFresh(1000,1000+age)).toBe(true));
  it.each([400,800])('stale mouth age %s is rejected',age=>expect(oralFrameFresh(1000,1000+age)).toBe(false));
  it('unknown/future timestamps cannot queue an oral frame',()=>{expect(oralFrameFresh(undefined,1000)).toBe(false);expect(oralFrameFresh(NaN,1000)).toBe(false);expect(oralFrameFresh(1200,1000)).toBe(false);});
  it('SOURCE/LIVE/AUTO preserve source-visible teeth and reveal closed-source interior',()=>{
    expect(oralFeedAllowed('source',0,.1,.2)).toBe(false);expect(oralFeedAllowed('live',.1,.1,.2)).toBe(true);
    expect(oralFeedAllowed('auto',.05,.05,.2)).toBe(false);expect(oralFeedAllowed('auto',.05,.1,.2)).toBe(true);expect(oralFeedAllowed('auto',0,.05,.2)).toBe(true);
  });
  it('future confident tongue mask is bounded; uncertain/stale/rectangle masks are rejected',()=>{
    const alpha=new Uint8Array(10000);for(let y=51;y<59;y++)for(let x=48;x<53;x++)alpha[y*100+x]=255;
    const good:TongueSegmentation={alpha,width:100,height:100,confidence:.95,timestampMs:1000};
    expect(admitTongueMask(good,ring,1050)).toBe(true);expect(admitTongueMask({...good,confidence:.5},ring,1050)).toBe(false);expect(admitTongueMask(good,ring,1250)).toBe(false);
    expect(admitTongueMask({...good,alpha:new Uint8Array(10000).fill(255)},ring,1050)).toBe(false);expect(admitTongueMask(null,ring,1050)).toBe(false);
  });
  it('uniform interior fit includes tongue in a shorter source aperture without vertically stretching teeth',()=>{
    const live=mouthTextureTarget(ring,640,480,256,192),short=mouthTextureTarget(ring.map(p=>({...p,y:.5+(p.y-.5)*.5})),640,480,256,192);
    const fit=oralContentFit(live,short);expect(fit).toBeCloseTo(.5);
    expect((short[5]!.y-.15)/fit+.15).toBeCloseTo(live[5]!.y);
    expect(oralContentFit(short,live)).toBe(1);
  });
  it('nose recess uses source depth and pitch exposes/conceals underside without deforming bridge',()=>{
    const {mesh}=fixture(),before=mesh.positions.slice(),nose=noseCavityData(mesh.positions)!;
    expect(nose.depth).toBeGreaterThan(.01);expect(nose.positions.length).toBe(2*17*3);expect(mesh.positions).toEqual(before);
    expect(nostrilVisibility(.25)).toBeGreaterThan(nostrilVisibility(0));expect(nostrilVisibility(-.25)).toBe(0);
    expect(nostrilVisibility(NaN)).toBe(0);expect(nostrilVisibility(2)).toBeLessThanOrEqual(.55);
    // The normal rotates toward the viewer when physical pitch is upward.
    const exposed=nose.normal.z*Math.cos(.25)-nose.normal.y*Math.sin(.25);
    const hidden=nose.normal.z*Math.cos(.25)+nose.normal.y*Math.sin(.25);
    expect(exposed).toBeGreaterThan(hidden);
  });
});
