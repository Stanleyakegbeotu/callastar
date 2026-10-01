import fs from 'node:fs';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const {PNG}=require('./artifacts/onboarding/.gifbuild/node_modules/pngjs');
const root='artifacts/onboarding';const a=PNG.sync.read(fs.readFileSync(root+'/girl-blink-open.png'));const b=PNG.sync.read(fs.readFileSync(root+'/girl-blink-closed.png'));
let count=0,minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){const k=(y*a.width+x)*4;if(a.data[k]!==b.data[k]||a.data[k+1]!==b.data[k+1]||a.data[k+2]!==b.data[k+2]){count++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}}
console.log(JSON.stringify({changedPixels:count,bounds:{minX,maxX,minY,maxY},gifBytes:fs.statSync(root+'/girl-blinking.gif').size,header:fs.readFileSync(root+'/girl-blinking.gif').subarray(0,6).toString()}));
