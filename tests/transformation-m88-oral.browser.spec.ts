import { expect, test } from '@playwright/test';
import {openStudioWithFaceCamera,prepareSource,startAndCalibrate,openFaceRender,horizontalOverflow} from './support/studioFlow';

test('M8.8 actual GPU: closed source reveals live teeth/tongue, moves with head, closes and expires', async ({ page }) => {
  await page.goto('/');
  const report = await page.evaluate(async () => {
    const [{ SourceAnalyzer }, { FaceRenderer }, { measureMouthControls, measureMouthGeometry }, { NEUTRAL_EXPRESSION }, { INNER_LIP_RING }, { Vector3 }] = await Promise.all([
      import('/src/features/transformation/source/sourceAnalyzer.ts'),
      import('/src/features/transformation/engine/rendering/FaceRenderer.ts'),
      import('/src/features/transformation/engine/mouthControls.ts'),
      import('/src/features/transformation/engine/expressionMotion.ts'),
      import('/src/features/transformation/engine/rendering/sourceMesh.ts'),
      import('/node_modules/three/build/three.module.js'),
    ]);
    const analyzer = new SourceAnalyzer();
    const result = await analyzer.analyze({ asset: { kind:'image', blob:await (await fetch('/media/onboarding/male-participant.jpg')).blob(), fileName:'p.jpg', mimeType:'image/jpeg', assetId:null }, profileId:'oral-proof' });
    analyzer.cancel();
    if (!result.ok) throw Error(result.message);
    const points = result.profile.primaryFace.landmarks.map(p=>({...p}));
    const y = (points[13]!.y + points[14]!.y)/2;
    for (const i of INNER_LIP_RING) points[i]!.y = y;
    const source = document.createElement('canvas'); source.width=source.height=512;
    const c=source.getContext('2d')!; c.fillStyle='#d29682'; c.fillRect(0,0,512,512);
    const blob=await new Promise<Blob>(resolve=>source.toBlob(b=>resolve(b!),'image/png'));
    const camera=document.createElement('canvas'); camera.width=640; camera.height=480;
    const ctx=camera.getContext('2d')!;
    ctx.fillStyle='#16ed25';ctx.fillRect(0,0,640,480); // deliberately obvious forbidden exterior
    ctx.fillStyle='#190f14'; ctx.beginPath();ctx.ellipse(320,280,48,24,0,0,2*Math.PI);ctx.fill();
    ctx.fillStyle='#fff';ctx.fillRect(300,263,40,6);
    ctx.fillStyle='#bd2d41';ctx.fillRect(310,289,20,8);
    const stream=camera.captureStream(30), video=document.createElement('video'); video.muted=true;video.srcObject=stream;await video.play();
    const ring=Array.from({length:20},(_,i)=>({x:(320-48*Math.cos(i*Math.PI/10))/640,y:(280+24*Math.sin(i*Math.PI/10))/480}));
    const canvas=document.createElement('canvas');canvas.style.cssText='width:500px;height:650px';document.body.append(canvas);
    const neutral={geometry:measureMouthGeometry(points)!,shapes:{}};
    let jaw=.8;
    const expression={current:{...NEUTRAL_EXPRESSION} as any}, manualPose={current:{x:0,y:0,scale:1,yaw:0,pitch:0,roll:0}};
    const feed=()=>expression.current={...NEUTRAL_EXPRESSION,updatedAtMs:performance.now(),mouth:measureMouthControls(points,{},neutral,jaw,1,performance.now()),liveMouth:{timestampMs:performance.now(),ring}};
    feed();
    const renderer=new FaceRenderer({canvas,asset:{kind:'image',blob,fileName:'closed.png',mimeType:'image/png',assetId:null},profile:{...result.profile,primaryFace:{...result.profile.primaryFace,landmarks:points}},motion:{current:{head:{translationX:0,translationY:0,scaleDelta:1,yawDelta:0,pitchDelta:0,rollDelta:0}}},expression,manualPose,liveMouthVideoRef:{current:video},liveMouthEnabled:{current:true},mirror:'faithful'});
    await renderer.initialize();
    const r=renderer as any, gl=canvas.getContext('webgl2')!;
    const timer=setInterval(feed,33);
    const sample=()=>{
      r.renderer.render(r.scene,r.camera);
      const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      let teeth=0,tongue=0,skinLeak=0;
      for(let k=0;k<pixels.length;k+=4){if(pixels[k]!>225&&pixels[k+1]!>225&&pixels[k+2]!>225)teeth++;if(pixels[k]!>140&&pixels[k+1]!<75&&pixels[k+2]!<110)tongue++;if(pixels[k]!<80&&pixels[k+1]!>180&&pixels[k+2]!<90)skinLeak++;}
      return {teeth,tongue,skinLeak,opacity:r.liveMouthOpacity,status:r.mouthMaskStatus,diagnostics:r.oralDiagnostics};
    };
    const samples=[];
    for(const pose of [{yaw:0,pitch:0},{yaw:.3,pitch:0},{yaw:-.3,pitch:0},{yaw:0,pitch:.28},{yaw:0,pitch:-.28}]){
      manualPose.current={...manualPose.current,...pose};await new Promise(resolve=>setTimeout(resolve,600));
      for(let i=0;i<20 && r.liveMouthOpacity<.995;i++)await new Promise(resolve=>setTimeout(resolve,100));
      samples.push({...sample(),diagnostics:{...r.oralDiagnostics}});
    }
    manualPose.current={...manualPose.current,yaw:0,pitch:.28};await new Promise(resolve=>setTimeout(resolve,600));
    const withNose=sample();
    r.renderer.render(r.scene,r.camera);const noseOn=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,noseOn);
    const noseOpacity=r.nostrilMaterial.opacity;r.nostrilMaterial.opacity=0;r.renderer.render(r.scene,r.camera);
    const noseOff=new Uint8Array(noseOn.length);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,noseOff);
    let noseChangedPixels=0;for(let k=0;k<noseOn.length;k+=4)if(Math.abs(noseOn[k]!-noseOff[k]!)+Math.abs(noseOn[k+1]!-noseOff[k+1]!)>3)noseChangedPixels++;
    r.nostrilMaterial.opacity=noseOpacity;
    jaw=0;await new Promise(resolve=>setTimeout(resolve,600));const closed=sample();
    jaw=.8;await new Promise(resolve=>setTimeout(resolve,600));
    clearInterval(timer);await new Promise(resolve=>setTimeout(resolve,1000));const stale=sample();
    renderer.dispose();stream.getTracks().forEach(t=>t.stop());
    return {samples,closed,stale,noseChangedPixels,noseOpacity};
  });
  console.log('[M8.8 GPU oral]',JSON.stringify(report));
  for(const s of report.samples){expect(s.teeth).toBeGreaterThan(30);expect(s.tongue).toBeGreaterThan(15);expect(s.skinLeak).toBe(0);}
  expect(report.closed.teeth).toBe(0);expect(report.closed.tongue).toBe(0);
  expect(report.stale.opacity).toBeLessThan(.02);expect(report.stale.status).toBe('stale');
  expect(report.noseOpacity).toBeGreaterThan(.4);expect(report.noseChangedPixels).toBeGreaterThan(3);
});

