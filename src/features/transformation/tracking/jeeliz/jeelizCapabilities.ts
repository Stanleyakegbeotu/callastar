import type { TrackerCapabilities } from '../trackerProvider';
import type { JeelizModel } from './jeelizTypes';
export function jeelizCapabilities(model: JeelizModel): TrackerCapabilities {
  return {
    headPose: true, translation: true, scale: true, mouthOpen: true,
    smile: model === '4-expression', browFrown: model === '4-expression', browRaise: model === '4-expression',
    denseLandmarks: false, irisLandmarks: false, gaze: false, blinkPerEye: false,
    // Library supports multiple faces; this adapter intentionally configures one controller.
    multiFace: false,
  };
}
