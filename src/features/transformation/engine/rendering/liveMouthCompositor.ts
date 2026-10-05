export interface MouthPoint { x: number; y: number }
export type OralInteriorMode = 'source' | 'live' | 'auto';
export const ORAL_FRESH_MS = 400;
export const MOUTH_HORIZONTAL_PAD_RATIO = 0.08;
export const MOUTH_UPPER_PAD_FACE_RATIO = 0.03;
export const MOUTH_LOWER_PAD_FACE_RATIO = 0.035;
export const MOUTH_MIN_FEATHER_SIGMA = 1.5;
export const MOUTH_FEATHER_FACE_RATIO = 0.008;
const perioralWorkspaces=new WeakMap<HTMLCanvasElement,{mask:HTMLCanvasElement;feathered:HTMLCanvasElement}>();
export function oralFrameFresh(updatedAtMs:number|undefined,nowMs:number):boolean {
  return updatedAtMs !== undefined && Number.isFinite(updatedAtMs) && nowMs >= updatedAtMs && nowMs-updatedAtMs < ORAL_FRESH_MS;
}
export function mouthMaskMetrics(ring:readonly MouthPoint[],width:number,height:number) {
  if(ring.length<3 || ![width,height].every(n=>Number.isFinite(n)&&n>0) || ring.some(p=>![p.x,p.y].every(Number.isFinite))) return null;
  const pixels=ring.map(p=>({x:p.x*width,y:p.y*height}));
  let signed=0;
  for(let i=0;i<pixels.length;i++){const a=pixels[i]!,b=pixels[(i+1)%pixels.length]!;signed+=a.x*b.y-b.x*a.y;}
  const bounds={minX:Math.min(...pixels.map(p=>p.x)),maxX:Math.max(...pixels.map(p=>p.x)),minY:Math.min(...pixels.map(p=>p.y)),maxY:Math.max(...pixels.map(p=>p.y))};
  const area=Math.abs(signed)/2;
  return {area,bounds,valid:area>=2 && bounds.minX>=0 && bounds.minY>=0 && bounds.maxX<=width && bounds.maxY<=height};
}

/** Expands an ordered outer-lip contour by mouth/face-relative padding. */
export function perioralRegion(ring:readonly MouthPoint[],width:number,height:number,faceWidthPx:number) {
  if (ring.length < 3 || ![width,height,faceWidthPx].every(n=>Number.isFinite(n)&&n>0) || ring.some(p=>![p.x,p.y].every(Number.isFinite))) return null;
  const pixels=ring.map(p=>({x:p.x*width,y:p.y*height}));
  const xs=pixels.map(p=>p.x),ys=pixels.map(p=>p.y);
  const left=Math.min(...xs),right=Math.max(...xs),top=Math.min(...ys),bottom=Math.max(...ys);
  const mouthWidth=right-left,mouthHeight=bottom-top;
  if (faceWidthPx < 24 || mouthWidth < 8 || mouthHeight < 4 || mouthWidth > width*.65 || mouthHeight > faceWidthPx*.45) return null;
  const padX=Math.max(1,Math.min(mouthWidth*.12,mouthWidth*MOUTH_HORIZONTAL_PAD_RATIO));
  const padTop=Math.max(1,Math.min(faceWidthPx*.05,faceWidthPx*MOUTH_UPPER_PAD_FACE_RATIO));
  const padBottom=Math.max(1,Math.min(faceWidthPx*.06,faceWidthPx*MOUTH_LOWER_PAD_FACE_RATIO));
  const cx=(left+right)/2,cy=(top+bottom)/2+(padBottom-padTop)/2;
  const expanded=pixels.map(p=>({
    x:cx+(p.x-(left+right)/2)*(1+2*padX/mouthWidth),
    y:cy+(p.y-(top+bottom)/2)*(1+(padTop+padBottom)/mouthHeight),
  }));
  const sigma=Math.max(MOUTH_MIN_FEATHER_SIGMA,faceWidthPx*MOUTH_FEATHER_FACE_RATIO);
  const bounds={minX:Math.min(...expanded.map(p=>p.x)),maxX:Math.max(...expanded.map(p=>p.x)),minY:Math.min(...expanded.map(p=>p.y)),maxY:Math.max(...expanded.map(p=>p.y))};
  if(bounds.minX<0||bounds.minY<0||bounds.maxX>width||bounds.maxY>height) return null;
  return { expanded, bounds, sigma, mouthWidth, faceWidthPx };
}

