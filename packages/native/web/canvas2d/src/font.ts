/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The CSS `font` shorthand as the canvas `font` attribute uses it (C2D-8; CSS Fonts 4 §3.7, HTML
 * "font" attribute): [style || variant-css2 || weight || stretch-css3]? size [/ line-height]? family-list,
 * or a system font keyword. Relative sizes (em, rem, %, larger, smaller) and relative weights resolve
 * against the default 10px / 400 (HTML: a canvas without a computed style uses "10px sans-serif").
 * line-height is validated and ignored.
 */

export type FontStyle = 'normal' | 'italic' | 'oblique';

export interface ParsedFont {
  style: FontStyle;
  smallCaps: boolean;
  weight: number;
  /** As written when it was a keyword ("bold"), else the number. Used for serialization. */
  weightText: string;
  stretch: string; // keyword
  stretchPercent: number;
  sizePx: number;
  families: string[];
  /** Parallel to families: true for generic families (unquoted keywords). */
  generic: boolean[];
  /** Parallel to families: written as a quoted string (serialized quoted again). */
  quoted?: boolean[];
}

const GENERIC = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);
const CSS_WIDE = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'default',
]);
const STRETCH: Record<string, number> = {
  'ultra-condensed': 50,
  'extra-condensed': 62.5,
  condensed: 75,
  'semi-condensed': 87.5,
  normal: 100,
  'semi-expanded': 112.5,
  expanded: 125,
  'extra-expanded': 150,
  'ultra-expanded': 200,
};
const ABSOLUTE_SIZES: Record<string, number> = {
  'xx-small': 9,
  'x-small': 10,
  small: 13,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32,
  'xxx-large': 48,
};
const SYSTEM_FONTS = new Set([
  'caption',
  'icon',
  'menu',
  'message-box',
  'small-caption',
  'status-bar',
]);
const UNIT_PX: Record<string, number> = {
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
};

export const DEFAULT_FONT_SIZE = 10;

type Tok = {
  kind: 'ident' | 'string' | 'comma' | 'slash' | 'other';
  text: string;
};

function tokenize(s: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') {
      i++;
      continue;
    }
    if (c === ',') {
      out.push({ kind: 'comma', text: ',' });
      i++;
      continue;
    }
    if (c === '/') {
      out.push({ kind: 'slash', text: '/' });
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let text = '';
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\\' && j + 1 < s.length) {
          text += s[j + 1];
          j += 2;
          continue;
        }
        if (s[j] === '\n') return null;
        text += s[j];
        j++;
      }
      if (j >= s.length) return null;
      out.push({ kind: 'string', text });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !' \t\n\r\f,/"\''.includes(s[j]!)) j++;
    const text = s.slice(i, j);
    out.push({
      kind: /^-?[a-zA-Z_\u0080-￿][\w\-\u0080-￿]*$/.test(text)
        ? 'ident'
        : 'other',
      text,
    });
    i = j;
  }
  return out;
}

/** Largest font size a canvas uses (Chrome's clamp of the computed font-size). */
export const MAX_FONT_SIZE_PX = 10000;

const NUM_UNIT = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/i;

function parseSize(t: Tok, parentPx: number): number | null {
  const low = t.text.toLowerCase();
  if (t.kind === 'ident') {
    if (low in ABSOLUTE_SIZES) return ABSOLUTE_SIZES[low]!;
    if (low === 'larger') return parentPx * 1.2;
    if (low === 'smaller') return parentPx / 1.2;
    return null;
  }
  if (t.kind !== 'other') return null;
  const m = NUM_UNIT.exec(low);
  if (!m) return null;
  const v = parseFloat(m[1]!);
  const unit = m[2]!;
  if (!Number.isFinite(v) || v < 0) return null;
  if (unit === '') return v === 0 ? 0 : null;
  if (unit in UNIT_PX) return v * UNIT_PX[unit]!;
  if (unit === 'em' || unit === 'rem') return v * parentPx;
  if (unit === 'ex' || unit === 'ch') return v * parentPx * 0.5;
  if (unit === '%') return (v / 100) * parentPx;
  return null;
}

function isSizeToken(t: Tok): boolean {
  if (t.kind === 'ident') {
    const low = t.text.toLowerCase();
    return low in ABSOLUTE_SIZES || low === 'larger' || low === 'smaller';
  }
  if (t.kind !== 'other') return false;
  const m = NUM_UNIT.exec(t.text.toLowerCase());
  // A unitless 0 is a valid <length> (CSS), and never a valid font-weight (1-1000), so it is the size.
  return !!m && (m[2] !== '' || parseFloat(m[1]!) === 0);
}

