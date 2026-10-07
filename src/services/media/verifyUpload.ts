import { sniffMediaType } from "@/features/transformation/source/sourceAsset";
import { validateFile } from "@/services/admin/mediaFiles";
import type { AssetKind } from "@/services/admin/types";

/** Verify the bytes; browser MIME and filename are only hints. */
export async function verifyUpload(kind: AssetKind, file: File): Promise<File> {
  const header = new Uint8Array(await file.slice(0, 128).arrayBuffer());
  const text = new TextDecoder("ascii").decode(header);
  let mime: string | null = sniffMediaType(header);
  if (mime === "video/mp4" && text.slice(8, 12) === "qt  ") mime = null;
  if (kind === "remote_audio") {
    if (text.startsWith("RIFF") && text.slice(8, 12) === "WAVE") mime = "audio/wav";
    else if (text.startsWith("OggS")) mime = "audio/ogg";
    else if (text.startsWith("ID3")) mime = "audio/mpeg";
    else if (header[0] === 0xff && (header[1] & 0xf6) === 0xf0) mime = "audio/aac";
    else if (header[0] === 0xff && (header[1] & 0xe0) === 0xe0) mime = "audio/mpeg";
    else if (mime === "video/mp4" && /M4A |M4B /.test(text.slice(8, 32))) mime = "audio/mp4";
    else if (mime === "video/webm" && file.type === "audio/webm" && text.includes("webm")) mime = "audio/webm";
  }
  if (!mime) throw new Error("This file is not a supported media format. Convert iPhone images to JPEG and videos to MP4.");
  const normalized = new File([file], file.name, { type: mime, lastModified: file.lastModified });
  const check = validateFile(kind, normalized);
  if (!check.ok) throw new Error(check.message);
  return normalized;
}