test('M8.8 real Studio uses AUTO and paired inference pixels; mode switches, stop and mobile layout preserve camera lifecycle',async ({page})=>{
  await openStudioWithFaceCamera(page);
  await prepareSource(page);await startAndCalibrate(page);
  await page.evaluate(async()=>{
    const {FaceRenderer}=await import('/src/features/transformation/engine/rendering/FaceRenderer.ts');
    const initialize=FaceRenderer.prototype.initialize;
    FaceRenderer.prototype.initialize=function(){(window as any).__oralRenderer=this;const onStats=(this as any).options.onStats;(this as any).options.onStats=(s:any)=>{(window as any).__oralStats=s;onStats?.(s);};return initialize.call(this);};
  });
  await openFaceRender(page);
  await expect(page.getByRole('combobox',{name:'Mouth interior',exact:true})).toHaveValue('auto');
  await expect.poll(()=>page.evaluate(()=>!!(window as any).__oralRenderer.options.expression.current?.liveMouth?.sourceFrame)).toBe(true);
  const capture=await page.evaluate(()=>{
    const r=(window as any).__oralRenderer,frame=r.options.expression.current.liveMouth.sourceFrame;
    const mouth=r.options.expression.current.liveMouth;
    return {width:frame.width,height:frame.height,clock:mouth.timestampMs,videoWidth:r.options.liveMouthVideoRef.current.videoWidth,mode:r.options.oralInteriorMode.current};
  });
  expect(capture.width).toBeGreaterThan(0);expect(capture.width).toBeLessThanOrEqual(capture.videoWidth);expect(capture.height).toBeGreaterThan(0);expect(capture.clock).toBeGreaterThan(0);
  for(const width of [320,390,430]){
    await page.setViewportSize({width,height:844});
    const overflow=await horizontalOverflow(page);
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth+1);expect(overflow.offenders).toEqual([]);
  }
  await page.locator('.mouth-nose-diagnostics > details > summary').click();
  await page.getByText('Oral bounds and model signals',{exact:true}).click();
  await page.getByRole('button',{name:'Diagnostics',exact:true}).click();
  console.log('[M8.8 live desktop automation]',JSON.stringify(await page.evaluate(()=>{
    const metrics=Object.fromEntries(Array.from(document.querySelectorAll('[data-metric]')).map(d=>[d.getAttribute('data-metric'),d.querySelector('dd')?.textContent]));
    const s=(window as any).__oralStats;
    return {metrics,rendererFps:s?.fps,renderMs:s?.renderMs,frameAgeMs:s?.displayInputAgeMs,rendererDrops:s?.droppedFrames,oral:s?.oral};
  })));
  for(const mode of ['source','live','auto']){
    await page.getByRole('combobox',{name:'Mouth interior',exact:true}).selectOption(mode);
    await expect.poll(()=>page.evaluate(()=>(window as any).__oralRenderer.options.oralInteriorMode.current)).toBe(mode);
  }
  for(const width of [320,390,430]){
    await page.setViewportSize({width,height:844});
    const overflow=await horizontalOverflow(page);
    if(overflow.offenders.length)console.log('[M8.8 overflow detail]',JSON.stringify(await page.evaluate(()=>Array.from(document.querySelectorAll('p.studio-note')).filter(e=>e.getBoundingClientRect().right>innerWidth+1).map(e=>({text:e.textContent,parent:e.parentElement?.outerHTML.slice(0,200),box:e.getBoundingClientRect().toJSON(),parentBox:e.parentElement?.getBoundingClientRect().toJSON()})))));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth+1);
    expect(overflow.offenders).toEqual([]);
  }
  const frame=await page.evaluate(()=>{(window as any).__oralFrame=(window as any).__oralRenderer.options.expression.current.liveMouth.sourceFrame;return {cameraRequests:(window as any).__faceCamera.calls};});
  expect(frame.cameraRequests).toBe(1);
  await page.getByRole('button',{name:'Stop',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).__oralFrame.width)).toBe(0);
  console.log('[M8.8 real Studio paired pixels]',JSON.stringify(capture));
});

