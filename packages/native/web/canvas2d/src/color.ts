/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * CSS <color> parsing for canvas styles (C2D-6): named colours, `transparent`, `currentcolor` (black: a
 * canvas here has no element style), #rgb/#rgba/#rrggbb/#rrggbbaa, rgb()/rgba() and hsl()/hsla() in legacy
 * (comma) and modern (space, `/ alpha`) syntax, hwb(), and the CSS Color 4 spaces lab(), lch(), oklab(), oklch()
 * and color(srgb | srgb-linear | display-p3 | a98-rgb | prophoto-rgb | rec2020 | xyz | xyz-d50 | xyz-d65 ...),
 * converted to sRGB with the CSS Color 4 conversion formulas and matrices and clipped to the sRGB gamut (the canvas
 * draws in sRGB). Those keep their own serialization ("lab(50 40 59.5)"), as browsers report them. Written from CSS
 * Color Module Level 4. Not supported (ignored like any invalid value): system colours, relative colour syntax.
 *
 * Colours are kept as 8-bit RGBA, the precision browsers keep for canvas colours.
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number; // 0..255
  /** Serialization for colours given in a CSS Color 4 space other than sRGB ("oklch(0.7 0.1 200)"). */
  css?: string;
}

const NAMED: Record<string, number> = {
  aliceblue: 0xf0f8ff,
  antiquewhite: 0xfaebd7,
  aqua: 0x00ffff,
  aquamarine: 0x7fffd4,
  azure: 0xf0ffff,
  beige: 0xf5f5dc,
  bisque: 0xffe4c4,
  black: 0x000000,
  blanchedalmond: 0xffebcd,
  blue: 0x0000ff,
  blueviolet: 0x8a2be2,
  brown: 0xa52a2a,
  burlywood: 0xdeb887,
  cadetblue: 0x5f9ea0,
  chartreuse: 0x7fff00,
  chocolate: 0xd2691e,
  coral: 0xff7f50,
  cornflowerblue: 0x6495ed,
  cornsilk: 0xfff8dc,
  crimson: 0xdc143c,
  cyan: 0x00ffff,
  darkblue: 0x00008b,
  darkcyan: 0x008b8b,
  darkgoldenrod: 0xb8860b,
  darkgray: 0xa9a9a9,
  darkgreen: 0x006400,
  darkgrey: 0xa9a9a9,
  darkkhaki: 0xbdb76b,
  darkmagenta: 0x8b008b,
  darkolivegreen: 0x556b2f,
  darkorange: 0xff8c00,
  darkorchid: 0x9932cc,
  darkred: 0x8b0000,
  darksalmon: 0xe9967a,
  darkseagreen: 0x8fbc8f,
  darkslateblue: 0x483d8b,
  darkslategray: 0x2f4f4f,
  darkslategrey: 0x2f4f4f,
  darkturquoise: 0x00ced1,
  darkviolet: 0x9400d3,
  deeppink: 0xff1493,
  deepskyblue: 0x00bfff,
  dimgray: 0x696969,
  dimgrey: 0x696969,
  dodgerblue: 0x1e90ff,
  firebrick: 0xb22222,
  floralwhite: 0xfffaf0,
  forestgreen: 0x228b22,
  fuchsia: 0xff00ff,
  gainsboro: 0xdcdcdc,
  ghostwhite: 0xf8f8ff,
  gold: 0xffd700,
  goldenrod: 0xdaa520,
  gray: 0x808080,
  green: 0x008000,
  greenyellow: 0xadff2f,
  grey: 0x808080,
  honeydew: 0xf0fff0,
  hotpink: 0xff69b4,
  indianred: 0xcd5c5c,
  indigo: 0x4b0082,
  ivory: 0xfffff0,
  khaki: 0xf0e68c,
  lavender: 0xe6e6fa,
  lavenderblush: 0xfff0f5,
  lawngreen: 0x7cfc00,
  lemonchiffon: 0xfffacd,
  lightblue: 0xadd8e6,
  lightcoral: 0xf08080,
  lightcyan: 0xe0ffff,
  lightgoldenrodyellow: 0xfafad2,
  lightgray: 0xd3d3d3,
  lightgreen: 0x90ee90,
  lightgrey: 0xd3d3d3,
  lightpink: 0xffb6c1,
  lightsalmon: 0xffa07a,
  lightseagreen: 0x20b2aa,
  lightskyblue: 0x87cefa,
  lightslategray: 0x778899,
  lightslategrey: 0x778899,
  lightsteelblue: 0xb0c4de,
  lightyellow: 0xffffe0,
  lime: 0x00ff00,
  limegreen: 0x32cd32,
  linen: 0xfaf0e6,
  magenta: 0xff00ff,
  maroon: 0x800000,
  mediumaquamarine: 0x66cdaa,
  mediumblue: 0x0000cd,
  mediumorchid: 0xba55d3,
  mediumpurple: 0x9370db,
  mediumseagreen: 0x3cb371,
  mediumslateblue: 0x7b68ee,
  mediumspringgreen: 0x00fa9a,
  mediumturquoise: 0x48d1cc,
  mediumvioletred: 0xc71585,
  midnightblue: 0x191970,
  mintcream: 0xf5fffa,
  mistyrose: 0xffe4e1,
  moccasin: 0xffe4b5,
  navajowhite: 0xffdead,
  navy: 0x000080,
  oldlace: 0xfdf5e6,
  olive: 0x808000,
  olivedrab: 0x6b8e23,
  orange: 0xffa500,
  orangered: 0xff4500,
  orchid: 0xda70d6,
  palegoldenrod: 0xeee8aa,
  palegreen: 0x98fb98,
  paleturquoise: 0xafeeee,
  palevioletred: 0xdb7093,
  papayawhip: 0xffefd5,
  peachpuff: 0xffdab9,
  peru: 0xcd853f,
  pink: 0xffc0cb,
  plum: 0xdda0dd,
  powderblue: 0xb0e0e6,
  purple: 0x800080,
  rebeccapurple: 0x663399,
  red: 0xff0000,
  rosybrown: 0xbc8f8f,
  royalblue: 0x4169e1,
  saddlebrown: 0x8b4513,
  salmon: 0xfa8072,
  sandybrown: 0xf4a460,
  seagreen: 0x2e8b57,
  seashell: 0xfff5ee,
  sienna: 0xa0522d,
  silver: 0xc0c0c0,
  skyblue: 0x87ceeb,
  slateblue: 0x6a5acd,
  slategray: 0x708090,
  slategrey: 0x708090,
  snow: 0xfffafa,
  springgreen: 0x00ff7f,
  steelblue: 0x4682b4,
  tan: 0xd2b48c,
  teal: 0x008080,
  thistle: 0xd8bfd8,
  tomato: 0xff6347,
  turquoise: 0x40e0d0,
  violet: 0xee82ee,
  wheat: 0xf5deb3,
  white: 0xffffff,
  whitesmoke: 0xf5f5f5,
  yellow: 0xffff00,
  yellowgreen: 0x9acd32,
};

