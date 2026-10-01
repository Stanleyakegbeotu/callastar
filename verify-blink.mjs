import fs from 'node:fs/promises';import {chromium} from '@playwright/test';
const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:950,height:620}});
await page.route('http://127.0.0.1:5222/blink.gif',async route=>route.fulfill({contentType:'image/gif',body:await fs.readFile('artifacts/onboarding/girl-blinking.gif')}));
await page.goto('http://127.0.0.1:5222/');await page.evaluate(()=>{document.body.innerHTML='<img src="/blink.gif" style="width:900px;height:auto">';});
await page.locator('img').evaluate(img=>img.decode());
await page.locator('img').screenshot({path:'artifacts/onboarding/gif-open-proof.png'});
await page.waitForTimeout(3300);await page.locator('img').screenshot({path:'artifacts/onboarding/gif-blink-proof.png'});
console.log('gif playback screenshots captured');await browser.close();
