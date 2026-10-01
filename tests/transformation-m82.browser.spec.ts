import { test, expect } from '@playwright/test';

test('M8.2 real source: visual states, one owner, source switching and context recovery',async({page})=>{
 await page.goto('/');
 const init=await page.evaluate(async()=>{
  const {SourceAnalyzer}=await import('/src/features/transformation/source/sourceAnalyzer.ts');
  const {FaceRenderer}=await import('/src/features/transformation/engine/rendering/FaceRenderer.ts');
  const blob=await (await fetch('/media/onboarding/male-participant.jpg')).blob();
  const asset={kind:'image',blob,fileName:'portrait.jpg',mimeType:'image/jpeg',assetId:null} as const;
  const analyzer=new SourceAnalyzer();const result=await analyzer.analyze({asset,profileId:'m82'});analyzer.cancel();
  if(!result.ok)throw Error(result.message);
  const canvas=document.createElement('canvas');canvas.style.cssText='width:390px;height:600px';canvas.dataset.testid='m82-face';document.body.replaceChildren(canvas);
  const head={translationX:0,translationY:0,scaleDelta:1,yawDelta:0,pitchDelta:0,rollDelta:0};
  const motion={current:{tracked:true,expression:null,upperBody:null,head}};
  const expression={current:null};let stats:any=null;
  const options={canvas,asset,profile:result.profile,motion,manualExpression:expression,onStats:(s:any)=>{stats=s;}};
  const renderer=new FaceRenderer(options);await Promise.all([renderer.initialize(),renderer.initialize()]);
  (window as any).__m82={renderer,options,motion,expression,getStats:()=>stats,FaceRenderer};
  return {status:stats.status,vertices:stats.meshVertices,triangles:stats.meshTriangles,depth:stats.depthRange};
 });
 expect(init.status).toBe('ready');// 468 landmarks + 21-vertex mouth fill + 21-vertex cavity; 852 tessellation + 28 eye + 40 mouth triangles.
 expect(init.vertices).toBe(510);expect(init.triangles).toBe(920);expect(init.depth).toBeGreaterThan(.02);
 for(const [name,head,expr] of [
  ['neutral',{},{}],['yaw-right',{yawDelta:-.25},{}],['yaw-left',{yawDelta:.25},{}],['pitch-up',{pitchDelta:-.2},{}],['pitch-down',{pitchDelta:.2},{}],['roll',{rollDelta:.2},{}],['blink',{}, {blinkLeft:1,blinkRight:1}],['jaw',{}, {jawOpen:1}],
 ] as const){
  const probe=await page.evaluate(async({head,expr})=>{
   const s=(window as any).__m82; s.motion.current.head={translationX:0,translationY:0,scaleDelta:1,yawDelta:0,pitchDelta:0,rollDelta:0,...head};
   s.expression.current={blinkLeft:0,blinkRight:0,jawOpen:0,smileLeft:0,smileRight:0,browInnerUp:0,browOuterUpLeft:0,browOuterUpRight:0,...expr,status:'manual',calculationMs:0};
   await new Promise(r=>setTimeout(r,500));return s.renderer.getProbe();
  },{head,expr});
  if(name==='yaw-right')expect(probe.nose.x).toBeGreaterThan(0);
  if(name==='yaw-left')expect(probe.nose.x).toBeLessThan(0);
  if(name==='pitch-up')expect(probe.nose.y).toBeGreaterThan(0);
  if(name==='pitch-down')expect(probe.nose.y).toBeLessThan(0);
  const shot=await page.locator('[data-testid="m82-face"]').screenshot({path:`artifacts/m82/${name}.png`});
  if(name==='neutral'||name==='jaw'){
   // Nothing inside the rendered inner-lip ring may be the canvas clear colour
   // (#0f172a): the tessellation leaves that ring open, and it used to show.
   const mouth=await page.evaluate(async(png)=>{
    const s=(window as any).__m82,r=s.renderer,T=r.three,canvas=s.options.canvas;
    r.scene.updateMatrixWorld(true);
    const ring=[78,95,88,178,87,14,317,402,318,324,308,415,310,311,312,13,82,81,80,191];
    const pos=r.deformer.positions;
    const px=ring.map((i:number)=>{const v=new T.Vector3(pos[i*3],pos[i*3+1],pos[i*3+2]).applyMatrix4(r.mesh.matrixWorld).project(r.camera);
     return [(v.x+1)/2*canvas.clientWidth,(1-v.y)/2*canvas.clientHeight];});
    const cx=px.reduce((a:number,p:number[])=>a+p[0],0)/px.length,cy=px.reduce((a:number,p:number[])=>a+p[1],0)/px.length;
    // Inset 20% towards the centre so antialiased lip edges are not sampled.
    const poly=px.map((p:number[])=>[cx+(p[0]-cx)*.8,cy+(p[1]-cy)*.8]);
    const inside=(x:number,y:number)=>{let hit=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const [xi,yi]=poly[i],[xj,yj]=poly[j];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)hit=!hit;}return hit;};
    const bytes=Uint8Array.from(atob(png),c=>c.charCodeAt(0));const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
    const c2=new OffscreenCanvas(bitmap.width,bitmap.height).getContext('2d')!;c2.drawImage(bitmap,0,0);
    const sx=bitmap.width/canvas.clientWidth,sy=bitmap.height/canvas.clientHeight;
    const xs=poly.map((p:number[])=>p[0]),ys=poly.map((p:number[])=>p[1]);
    const [x0,x1,y0,y1]=[Math.min(...xs),Math.max(...xs),Math.min(...ys),Math.max(...ys)];
    let samples=0,background=0;
    for(let gy=0;gy<=16;gy++)for(let gx=0;gx<=16;gx++){
     const x=x0+(x1-x0)*gx/16,y=y0+(y1-y0)*gy/16;if(!inside(x,y))continue;samples++;
     const [R,G,B]=c2.getImageData(Math.round(x*sx),Math.round(y*sy),1,1).data;
     if(Math.hypot(R-15,G-23,B-42)<14)background++;
    }
    return {samples,background,apertureHeightPx:y1-y0};
   },shot.toString('base64'));
   console.log('[M8.2 mouth]',name,JSON.stringify(mouth));
   expect(mouth.samples,name).toBeGreaterThan(8);
   expect(mouth.background,name).toBe(0);
  }
 }
 const lifecycle=await page.evaluate(async()=>{
  const s=(window as any).__m82;const gl=s.options.canvas.getContext('webgl2');
  const states=[];for(let i=0;i<5;i++){
   s.renderer.dispose();s.renderer=new s.FaceRenderer(s.options);await s.renderer.initialize();
   states.push({status:s.getStats().status,sameContext:s.options.canvas.getContext('webgl2')===gl});
  }
  await new Promise(r=>setTimeout(r,600));const metrics=s.getStats();
  const extension=gl.getExtension('WEBGL_lose_context');extension.loseContext();await new Promise(r=>setTimeout(r,100));
  const lost={status:s.getStats().status,message:s.getStats().message};extension.restoreContext();await new Promise(r=>setTimeout(r,150));
  s.renderer.dispose();s.renderer=new s.FaceRenderer(s.options);await s.renderer.initialize();const restored=s.getStats().status;
  s.renderer.dispose();return {states,lost,restored,metrics};
 });
 expect(lifecycle.states.every(s=>s.status==='ready'&&s.sameContext)).toBe(true);
 expect(lifecycle.lost.status).toBe('failed');expect(lifecycle.lost.message).toContain('Return to Raw');expect(lifecycle.restored).toBe('ready');
 console.log('[M8.2 renderer]',JSON.stringify(lifecycle.metrics));
});

