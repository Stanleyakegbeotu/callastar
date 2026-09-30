import { CallaStarLogo } from "@/components/branding/CallaStarLogo";
import { Avatar } from "@/components/ui/Avatar";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/Spinner";
import type { HostPreview } from "@/types/host";

interface ConnectingPageProps {
  host: HostPreview;
  title: string;
  copy: string;
}

/**
 * Covers everything before the line is ringing: preparing the session, waiting
 * on the device prompt, and connecting. Same screen throughout, with wording
 * that matches what is actually happening.
 */
export function ConnectingPage({ host, title, copy }: ConnectingPageProps) {
  return (
    <main className="status-screen">
      <div className="status-brand">
        <CallaStarLogo />
      </div>
      <div className="status-content">
        <Avatar src={host.avatarUrl} alt={`Fictional host ${host.displayName}`} />
        <Spinner label={title} />
        <h1 className="status-title" role="status">
          {title}
        </h1>
        <p className="status-copy">{copy}</p>
        <div className="secure-pill">
          <Icon name="lock" className="size-4" />
          Secure connection
        </div>
      </div>
    </main>
  );
}

export default ConnectingPage;
