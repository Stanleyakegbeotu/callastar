import { describe, it, expect, vi } from 'vitest';
import { readyVideoFrame } from './readyVideoFrame';
class Video extends EventTarget {
 readyState=1;videoWidth=0;videoHeight=0;duration=10;currentTime=0;seeking=false;
 cb:VideoFrameRequestCallback|null=null;
 requestVideoFrameCallback=vi.fn((cb:VideoFrameRequestCallback)=>{this.cb=cb;return 1;});
 cancelVideoFrameCallback=vi.fn();
 present(){this.cb?.(0,{mediaTime:this.currentTime} as VideoFrameCallbackMetadata);}
}
describe('decoded source frame readiness',()=>{
 it('metadata and seek completion cannot authorize capture before the presented frame',async()=>{
  const v=new Video();const capture=vi.fn();const done=readyVideoFrame(v as unknown as HTMLVideoElement,2).then(capture);
  v.dispatchEvent(new Event('seeked'));await Promise.resolve();expect(capture).not.toHaveBeenCalled();
  v.readyState=2;v.videoWidth=640;v.videoHeight=480;v.dispatchEvent(new Event('loadeddata'));
  await Promise.resolve();expect(capture).not.toHaveBeenCalled();v.present();await done;expect(capture).toHaveBeenCalledOnce();
 });
 it('supports presented-before-seeked ordering',async()=>{
  const v=new Video();v.readyState=2;v.videoWidth=640;v.videoHeight=480;v.seeking=true;
  const capture=vi.fn();const done=readyVideoFrame(v as unknown as HTMLVideoElement,2).then(capture);
  v.present();await Promise.resolve();expect(capture).not.toHaveBeenCalled();v.seeking=false;v.dispatchEvent(new Event('seeked'));await done;
 });
 it('cancels pending delivery and releases the frame callback',async()=>{
  const v=new Video();const abort=new AbortController();const done=readyVideoFrame(v as unknown as HTMLVideoElement,2,abort.signal);
  abort.abort();await expect(done).rejects.toThrow('cancelled');expect(v.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
 });
 it('uses data and seek events where frame callbacks are unavailable',async()=>{
  const v=new Video();Object.defineProperty(v,'requestVideoFrameCallback',{value:undefined});
  const done=readyVideoFrame(v as unknown as HTMLVideoElement,2);
  v.readyState=2;v.videoWidth=640;v.videoHeight=480;v.dispatchEvent(new Event('seeked'));await done;
 });
});
