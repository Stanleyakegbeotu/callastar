import { useTranslation } from "react-i18next";
import { formatAudienceCount } from "@/services/admin/profileEngagement";

export function HostAudience({ followerCount = 0, likeCount = 0 }: { followerCount?: number; likeCount?: number }) {
  const { i18n } = useTranslation();
  const full = new Intl.NumberFormat(i18n.resolvedLanguage);
  return (
    <div className="host-audience" aria-live="polite">
      <span title={`${full.format(followerCount)} followers`} aria-label={`${full.format(followerCount)} followers`}>
        <strong>{formatAudienceCount(followerCount)}</strong> <span>Followers</span>
      </span>
      <span title={`${full.format(likeCount)} likes`} aria-label={`${full.format(likeCount)} likes`}>
        <strong>{formatAudienceCount(likeCount)}</strong> <span>Likes</span>
      </span>
    </div>
  );
}

export default HostAudience;