test('M8.8 small distant camera aperture retains white teeth and moving inside tongue without exterior pixels',async ({page})=>{
  await page.goto('/');
  const report=await page.evaluate(async()=>{
    const {drawWarpedMouth,mouthTextureTarget}=await import('/src/features/transformation/engine/rendering/liveMouthCompositor.ts');
    const camera=document.createElement('canvas');camera.width=1024;camera.height=768;
    const ctx=camera.getContext('2d')!,out=document.createElement('canvas');out.width=256;out.height=192;
    const targetCtx=out.getContext('2d',{willReadFrequently:true})!;
    const ring=Array.from({length:20},(_,i)=>({x:(512-22*Math.cos(i*Math.PI/10))/1024,y:(384+3*Math.sin(i*Math.PI/10))/768}));
    const reports=[];
    for(const x of [505,514]){
      ctx.fillStyle='#16ed25';ctx.fillRect(0,0,1024,768);ctx.fillStyle='#190f14';ctx.beginPath();ctx.ellipse(512,384,22,3,0,0,2*Math.PI);ctx.fill();
      ctx.fillStyle='#fff';ctx.fillRect(507,382,10,1);ctx.fillStyle='#bd2d41';ctx.fillRect(x,385,4,1);
      const drawn=drawWarpedMouth(targetCtx,camera,ring,mouthTextureTarget(ring,1024,768,256,192),256,192,1024,768);
      const pixels=targetCtx.getImageData(0,0,256,192).data;let teeth=0,tongue=0,leak=0,sumX=0;
      for(let k=0;k<pixels.length;k+=4){if(pixels[k+3]!<250)continue;if(Math.min(pixels[k]!,pixels[k+1]!,pixels[k+2]!)>210)teeth++;if(pixels[k]!>130&&pixels[k+1]!<85&&pixels[k+2]!<115){tongue++;sumX+=(k/4)%256;}if(pixels[k]!<80&&pixels[k+1]!>180&&pixels[k+2]!<90)leak++;}
      reports.push({drawn,teeth,tongue,leak,tongueX:sumX/Math.max(1,tongue)});
    }
    return reports;
  });
  for(const r of report){expect(r.drawn).toBe(true);expect(r.teeth).toBeGreaterThan(30);expect(r.tongue).toBeGreaterThan(10);expect(r.leak).toBe(0);}
  expect(report[1]!.tongueX).toBeGreaterThan(report[0]!.tongueX+30);
});