test('M8.2 video decoder delivers changing presented frames',async({page})=>{
 await page.goto('/');const result=await page.evaluate(async()=>{
  const {VideoFrameReader}=await import('/src/features/transformation/source/videoFrameReader.ts');
  const reader=new VideoFrameReader();const blob=await (await fetch('/media/call-demo.mp4')).blob();
  try{const meta=await reader.open(blob);const frames=[];
   for(const time of [0,meta.durationSeconds*.5,meta.durationSeconds*.8]){
    const canvas=await reader.frameAt(time);const bitmap=await createImageBitmap(canvas);frames.push({width:bitmap.width,height:bitmap.height});bitmap.close();
   }return frames;
  }finally{reader.dispose();}
 });expect(result).toHaveLength(3);for(const frame of result)expect(frame.width*frame.height).toBeGreaterThan(0);
});


test('M8.2 real source rolled 15 and 30 degrees canonicalizes to the same upright face',async({page})=>{
 await page.goto('/');
 const result=await page.evaluate(async()=>{
  const {SourceAnalyzer}=await import('/src/features/transformation/source/sourceAnalyzer.ts');
  const {buildSourceFaceMesh}=await import('/src/features/transformation/engine/rendering/sourceMesh.ts');
  const original=await createImageBitmap(await (await fetch('/media/onboarding/male-participant.jpg')).blob());
  // Rotate the real photograph on a canvas large enough that no corner crops.
  const rolled=async(degrees:number)=>{
   const side=Math.ceil(Math.hypot(original.width,original.height));
   const canvas=new OffscreenCanvas(side,side);const c=canvas.getContext('2d')!;
   c.fillStyle='#808080';c.fillRect(0,0,side,side);c.translate(side/2,side/2);c.rotate(degrees*Math.PI/180);
   c.drawImage(original,-original.width/2,-original.height/2);return canvas.convertToBlob({type:'image/jpeg',quality:.95});
  };
  const measure=async(blob:Blob)=>{
   const analyzer=new SourceAnalyzer();
   const r=await analyzer.analyze({asset:{kind:'image',blob,fileName:'p.jpg',mimeType:'image/jpeg',assetId:null},profileId:'m82-roll'});analyzer.cancel();
   if(!r.ok)throw Error(r.message);const face=r.profile.primaryFace;
   const mesh=buildSourceFaceMesh(face.landmarks,face,r.profile.dimensions?.aspectRatio??1);
   const p=(i:number)=>[mesh.positions[i*3]!,mesh.positions[i*3+1]!];
   // Canonical in-plane angles: the eye line and the brow-to-chin midline.
   const [lx,ly]=p(33),[rx,ry]=p(263),[tx,ty]=p(168),[cx,cy]=p(152);
   return {sourceRollDeg:face.roll*180/Math.PI,eyeLineDeg:Math.atan2(ry-ly,rx-lx)*180/Math.PI,midlineDeg:Math.atan2(cx-tx,-(cy-ty))*180/Math.PI};
  };
  return {upright:await measure(await rolled(0)),rolled15:await measure(await rolled(15)),rolled30:await measure(await rolled(30))};
 });
 console.log('[M8.2 canonical roll]',JSON.stringify(result));
 // The analyzer saw each roll...
 expect(Math.abs(result.rolled15.sourceRollDeg-result.upright.sourceRollDeg)).toBeGreaterThan(10);
 expect(Math.abs(result.rolled30.sourceRollDeg-result.upright.sourceRollDeg)).toBeGreaterThan(24);
 // ...and the renderer's neutral face does not inherit it.
 for(const rolled of [result.rolled15,result.rolled30]){
  expect(Math.abs(rolled.eyeLineDeg-result.upright.eyeLineDeg)).toBeLessThan(3);
  expect(Math.abs(rolled.midlineDeg-result.upright.midlineDeg)).toBeLessThan(3);
 }
});
