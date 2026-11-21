/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The launch splash (native.splash): one PNG, `assets/vr_splash.png`, that
 * serves twice.
 *
 * 1. Horizon OS shows it as the system splash while the app's process starts
 *    (Meta's "Add a Splash Screen" documentation: the file name and location,
 *    plus `<meta-data android:name="com.oculus.ossplash" android:value="true"/>`
 *    on the application, which manifest.ts adds). The system removes it on the
 *    app's first frame.
 * 2. The runtime's loading screen (runtime/xr loading.h) shows the same image
 *    from its first frame, at the system splash's distance and size, with an
 *    animated spinner, until the web app renders its first XR frame.
 *
 * By default the image is generated here: the app's icon above its name, on
 * transparency (the system draws it over black; the runtime over the
 * configured background). Developers can supply their own PNG instead.
 */

import { readFileSync } from 'node:fs';
import {
  decodePng,
  encodePng,
  isPng,
  isWebp,
  resize,
  type RgbaImage,
} from './png.ts';
import {
  codePoints,
  drawText,
  measureText,
  missingGlyphs,
  parseTrueType,
  type TrueTypeFont,
} from './ttf.ts';

/** Where Horizon OS looks for the system splash image (and the runtime too). */
export const SPLASH_ENTRY = 'assets/vr_splash.png';
/** The same file as the runtime config names it (relative to assets/). */
export const SPLASH_RUNTIME_IMAGE = 'vr_splash.png';
/** The font the template ships for Canvas 2D (C2D-9), used for the app name. */
export const SPLASH_FONT_ENTRY = 'assets/iwn/fonts/Roboto-Bold.ttf';

/** Generated card size: 2:1, so Horizon OS fits it to 20 degrees tall (about 39 wide). */
export const CARD_WIDTH = 1024;
export const CARD_HEIGHT = 512;
/** Meta's best-practice limit for splash artwork ("keep artwork within 1500x1500px"). */
export const MAX_SPLASH_SIDE = 1500;
/** The runtime decodes at most this many pixels per side (and scales down to 2048). */
export const HARD_MAX_SPLASH_SIDE = 4096;

const MARGIN = 48;
const ICON_SIZE = 208;
const ICON_ONLY_SIZE = 256;
const GAP = 40;
const NAME_MAX_PX = 80;
const NAME_ONLY_MAX_PX = 104;
const NAME_MIN_PX = 44;

export interface SplashCardInput {
  appName: string;
  /** Decoded icon (straight alpha), or null. */
  icon: RgbaImage | null;
  /** The font for the name, or null (icon only). */
  font: TrueTypeFont | null;
}

export interface SplashCard {
  image: RgbaImage;
  /** The text drawn (possibly shortened with an ellipsis), or null. */
  text: string | null;
  fontPx: number;
  icon: boolean;
  warnings: string[];
}

/** Draw the default splash card: icon above the app name, centred, on transparency. */
export function renderSplashCard(input: SplashCardInput): SplashCard {
  const warnings: string[] = [];
  const W = CARD_WIDTH;
  const H = CARD_HEIGHT;
  const out: RgbaImage = {
    width: W,
    height: H,
    data: new Uint8Array(W * H * 4),
  };

  // The name: fitted to the width, shortened with an ellipsis as a last resort.
  let text: string | null = input.appName.trim() || null;
  let fontPx = 0;
  const font = input.font;
  if (text && !font) {
    warnings.push('no font in the template: the splash shows the icon only');
    text = null;
  }
  if (text && font) {
    const missing = missingGlyphs(font, text);
    if (missing.length > 0) {
      warnings.push(
        `the app name has characters the bundled font cannot draw (${missing.slice(0, 5).join(' ')}): the splash shows the icon only; set native.splash.image to use your own artwork`,
      );
      text = null;
    }
  }
  if (text && font) {
    const avail = W - 2 * MARGIN;
    const max = input.icon ? NAME_MAX_PX : NAME_ONLY_MAX_PX;
    fontPx = max;
    const w = measureText(font, text, fontPx);
    if (w > avail)
      fontPx = Math.max(NAME_MIN_PX, Math.floor((max * avail) / w));
    if (measureText(font, text, fontPx) > avail) {
      const cps = codePoints(text);
      while (
        cps.length > 1 &&
        measureText(font, `${String.fromCodePoint(...cps)}…`, fontPx) > avail
      )
        cps.pop();
      text = `${String.fromCodePoint(...cps).trimEnd()}…`;
    }
  }

  const iconSize = text ? ICON_SIZE : ICON_ONLY_SIZE;
  const capPx = text && font ? (font.capHeight / font.unitsPerEm) * fontPx : 0;
  const blockH =
    (input.icon ? iconSize : 0) + (input.icon && text ? GAP : 0) + capPx;
  const top = Math.round((H - blockH) / 2);
  if (input.icon) {
    const icon = roundedIcon(input.icon, iconSize);
    composite(out, icon, Math.round((W - iconSize) / 2), top);
  }
  if (text && font) {
    const width = measureText(font, text, fontPx);
    const baseline = top + (input.icon ? iconSize + GAP : 0) + capPx;
    const mask = drawText(font, text, fontPx, (W - width) / 2, baseline, W, H);
    for (let i = 0; i < W * H; i++) {
      const a = mask.data[i];
      if (a === 0) continue;
      overPixel(out.data, i * 4, 255, 255, 255, a);
    }
  }
  if (!input.icon && !text)
    warnings.push('no icon and no name to draw: the splash is empty');
  return { image: out, text, fontPx, icon: !!input.icon, warnings };
}

