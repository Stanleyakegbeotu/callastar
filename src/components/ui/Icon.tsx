import type { ReactNode } from "react";

export type IconName =
  | "video"
  | "audio"
  | "arrow"
  | "check"
  | "info"
  | "lock"
  | "mic"
  | "micOff"
  | "camera"
  | "cameraOff"
  | "phone"
  | "flip"
  | "speaker"
  | "chevron"
  | "bolt"
  | "shield"
  | "user"
  | "mail"
  | "crown"
  | "close"
  | "star"
  | "chat"
  | "whatsapp"
  | "bell"
  | "settings"
  | "paperclip"
  | "send"
  | "download"
  | "reply"
  | "image"
  | "globe"
  | "trash"
  | "plus"
  | "clock"
  | "rotate"
  | "phoneOff"
  | "maximize"
  | "minimize"
  | "menu"
  | "copy"
  | "eye"
  | "pencil";

/** The icon set drawn for the approved design — paths are unchanged. */
const paths: Record<IconName, ReactNode> = {
  video: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="3" />
      <path d="m16 10 4.3-2.2a.5.5 0 0 1 .7.45v7.5a.5.5 0 0 1-.7.45L16 14" />
    </>
  ),
  audio: (
    <path d="M6.6 3.8 9 7.7 7.5 9.2a15 15 0 0 0 7.3 7.3l1.5-1.5 3.9 2.4a1.5 1.5 0 0 1 .7 1.5v1.3a1.7 1.7 0 0 1-1.8 1.7C9.8 21.2 2.8 14.2 2.1 4.9A1.7 1.7 0 0 1 3.8 3h1.3a1.5 1.5 0 0 1 1.5.8Z" />
  ),
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  check: <path d="m5 12 4 4L19 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5m0-8h.01" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="3" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0m-7 7v3" />
    </>
  ),
  micOff: (
    <path d="m3 3 18 18M9 5.5V11a3 3 0 0 0 4.7 2.5M15 10.5V6a3 3 0 0 0-5.2-2M5 11a7 7 0 0 0 11.6 5.2M19 11a7 7 0 0 1-.5 2.7M12 18v3" />
  ),
  camera: (
    <>
      <rect x="3" y="6" width="13" height="12" rx="3" />
      <path d="m16 10 5-2.5v9L16 14" />
    </>
  ),
  cameraOff: (
    <path d="m3 3 18 18M10 6h3a3 3 0 0 1 3 3v5m-2 4H6a3 3 0 0 1-3-3V9c0-.7.2-1.3.6-1.8M16 10l5-2.5v9l-2.5-1.2" />
  ),
  phone: (
    <path d="M5.5 15.2a10.5 10.5 0 0 1 13 0l1.8-2.4a2 2 0 0 0-.3-2.7 13 13 0 0 0-16 0 2 2 0 0 0-.3 2.7l1.8 2.4Z" />
  ),
  flip: (
    <>
      <path d="M20 7h-9L8 4M4 17h9l3 3" />
      <path d="M18 4.5A8 8 0 0 1 20 10M6 19.5A8 8 0 0 1 4 14" />
    </>
  ),
  speaker: (
    <>
      <path d="M5 9H2v6h3l5 4V5L5 9Z" />
      <path d="M14 9a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12" />
    </>
  ),
  chevron: <path d="m15 18-6-6 6-6" />,
  bolt: <path d="M13 2 4.5 13.2a.6.6 0 0 0 .5.95h5.2l-.7 7.4a.4.4 0 0 0 .73.27L19.5 10.8a.6.6 0 0 0-.5-.95h-5.2l.9-7.4a.4.4 0 0 0-.7-.45Z" />,
  shield: (
    <>
      <path d="M12 3.2 5.5 5.7v5.6c0 4 2.7 7.6 6.5 9 3.8-1.4 6.5-5 6.5-9V5.7L12 3.2Z" />
      <path d="m9.2 12 2 2 3.6-3.6" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="m4 7.5 8 5.5 8-5.5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  star: <path d="m12 3.5 2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.65l5.9-.85L12 3.5Z" />,
  chat: <path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H9l-4.5 3.5V16.5H4A1.5 1.5 0 0 1 2.5 15V7A1.5 1.5 0 0 1 4 5.5Z" />,
  whatsapp: (
    <>
      <path d="M12 3.4a8.6 8.6 0 0 0-7.4 12.95L3.5 20.5l4.3-1.1A8.6 8.6 0 1 0 12 3.4Z" />
      <path d="M8.9 8.2c.2-.5.4-.5.7-.5h.5c.2 0 .4 0 .6.5l.7 1.6c.1.3 0 .5-.1.7l-.4.5c-.1.2-.2.3 0 .6a6 6 0 0 0 2.6 2.3c.3.1.5.1.6-.1l.5-.6c.2-.2.4-.2.6-.1l1.5.8c.3.2.4.3.4.5 0 .4-.2 1.1-.6 1.4-.4.3-1 .5-1.7.4-1.4-.3-3-1.2-4.2-2.5-1.2-1.2-2-2.6-2.2-3.8-.1-.7 0-1.3.3-1.7Z" />
    </>
  ),
  crown: <path d="M4 17h16l1.2-8.2a.5.5 0 0 0-.8-.46L16.5 11 12.6 5.3a.7.7 0 0 0-1.2 0L7.5 11 3.6 8.34a.5.5 0 0 0-.8.46L4 17Z" />,
  bell: (
    <>
      <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16S18 14 18 9Z" />
      <path d="M10.3 19a1.9 1.9 0 0 0 3.4 0" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 14.5a1.6 1.6 0 0 0 .32 1.77l.06.06a1.9 1.9 0 1 1-2.7 2.7l-.05-.06a1.6 1.6 0 0 0-2.72 1.14v.17a1.9 1.9 0 0 1-3.8 0v-.09a1.6 1.6 0 0 0-2.8-1.06l-.06.06a1.9 1.9 0 1 1-2.7-2.7l.06-.06A1.6 1.6 0 0 0 3.7 13.7h-.17a1.9 1.9 0 0 1 0-3.8h.09A1.6 1.6 0 0 0 4.68 7.1l-.06-.06a1.9 1.9 0 1 1 2.7-2.7l.06.06a1.6 1.6 0 0 0 1.77.32h.08A1.6 1.6 0 0 0 10.2 3.3v-.17a1.9 1.9 0 0 1 3.8 0v.09a1.6 1.6 0 0 0 2.72 1.14l.06-.06a1.9 1.9 0 1 1 2.7 2.7l-.06.06a1.6 1.6 0 0 0-.32 1.77v.08a1.6 1.6 0 0 0 1.47.98h.17a1.9 1.9 0 0 1 0 3.8h-.09a1.6 1.6 0 0 0-1.45.83Z" />
    </>
  ),
  paperclip: <path d="M20.4 11.3 12 19.7a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />,
  send: <path d="M4.4 11.6 20 4.5l-7.1 15.6-1.8-6.3-6.7-2.2Z" />,
  download: (
    <>
      <path d="M12 4v10m0 0 4-4m-4 4-4-4" />
      <path d="M4.5 17.5v1a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-1" />
    </>
  ),
  reply: <path d="M9 7 4 12l5 5M4 12h9a6 6 0 0 1 6 6v1" />,
  image: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m4.5 17.5 4.7-4.2a1.6 1.6 0 0 1 2.2.05L20 20" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.3 2.4 14.7 0 17M12 3.5c-2.4 2.3-2.4 14.7 0 17" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7.5h15M9.5 7.5V5.8a1.3 1.3 0 0 1 1.3-1.3h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7" />
      <path d="M6.5 7.5 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-11.5" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  pencil: <path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  /** A phone turning upright, for the portrait orientation guard. */
  rotate: (
    <>
      <rect x="8" y="2.5" width="8" height="13" rx="1.6" />
      <path d="M11 4.6h2" />
      <path d="M4.2 14.5a8 8 0 0 0 4.6 6.4" />
      <path d="M4.6 18.4 4.2 14.5l3.8.7" />
    </>
  ),
  /** Arrows pushing outwards: take this conversation full screen. */
  maximize: (
    <>
      <path d="M9 4H4v5" />
      <path d="M15 4h5v5" />
      <path d="M15 20h5v-5" />
      <path d="M9 20H4v-5" />
    </>
  ),
  /** The same arrows pulling in: give the page back. */
  minimize: (
    <>
      <path d="M4 9h5V4" />
      <path d="M20 9h-5V4" />
      <path d="M20 15h-5v5" />
      <path d="M4 15h5v5" />
    </>
  ),
  /** A handset laid down: ending or declining, distinct from `phone`. */
  phoneOff: (
    <>
      <path d="M4.2 5.6c-.5 3.1.7 6.3 3.2 8.8s5.7 3.7 8.8 3.2l1.1-2.9-3.3-1.6-1.6 1.4a12 12 0 0 1-3.9-3.9l1.4-1.6L8.3 5.6z" />
      <path d="M4 20 20 4" />
    </>
  ),
};

export function Icon({ name, className = "size-5" }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}

export default Icon;
