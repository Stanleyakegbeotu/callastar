interface CallaStarMarkProps {
  theme?: "light" | "dark";
  size?: number;
  className?: string;
}

/** Transparent star and call waves. Use dark for a navy or photographic surface. */
export function CallaStarMark({ theme = "light", size = 36, className = "" }: CallaStarMarkProps) {
  return (
    <img
      className={`brand-image brand-image-mark ${className}`.trim()}
      src={theme === "dark" ? "/branding/callastar-mark-light.svg" : "/branding/callastar-mark.svg"}
      width={size}
      height={size}
      style={{ height: size, width: size }}
      alt=""
      aria-hidden="true"
    />
  );
}

export default CallaStarMark;
