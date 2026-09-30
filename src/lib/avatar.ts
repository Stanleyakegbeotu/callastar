import { getInitials } from "./utils";

/**
 * A deterministic initials avatar, drawn as an inline SVG data URL.
 *
 * Used wherever a profile has no uploaded image. It is a lettermark, never a
 * generated face: a placeholder must not look like a person who does not exist.
 * Being a data URL, it drops straight into an `<img src>` with no object-URL
 * lifecycle to manage.
 */
export function initialsAvatarDataUrl(name: string, size = 256): string {
  const initials = getInitials(name);
  const fontSize = Math.round(size * 0.38);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${initials}">
  <rect width="${size}" height="${size}" fill="#eef3ff"/>
  <text x="50%" y="50%" dy="0.35em" text-anchor="middle" fill="#2f5bd7"
    font-family="Inter, ui-sans-serif, system-ui, sans-serif" font-size="${fontSize}" font-weight="700"
    letter-spacing="1">${initials}</text>
</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