function validLineHeight(t: Tok): boolean {
  if (t.kind === 'ident') return t.text.toLowerCase() === 'normal';
  if (t.kind !== 'other') return false;
  const m = NUM_UNIT.exec(t.text.toLowerCase());
  if (!m) return false;
  const unit = m[2]!;
  return (
    parseFloat(m[1]!) >= 0 &&
    (unit === '' ||
      unit === '%' ||
      unit in UNIT_PX ||
      unit === 'em' ||
      unit === 'rem' ||
      unit === 'ex' ||
      unit === 'ch')
  );
}

/** Parses a `font` value; null when invalid (the setter then ignores it). */
export function parseFont(
  value: string,
  parentPx = DEFAULT_FONT_SIZE,
  parentWeight = 400,
): ParsedFont | null {
  const toks = tokenize(value);
  if (!toks || toks.length === 0) return null;
  if (
    toks.length === 1 &&
    toks[0]!.kind === 'ident' &&
    SYSTEM_FONTS.has(toks[0]!.text.toLowerCase())
  ) {
    return {
      style: 'normal',
      smallCaps: false,
      weight: 400,
      weightText: '400',
      stretch: 'normal',
      stretchPercent: 100,
      // System font keywords resolve to the platform's UI font; Chrome reports 16px and its default sans family.
      sizePx: 16,
      families: ['sans-serif'],
      generic: [true],
    };
  }
  let style: FontStyle | null = null;
  let smallCaps: boolean | null = null;
  let weight: number | null = null;
  let weightText = '';
  let stretch: string | null = null;
  let i = 0;
  let pre = 0;
  for (; i < toks.length; i++) {
    const t = toks[i]!;
    if (isSizeToken(t)) break;
    if (++pre > 4) return null;
    const low = t.text.toLowerCase();
    if (t.kind === 'ident') {
      if (low === 'normal') continue;
      if (low === 'italic' || low === 'oblique') {
        if (style) return null;
        style = low;
        continue;
      }
      if (low === 'small-caps') {
        if (smallCaps !== null) return null;
        smallCaps = true;
        continue;
      }
      if (low === 'bold' || low === 'bolder' || low === 'lighter') {
        if (weight !== null) return null;
        weightText = low === 'bold' ? 'bold' : '';
        weight =
          low === 'bold'
            ? 700
            : low === 'bolder'
              ? parentWeight < 350
                ? 400
                : parentWeight < 550
                  ? 700
                  : 900
              : parentWeight < 550
                ? 100
                : parentWeight < 750
                  ? 400
                  : 700;
        if (!weightText) weightText = String(weight);
        continue;
      }
      if (low in STRETCH) {
        if (stretch) return null;
        stretch = low;
        continue;
      }
      return null;
    }
    if (
      t.kind === 'other' &&
      /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t.text)
    ) {
      const w = parseFloat(t.text);
      if (weight !== null || !(w >= 1 && w <= 1000)) return null;
      weight = w;
      weightText = String(w);
      continue;
    }
    return null;
  }
  if (i >= toks.length) return null;
  const rawPx = parseSize(toks[i]!, parentPx);
  if (rawPx === null) return null;
  // Chrome clamps canvas font sizes to 10000px (the computed value, so the getter, metrics and drawing all agree).
  const sizePx = Math.min(rawPx, MAX_FONT_SIZE_PX);
  i++;
  if (i < toks.length && toks[i]!.kind === 'slash') {
    i++;
    if (i >= toks.length || !validLineHeight(toks[i]!)) return null;
    i++;
  }
  // Family list.
  const families: string[] = [];
  const generic: boolean[] = [];
  const quoted: boolean[] = [];
  let idents: string[] = [];
  let expectName = true;
  const flush = (): boolean => {
    if (idents.length === 0) return false;
    const name = idents.join(' ');
    const low = name.toLowerCase();
    if (idents.length === 1 && CSS_WIDE.has(low)) return false;
    if (idents.length === 1 && GENERIC.has(low)) {
      families.push(low);
      generic.push(true);
    } else {
      families.push(name);
      generic.push(false);
    }
    quoted.push(false);
    idents = [];
    return true;
  };
  for (; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.kind === 'comma') {
      if (expectName && idents.length === 0) return null;
      if (idents.length && !flush()) return null;
      expectName = true;
      continue;
    }
    if (!expectName && idents.length === 0) return null;
    if (t.kind === 'string') {
      if (idents.length) return null;
      families.push(t.text);
      generic.push(false);
      quoted.push(true);
      expectName = false;
      continue;
    }
    if (t.kind === 'ident') {
      idents.push(t.text);
      continue;
    }
    return null;
  }
  if (idents.length && !flush()) return null;
  if (expectName && families.length === 0) return null;
  if (families.length === 0) return null;
  if (toks[toks.length - 1]!.kind === 'comma') return null;
  const st = stretch ?? 'normal';
  return {
    style: style ?? 'normal',
    smallCaps: smallCaps ?? false,
    weight: weight ?? 400,
    weightText: weight === null ? '400' : weightText,
    stretch: st,
    stretchPercent: STRETCH[st]!,
    sizePx,
    families,
    generic,
    quoted,
  };
}

