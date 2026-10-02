import { expect, test, type Page } from '@playwright/test';
import { openStudioWithFaceCamera, startAndCalibrate } from './support/studioFlow';

// Controlled landmark input tests the real scheduler, calibration, expression
// pipeline and diagnostics. It does not claim MediaPipe model accuracy.
const visionMock = `
import { eyeRegressionFixture } from '/src/features/transformation/engine/fixtures/eyeRegression.ts';
import { Matrix4, Euler, Vector3 } from '/node_modules/three/build/three.module.js';
export async function loadMediaPipeVision() {
 return {
  FilesetResolver:{forVisionTasks:async()=>({})},
  FaceLandmarker:{createFromOptions:async()=>({detectForVideo(){
   const options=window.__eyeInput ?? {}; const yaw=options.yaw??0,pitch=options.pitch??0,roll=options.roll??0;
   const e=new Euler(pitch,yaw,roll,'XYZ');
   const video=document.querySelector('.studio-video');const aspect=video.videoWidth/video.videoHeight;
   const p=eyeRegressionFixture(options).map(point=>{const v=new Vector3(point.x-.5,-(point.y-.5),-(point.z+.05)).applyEuler(e).multiplyScalar(.65);return {x:.5+v.x,y:.45-v.y*aspect,z:-v.z};});
   return {faceLandmarks:options.lost?[]:[p],faceBlendshapes:[{categories:[{categoryName:'eyeBlinkLeft',score:0},{categoryName:'eyeBlinkRight',score:0}]}],facialTransformationMatrixes:[{data:new Matrix4().makeRotationFromEuler(e).elements}]};
  },close(){}})},
  PoseLandmarker:{createFromOptions:async()=>({detectForVideo(){const p=Array.from({length:33},()=>({x:.5,y:.7,z:0,visibility:1,presence:1}));p[11]={...p[11],x:.3,y:.72};p[12]={...p[12],x:.7,y:.72};p[23]={...p[23],x:.35,y:.9};p[24]={...p[24],x:.65,y:.9};return {landmarks:[p],worldLandmarks:[]};},close(){}})}
 };
}
export async function loadThreeRenderer(){return import('/node_modules/three/build/three.module.js');}
export async function loadOpenCv(){throw Error('unused');}
export async function loadComlink(){throw Error('unused');}
`;
async function studio(page: Page) {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:5201(?:\/|$))/,r=>r.abort());
  await page.addInitScript(()=>sessionStorage.setItem('callastar.development-admin','active'));
  await page.route('**/src/features/transformation/loaders.ts',r=>r.fulfill({contentType:'text/javascript',body:visionMock}));
  await page.goto('/admin/studio');
  await page.getByRole('button',{name:'Start camera',exact:true}).click();
  await expect(page.getByRole('button',{name:'Pause tracking',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Start calibration',exact:true}).click();
  await expect(page.locator('.studio-calibration-result')).toBeVisible({timeout:30000});
  await page.locator('.eye-diagnostics > details > summary').click();
  await expect(page.locator('[data-eye-metric="left-confidence"] dd')).toHaveText('1.000');
}
const input=(page:Page,value:unknown)=>page.evaluate(value=>{(window as any).__eyeInput=value;},value);
const value=async(page:Page,key:string)=>Number(await page.locator(`[data-eye-metric="${key}"] dd`).innerText());
const greater=(page:Page,key:string,floor:number)=>expect.poll(()=>value(page,key)).toBeGreaterThan(floor);
const less=(page:Page,key:string,ceiling:number)=>expect.poll(()=>value(page,key)).toBeLessThan(ceiling);

test('M8.6 both blink, left/right winks and slow partial closure remain independent',async({page})=>{
  await studio(page);
  for(const side of ['left','right'] as const){
    await input(page,{[side]:{ratio:.25}});await greater(page,`${side}-blink`,.98);
    await less(page,`${side==='left'?'right':'left'}-blink`,.02);
    await input(page,{});await less(page,`${side}-blink`,.02);
  }
  // Deliberately slow closure: a single abrupt half-close is a fast-blink
  // stimulus, and must not stand in for the continuous slow-aperture gate.
  for(const ratio of [.925,.85,.775,.7,.625]){
    await input(page,{left:{ratio},right:{ratio}});await page.waitForTimeout(250);
  }
  await greater(page,'left-blink',.4);await less(page,'left-blink',.6);
  await input(page,{left:{ratio:.25},right:{ratio:.25}});await greater(page,'left-blink',.98);await greater(page,'right-blink',.98);
});
test('M8.6 held closure and held wink stay shut for three seconds',async({page})=>{
  await studio(page);
  for(const options of [{left:{ratio:.25},right:{ratio:.25}},{left:{ratio:.25}}]){
    await input(page,options);await greater(page,'left-blink',.98);
    for(let i=0;i<6;i++){await page.waitForTimeout(500);expect(await value(page,'left-blink')).toBeGreaterThan(.98);}
    await input(page,{});await less(page,'left-blink',.02);
  }
});
test('M8.6 wide eyes have a distinct per-eye control and reopen from closure',async({page})=>{
  await studio(page);await input(page,{left:{ratio:1.4}});await greater(page,'left-wideOpen',.9);await less(page,'right-wideOpen',.02);
  await input(page,{left:{ratio:.25}});await greater(page,'left-blink',.98);await less(page,'left-wideOpen',.02);
  await input(page,{});await less(page,'left-blink',.02);await less(page,'left-wideOpen',.02);
});
test('M8.6 horizontal, vertical and diagonal gaze responds and stays bounded',async({page})=>{
  await studio(page);
  for(const [axis,amount] of [['irisX',.13],['irisX',-.13],['irisY',.126],['irisY',-.126]] as const){
    await input(page,{left:{[axis]:amount},right:{[axis]:amount}});
    const channel=axis==='irisX'?'gazeX':'gazeY';
    if(amount>0)await greater(page,`left-${channel}`,.8);else await less(page,`left-${channel}`,-.8);
    expect(Math.abs(await value(page,`left-${channel}`))).toBeLessThanOrEqual(1);
  }
  await input(page,{left:{irisX:.13,irisY:-.126}});await greater(page,'left-gazeX',.8);await less(page,'left-gazeY',-.8);
});
test('M8.6 head rotation preserves centered gaze, deliberate gaze, blink and wide eyes',async({page})=>{
  await studio(page);
  await input(page,{yaw:.3});await less(page,'left-blink',.03);await less(page,'left-wideOpen',.03);
  expect(Math.abs(await value(page,'left-gazeX'))).toBeLessThan(.03);
  await input(page,{yaw:.3,left:{irisX:.13}});await greater(page,'left-gazeX',.8);
  await input(page,{yaw:.3,left:{ratio:.25}});await greater(page,'left-blink',.98);await less(page,'right-blink',.03);
  await input(page,{yaw:.3,left:{ratio:1.4}});await greater(page,'left-wideOpen',.9);
});
test('M8.6 developer diagnostics and A–Q sequence fit every mobile width; camera flip resets eyes',async({page})=>{
  await studio(page);await page.getByText('Eye Test sequence A–Q',{exact:true}).click();
  await expect(page.getByText('TEST Q',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Start eye sequence'}).click();await page.getByRole('button',{name:'Next eye test'}).click();
  for(const width of [320,360,375,390,393,414,430]){
    await page.setViewportSize({width,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  }
  await input(page,{left:{ratio:.25}});await greater(page,'left-blink',.98);
  await input(page,{});await page.getByRole('button',{name:'Flip camera',exact:true}).click();
  await expect(page.locator('.studio-calibration-result')).toBeVisible({timeout:30000});await less(page,'left-blink',.02);
});

test('M8.6 actual source rendering: gaze pixels move, lids close/widen, identity and non-eye geometry stay intact',async({page})=>{
  await page.goto('/');await page.setViewportSize({width:900,height:1000});
  await page.evaluate(async()=>{
    const [{SourceAnalyzer},{FaceRenderer},{eyeRegressionFixture,eyeRegressionFrame},{CalibrationCollector},{computeExpressionMotion},{BlinkStateMachine},{EyeControlFilter},{GazeSmoother},{EYE_RENDER_CHANNELS}]=await Promise.all([
      import('/src/features/transformation/source/sourceAnalyzer.ts'),import('/src/features/transformation/engine/rendering/FaceRenderer.ts'),
      import('/src/features/transformation/engine/fixtures/eyeRegression.ts'),import('/src/features/transformation/engine/calibrationCollector.ts'),
      import('/src/features/transformation/engine/expressionMotion.ts'),import('/src/features/transformation/engine/blinkState.ts'),
      import('/src/features/transformation/engine/eyeControls.ts'),import('/src/features/transformation/engine/eyeGaze.ts'),import('/src/features/transformation/engine/eyeControls.ts')]);
    const blob=await(await fetch('/media/onboarding/male-participant.jpg')).blob();const asset={kind:'image',blob,fileName:'portrait.jpg',mimeType:'image/jpeg',assetId:null};
    const analyzer=new SourceAnalyzer();const result=await analyzer.analyze({asset,profileId:'m86-eye-source'});analyzer.cancel();if(!result.ok)throw Error(result.message);
    const canvas=document.createElement('canvas');canvas.style.cssText='width:720px;height:900px;display:block';canvas.dataset.testid='eye-render';document.body.replaceChildren(canvas);
    const collector=new CalibrationCollector();collector.start('face-only',{cameraFacing:'user',trackingWidth:640,trackingHeight:640,mirrored:false},0);
    for(let t=0;t<=4000&&collector.getState().phase!=='ready';t+=100)collector.accept(eyeRegressionFrame(undefined,t),null,t);
    const profile=collector.getState().profile;if(!profile)throw Error('fixture calibration failed');
    const expression={current:null},manualPose={current:{x:0,y:0,scale:1,yaw:0,pitch:0,roll:0}};
    const statistics={current:null};
    const renderer=new FaceRenderer({canvas,asset,profile:result.profile,mirror:'faithful',motion:{current:{tracked:true,expression:null,upperBody:null,head:{translationX:0,translationY:0,scaleDelta:1,yawDelta:0,pitchDelta:0,rollDelta:0}}},manualExpression:expression,manualPose,onStats:s=>{statistics.current=s;}});
    await renderer.initialize();
    (window as any).__eyeRender={renderer,expression,manualPose,profile,eyeRegressionFixture,eyeRegressionFrame,computeExpressionMotion,BlinkStateMachine,EyeControlFilter,GazeSmoother,EYE_RENDER_CHANNELS,canvas,statistics};
  });
  const show=async(options:unknown,pose={yaw:0,pitch:0,roll:0})=>{
    await page.evaluate(({options,pose})=>{
      const s=(window as any).__eyeRender;const machine=new s.BlinkStateMachine();machine.apply(s.computeExpressionMotion(s.eyeRegressionFrame(),s.profile),0);
      const motion=machine.apply(s.computeExpressionMotion(s.eyeRegressionFrame(s.eyeRegressionFixture(options)),s.profile),500);
      for(const side of ['left','right']){const channel=s.EYE_RENDER_CHANNELS[side];motion.eyes[side].blink=channel==='left'?motion.blinkLeft:motion.blinkRight;}
      s.expression.current=motion;s.manualPose.current={x:0,y:0,scale:1,...pose};
    },{options,pose});
    await page.waitForTimeout(300);
    return page.evaluate(()=>{const s=(window as any).__eyeRender;return {positions:Array.from(s.renderer.deformer.positions),uvs:Array.from(s.renderer.geometry.getAttribute('uv').array),base:Array.from(s.renderer.deformer.basePositions),probe:s.renderer.getProbe()};});
  };
  const neutral=await show({});await page.getByTestId('eye-render').screenshot({path:test.info().outputPath('eyes-neutral.png')});
  const left=await show({left:{ratio:.25}});expect(left.probe.expressionApplied!.blinkRight).toBeGreaterThan(.98);
  expect(left.positions[159*3+1]).toBe(neutral.positions[159*3+1]);expect(left.positions[386*3+1]).not.toBe(neutral.positions[386*3+1]);
  const closed=await show({left:{ratio:.25},right:{ratio:.25}});
  // These real landmark pairs have slightly different x coordinates on a
  // curved meeting line. Judge the residual in visible pixels, not equal y.
  const residualPx=await page.evaluate(()=>{const s=(window as any).__eyeRender,p=s.renderer.deformer.positions;return Math.abs(p[386*3+1]-p[374*3+1])*s.renderer.mesh.scale.y*s.canvas.clientHeight/2;});
  expect(residualPx).toBeLessThan(.25);
  await page.waitForTimeout(3000);expect((await page.evaluate(()=>(window as any).__eyeRender.renderer.getProbe())).expressionApplied.blinkRight).toBeGreaterThan(.98);
  await page.getByTestId('eye-render').screenshot({path:test.info().outputPath('eyes-held-closed.png')});
  const wide=await show({left:{ratio:1.4},right:{ratio:1.4}});
  expect(Number(wide.positions[386*3+1])-Number(wide.positions[374*3+1])).toBeGreaterThan(Number(neutral.positions[386*3+1])-Number(neutral.positions[374*3+1]));
  await page.getByTestId('eye-render').screenshot({path:test.info().outputPath('eyes-wide.png')});
  const gaze=await show({left:{irisX:.13},right:{irisX:-.13}});
  expect(gaze.uvs.slice(0,510*2)).toEqual(neutral.uvs.slice(0,510*2));expect(gaze.uvs.slice(510*2)).not.toEqual(neutral.uvs.slice(510*2));
  await page.getByTestId('eye-render').screenshot({path:test.info().outputPath('eyes-gaze.png')});
  const turned=await show({left:{irisX:.13},right:{irisX:-.13}},{yaw:.2,pitch:.15,roll:.1});
  expect(turned.uvs).toEqual(gaze.uvs);
  for(const index of [1,10,70,107,300,336,13,14,61,291,152,234,454]) expect(wide.positions.slice(index*3,index*3+3)).toEqual(neutral.positions.slice(index*3,index*3+3));
  console.log('[M8.6 desktop renderer]',JSON.stringify(await page.evaluate(()=>{const s=(window as any).__eyeRender;const gl=s.canvas.getContext('webgl2');const ext=gl.getExtension('WEBGL_debug_renderer_info');const stats=s.statistics.current;return {graphics:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),rendererFps:stats?.fps,renderMs:stats?.renderMs,deformationMs:stats?.deformationMs,droppedDisplayFrames:stats?.droppedFrames,syntheticController:true};})));
  await page.evaluate(()=>(window as any).__eyeRender.renderer.dispose());
});

test('M8.6 cancelling the bounded assistant disposes it and leaves the main camera live',async({page})=>{
  await page.route('**/src/features/transformation/tracking/jeeliz/jeelizLoader.ts',r=>r.fulfill({contentType:'text/javascript',body:`
export async function loadJeeliz(){ let timer,options;const report=window.__eyeAssistant={callbacks:0,destroyed:0};
return {init(o){options=o;queueMicrotask(()=>o.callbackReady(false,{videoElement:o.videoSettings.videoElement}));},
async toggle_pause(paused,shutoff){if(shutoff)throw Error('camera ownership');clearInterval(timer);if(!paused)timer=setInterval(()=>{report.callbacks++;options.callbackTrack({detected:.95,x:0,y:0,s:.3,rx:0,ry:0,rz:0,expressions:[0]});},10);},
resize(){return true;},async destroy(){clearInterval(timer);report.destroyed++;}};
}` }));
  await studio(page);
  await page.getByText('Bounded hybrid comparison',{exact:true}).click();await page.getByRole('button',{name:'Run one hybrid comparison'}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__eyeAssistant?.callbacks??0),{timeout:30000}).toBeGreaterThan(0);
  await page.getByRole('button',{name:'Cancel comparison'}).click();await expect(page.getByTestId('hybrid-progress')).toContainText('cancelled');
  expect(await page.evaluate(()=>(window as any).__eyeAssistant.destroyed)).toBe(1);
  const count=await page.evaluate(()=>(window as any).__eyeAssistant.callbacks);await page.waitForTimeout(600);
  expect(await page.evaluate(()=>(window as any).__eyeAssistant.callbacks)).toBe(count);
  expect(await page.evaluate(()=>((document.querySelector('.studio-video') as HTMLVideoElement).srcObject as MediaStream).getVideoTracks()[0].readyState)).toBe('live');
});

test('M8.6 bounded real hybrid comparison measures both installed trackers on the shared Studio camera',async({page})=>{
  await page.route(/^https?:\/\/(?!127\.0\.0\.1:5201(?:\/|$))/,r=>r.abort());
  await openStudioWithFaceCamera(page,1000,1000);await startAndCalibrate(page);
  await page.locator('.eye-diagnostics > details > summary').click();
  await page.getByText('Bounded hybrid comparison',{exact:true}).click();
  await page.getByRole('button',{name:'Run one hybrid comparison'}).click();
  await expect(page.getByTestId('hybrid-progress')).toContainText('Comparison complete',{timeout:120000});
  const report=await page.evaluate(()=>{
    const details=Array.from(document.querySelectorAll('.eye-diagnostics details')).filter(d=>d.querySelector(':scope > summary')?.textContent?.startsWith('MediaPipe'));
    return details.map(d=>({mode:d.querySelector('summary')?.textContent,...Object.fromEntries(Array.from(d.querySelectorAll('dl > div')).map(row=>[row.querySelector('dt')!.textContent,row.querySelector('dd')!.textContent]))}));
  });
  console.log('[M8.6 desktop hybrid]',JSON.stringify(report));
  expect(report).toHaveLength(2);expect(Number(report[0].samples)).toBeGreaterThan(0);expect(Number(report[1].assistantCallbacks)).toBeGreaterThan(0);
  expect(report[1].blinkResponseMs).toBe('unavailable');expect(report[1].gazeResponseMs).toBe('unavailable');
  expect(await page.evaluate(()=>(window as any).__faceCamera.calls)).toBe(1);
  expect(await page.evaluate(()=>((document.querySelector('.studio-video') as HTMLVideoElement).srcObject as MediaStream).getVideoTracks()[0].readyState)).toBe('live');
});
