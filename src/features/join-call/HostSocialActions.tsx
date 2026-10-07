import { useEffect, useRef, useState } from "react";

import { HostAudience } from "@/components/host/HostAudience";
import { Icon } from "@/components/ui/Icon";
import { adminRepository } from "@/services/admin/repository";
import type { EngagementChange, EngagementSnapshot } from "@/services/admin/profileEngagement";
import type { HostPreview } from "@/types/host";

export function HostSocialActions({ host, callerEmail }: { host: HostPreview; callerEmail: string }) {
  const [snapshot, setSnapshot] = useState<EngagementSnapshot>({
    followerCount: host.followerCount ?? 0, likeCount: host.likeCount ?? 0, following: false, liked: false,
  });
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const writing = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setPending(true);
    setError(null);
    void adminRepository.getProfileEngagement(host.id, callerEmail)
      .then((value) => { if (!cancelled) setSnapshot(value); })
      .catch(() => { if (!cancelled) setError("Could not load follows and likes. Please try again."); })
      .finally(() => { if (!cancelled) setPending(false); });
    return () => { cancelled = true; };
  }, [host.id, callerEmail, revision]);

  const change = async (value: EngagementChange) => {
    if (pending || writing.current) return;
    writing.current = true;
    setPending(true);
    setError(null);
    try {
      setSnapshot(await adminRepository.setProfileEngagement(host.id, callerEmail, value));
    } catch {
      setError("Could not save that change. Please try again.");
    } finally {
      writing.current = false;
      setPending(false);
    }
  };

  return (
    <div className="host-social" aria-busy={pending}>
      <HostAudience followerCount={snapshot.followerCount} likeCount={snapshot.likeCount} />
      {host.shortBio && <p className="ready-role">{host.shortBio}</p>}
      <div className="host-social-actions">
        <button type="button" className="host-follow" aria-pressed={snapshot.following}
          disabled={pending || !!error} onClick={() => void change({ following: !snapshot.following })}>
          <Icon name={snapshot.following ? "check" : "plus"} />
          {snapshot.following ? "Following" : "Follow"}
        </button>
        <button type="button" className="host-like" aria-pressed={snapshot.liked}
          disabled={pending || !!error} onClick={() => void change({ liked: !snapshot.liked })}>
          <Icon name="heart" />
          {snapshot.liked ? "Liked" : "Like"}
        </button>
      </div>
      {error && (
        <p className="host-social-error" role="alert">
          {error} <button type="button" onClick={() => setRevision((value) => value + 1)}>Try again</button>
        </p>
      )}
    </div>
  );
}

export default HostSocialActions;