const cache = new Map<string, RGBA | null>();

/** Parses a CSS colour; null when invalid. Results are cached (canvas code sets the same strings often). */
export function parseColor(input: string): RGBA | null {
  const hit = cache.get(input);
  if (hit !== undefined) return hit;
  const v = parseUncached(input);
  if (cache.size > 512) cache.clear();
  cache.set(input, v);
  return v;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function parseUncached(input: string): RGBA | null {
  const s = input.trim().toLowerCase();
  if (s.length === 0) return null;
  if (s[0] === '#') return parseHex(s.slice(1));
  const named = NAMED[s];
  if (named !== undefined)
    return { r: named >> 16, g: (named >> 8) & 255, b: named & 255, a: 255 };
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s === 'currentcolor') return { r: 0, g: 0, b: 0, a: 255 };
  const open = s.indexOf('(');
  if (open <= 0 || s[s.length - 1] !== ')') return null;
  const fn = s.slice(0, open).trim();
  const body = s.slice(open + 1, -1).trim();
  switch (fn) {
    case 'rgb':
    case 'rgba':
      return parseRgb(body);
    case 'hsl':
    case 'hsla':
      return parseHsl(body);
    case 'hwb':
      return parseHwb(body);
    case 'lab':
    case 'lch':
    case 'oklab':
    case 'oklch':
      return parseLabLike(fn, body);
    case 'color':
      return parseColorFn(body);
    default:
      return null;
  }
}

