/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// A small markup tokenizer and tree builder for the stand-in tree: the entry document (DOM-7), `innerHTML` /
// `outerHTML` / `insertAdjacentHTML` (DOM-8), and DOMParser / XMLSerializer (DOM-10). Not the HTML parsing algorithm:
// it handles what app markup and SVG/XML assets use (start/end/self-closing tags, quoted/unquoted/boolean attributes,
// void and raw-text elements, comments, doctype, CDATA, processing instructions, character references, foreign
// <svg>/<math> subtrees, the implied html/head/body of a document, and the common implied end tags of p/li/option/
// table cells). Malformed input never throws: stray end tags are ignored, unclosed elements end with their parent.

import { HTML_NS, MATHML_NS, SVG_NS, XMLNS_NS, lower } from './env.ts';

export interface ParsedNode {
  readonly nodeType: number;
  appendChild(child: ParsedNode): unknown;
}
export interface ParsedElement extends ParsedNode {
  readonly localName: string;
  readonly namespaceURI: string | null;
  readonly parentNode: unknown;
  setAttribute(name: string, value: string): void;
  setAttributeNS(ns: string | null, name: string, value: string): void;
}
export interface NodeFactory {
  createElementNS(ns: string | null, qualifiedName: string): ParsedElement;
  createTextNode(data: string): ParsedNode;
  createComment(data: string): ParsedNode;
  createCDATASection?(data: string): ParsedNode;
  createProcessingInstruction?(target: string, data: string): ParsedNode;
  createDocumentType?(name: string, publicId: string, systemId: string): ParsedNode;
}

export const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param',
  'keygen', 'frame', 'basefont', 'bgsound',
]);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
const ESCAPABLE_RAW = new Set(['textarea', 'title']);
const HEAD_ELEMENTS = new Set(['base', 'basefont', 'bgsound', 'link', 'meta', 'title', 'style', 'script', 'noscript', 'template']);

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', times: '×', divide: '÷', middot: '·', bull: '•', deg: '°', plusmn: '±',
  para: '¶', sect: '§', euro: '€', pound: '£', yen: '¥', cent: '¢', larr: '←', rarr: '→',
  uarr: '↑', darr: '↓', harr: '↔', hearts: '♥', check: '✓', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
  zwj: '\u200d', zwnj: '\u200c', shy: '\u00ad', iexcl: '¡', iquest: '¿', frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', micro: 'µ', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π',
  sigma: 'σ', omega: 'ω', lambda: 'λ', mu: 'μ', theta: 'θ', infin: '∞', ne: '≠', le: '≤', ge: '≥',
};

