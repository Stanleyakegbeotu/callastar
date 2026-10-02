/** Small source-measured 3D nostril recesses. No texture replacement, source
 * mesh writes or global pose changes. Hidden frontal anatomy remains unknown. */
export function noseCavityData(p:Float32Array) {
  const point=(i:number)=>({x:p[i*3]!,y:p[i*3+1]!,z:p[i*3+2]!});
  const tip=point(1),base=point(2),left=point(98),right=point(327);
  const width=Math.hypot(right.x-left.x,right.y-left.y);
  const dy=base.y-tip.y,dz=base.z-tip.z,len=Math.hypot(dy,dz);
  if(![width,len,...Object.values(tip),...Object.values(base)].every(Number.isFinite)||width<.004||len<.001)return null;
  const ty=dy/len,tz=dz/len;
  const positions:number[]=[],colors:number[]=[],indices:number[]=[];
  const n=16;
  for(const wing of [left,right]){
    const cx=base.x*.45+wing.x*.55,cy=base.y*.4+wing.y*.6;
    // Depth samples interpolate the source's existing nose underside. A small
    // edge offset avoids coplanar flicker; the centre is a physical recess.
    const cz=base.z*.4+wing.z*.6+width*.045;
    const rx=Math.abs(wing.x-base.x)*.26,ry=Math.min(width*.07,len*.13);
    const start=positions.length/3;
    positions.push(cx,cy,cz-width*.025);colors.push(.35,.35,.35);
    for(let i=0;i<n;i++){
      const a=i*2*Math.PI/n;
      positions.push(cx+Math.cos(a)*rx,cy+Math.sin(a)*ry*ty,cz+Math.sin(a)*ry*tz);
      colors.push(1,1,1);indices.push(start,start+1+i,start+1+(i+1)%n);
    }
  }
  return {positions:new Float32Array(positions),colors:new Float32Array(colors),indices:new Uint16Array(indices),depth:Math.abs(tip.z-base.z),normal:{y:tz,z:-ty},width};
}
export function nostrilVisibility(pitch:number):number {
  if(!Number.isFinite(pitch))return 0;
  // Visibility is conservative, driven by physical +UP (rendererMotion owns
  // signs). Up exposes the underside; down conceals these unknown-source pits.
  return Math.max(0,Math.min(.55,(pitch-.025)*2.2));
}
