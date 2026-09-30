/**
 * The remote participant's surface when their media has stopped arriving.
 *
 * Shown when the uploaded reference clip reaches its natural end before the
 * subscription checkpoint is due. The clip is a stand-in for a person, so it is
 * never looped or restarted — that would be a visible lie about who is there.
 * Instead their surface, and only their surface, says the connection is being
 * restored, over the last frame they were seen in.
 *
 * Deliberately NOT phrased as a network error. A prerecorded file running out
 * is not evidence that anybody's internet failed, and claiming so would send
 * people to check a connection that is working.
 */
export function RemoteConnectionState({ variant }: { variant: "tile" | "main" }) {
  return (
    <div
      className={`remote-reconnect remote-reconnect-${variant}`}
      role="status"
      aria-live="polite"
      // One announcement, not one per frame of the spinner.
      aria-label="Reconnecting. Restoring your connection."
    >
      <span className="remote-reconnect-spinner" aria-hidden="true" />
      <span className="remote-reconnect-title" aria-hidden="true">
        Reconnecting…
      </span>
      <span className="remote-reconnect-copy" aria-hidden="true">
        Restoring your connection
      </span>
    </div>
  );
}

export default RemoteConnectionState;