/** Decodes character references (`&amp;`, `&#38;`, `&#x26;`); unknown names stay as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});?/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
      return String.fromCodePoint(cp);
    }
    const v = ENTITIES[e] ?? ENTITIES[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

type Token =
  | { kind: 'start'; name: string; attrs: Array<[string, string]>; selfClosing: boolean }
  | { kind: 'end'; name: string }
  | { kind: 'text'; data: string }
  | { kind: 'comment'; data: string }
  | { kind: 'cdata'; data: string }
  | { kind: 'doctype'; name: string; publicId: string; systemId: string }
  | { kind: 'pi'; target: string; data: string };

const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function* tokenize(src: string, xml: boolean): Generator<Token> {
  let i = 0;
  const n = src.length;
  let rawUntil: string | null = null;
  while (i < n) {
    if (rawUntil !== null) {
      const re = new RegExp(`</${rawUntil}\\s*>`, 'i');
      const m = re.exec(src.slice(i));
      const end = m ? i + m.index : n;
      const data = src.slice(i, end);
      if (data) yield { kind: 'text', data: ESCAPABLE_RAW.has(rawUntil) ? decodeEntities(data) : data };
      if (m) {
        yield { kind: 'end', name: rawUntil };
        i = end + m[0].length;
      } else i = n;
      rawUntil = null;
      continue;
    }
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      yield { kind: 'text', data: decodeEntities(src.slice(i)) };
      break;
    }
    if (lt > i) yield { kind: 'text', data: decodeEntities(src.slice(i, lt)) };
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      yield { kind: 'comment', data: src.slice(i + 4, end < 0 ? n : end) };
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      const data = src.slice(i + 9, end < 0 ? n : end);
      yield xml ? { kind: 'cdata', data } : { kind: 'comment', data: `[CDATA[${data}]]` };
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<!', i)) {
      const end = src.indexOf('>', i + 2);
      const body = src.slice(i + 2, end < 0 ? n : end);
      const dm = /^doctype\s+([^\s>]+)(?:\s+public\s+["']([^"']*)["'](?:\s+["']([^"']*)["'])?|\s+system\s+["']([^"']*)["'])?/i.exec(body);
      if (dm) yield { kind: 'doctype', name: xml ? dm[1]! : lower(dm[1]!), publicId: dm[2] ?? '', systemId: dm[3] ?? dm[4] ?? '' };
      else yield { kind: 'comment', data: body };
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (src.startsWith('<?', i)) {
      const end = src.indexOf(xml ? '?>' : '>', i + 2);
      const body = src.slice(i + 2, end < 0 ? n : end);
      if (xml) {
        const sp = body.search(/\s/);
        const target = sp < 0 ? body : body.slice(0, sp);
        if (lower(target) !== 'xml') yield { kind: 'pi', target, data: sp < 0 ? '' : body.slice(sp).trim() };
        i = end < 0 ? n : end + 2;
      } else {
        yield { kind: 'comment', data: `?${body}` };
        i = end < 0 ? n : end + 1;
      }
      continue;
    }
    if (src[i + 1] === '/') {
      const m = /^<\/\s*([^\s>/]+)[^>]*>/.exec(src.slice(i));
      if (m) {
        yield { kind: 'end', name: xml ? m[1]! : m[1]! };
        i += m[0].length;
      } else {
        yield { kind: 'text', data: '</' };
        i += 2;
      }
      continue;
    }
    const sm = /^<([a-zA-Z][^\s/>]*)/.exec(src.slice(i, i + 256));
    if (!sm) {
      yield { kind: 'text', data: '<' };
      i++;
      continue;
    }
    // Find the end of the tag, skipping quoted attribute values.
    let j = i + sm[0].length;
    let quote = '';
    for (; j < n; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    let inner = src.slice(i + sm[0].length, j);
    let selfClosing = false;
    if (inner.endsWith('/')) {
      selfClosing = true;
      inner = inner.slice(0, -1);
    }
    const attrs: Array<[string, string]> = [];
    const seen = new Set<string>();
    ATTR_RE.lastIndex = 0;
    for (let m = ATTR_RE.exec(inner); m; m = ATTR_RE.exec(inner)) {
      const name = xml ? m[1]! : lower(m[1]!);
      if (seen.has(name)) continue;
      seen.add(name);
      attrs.push([name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')]);
    }
    const name = sm[1]!;
    yield { kind: 'start', name, attrs, selfClosing };
    i = j < n ? j + 1 : n;
    if (!xml && !selfClosing && RAW_TEXT.has(lower(name))) rawUntil = lower(name);
  }
}

function nsFor(name: string, attrs: Array<[string, string]>, parentNs: string | null, xml: boolean, scopes: Array<Map<string, string>>): string | null {
  const colon = name.indexOf(':');
  const prefix = colon > 0 ? name.slice(0, colon) : '';
  for (const [k, v] of attrs) {
    if (prefix ? k === `xmlns:${prefix}` : k === 'xmlns') return v || null;
  }
  for (let i = scopes.length - 1; i >= 0; i--) {
    const v = scopes[i]!.get(prefix);
    if (v !== undefined) return v || null;
  }
  if (xml) return prefix === 'svg' ? SVG_NS : prefix ? null : parentNs;
  if (parentNs === SVG_NS || parentNs === MATHML_NS) {
    return parentNs === SVG_NS && lower(name) === 'foreignobject' ? SVG_NS : parentNs;
  }
  const l = lower(name);
  if (l === 'svg') return SVG_NS;
  if (l === 'math') return MATHML_NS;
  return HTML_NS;
}

/** Closes an open `p`/`li`/... implied by a new start tag (the common cases of HTML's implied end tags). */
function impliedClose(stack: ParsedElement[], name: string): void {
  const top = (): string | undefined => {
    const t = stack[stack.length - 1];
    return t && t.namespaceURI === HTML_NS ? t.localName : undefined;
  };
  const closesP = /^(address|article|aside|blockquote|details|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|main|menu|nav|ol|p|pre|section|table|ul)$/;
  if (closesP.test(name) && top() === 'p') stack.pop();
  else if (name === 'li' && top() === 'li') stack.pop();
  else if ((name === 'dt' || name === 'dd') && (top() === 'dt' || top() === 'dd')) stack.pop();
  else if (name === 'option' && top() === 'option') stack.pop();
  else if ((name === 'td' || name === 'th') && (top() === 'td' || top() === 'th')) stack.pop();
  else if (name === 'tr' && (top() === 'td' || top() === 'th' || top() === 'tr')) {
    while (top() === 'td' || top() === 'th') stack.pop();
    if (top() === 'tr') stack.pop();
  }
}

