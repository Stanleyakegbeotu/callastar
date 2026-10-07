import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const publicDir = join(process.cwd(), "public");
const iconSvg = await readFile(join(publicDir, "branding", "callastar-icon.svg"), "utf8");
const maskableSvg = await readFile(join(publicDir, "branding", "callastar-maskable.svg"), "utf8");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();

  async function rasterize(svg, size, background = null) {
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    const pngBase64 = await page.evaluate(
      async ({ dataUrl, size, background }) => {
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D is unavailable");
        if (background) {
          context.fillStyle = background;
          context.fillRect(0, 0, size, size);
        }
        context.drawImage(image, 0, 0, size, size);
        return canvas.toDataURL("image/png").split(",")[1];
      },
      { dataUrl, size, background },
    );
    return Buffer.from(pngBase64, "base64");
  }

  const favicon = await rasterize(iconSvg, 32);
  const icoHeader = Buffer.alloc(22);
  icoHeader.writeUInt16LE(1, 2); // ICO image type.
  icoHeader.writeUInt16LE(1, 4); // One image.
  icoHeader[6] = 32;
  icoHeader[7] = 32;
  icoHeader.writeUInt16LE(1, 10);
  icoHeader.writeUInt16LE(32, 12);
  icoHeader.writeUInt32LE(favicon.length, 14);
  icoHeader.writeUInt32LE(22, 18);

  await Promise.all([
    writeFile(join(publicDir, "favicon.svg"), iconSvg),
    writeFile(join(publicDir, "favicon.ico"), Buffer.concat([icoHeader, favicon])),
    writeFile(join(publicDir, "apple-touch-icon.png"), await rasterize(iconSvg, 180, "#FFFFFF")),
    writeFile(join(publicDir, "pwa-192x192.png"), await rasterize(iconSvg, 192)),
    writeFile(join(publicDir, "pwa-512x512.png"), await rasterize(iconSvg, 512)),
    writeFile(join(publicDir, "maskable-icon-512x512.png"), await rasterize(maskableSvg, 512)),
  ]);
} finally {
  await browser.close();
}