// --- CSS Color 4 spaces ----------------------------------------------------------------------------

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3];

function mul(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

// CSS Color 4 §18 (sample code) matrices.
const XYZ65_TO_LIN_SRGB: Mat3 = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
];
const D50_TO_D65: Mat3 = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];
const LIN_P3_TO_XYZ65: Mat3 = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976],
];
const LIN_A98_TO_XYZ65: Mat3 = [
  [0.5766690429101305, 0.1855582379065463, 0.1882286462349947],
  [0.29734497525053605, 0.6273635662554661, 0.07529145849399788],
  [0.02703136138641234, 0.07068885253582723, 0.9913375368376388],
];
const LIN_REC2020_TO_XYZ65: Mat3 = [
  [0.6369580483012914, 0.14461690358620832, 0.1688809751641721],
  [0.2627002120112671, 0.6779980715188708, 0.05930171646986196],
  [0, 0.028072693049087428, 1.060985057710791],
];
const LIN_PROPHOTO_TO_XYZ50: Mat3 = [
  [0.7977604896723027, 0.13518583717574031, 0.0313493495815248],
  [0.2880711282292934, 0.7118432178101014, 0.00008565396060525902],
  [0, 0, 0.8251046025104601],
];

function signedPow(v: number, e: number): number {
  return Math.sign(v) * Math.abs(v) ** e;
}
function srgbEncode(c: number): number {
  const a = Math.abs(c);
  return a <= 0.0031308
    ? 12.92 * c
    : Math.sign(c) * (1.055 * a ** (1 / 2.4) - 0.055);
}
function srgbDecode(c: number): number {
  const a = Math.abs(c);
  return a <= 0.04045 ? c / 12.92 : Math.sign(c) * ((a + 0.055) / 1.055) ** 2.4;
}

function labToXyz50(L: number, a: number, b: number): Vec3 {
  const k = 24389 / 27;
  const e = 216 / 24389;
  const f1 = (L + 16) / 116;
  const f0 = a / 500 + f1;
  const f2 = f1 - b / 200;
  const x = f0 ** 3 > e ? f0 ** 3 : (116 * f0 - 16) / k;
  const y = L > k * e ? ((L + 16) / 116) ** 3 : L / k;
  const z = f2 ** 3 > e ? f2 ** 3 : (116 * f2 - 16) / k;
  return [x * (0.3457 / 0.3585), y, z * ((1 - 0.3457 - 0.3585) / 0.3585)];
}

