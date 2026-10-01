import { expect, it, vi } from 'vitest';
import { faceWebGLContext, FACE_WEBGL_UNAVAILABLE } from './webglPreflight';
it('refuses Safari null shader precision before Three touches it',()=>{
 const gl={isContextLost:()=>false,getShaderPrecisionFormat:()=>null,VERTEX_SHADER:1,FRAGMENT_SHADER:2,HIGH_FLOAT:3,MEDIUM_FLOAT:4};
 const canvas={getContext:vi.fn(()=>gl)} as unknown as HTMLCanvasElement;
 expect(()=>faceWebGLContext(canvas)).toThrow(FACE_WEBGL_UNAVAILABLE);
 expect(canvas.getContext).toHaveBeenCalledOnce();
});
it('rejects lost or unavailable contexts with the controlled Studio message',()=>{
 for(const gl of [null,{isContextLost:()=>true}]) expect(()=>faceWebGLContext({getContext:()=>gl} as unknown as HTMLCanvasElement)).toThrow(FACE_WEBGL_UNAVAILABLE);
});
