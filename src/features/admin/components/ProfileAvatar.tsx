import { getInitials } from "@/lib/utils";
import { useAssetUrl } from "../hooks/useAdminData";

interface ProfileAvatarProps {
  name: string;
  assetId: string | null;
  size?: "sm" | "md" | "lg";
}

/**
 * Profile image with a deterministic initials fallback. The blob is only read
 * when an avatar exists, and the object URL is revoked by the hook.
 */
export function ProfileAvatar({ name, assetId, size = "md" }: ProfileAvatarProps) {
  const url = useAssetUrl(assetId);

  return (
    <span className={`admin-avatar admin-avatar-${size}`}>
      {url ? <img src={url} alt="" /> : <span aria-hidden="true">{getInitials(name)}</span>}
    </span>
  );
}

export default ProfileAvatar;