/** The icon scaled to `size`, with rounded corners (an app-icon tile). */
export function roundedIcon(icon: RgbaImage, size: number): RgbaImage {
  const img = resize(icon, size, size);
  const data = new Uint8Array(img.data);
  const r = size * 0.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Distance outside the rounded square (negative inside), 1 px anti-aliasing band.
      const cx = Math.min(Math.max(x + 0.5, r), size - r);
      const cy = Math.min(Math.max(y + 0.5, r), size - r);
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r;
      const m = Math.min(1, Math.max(0, 0.5 - d));
      const o = (y * size + x) * 4 + 3;
      data[o] = Math.round(data[o] * m);
    }
  }
  return { width: size, height: size, data };
}

/** Straight-alpha "source over" of one pixel. */
function overPixel(
  dst: Uint8Array,
  o: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const sa = a / 255;
  const da = dst[o + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  dst[o] = Math.round((r * sa + dst[o] * da * (1 - sa)) / oa);
  dst[o + 1] = Math.round((g * sa + dst[o + 1] * da * (1 - sa)) / oa);
  dst[o + 2] = Math.round((b * sa + dst[o + 2] * da * (1 - sa)) / oa);
  dst[o + 3] = Math.round(oa * 255);
}

function composite(
  dst: RgbaImage,
  src: RgbaImage,
  x0: number,
  y0: number,
): void {
  for (let y = 0; y < src.height; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      if (src.data[s + 3] === 0) continue;
      overPixel(
        dst.data,
        (dy * dst.width + dx) * 4,
        src.data[s],
        src.data[s + 1],
        src.data[s + 2],
        src.data[s + 3],
      );
    }
  }
}

export interface SplashBuildInput {
  appName: string;
  /** Absolute path of the configured icon (PNG decodes; WebP cannot be drawn here). */
  iconFile: string | null;
  /** The template's generated placeholder icon, used when no icon is configured. */
  defaultIcon: RgbaImage | null;
  /** Absolute path of native.splash.image, or null to generate the card. */
  imageFile: string | null;
  /** The template's font bytes, or null. */
  fontBytes: Buffer | null;
}

export interface SplashBuild {
  png: Buffer;
  width: number;
  height: number;
  source: 'image' | 'generated';
  /** What the generated card shows. */
  text: string | null;
  icon: boolean;
  warnings: string[];
}

export class SplashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SplashError';
  }
}

/** The PNG to ship as assets/vr_splash.png. */
export function buildSplash(input: SplashBuildInput): SplashBuild {
  if (input.imageFile) {
    const bytes = readFileSync(input.imageFile);
    if (!isPng(bytes))
      throw new SplashError(
        `splash image ${input.imageFile} is not a PNG (Horizon OS reads the system splash as vr_splash.png)`,
      );
    const img = decodePng(bytes); // validates the file
    if (img.width > HARD_MAX_SPLASH_SIDE || img.height > HARD_MAX_SPLASH_SIDE)
      throw new SplashError(
        `splash image ${input.imageFile} is ${img.width}x${img.height}; the runtime takes at most ${HARD_MAX_SPLASH_SIDE} px per side (Meta recommends ${MAX_SPLASH_SIDE}x${MAX_SPLASH_SIDE})`,
      );
    const warnings: string[] = [];
    if (img.width > MAX_SPLASH_SIDE || img.height > MAX_SPLASH_SIDE)
      warnings.push(
        `splash image ${input.imageFile} is ${img.width}x${img.height}; Meta recommends at most ${MAX_SPLASH_SIDE}x${MAX_SPLASH_SIDE} px`,
      );
    return {
      png: bytes,
      width: img.width,
      height: img.height,
      source: 'image',
      text: null,
      icon: false,
      warnings,
    };
  }
  const warnings: string[] = [];
  let icon: RgbaImage | null = input.defaultIcon;
  if (input.iconFile) {
    const bytes = readFileSync(input.iconFile);
    if (isPng(bytes)) icon = decodePng(bytes);
    else if (isWebp(bytes)) {
      icon = null;
      warnings.push(
        'the icon is WebP, which the packer cannot draw: the generated splash shows the app name only (use a PNG icon or native.splash.image)',
      );
    }
  }
  let font: TrueTypeFont | null = null;
  if (input.fontBytes) {
    try {
      font = parseTrueType(input.fontBytes);
    } catch (e) {
      warnings.push(
        `the template's font cannot be read (${(e as Error).message}): no app name on the splash`,
      );
    }
  }
  const card = renderSplashCard({ appName: input.appName, icon, font });
  return {
    png: encodePng(card.image),
    width: card.image.width,
    height: card.image.height,
    source: 'generated',
    text: card.text,
    icon: card.icon,
    warnings: [...warnings, ...card.warnings],
  };
}
