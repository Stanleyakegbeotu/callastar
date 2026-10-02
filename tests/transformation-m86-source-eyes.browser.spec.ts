import { expect, test } from '@playwright/test';

/** A labelled synthetic SOURCE texture makes iris direction, source colour,
 * aperture coverage and glasses preservation measurable in real WebGL pixels.
 * It is never offered as a user source and is not a physical-glasses claim. */
test('M8.6 source iris pixels follow gaze inside the aperture; source glasses and colours remain stable', async ({page}) => {
  await page.goto('/');await page.setViewportSize({width:1000,height:1000});
  await page.evaluate(async()=>{
    const [{FaceRenderer},{eyeRegressionFixture},{NEUTRAL_EXPRESSION},{measureEyeGeometry,eyeStateFromGeometry}]=await Promise.all([
      import('/src/features/transformation/engine/rendering/FaceRenderer.ts'),import('/src/features/transformation/engine/fixtures/eyeRegression.ts'),
      import('/src/features/transformation/engine/expressionMotion.ts'),import('/src/features/transformation/engine/eyeControls.ts')]);
    const points=eyeRegressionFixture();const texture=document.createElement('canvas');texture.width=texture.height=512;
    const ctx=texture.getContext('2d')!;ctx.fillStyle='#c48f76';ctx.fillRect(0,0,512,512);
    for(const [cx,height] of [[.4,.025],[.6,.035]]){
      ctx.fillStyle='white';ctx.beginPath();ctx.ellipse(cx*512,.4*512,.05*512,height*.5*512,0,0,2*Math.PI);ctx.fill();
      ctx.fillStyle='#2149d5';ctx.beginPath();ctx.arc(cx*512,.4*512,.009*512,0,2*Math.PI);ctx.fill();
      ctx.fillStyle='#101827';ctx.beginPath();ctx.arc(cx*512,.4*512,.003*512,0,2*Math.PI);ctx.fill();
      ctx.strokeStyle='#00dddd';ctx.lineWidth=2;ctx.strokeRect((cx-.075)*512,(.4-height*1.8)*512,.15*512,height*3.6*512);
    }
    ctx.strokeStyle='#00dddd';ctx.beginPath();ctx.moveTo(.475*512,.35*512);ctx.lineTo(.525*512,.35*512);ctx.stroke();
    const blob=await new Promise<Blob>(resolve=>texture.toBlob(b=>resolve(b!),'image/png'));
    const asset={kind:'image',blob,fileName:'synthetic-eye-glasses-fixture.png',mimeType:'image/png',assetId:null};
    const canvas=document.createElement('canvas');canvas.style.cssText='width:800px;height:800px;display:block';canvas.dataset.testid='source-eyes';document.body.replaceChildren(canvas);
    const neutral={left:eyeStateFromGeometry(measureEyeGeometry(points,'left'),measureEyeGeometry(points,'left'),0,1,null),right:eyeStateFromGeometry(measureEyeGeometry(points,'right'),measureEyeGeometry(points,'right'),0,1,null)};
    const expression={current:{...NEUTRAL_EXPRESSION,eyes:neutral,status:'manual',calculationMs:0}};
    const profile={primaryFace:{landmarks:points,yaw:0,pitch:0,roll:0},dimensions:{aspectRatio:1},movementEnvelope:{yawLeft:1,yawRight:1,pitchUp:1,pitchDown:1}};
    const renderer=new FaceRenderer({canvas,asset,profile,motion:{current:{tracked:true,head:{translationX:0,translationY:0,scaleDelta:1,yawDelta:0,pitchDelta:0,rollDelta:0},expression:null,upperBody:null}},manualExpression:expression,mirror:'faithful'});
    await renderer.initialize();
    (window as any).__sourceEye={renderer,expression,neutral,NEUTRAL_EXPRESSION,canvas};
  });
  const show=async(gazeX=0,gazeY=0,blink=0,wide=0)=>{
    await page.evaluate(({gazeX,gazeY,blink,wide})=>{
      const s=(window as any).__sourceEye;
      s.expression.current={...s.NEUTRAL_EXPRESSION,blinkLeft:blink,blinkRight:blink,status:'manual',calculationMs:0,eyes:{
        left:{...s.neutral.left,blink,wideOpen:wide,gazeX,gazeY,upperLid:.7*blink,lowerLid:.3*blink},
        right:{...s.neutral.right,blink,wideOpen:wide,gazeX:-gazeX,gazeY,upperLid:.7*blink,lowerLid:.3*blink}}};
    },{gazeX,gazeY,blink,wide});
    await page.waitForTimeout(250);
    return page.evaluate(()=>{
      const s=(window as any).__sourceEye,r=s.renderer;r.renderer.render(r.scene,r.camera);
      const copy=document.createElement('canvas');copy.width=s.canvas.width;copy.height=s.canvas.height;const ctx=copy.getContext('2d')!;ctx.drawImage(s.canvas,0,0);
      const rgba=ctx.getImageData(0,0,copy.width,copy.height).data;
      const iris:number[][]=[[],[]],glasses:number[][]=[];
      for(let y=0;y<copy.height;y++)for(let x=0;x<copy.width;x++){
        const i=(y*copy.width+x)*4,red=rgba[i],green=rgba[i+1],blue=rgba[i+2];
        if(red<80&&green<150&&blue>150)iris[x<copy.width/2?0:1].push([x,y]);
        if(red<60&&green>170&&blue>170)glasses.push([x,y]);
      }
      const measure=(p:number[][])=>({count:p.length,x:p.reduce((s,p)=>s+p[0],0)/p.length,y:p.reduce((s,p)=>s+p[1],0)/p.length});
      return {iris:iris.map(measure),glasses:measure(glasses),finite:Array.from(r.deformer.positions).every(Number.isFinite)};
    });
  };
  const neutral=await show();expect(neutral.iris[0].count).toBeGreaterThan(30);expect(neutral.iris[1].count).toBeGreaterThan(30);
  const right=await show(1),left=await show(-1),up=await show(0,-1),down=await show(0,1);
  for(const i of [0,1]){
    expect(right.iris[i].x).toBeGreaterThan(neutral.iris[i].x+1);
    expect(left.iris[i].x).toBeLessThan(neutral.iris[i].x-1);
    expect(up.iris[i].y).toBeLessThan(neutral.iris[i].y-.5);
    expect(down.iris[i].y).toBeGreaterThan(neutral.iris[i].y+.5);
  }
  const closed=await show(0,0,1);expect(closed.finite).toBe(true);
  expect(closed.iris[0].count+closed.iris[1].count).toBeLessThan(5);
  expect(Math.abs(closed.glasses.x-neutral.glasses.x)).toBeLessThan(2);
  expect(Math.abs(closed.glasses.y-neutral.glasses.y)).toBeLessThan(2);
  expect(closed.glasses.count/neutral.glasses.count).toBeGreaterThan(.9);
  const wide=await show(0,0,0,1);
  for(const i of [0,1])expect(Math.abs(wide.iris[i].count/neutral.iris[i].count-1)).toBeLessThan(.2);
  await page.getByTestId('source-eyes').screenshot({path:test.info().outputPath('synthetic-source-glasses-wide.png')});
  console.log('[M8.6 source pixel measurements]',JSON.stringify({neutral,right,left,up,down,closed,wide,syntheticSource:true}));
  await page.evaluate(()=>(window as any).__sourceEye.renderer.dispose());
});
