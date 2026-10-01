import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
const root='artifacts/onboarding';
const geometry=JSON.parse(await fs.readFile(root+'/eye-landmarks.json','utf8'));
const images={open:'girl-wallpaper.jpg',half:'girl-eyes-half-generated.png',closed:'girl-eyes-closed-generated.png'};
const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage();
for(const [key,file] of Object.entries(images)) await page.route('http://127.0.0.1:5222/blink-'+key,async route=>route.fulfill({contentType:file.endsWith('png')?'image/png':'image/jpeg',body:await fs.readFile(root+'/'+file)}));
await page.goto('http://127.0.0.1:5222/');
const outputs=await page.evaluate(async geometry=>{
 const loaded={};for(const key of ['open','half','closed']){const img=new Image();img.src='/blink-'+key;await img.decode();loaded[key]=img;}
 const original=loaded.open,w=original.naturalWidth,h=original.naturalHeight;
 const base=document.createElement('canvas');base.width=w;base.height=h;const b=base.getContext('2d',{willReadFrequently:true});b.drawImage(original,0,0);
 const originalData=b.getImageData(0,0,w,h);const frames={open:base.toDataURL('image/png')};
 for(const state of ['half','closed']){
  const out=document.createElement('canvas');out.width=w;out.height=h;const c=out.getContext('2d',{willReadFrequently:true});c.putImageData(originalData,0,0);
  const donor=document.createElement('canvas');donor.width=w;donor.height=h;const dc=donor.getContext('2d',{willReadFrequently:true});
  for(const side of ['left','right']){
   const a=geometry.open[side],z=geometry[state][side];
   const mid=(q)=>({x:(q[0].x+q[1].x)/2,y:(q[0].y+q[1].y)/2});const src=mid(z),dst=mid(a);
   const vec=q=>({x:q[1].x-q[0].x,y:q[1].y-q[0].y});const v=vec(a),u=vec(z);
   const theta=Math.atan2(v.y,v.x),phi=Math.atan2(u.y,u.x),size=Math.hypot(v.x,v.y),scale=size/Math.hypot(u.x,u.y);
   dc.setTransform(1,0,0,1,0,0);dc.clearRect(0,0,w,h);
   dc.translate(dst.x,dst.y);dc.rotate(theta-phi);dc.scale(scale,scale);dc.translate(-src.x,-src.y);dc.drawImage(loaded[state],0,0);
   const donorData=dc.getImageData(0,0,w,h).data;
   const output=c.getImageData(0,0,w,h),dest=output.data;
   const rx=size*.73,ry=size*.39,cos=Math.cos(theta),sin=Math.sin(theta);
   const left=Math.floor(dst.x-rx-18),right=Math.ceil(dst.x+rx+18),top=Math.floor(dst.y-rx-18),bottom=Math.ceil(dst.y+rx+18);
   for(let y=Math.max(0,top);y<Math.min(h,bottom);y++)for(let x=Math.max(0,left);x<Math.min(w,right);x++){
    const dx=x-dst.x,dy=y-dst.y,lx=(dx*cos+dy*sin)/rx,ly=(-dx*sin+dy*cos)/ry,d=Math.hypot(lx,ly);
    if(d>=1)continue;const t=Math.max(0,Math.min(1,(1-d)/.22));const alpha=t*t*(3-2*t);
    const k=(y*w+x)*4;for(let channel=0;channel<3;channel++)dest[k+channel]=dest[k+channel]*(1-alpha)+donorData[k+channel]*alpha;
   }
   c.putImageData(output,0,0);
  }
  frames[state]=out.toDataURL('image/png');
 }
 return frames;
},geometry);
for(const [state,url] of Object.entries(outputs)) await fs.writeFile(root+'/girl-blink-'+state+'.png',Buffer.from(url.split(',')[1],'base64'));
console.log(Object.keys(outputs));await browser.close();
