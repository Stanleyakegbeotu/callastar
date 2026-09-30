import type { ReactNode } from "react";

import { IconButton } from "@/components/ui/IconButton";
import type { LocalMediaController } from "@/types/media";

interface CallControlsProps {
  media: LocalMediaController;
  speakerOn: boolean;
  onToggleSpeaker: () => void;
  onEnd: () => void;
  /** Audio calls have no camera to show, so the camera and flip controls go. */
  showCameraControls?: boolean;
  className?: string;
}

function ControlItem({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="control-item">
      {children}
      <span>{caption}</span>
    </div>
  );
}

/**
 * The bottom control bar of an active call.
 *
 * Every control acts on the real media tracks, with two documented exceptions:
 * Flip is disabled when the device has no second camera, and Speaker only
 * carries UI state — see the note on the speaker control below.
 */
export function CallControls({
  media,
  speakerOn,
  onToggleSpeaker,
  onEnd,
  showCameraControls = true,
  className = "",
}: CallControlsProps) {
  const flipDisabled = !media.canSwitchCamera || media.isSwitchingCamera || !media.hasVideoTrack;

  return (
    <div className={`call-controls ${className}`.trim()}>
      <ControlItem caption={media.micEnabled ? "Mute" : "Unmute"}>
        <IconButton
          icon={media.micEnabled ? "mic" : "micOff"}
          label={media.micEnabled ? "Mute microphone" : "Unmute microphone"}
          active={!media.micEnabled}
          pressed={!media.micEnabled}
          onClick={media.toggleMic}
        />
      </ControlItem>

      {showCameraControls && (
        <ControlItem caption="Camera">
          <IconButton
            icon={media.cameraEnabled ? "camera" : "cameraOff"}
            label={media.cameraEnabled ? "Turn camera off" : "Turn camera on"}
            active={!media.cameraEnabled}
            pressed={!media.cameraEnabled}
            disabled={!media.hasVideoTrack}
            onClick={media.toggleCamera}
          />
        </ControlItem>
      )}

      <ControlItem caption="End">
        <IconButton icon="phone" label="End call" danger onClick={onEnd} />
      </ControlItem>

      {showCameraControls && (
        <ControlItem caption="Flip">
          <IconButton
            icon="flip"
            label="Switch camera"
            disabled={flipDisabled}
            title={media.canSwitchCamera ? undefined : "This device has only one camera"}
            onClick={() => void media.switchCamera()}
          />
        </ControlItem>
      )}

      <ControlItem caption="Speaker">
        {/*
         * Audio output routing: the web platform has no equivalent of a native
         * speaker/earpiece switch. `setSinkId` is the closest thing and it is
         * absent in Safari, so on iOS nothing can be routed programmatically at
         * all. Rather than fake it, this control carries the caller's intent
         * only; once there is a remote audio element to attach it to, a real
         * implementation goes behind `media.canSelectAudioOutput`.
         */}
        <IconButton
          icon="speaker"
          label={speakerOn ? "Turn speaker off" : "Turn speaker on"}
          active={!speakerOn}
          pressed={speakerOn}
          title={
            media.canSelectAudioOutput
              ? undefined
              : "Speaker routing is not available in this browser"
          }
          onClick={onToggleSpeaker}
        />
      </ControlItem>
    </div>
  );
}

export default CallControls;
