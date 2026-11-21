/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Intl comes from V8 (built with v8_enable_i18n_support = true and ICU data embedded,
// icu_use_data_file = false). The glue adds nothing; this check proves what the bundle relies on
// (JS-6: Intl.Segmenter grapheme + word for Latin, CJK and emoji) and is exposed on the glue
// registry for the headless runner, the debug endpoint and device tests.

export interface IntlReport {
  ok: boolean;
  defaultLocale: string | null;
  constructors: Record<string, boolean>;
  problems: string[];
}

const CONSTRUCTORS = [
  'Collator',
  'DateTimeFormat',
  'DisplayNames',
  'DurationFormat',
  'ListFormat',
  'Locale',
  'NumberFormat',
  'PluralRules',
  'RelativeTimeFormat',
  'Segmenter',
] as const;

export function verifyIntl(
  intl: unknown = (globalThis as { Intl?: unknown }).Intl,
): IntlReport {
  const problems: string[] = [];
  const constructors: Record<string, boolean> = {};
  if (typeof intl !== 'object' || intl === null) {
    return {
      ok: false,
      defaultLocale: null,
      constructors,
      problems: ['Intl is missing'],
    };
  }
  const I = intl as Record<string, unknown>;
  for (const c of CONSTRUCTORS) constructors[c] = typeof I[c] === 'function';
  let defaultLocale: string | null = null;
  try {
    defaultLocale =
      new (I.NumberFormat as typeof Intl.NumberFormat)().resolvedOptions()
        .locale;
  } catch (e) {
    problems.push(`NumberFormat: ${String(e)}`);
  }
  const need = (cond: boolean, what: string): void => {
    if (!cond) problems.push(what);
  };
  try {
    const Seg = I.Segmenter as typeof Intl.Segmenter;
    const graphemes = (s: string): string[] =>
      Array.from(
        new Seg('en', { granularity: 'grapheme' }).segment(s),
        (x) => x.segment,
      );
    // Family emoji (ZWJ sequence) and a flag are one grapheme each; "e" + combining acute is one.
    need(
      graphemes(
        'a\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u{1F1EF}\u{1F1F5}e\u0301',
      ).length === 4,
      'Segmenter grapheme clusters',
    );
    const words = Array.from(
      new Seg('en', { granularity: 'word' }).segment('Hello, world'),
    )
      .filter((x) => x.isWordLike)
      .map((x) => x.segment);
    need(words.join('|') === 'Hello|world', 'Segmenter Latin words');
    const wordsOf = (locale: string, s: string): string =>
      Array.from(
        new Seg(locale, { granularity: 'word' }).segment(s),
        (x) => x.segment,
      ).join('|');
    // The spec's JS-6 check, compared with Node's output.
    const mixed = wordsOf('en', 'é\u{1F44D}\u{1F3FD}漢字 word');
    need(
      mixed === 'é|\u{1F44D}\u{1F3FD}|漢字| |word',
      `Segmenter mixed words (got ${mixed})`,
    );
    // Dictionary segmentation (ICU's CJ dictionary): words, not one segment per character.
    const ja = wordsOf('ja', '今日は良い天気です').split('|');
    need(
      ja.includes('今日') && ja.includes('天気'),
      `Segmenter Japanese dictionary words (got ${ja.join('|')})`,
    );
    const zh = wordsOf('zh', '我们今天去公园').split('|');
    need(
      zh.includes('我们') && zh.includes('公园'),
      `Segmenter Chinese dictionary words (got ${zh.join('|')})`,
    );
  } catch (e) {
    problems.push(`Segmenter: ${String(e)}`);
  }
  try {
    need(
      new (I.NumberFormat as typeof Intl.NumberFormat)('en-US').format(
        1234.5,
      ) === '1,234.5',
      'NumberFormat en-US',
    );
    need(
      new (I.DateTimeFormat as typeof Intl.DateTimeFormat)('en-US', {
        timeZone: 'UTC',
      }).format(0) === '1/1/1970',
      'DateTimeFormat en-US',
    );
    need(
      new (I.Collator as typeof Intl.Collator)('en').compare('a', 'B') < 0,
      'Collator en',
    );
    need(
      new (I.PluralRules as typeof Intl.PluralRules)('en').select(1) === 'one',
      'PluralRules en',
    );
    need(
      'i'.toLocaleUpperCase('tr') === '\u0130' &&
        'I'.toLocaleLowerCase('tr') === '\u0131',
      'locale-aware case mapping',
    );
    need('A\u030A'.normalize('NFC') === '\u00C5', 'String.prototype.normalize');
  } catch (e) {
    problems.push(String(e));
  }
  return { ok: problems.length === 0, defaultLocale, constructors, problems };
}
