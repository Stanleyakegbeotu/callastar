interface AvatarProps {
  src: string;
  alt: string;
  /** Concentric rings used while the call is ringing. */
  pulse?: boolean;
}

export function Avatar({ src, alt, pulse = false }: AvatarProps) {
  return (
    <div className={`avatar-wrap ${pulse ? "avatar-pulse" : ""}`.trim()}>
      <img src={src} alt={alt} className="avatar" />
    </div>
  );
}

export default Avatar;
