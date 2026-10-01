import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
const root='artifacts/onboarding';
const names={open:'girl-wallpaper.jpg',half:'girl-eyes-half-generated.png',closed:'girl-eyes-closed-generated.png'};
const browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-gl=angle','--use-angle=swiftshader']});
const page=await browser.newPage();
for(const [key,file] of Object.entries(names)){
 await page.route('http://127.0.0.1:5222/blink-'+key,async route=>route.fulfill({contentType:file.endsWith('png')?'image/png':'image/jpeg',body:await fs.readFile(root+'/'+file)}));
}
await page.goto('http://127.0.0.1:5222/');
const result=await page.evaluate(async()=>{
 const {SourceAnalysisTasks}=await import('/src/features/transformation/source/sourceTrackers.ts');
 const tasks=new SourceAnalysisTasks();await tasks.initialize();
 const data={};for(const key of ['open','half','closed']){
  const img=new Image();img.src='/blink-'+key;await img.decode();const face=tasks.detectFace(img);if(!face.detected)throw Error('face failed '+key);
  const p=face.landmarks;data[key]={width:img.naturalWidth,height:img.naturalHeight,
   left:[33,133,159,145].map(i=>({x:p[i].x*img.naturalWidth,y:p[i].y*img.naturalHeight})),
   right:[263,362,386,374].map(i=>({x:p[i].x*img.naturalWidth,y:p[i].y*img.naturalHeight}))};
 }
 tasks.dispose();return data;
});
await fs.writeFile(root+'/eye-landmarks.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));await browser.close();
