import { useState } from "react";

import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { Avatar } from "@/components/ui/Avatar";
import { IconButton } from "@/components/ui/IconButton";
import { formatDuration } from "@/lib/utils";
import type { HostPreview } from "@/types/host";
import type { LocalMediaController } from "@/types/media";

import { useCallTimer } from "./hooks/useCallTimer";

interface RingingPageProps {
  host: HostPreview;
  media: LocalMediaController;
  onEnd: () => void;
}

/** The line is ringing. Mute already acts on the real microphone track. */
export function RingingPage({ host, media, onEnd }: RingingPageProps) {
  // Counts from the moment this screen appears; the call timer proper starts
  // when the call is answered.
  const [ringingSince] = useState(() => Date.now());
  const seconds = useCallTimer(ringingSince);

  return (
    <main className="status-screen ringing-screen">
      <div className="status-brand">
        <CallaStarLogo />
      </div>
      <div className="ring-content">
        <Avatar src={host.avatarUrl} alt={`Fictional host ${host.displayName}`} pulse />
        <h1 className="ring-title">{host.displayName}</h1>
        <div className="ring-status" role="status">
          <span className="wave-bars" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Ringing…
        </div>
        <div className="ring-time">{formatDuration(seconds)}</div>
      </div>
      <div className="ring-controls">
        <div className="control-item">
          <IconButton
            icon={media.micEnabled ? "mic" : "micOff"}
            label={media.micEnabled ? "Mute microphone" : "Unmute microphone"}
            active={!media.micEnabled}
            pressed={!media.micEnabled}
            onClick={media.toggleMic}
          />
          <span>{media.micEnabled ? "Mute" : "Unmute"}</span>
        </div>
        <div className="control-item">
          <IconButton icon="phone" label="End call" danger onClick={onEnd} />
          <span>End</span>
        </div>
      </div>
    </main>
  );
}

export default RingingPage;