/** Crops current-frame perioral pixels and applies a feathered polygon alpha. */
export function drawPerioralPatch(
  context:CanvasRenderingContext2D, frame:CanvasImageSource, ring:readonly MouthPoint[],
  width:number,height:number,faceWidthPx:number,
):boolean {
  const region=perioralRegion(ring,width,height,faceWidthPx);
  if(!region||context.canvas.width<=0||context.canvas.height<=0)return false;
  const {bounds,expanded,sigma}=region,canvasWidth=context.canvas.width,canvasHeight=context.canvas.height;
  const roiWidth=bounds.maxX-bounds.minX,roiHeight=bounds.maxY-bounds.minY;
  if(roiWidth<2||roiHeight<2)return false;
  let workspace=perioralWorkspaces.get(context.canvas);
  if(!workspace){workspace={mask:document.createElement('canvas'),feathered:document.createElement('canvas')};perioralWorkspaces.set(context.canvas,workspace);}
  const {mask,feathered}=workspace;
  if(mask.width!==canvasWidth||mask.height!==canvasHeight){mask.width=canvasWidth;mask.height=canvasHeight;feathered.width=canvasWidth;feathered.height=canvasHeight;}
  const maskContext=mask.getContext('2d');if(!maskContext)return false;
  context.setTransform(1,0,0,1,0,0);context.filter='none';context.globalCompositeOperation='source-over';
  context.clearRect(0,0,canvasWidth,canvasHeight);
  context.drawImage(frame,bounds.minX,bounds.minY,roiWidth,roiHeight,0,0,canvasWidth,canvasHeight);
  const scaleX=canvasWidth/roiWidth,scaleY=canvasHeight/roiHeight;
  maskContext.clearRect(0,0,canvasWidth,canvasHeight);
  maskContext.beginPath();
  expanded.forEach((p,i)=>{const x=(p.x-bounds.minX)*scaleX,y=(p.y-bounds.minY)*scaleY;i===0?maskContext.moveTo(x,y):maskContext.lineTo(x,y);});
  maskContext.closePath();maskContext.fillStyle='#fff';maskContext.fill();
  const feather=Math.max(.5,sigma*(scaleX+scaleY)/2);
  // The contour is one filled polygon, so raster gaps cannot form internally;
  // only the feather is needed here (no full-frame morphology pass).
  const featherContext=feathered.getContext('2d');if(!featherContext)return false;
  featherContext.clearRect(0,0,canvasWidth,canvasHeight);
  featherContext.filter=`blur(${feather}px)`;featherContext.drawImage(mask,0,0);maskContext.filter='none';
  maskContext.clearRect(0,0,canvasWidth,canvasHeight);maskContext.drawImage(feathered,0,0);
  context.globalCompositeOperation='destination-in';context.drawImage(mask,0,0);context.globalCompositeOperation='source-over';
  return true;
}
/** Half a camera pixel prevents nearest-sample exterior bleed; capped at
 * 0.65px. The old 1.5px inset erased narrow strips at distance. */
