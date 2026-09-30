import { describe, expect, it } from "vitest";

import { SOURCE_LIMITS, kindOf, sniffMediaType, sourceFromFile, validateSourceFile } from "./sourceAsset";

/**
 * Deciding what a source file actually is.
 *
 * The failure worth preventing: a browser fills `File.type` from the extension
 * on most platforms, so a video renamed `.jpg` arrives claiming to be an image.
 * Trusting that sends it to an image decoder, where it fails as something
 * unrecognisable a long way from the cause.
 */

function bytes(...values: number[]): Uint8Array {
  const buffer = new Uint8Array(SOURCE_LIMITS.signatureBytes);
  buffer.set(values.slice(0, buffer.length));
  return buffer;
}

function fileFrom(header: Uint8Array, name: string, declaredType: string, size = header.length): File {
  // One contiguous buffer: a typed-array view is not a `BlobPart` under the
  // current lib types, and the padding only exists to give the file a size.
  const buffer = new ArrayBuffer(Math.max(header.length, size));
  new Uint8Array(buffer).set(header);
  return new File([buffer], name, { type: declaredType });
}

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
const MP4 = bytes(0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d);
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3);

describe("signatures", () => {
  it("recognises the formats this project accepts", () => {
    expect(sniffMediaType(JPEG)).toBe("image/jpeg");
    expect(sniffMediaType(PNG)).toBe("image/png");
    expect(sniffMediaType(WEBP)).toBe("image/webp");
    expect(sniffMediaType(MP4)).toBe("video/mp4");
    expect(sniffMediaType(WEBM)).toBe("video/webm");
  });

  it("does not mistake a RIFF container for WebP", () => {
    // A WAV file is also RIFF; only the WEBP marker at offset 8 decides.
    const wav = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45);
    expect(sniffMediaType(wav)).toBeNull();
  });

  it("says nothing rather than guessing at an unknown format", () => {
    expect(sniffMediaType(bytes(0x00, 0x01, 0x02, 0x03))).toBeNull();
    expect(sniffMediaType(new Uint8Array(0))).toBeNull();
  });

  it("maps each type to its kind", () => {
    expect(kindOf("image/jpeg")).toBe("image");
    expect(kindOf("image/webp")).toBe("image");
    expect(kindOf("video/mp4")).toBe("video");
    expect(kindOf("video/webm")).toBe("video");
  });
});

describe("validation", () => {
  it("accepts an ordinary image and video", async () => {
    await expect(validateSourceFile(fileFrom(JPEG, "face.jpg", "image/jpeg"))).resolves.toMatchObject({
      ok: true,
      kind: "image",
      mimeType: "image/jpeg",
    });

    await expect(validateSourceFile(fileFrom(MP4, "clip.mp4", "video/mp4"))).resolves.toMatchObject({
      ok: true,
      kind: "video",
    });
  });

  it("believes the bytes over the filename", async () => {
    /*
     * The case this exists for.
     *
     * An MP4 named `.jpg`, which most browsers will declare as `image/jpeg`.
     * The bytes say video, so it is a video.
     */
    const disguised = fileFrom(MP4, "portrait.jpg", "image/jpeg");
    await expect(validateSourceFile(disguised)).resolves.toMatchObject({ ok: true, kind: "video" });
  });

  it("measures size against the kind the bytes say it is", async () => {
    // A 30MB video renamed `.png` must not slip under the image ceiling.
    const bigVideo = fileFrom(MP4, "clip.png", "image/png", SOURCE_LIMITS.maxImageBytes + 1);
    await expect(validateSourceFile(bigVideo)).resolves.toMatchObject({ ok: true, kind: "video" });

    const hugeImage = fileFrom(JPEG, "huge.jpg", "image/jpeg", SOURCE_LIMITS.maxImageBytes + 1);
    const result = await validateSourceFile(hugeImage);
    expect(result.ok).toBe(false);
  });

  it("refuses a format this project does not accept", async () => {
    const gif = fileFrom(bytes(0x47, 0x49, 0x46, 0x38), "loop.gif", "image/gif");
    const result = await validateSourceFile(gif);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/JPEG, PNG or WebP/);
  });

  it("refuses a Matroska file wearing a WebM signature", async () => {
    // EBML is shared. Broadening the codec set because a browser might cope
    // would ship a path nobody has run.
    const mkv = fileFrom(WEBM, "clip.mkv", "video/x-matroska");
    const result = await validateSourceFile(mkv);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/Matroska/);
  });

  it("accepts a WebM that declares itself honestly", async () => {
    await expect(validateSourceFile(fileFrom(WEBM, "clip.webm", "video/webm"))).resolves.toMatchObject({
      ok: true,
      kind: "video",
    });
  });

  it("refuses an empty file", async () => {
    const empty = new File([], "nothing.jpg", { type: "image/jpeg" });
    const result = await validateSourceFile(empty);
    expect(result.ok).toBe(false);
  });

  it("refuses a video past its own ceiling", async () => {
    const huge = fileFrom(MP4, "long.mp4", "video/mp4", SOURCE_LIMITS.maxVideoBytes + 1);
    const result = await validateSourceFile(huge);
    expect(result.ok).toBe(false);
  });
});

describe("building an asset", () => {
  it("produces a temporary asset with no stored id", async () => {
    // A direct upload is never written to storage, so it has no asset id and
    // nothing to clean up beyond the blob itself.
    const asset = await sourceFromFile(fileFrom(JPEG, "face.jpg", "image/jpeg"));

    expect(asset).toMatchObject({ kind: "image", mimeType: "image/jpeg", fileName: "face.jpg", assetId: null });
  });

  it("returns the reason a file was refused", async () => {
    const asset = await sourceFromFile(fileFrom(bytes(0x00), "mystery.bin", "application/octet-stream"));
    expect(asset).toHaveProperty("error");
  });
});