function formatPx(v: number): string {
  // Shortest form, at most 6 significant decimals (what browsers print for computed lengths).
  const r = Math.round(v * 1e6) / 1e6;
  return `${r}px`;
}

function serializeFamily(
  name: string,
  isGeneric: boolean,
  wasQuoted: boolean,
): string {
  if (isGeneric) return name;
  if (wasQuoted) return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const parts = name.split(' ');
  const plain = parts.every(
    (p) =>
      /^-?[a-zA-Z_\u0080-￿][\w\-\u0080-￿]*$/.test(p) &&
      !GENERIC.has(p.toLowerCase()) &&
      !CSS_WIDE.has(p.toLowerCase()),
  );
  return plain ? name : `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The value the `font` getter returns: the shorthand with computed size in px and no line-height. */
/**
 * The `font` getter's value, serialized as Chrome does: style (oblique reads back as italic), weight (700 as
 * "bold", other non-normal weights as numbers), small-caps, the computed size in px and the family list. Stretch is
 * not part of it (it is reflected by ctx.fontStretch).
 */
export function serializeFont(f: ParsedFont): string {
  const parts: string[] = [];
  if (f.style !== 'normal') parts.push('italic');
  if (f.weight !== 400)
    parts.push(f.weight === 700 ? 'bold' : String(f.weight));
  if (f.smallCaps) parts.push('small-caps');
  parts.push(formatPx(f.sizePx));
  parts.push(
    f.families
      .map((n, i) => serializeFamily(n, f.generic[i]!, !!f.quoted?.[i]))
      .join(', '),
  );
  return parts.join(' ');
}

/** Parses a CSS length for letterSpacing / wordSpacing ("0px", "2px", "0.1em"); null when invalid. */
export function parseSpacing(value: string, fontPx: number): number | null {
  const e = spacingFor(value);
  return e ? spacingPx(e, fontPx) : null;
}

/** A parsed letterSpacing / wordSpacing value: `px` absolute pixels, or `em` times the font size. */
export interface SpacingValue {
  readonly normalized: string;
  readonly px: number;
  readonly em: number;
}

export function spacingPx(e: SpacingValue, fontPx: number): number {
  return e.em ? e.em * fontPx : e.px;
}

// Realm-wide cache of parsed spacing strings, so labels that assign the same value every frame allocate nothing.
const spacingCache = new Map<string, SpacingValue | null>();
const SPACING_CACHE_MAX = 256;

/** The parsed (cached) spacing value of `value`; null when invalid. */
export function spacingFor(value: string): SpacingValue | null {
  const hit = spacingCache.get(value);
  if (hit !== undefined) return hit;
  const r = parseSpacingUncached(value);
  if (spacingCache.size >= SPACING_CACHE_MAX) spacingCache.clear();
  spacingCache.set(value, r);
  return r;
}

function parseSpacingUncached(value: string): SpacingValue | null {
  const normalized = value.trim().toLowerCase();
  const m = NUM_UNIT.exec(normalized);
  if (!m) return null;
  const v = parseFloat(m[1]!);
  if (!Number.isFinite(v)) return null;
  const unit = m[2]!;
  if (unit === '') return v === 0 ? { normalized, px: 0, em: 0 } : null;
  if (unit in UNIT_PX) return { normalized, px: v * UNIT_PX[unit]!, em: 0 };
  if (unit === 'em')
    return v === 0
      ? { normalized, px: 0, em: 0 }
      : { normalized, px: 0, em: v };
  if (unit === 'rem') return { normalized, px: v * DEFAULT_FONT_SIZE, em: 0 };
  return null;
}
