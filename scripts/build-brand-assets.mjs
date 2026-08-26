// Turns the raw logo exports in assets/brand/source/ into the sizes the
// dashboard, the browser tab and the README actually need.
//
//   npm run brand:assets
//
// Sharp is a devDependency: the generated files under public/brand/ are
// committed, so a normal install never needs it.

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "assets", "brand", "source");
const OUT = join(__dirname, "..", "public", "brand");

// The wordmark and the plain mark were exported on a white card. Anything that
// close to white becomes transparent so they sit on a dark dashboard without a
// white box around them; the 235..250 band is feathered so the rounded strokes
// don't get a hard staircase edge.
async function whiteToAlpha(input) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
    if (lum >= 250) data[i + 3] = 0;
    else if (lum > 235) data[i + 3] = Math.round(((250 - lum) / 15) * 255);
  }

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

async function write(name, buffer) {
  await writeFile(join(OUT, name), buffer);
  console.log(`  ${name}  ${(buffer.length / 1024).toFixed(1)} KB`);
}

await mkdir(OUT, { recursive: true });

// --- App icon (the dark rounded tile) -------------------------------------
// Used for the favicon, the PWA manifest and the sidebar badge. It reads on
// light and dark backgrounds alike, which the white-card variants don't.
const icon = join(SRC, "icon.png");
for (const size of [512, 192, 180, 32, 16]) {
  const name =
    size === 180 ? "apple-touch-icon.png" : `icon-${size}.png`;
  await write(
    name,
    await sharp(icon)
      .resize(size, size, { fit: "cover" })
      .png({ compressionLevel: 9 })
      .toBuffer()
  );
}
await write(
  "icon-512.webp",
  await sharp(icon).resize(512, 512, { fit: "cover" }).webp({ quality: 90 }).toBuffer()
);

// --- Wordmark (logo + "Levix") --------------------------------------------
const wordmark = await whiteToAlpha(join(SRC, "wordmark.png"));
const wordmarkTrimmed = await sharp(wordmark).trim({ threshold: 1 }).toBuffer();
await write(
  "wordmark.png",
  await sharp(wordmarkTrimmed).resize({ height: 160 }).png({ compressionLevel: 9 }).toBuffer()
);
await write(
  "wordmark.webp",
  await sharp(wordmarkTrimmed).resize({ height: 160 }).webp({ quality: 92 }).toBuffer()
);

// --- Mark only (no text) ---------------------------------------------------
const mark = await whiteToAlpha(join(SRC, "mark.png"));
const markTrimmed = await sharp(mark).trim({ threshold: 1 }).toBuffer();
await write(
  "mark.png",
  await sharp(markTrimmed).resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png({ compressionLevel: 9 }).toBuffer()
);
await write(
  "mark.webp",
  await sharp(markTrimmed).resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 92 }).toBuffer()
);

// --- Banner (README hero / GitHub social preview) --------------------------
const banner = join(SRC, "banner.png");
// JPEG, not PNG: it is a soft gradient, and the PNG of it was ~850 KB.
await write(
  "banner.jpg",
  await sharp(banner).resize({ width: 1280 }).jpeg({ quality: 88, mozjpeg: true }).toBuffer()
);
await write(
  "banner.webp",
  await sharp(banner).resize({ width: 1280 }).webp({ quality: 88 }).toBuffer()
);

console.log("\nBrand assets written to public/brand/");