export interface ParseResult {
  /** Elements created for `<script>` tags (the caller marks them already started: they never run again). */
  scripts: ParsedElement[];
}

/**
 * Parses `src` into `root` (an element, fragment or document). `contextNs` is the namespace of the context element
 * (fragments inside an <svg> parse as SVG).
 */
export function parseInto(
  root: ParsedNode,
  src: string,
  factory: NodeFactory,
  opts: { xml?: boolean; contextNs?: string | null } = {},
): ParseResult {
  const xml = !!opts.xml;
  const stack: ParsedElement[] = [];
  const scopes: Array<Map<string, string>> = [];
  const scripts: ParsedElement[] = [];
  // HTML: a <template>'s children go into its content fragment, not into the element (HTML "template contents").
  const current = (): ParsedNode => {
    const top = stack[stack.length - 1];
    if (!top) return root;
    if (!xml && top.localName === 'template' && top.namespaceURI === HTML_NS) {
      const content = (top as unknown as { content?: ParsedNode }).content;
      if (content) return content;
    }
    return top;
  };
  const currentNs = (): string | null =>
    stack.length ? stack[stack.length - 1]!.namespaceURI : opts.contextNs === undefined ? (xml ? null : HTML_NS) : opts.contextNs;
  for (const t of tokenize(src, xml)) {
    switch (t.kind) {
      case 'text':
        if (t.data) current().appendChild(factory.createTextNode(t.data));
        break;
      case 'comment':
        current().appendChild(factory.createComment(t.data));
        break;
      case 'cdata':
        current().appendChild(factory.createCDATASection ? factory.createCDATASection(t.data) : factory.createTextNode(t.data));
        break;
      case 'pi':
        if (factory.createProcessingInstruction) current().appendChild(factory.createProcessingInstruction(t.target, t.data));
        break;
      case 'doctype':
        if (factory.createDocumentType && (root as { nodeType: number }).nodeType === 9 && stack.length === 0) {
          root.appendChild(factory.createDocumentType(t.name, t.publicId, t.systemId));
        }
        break;
      case 'start': {
        const parentNs = currentNs();
        const ns = nsFor(t.name, t.attrs, parentNs, xml, scopes);
        const html = ns === HTML_NS && !xml;
        const name = html ? lower(t.name) : t.name;
        if (html) impliedClose(stack, name);
        const el = factory.createElementNS(ns, name);
        const scope = new Map<string, string>();
        for (const [k, v] of t.attrs) {
          if (k === 'xmlns' || k.startsWith('xmlns:')) {
            scope.set(k === 'xmlns' ? '' : k.slice(6), v);
            if (!html) {
              try {
                el.setAttributeNS(XMLNS_NS, k, v);
              } catch {
                el.setAttribute(k, v);
              }
              continue;
            }
          }
          el.setAttribute(k, v);
        }
        current().appendChild(el);
        if (html && name === 'script') scripts.push(el);
        const isVoid = html ? VOID_ELEMENTS.has(name) : t.selfClosing;
        if (!isVoid && !(t.selfClosing && !html)) {
          stack.push(el);
          scopes.push(scope);
        }
        break;
      }
      case 'end': {
        const name = t.name;
        for (let k = stack.length - 1; k >= 0; k--) {
          const el = stack[k]!;
          const match = el.namespaceURI === HTML_NS && !xml ? el.localName === lower(name) : qualifiedName(el) === name || el.localName === name;
          if (match) {
            stack.length = k;
            scopes.length = k;
            break;
          }
        }
        break;
      }
    }
  }
  return { scripts };
}

