import { expect, it } from "vitest";
import { verifyUpload } from "./verifyUpload";
it("accepts JPEG bytes despite a wrong extension and corrects the stored MIME", async () => {
  const file = new File([new Uint8Array([255,216,255,224])], "photo.png", { type: "image/png" });
  expect((await verifyUpload("avatar", file)).type).toBe("image/jpeg");
});
it("rejects video masquerading as an image and unsupported iPhone MOV", async () => {
  const mp4 = new File([new Uint8Array([0,0,0,24]), "ftypisom"], "image.jpg", { type: "image/jpeg" });
  await expect(verifyUpload("avatar", mp4)).rejects.toThrow("image");
  const mov = new File([new Uint8Array([0,0,0,24]), "ftypqt  "], "video.mp4", { type: "video/mp4" });
  await expect(verifyUpload("remote_video", mov)).rejects.toThrow("supported media");
});