export function oralInsetScale(radius:number):number {
  return radius>0 ? Math.max(0,1-Math.min(.65,Math.max(.5,radius*.06))/radius) : 0;
}
export function oralFeedAllowed(mode:OralInteriorMode,sourceGap:number,renderedGap:number,width:number):boolean {
  if(mode==='source')return false;
  if(mode==='live')return true;
  // Keep a source's visible interior at neutral. Geometric opening beyond
  // that photographed aperture needs live pixels rather than stretching teeth.
  return sourceGap < width*.035 || renderedGap > sourceGap+width*.04;
}
/** Fit the complete live interior uniformly when its aspect is taller than
 * the rendered aperture. Clipping a width-only atlas used to lose the tongue;
 * independently stretching y would distort teeth. Empty sides remain cavity. */
export function oralContentFit(live:readonly MouthPoint[],target:readonly MouthPoint[]):number {
  const liveGap=Math.abs((live[5]?.y ?? 0)-(live[15]?.y ?? 0));
  const targetGap=Math.abs((target[5]?.y ?? 0)-(target[15]?.y ?? 0));
  return liveGap>1e-6 ? Math.max(.05,Math.min(1,targetGap/liveGap)) : 1;
}

/** Triangles from a centroid through the ordered inner-lip contour. */
export function mouthFanTriangles(count: number): [number, number, number][] {
  if (count < 3) return [];
  return Array.from({ length: count }, (_, i) => [count, i, (i + 1) % count]);
}

/**
 * Draws only the live inner-mouth polygon into a transparent target canvas.
 * Each triangle maps three live landmarks to their source-mouth counterpart;
 * no pixels outside the lip contour are copied.
 */
export function drawWarpedMouth(
  context: CanvasRenderingContext2D,
  video: CanvasImageSource,
  liveRing: readonly MouthPoint[],
  targetRing: readonly MouthPoint[],
  width: number,
  height: number,
  videoWidth: number,
  videoHeight: number,
): boolean {
  if (liveRing.length < 3 || liveRing.length !== targetRing.length || width <= 0 || height <= 0 || videoWidth <= 0 || videoHeight <= 0) return false;
  if([...liveRing,...targetRing].some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)))return false;
  const liveCentre = centroid(liveRing);
  const targetCentre = centroid(targetRing);
  const metrics=mouthMaskMetrics(liveRing,videoWidth,videoHeight);
  if(!metrics?.valid)return false;
  const liveRadius=Math.min(...liveRing.map(p=>Math.hypot((p.x-liveCentre.x)*videoWidth,(p.y-liveCentre.y)*videoHeight)));
  if(liveRadius<1)return false;
  const liveInset=oralInsetScale(liveRadius);
  // Inset both the sampled live contour and destination: the operator's
  // outer lips/skin cannot enter via bilinear edge sampling.
  const source = [...liveRing.map(p => ({ x: (liveCentre.x+(p.x-liveCentre.x)*liveInset) * videoWidth, y: (liveCentre.y+(p.y-liveCentre.y)*liveInset) * videoHeight })),
    { x: liveCentre.x * videoWidth, y: liveCentre.y * videoHeight }];
  const targetPixels = targetRing.map(p => ({ x: p.x * width, y: p.y * height }));
  const centrePixels = { x: targetCentre.x * width, y: targetCentre.y * height };
  // Equal fractional insets preserve the uniform pixel aspect of the atlas.
  const insetScale = liveInset;
  const target = [...targetPixels.map(p => ({
    x: centrePixels.x + (p.x - centrePixels.x) * insetScale,
    y: centrePixels.y + (p.y - centrePixels.y) * insetScale,
  })), centrePixels];
  context.setTransform(1,0,0,1,0,0);
  context.clearRect(0, 0, width, height);
  // Uniform atlas mappings need one image draw. Per-triangle clip edges
  // introduced seams through small tooth strips and altered their pixel aspect.
  const uniform=affine(source[liveRing.length]!,source[0]!,source[1]!,target[liveRing.length]!,target[0]!,target[1]!);
  if(uniform && source.every((p,i)=>Math.hypot(uniform.a*p.x+uniform.c*p.y+uniform.e-target[i]!.x,uniform.b*p.x+uniform.d*p.y+uniform.f-target[i]!.y)<.05)){
    context.save();context.imageSmoothingEnabled=false;context.beginPath();target.slice(0,-1).forEach((p,i)=>i===0?context.moveTo(p.x,p.y):context.lineTo(p.x,p.y));context.closePath();context.clip();
    context.setTransform(uniform.a,uniform.b,uniform.c,uniform.d,uniform.e,uniform.f);context.drawImage(video,0,0,videoWidth,videoHeight);context.restore();
    return true;
  }
  let drawn=0;
  for (const [centre, first, second] of mouthFanTriangles(liveRing.length)) {
    const a = affine(source[centre]!, source[first]!, source[second]!, target[centre]!, target[first]!, target[second]!);
    if (!a) continue;
    drawn++;
    const t0 = target[centre]!, t1 = target[first]!, t2 = target[second]!;
    context.save();
    // Preserve small camera tooth strips on atlas resampling. The GL texture
    // still uses linear filtering, so displayed edges interpolate normally.
    context.imageSmoothingEnabled=false;
    context.beginPath();
    context.moveTo(t0.x, t0.y);
    context.lineTo(t1.x, t1.y);
    context.lineTo(t2.x, t2.y);
    context.closePath();
    context.clip();
    context.setTransform(a.a, a.b, a.c, a.d, a.e, a.f);
    context.drawImage(video, 0, 0, videoWidth, videoHeight);
    context.restore();
  }
  context.setTransform(1, 0, 0, 1, 0, 0);
  return drawn>0;
}