function oklabToLinSrgb(L: number, a: number, b: number): Vec3 {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Linear-light sRGB (any range) -> 8-bit, gamut clipped. */
function fromLinear(lin: Vec3, a: number, css: string): RGBA {
  return {
    r: clamp255(srgbEncode(lin[0]) * 255),
    g: clamp255(srgbEncode(lin[1]) * 255),
    b: clamp255(srgbEncode(lin[2]) * 255),
    a,
    css,
  };
}

/** Number as browsers serialize colour components (up to 6 decimals, no trailing zeros). */
function fmt(v: number): string {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
}

function modernArgs(
  body: string,
  count: number,
): { parts: string[]; alpha: string | null } | null {
  if (body.includes(',')) return null;
  const slash = body.split('/');
  if (slash.length > 2) return null;
  const parts = slash[0]!.trim().split(/\s+/);
  if (parts.length !== count) return null;
  let alpha: string | null = null;
  if (slash.length === 2) {
    alpha = slash[1]!.trim();
    if (alpha === '' || /\s/.test(alpha)) return null;
  }
  return { parts, alpha };
}

function alphaSuffix(a: number, alphaTok: Token | undefined): string {
  if (!alphaTok || a === 255) return '';
  const v =
    alphaTok.unit === 'none'
      ? 0
      : alphaTok.unit === '%'
        ? alphaTok.value / 100
        : alphaTok.value;
  return ` / ${fmt(Math.max(0, Math.min(1, v)))}`;
}

function parseLabLike(fn: string, body: string): RGBA | null {
  const args = modernArgs(body, 3);
  if (!args) return null;
  const t = args.parts.map(tokenize);
  if (t.some((x) => x === null)) return null;
  const tk = t as Token[];
  const alphaTok =
    args.alpha === null ? undefined : (tokenize(args.alpha) ?? undefined);
  if (args.alpha !== null && !alphaTok) return null;
  const a = alphaOf(alphaTok);
  if (a === null) return null;
  const ok = fn.startsWith('ok');
  const polar = fn.endsWith('ch');
  // Percent references (CSS Color 4): L 100% = 100 (lab/lch) or 1 (oklab/oklch); a/b 100% = 125 or 0.4; C 100% =
  // 150 or 0.4.
  const num = (x: Token, pct: number): number | null =>
    x.unit === 'none'
      ? 0
      : x.unit === '%'
        ? (x.value / 100) * pct
        : x.unit === ''
          ? x.value
          : null;
  let L = num(tk[0]!, ok ? 1 : 100);
  if (L === null) return null;
  L = Math.max(0, Math.min(ok ? 1 : 100, L));
  let c1: number | null;
  let c2: number | null;
  if (polar) {
    c1 = num(tk[1]!, ok ? 0.4 : 150);
    c2 = hueDegrees(tk[2]!);
    if (c1 === null || c2 === null) return null;
    c1 = Math.max(0, c1);
  } else {
    c1 = num(tk[1]!, ok ? 0.4 : 125);
    c2 = num(tk[2]!, ok ? 0.4 : 125);
    if (c1 === null || c2 === null) return null;
  }
  const css = `${fn}(${fmt(L)} ${fmt(c1)} ${fmt(c2)}${alphaSuffix(a, alphaTok)})`;
  let A = c1;
  let B = c2;
  if (polar) {
    const h = (c2 * Math.PI) / 180;
    A = c1 * Math.cos(h);
    B = c1 * Math.sin(h);
  }
  if (ok) return fromLinear(oklabToLinSrgb(L, A, B), a, css);
  return fromLinear(
    mul(XYZ65_TO_LIN_SRGB, mul(D50_TO_D65, labToXyz50(L, A, B))),
    a,
    css,
  );
}

function parseColorFn(body: string): RGBA | null {
  const m = /^([a-z0-9-]+)\s+(.*)$/.exec(body);
  if (!m) return null;
  const space = m[1]!;
  const args = modernArgs(m[2]!, 3);
  if (!args) return null;
  const t = args.parts.map(tokenize);
  if (
    t.some(
      (x) =>
        x === null || (x.unit !== '' && x.unit !== '%' && x.unit !== 'none'),
    )
  )
    return null;
  const v = (t as Token[]).map((x) =>
    x.unit === 'none' ? 0 : x.unit === '%' ? x.value / 100 : x.value,
  ) as Vec3;
  const alphaTok =
    args.alpha === null ? undefined : (tokenize(args.alpha) ?? undefined);
  if (args.alpha !== null && !alphaTok) return null;
  const a = alphaOf(alphaTok);
  if (a === null) return null;
  const css = `color(${space === 'xyz' ? 'xyz-d65' : space} ${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}${alphaSuffix(a, alphaTok)})`;
  let lin: Vec3;
  switch (space) {
    case 'srgb':
      lin = v.map(srgbDecode) as Vec3;
      break;
    case 'srgb-linear':
      lin = v;
      break;
    case 'display-p3':
      lin = mul(
        XYZ65_TO_LIN_SRGB,
        mul(LIN_P3_TO_XYZ65, v.map(srgbDecode) as Vec3),
      );
      break;
    case 'a98-rgb':
      lin = mul(
        XYZ65_TO_LIN_SRGB,
        mul(LIN_A98_TO_XYZ65, v.map((c) => signedPow(c, 563 / 256)) as Vec3),
      );
      break;
    case 'rec2020': {
      const al = 1.09929682680944;
      const be = 0.018053968510807;
      const dec = (c: number) => {
        const x = Math.abs(c);
        return x < be * 4.5
          ? c / 4.5
          : Math.sign(c) * ((x + al - 1) / al) ** (1 / 0.45);
      };
      lin = mul(
        XYZ65_TO_LIN_SRGB,
        mul(LIN_REC2020_TO_XYZ65, v.map(dec) as Vec3),
      );
      break;
    }
    case 'prophoto-rgb': {
      const dec = (c: number) =>
        Math.abs(c) <= 16 / 512 ? c / 16 : signedPow(c, 1.8);
      lin = mul(
        XYZ65_TO_LIN_SRGB,
        mul(D50_TO_D65, mul(LIN_PROPHOTO_TO_XYZ50, v.map(dec) as Vec3)),
      );
      break;
    }
    case 'xyz':
    case 'xyz-d65':
      lin = mul(XYZ65_TO_LIN_SRGB, v);
      break;
    case 'xyz-d50':
      lin = mul(XYZ65_TO_LIN_SRGB, mul(D50_TO_D65, v));
      break;
    default:
      return null;
  }
  // An sRGB colour given as color(srgb ...) still reads back in that form.
  return fromLinear(lin, a, css);
}

function parseHex(h: string): RGBA | null {
  if (!/^[0-9a-f]+$/.test(h)) return null;
  const n = (i: number, len: number) => parseInt(h.substr(i, len), 16);
  switch (h.length) {
    case 3:
      return { r: n(0, 1) * 17, g: n(1, 1) * 17, b: n(2, 1) * 17, a: 255 };
    case 4:
      return {
        r: n(0, 1) * 17,
        g: n(1, 1) * 17,
        b: n(2, 1) * 17,
        a: n(3, 1) * 17,
      };
    case 6:
      return { r: n(0, 2), g: n(2, 2), b: n(4, 2), a: 255 };
    case 8:
      return { r: n(0, 2), g: n(2, 2), b: n(4, 2), a: n(6, 2) };
    default:
      return null;
  }
}

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/;

interface Token {
  value: number;
  unit: '' | '%' | 'deg' | 'rad' | 'grad' | 'turn' | 'none';
}

function tokenize(part: string): Token | null {
  const p = part.trim();
  if (p === 'none') return { value: 0, unit: 'none' };
  const m = NUMBER_RE.exec(p);
  if (!m) return null;
  const rest = p.slice(m[0].length);
  const value = parseFloat(m[0]);
  if (!Number.isFinite(value)) return null;
  if (
    rest === '' ||
    rest === '%' ||
    rest === 'deg' ||
    rest === 'rad' ||
    rest === 'grad' ||
    rest === 'turn'
  ) {
    return { value, unit: rest };
  }
  return null;
}

/** Splits arguments in legacy (commas) or modern (spaces + optional "/ alpha") syntax. */
function splitArgs(body: string): { parts: string[]; legacy: boolean } | null {
  if (body.includes(',')) {
    const parts = body.split(',').map((x) => x.trim());
    if (parts.some((x) => x === '' || /\s/.test(x))) return null;
    return { parts, legacy: true };
  }
  const slash = body.split('/');
  if (slash.length > 2) return null;
  const parts = slash[0]!.trim().split(/\s+/);
  if (slash.length === 2) {
    const alpha = slash[1]!.trim();
    if (alpha === '' || /\s/.test(alpha)) return null;
    parts.push(alpha);
    if (parts.length !== 4) return null;
  } else if (parts.length !== 3) {
    return null;
  }
  return { parts, legacy: false };
}

function alphaOf(t: Token | undefined): number | null {
  if (!t) return 255;
  if (t.unit === 'none') return 0;
  if (t.unit === '%') return clamp255((t.value / 100) * 255);
  if (t.unit !== '') return null;
  return clamp255(t.value * 255);
}

function parseRgb(body: string): RGBA | null {
  const sp = splitArgs(body);
  if (!sp || sp.parts.length < 3 || sp.parts.length > 4) return null;
  const toks = sp.parts.map(tokenize);
  if (toks.some((t) => t === null)) return null;
  const t = toks as Token[];
  const ch = t.slice(0, 3);
  if (sp.legacy) {
    // Legacy syntax: all three percentages or all three numbers; no "none".
    const pct = ch[0]!.unit === '%';
    if (
      ch.some(
        (c) =>
          c.unit === 'none' ||
          (c.unit === '%') !== pct ||
          (c.unit !== '%' && c.unit !== ''),
      )
    )
      return null;
    if (t[3] && t[3].unit === 'none') return null;
  } else if (
    ch.some((c) => c.unit !== '' && c.unit !== '%' && c.unit !== 'none')
  ) {
    return null;
  }
  const conv = (c: Token) =>
    c.unit === 'none'
      ? 0
      : c.unit === '%'
        ? clamp255((c.value / 100) * 255)
        : clamp255(c.value);
  const a = alphaOf(t[3]);
  if (a === null) return null;
  return { r: conv(ch[0]!), g: conv(ch[1]!), b: conv(ch[2]!), a };
}

function hueDegrees(t: Token): number | null {
  switch (t.unit) {
    case '':
    case 'deg':
      return t.value;
    case 'rad':
      return (t.value * 180) / Math.PI;
    case 'grad':
      return t.value * 0.9;
    case 'turn':
      return t.value * 360;
    case 'none':
      return 0;
    default:
      return null;
  }
}

/** HSL to sRGB (CSS Color 4 sample algorithm), channels 0..1. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function parseHsl(body: string): RGBA | null {
  const sp = splitArgs(body);
  if (!sp || sp.parts.length < 3 || sp.parts.length > 4) return null;
  const toks = sp.parts.map(tokenize);
  if (toks.some((t) => t === null)) return null;
  const t = toks as Token[];
  const h = hueDegrees(t[0]!);
  if (h === null) return null;
  const pct = (x: Token, legacy: boolean): number | null => {
    if (x.unit === 'none') return legacy ? null : 0;
    if (x.unit === '%') return x.value / 100;
    if (x.unit === '' && !legacy) return x.value / 100;
    return null;
  };
  const s = pct(t[1]!, sp.legacy);
  const l = pct(t[2]!, sp.legacy);
  if (s === null || l === null) return null;
  if (sp.legacy && t[0]!.unit === 'none') return null;
  const a = alphaOf(t[3]);
  if (a === null) return null;
  const [r, g, b] = hslToRgb(
    h,
    Math.max(0, Math.min(1, s)),
    Math.max(0, Math.min(1, l)),
  );
  return {
    r: clamp255(r * 255),
    g: clamp255(g * 255),
    b: clamp255(b * 255),
    a,
  };
}

function parseHwb(body: string): RGBA | null {
  const sp = splitArgs(body);
  if (!sp || sp.legacy || sp.parts.length < 3) return null;
  const toks = sp.parts.map(tokenize);
  if (toks.some((t) => t === null)) return null;
  const t = toks as Token[];
  const h = hueDegrees(t[0]!);
  if (h === null) return null;
  const pct = (x: Token) =>
    x.unit === 'none'
      ? 0
      : x.unit === '%' || x.unit === ''
        ? x.value / 100
        : null;
  let w = pct(t[1]!);
  let bl = pct(t[2]!);
  if (w === null || bl === null) return null;
  w = Math.max(0, Math.min(1, w));
  bl = Math.max(0, Math.min(1, bl));
  const a = alphaOf(t[3]);
  if (a === null) return null;
  let rgb: [number, number, number];
  if (w + bl >= 1) {
    const gray = w / (w + bl);
    rgb = [gray, gray, gray];
  } else {
    rgb = hslToRgb(h, 1, 0.5).map((c) => c * (1 - w! - bl!) + w!) as [
      number,
      number,
      number,
    ];
  }
  return {
    r: clamp255(rgb[0] * 255),
    g: clamp255(rgb[1] * 255),
    b: clamp255(rgb[2] * 255),
    a,
  };
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/**
 * HTML's serialization of a canvas colour: "#rrggbb" when opaque, otherwise "rgba(r, g, b, a)" with the
 * alpha in the shortest decimal form that round-trips the 8-bit value (CSS Color 4 "serializing alpha").
 */
export function serializeColor(c: RGBA): string {
  if (c.css) return c.css;
  if (c.a === 255) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${serializeAlpha(c.a)})`;
}

export function serializeAlpha(a255: number): string {
  if (a255 === 0) return '0';
  let v = Math.round((a255 / 255) * 100) / 100;
  if (Math.round(v * 255) !== a255) v = Math.round((a255 / 255) * 1000) / 1000;
  return String(v);
}