function qualifiedName(el: ParsedElement): string {
  const tn = (el as unknown as { tagName?: string }).tagName;
  return typeof tn === 'string' ? tn : el.localName;
}

/** Nodes as the serializer reads them (nodes.ts). */
interface SerNode {
  nodeType: number;
  nodeName: string;
  childNodes: ArrayLike<SerNode>;
  data?: string;
  localName?: string;
  namespaceURI?: string | null;
  attributes?: ArrayLike<{ name: string; value: string }>;
  target?: string;
  name?: string;
  publicId?: string;
  systemId?: string;
  content?: SerNode;
}

function escapeText(s: string, attr: boolean): string {
  let out = s.replace(/&/g, '&amp;').replace(/\u00a0/g, '&nbsp;');
  out = attr ? out.replace(/"/g, '&quot;') : out.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return out;
}

/** HTML fragment serialization (`innerHTML`); `xml` gives XMLSerializer-style output (self-closed empty elements). */
export function serializeChildren(node: SerNode, xml = false): string {
  const kids = node.localName === 'template' && node.content ? node.content.childNodes : node.childNodes;
  let out = '';
  for (let i = 0; i < kids.length; i++) out += serializeNode(kids[i]!, xml, node);
  return out;
}

export function serializeNode(node: SerNode, xml = false, parent: SerNode | null = null): string {
  switch (node.nodeType) {
    case 1: {
      const html = !xml && node.namespaceURI === HTML_NS;
      const name = html ? node.localName! : node.nodeName;
      let s = `<${name}`;
      const attrs = node.attributes ?? [];
      for (let i = 0; i < attrs.length; i++) s += ` ${attrs[i]!.name}="${escapeText(attrs[i]!.value, true)}"`;
      if (html && VOID_ELEMENTS.has(name)) return `${s}>`;
      const inner = serializeChildren(node, xml);
      if (!html && inner === '') return `${s}/>`;
      return `${s}>${inner}</${name}>`;
    }
    case 3: {
      const p = parent?.localName;
      if (!xml && parent?.namespaceURI === HTML_NS && p && (p === 'script' || p === 'style' || p === 'xmp' || p === 'iframe' || p === 'noscript' || p === 'plaintext')) {
        return node.data ?? '';
      }
      return escapeText(node.data ?? '', false);
    }
    case 4:
      return `<![CDATA[${node.data ?? ''}]]>`;
    case 7:
      return `<?${node.target} ${node.data ?? ''}?>`;
    case 8:
      return `<!--${node.data ?? ''}-->`;
    case 9:
    case 11:
      return serializeChildren(node, xml);
    case 10:
      return `<!DOCTYPE ${node.name}${node.publicId ? ` PUBLIC "${node.publicId}"` : ''}${node.systemId ? `${node.publicId ? '' : ' SYSTEM'} "${node.systemId}"` : ''}>`;
    default:
      return '';
  }
}

/** Whether a parsed element belongs in <head> when it appears before any body content (document parsing). */
export function isHeadElement(localName: string): boolean {
  return HEAD_ELEMENTS.has(localName);
}
