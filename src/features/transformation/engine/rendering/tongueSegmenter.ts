import type { MouthPoint } from './liveMouthCompositor';

/** Optional future pixel model. FaceLandmarker has no tongue skeleton. This
 * seam does not run inference or enable any extended live region by itself. */
export interface TongueSegmenter {
  segment(input: {pixels:ImageData; innerLip:readonly MouthPoint[]; outerLip:readonly MouthPoint[]; timestampMs:number}): TongueSegmentation | null;
  dispose():void;
}
export interface TongueSegmentation {
  timestampMs:number;
  confidence:number;
  /** Pixel alpha mask at camera resolution, exclusively tongue tissue. */
  alpha:Uint8Array;
  width:number;
  height:number;
}
/** Defensive admission for a future implementation: stale/uncertain pixels
 * cannot reveal a live lower-face rectangle. Current production has no
 * segmenter, so protrusion stays unavailable and the inner-mouth path works. */
export function admitTongueMask(result:TongueSegmentation|null,inner:readonly MouthPoint[],nowMs:number):boolean {
  if(!result || !Number.isFinite(result.confidence) || result.confidence<.9 || !Number.isFinite(result.timestampMs) || nowMs<result.timestampMs || nowMs-result.timestampMs>150) return false;
  const {width,height,alpha}=result;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<=0||height<=0||alpha.length!==width*height||inner.length<3||inner.some(p=>![p.x,p.y].every(Number.isFinite)))return false;
  const x0=Math.min(...inner.map(p=>p.x)),x1=Math.max(...inner.map(p=>p.x)),y0=Math.min(...inner.map(p=>p.y)),y1=Math.max(...inner.map(p=>p.y)),span=x1-x0;
  if(span<=0)return false;
  let count=0;
  for(let k=0;k<alpha.length;k++)if(alpha[k]!>127){
    count++; const x=(k%width)/width,y=Math.floor(k/width)/height;
    if(x<x0-span*.15 || x>x1+span*.15 || y<y0-span*.15 || y>y1+span*.5)return false;
  }
  return count>=3 && count<width*height*span*span*.45;
}
