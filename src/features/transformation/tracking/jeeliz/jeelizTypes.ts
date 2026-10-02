export type JeelizModel = 'default' | '4-expression';
export interface JeelizState {
  detected: number; x: number; y: number; s: number;
  rx: number; ry: number; rz: number; expressions: ArrayLike<number>;
}
export interface JeelizApi {
  create_new(): JeelizApi;
  init(options: {
    canvas: HTMLCanvasElement; NNCPath: string; maxFacesDetected: number; followZRot: boolean;
    videoSettings: { videoElement: HTMLVideoElement };
    callbackReady: (error: string | false, spec?: { videoElement: HTMLVideoElement; GL?: WebGLRenderingContext | WebGL2RenderingContext }) => void;
    callbackTrack: (state: JeelizState) => void;
  }): void;
  toggle_pause(paused: boolean, shutOffVideo: boolean): Promise<void>;
  update_videoElement(video: HTMLVideoElement, callback?: () => void): void;
  resize(): boolean;
  destroy(): Promise<void>;
}
export interface JeelizTrackingSample {
  timestamp: number; detected: number; centerX: number; centerY: number; scale: number;
  rotationX: number; rotationY: number; rotationZ: number; expressions: number[];
  mouthOpen: number | null; smile: number | null; browFrown: number | null; browRaise: number | null;
  /** Exact inference interval is not exposed by FaceFilter. */
  inferenceIntervalMs: null;
}