/** Uniform image-plane mapping, anchored at the upper aperture. Teeth retain
 * their aspect as the lower source lip moves; clipping reveals the interior. */
export function mouthTextureTarget(ring:readonly MouthPoint[],videoWidth:number,videoHeight:number,width:number,height:number):MouthPoint[] {
  // Remove camera roll in pixel space before uniformly scaling the interior.
  // Raw screen y is not a lip-plane height when the head tilts.
  const a=ring[0]!,b=ring[10]??ring[Math.floor(ring.length/2)]!;
  const dx=(b.x-a.x)*videoWidth,dy=(b.y-a.y)*videoHeight,len=Math.max(1e-6,Math.hypot(dx,dy));
  const ux=dx/len,uy=dy/len;
  const local=ring.map(p=>({x:(p.x-a.x)*videoWidth*ux+(p.y-a.y)*videoHeight*uy,y:-(p.x-a.x)*videoWidth*uy+(p.y-a.y)*videoHeight*ux}));
  const left=Math.min(...local.map(p=>p.x)),right=Math.max(...local.map(p=>p.x)),top=local[15]?.y??Math.min(...local.map(p=>p.y));
  const scale=width/Math.max(1e-6,right-left);
  return local.map(p=>({x:(p.x-left)*scale/width,y:.15+(p.y-top)*scale/height}));
}

function centroid(points: readonly MouthPoint[]): MouthPoint {
  const sum = points.reduce((value, point) => ({ x: value.x + point.x, y: value.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function affine(s0: MouthPoint, s1: MouthPoint, s2: MouthPoint, d0: MouthPoint, d1: MouthPoint, d2: MouthPoint) {
  const x1 = s1.x - s0.x, y1 = s1.y - s0.y;
  const x2 = s2.x - s0.x, y2 = s2.y - s0.y;
  const det = x1 * y2 - x2 * y1;
  if (Math.abs(det) < 1e-8) return null;
  const X1 = d1.x - d0.x, Y1 = d1.y - d0.y;
  const X2 = d2.x - d0.x, Y2 = d2.y - d0.y;
  const a = (X1 * y2 - X2 * y1) / det;
  const c = (x1 * X2 - x2 * X1) / det;
  const b = (Y1 * y2 - Y2 * y1) / det;
  const d = (x1 * Y2 - x2 * Y1) / det;
  return { a, b, c, d, e: d0.x - a * s0.x - c * s0.y, f: d0.y - b * s0.x - d * s0.y };
}
