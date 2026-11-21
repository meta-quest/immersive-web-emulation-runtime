/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Installs the DOM stand-ins on the page global (never in a worker): the node and element interfaces, the page's
// `document` built from the entry document's markup (DOM-7), UI events, observers, geometry, the DOM-3 window
// members, and `readystatechange` around the core's DOMContentLoaded/load (DOM-6). Runs after the web glue and
// before the canvas2d / image / webgl / xr preludes (they attach to HTMLCanvasElement / HTMLElement / document).

import { CSSStyleDeclaration } from './css.ts';
import {
  DOMImplementation,
  DOMParser,
  Document,
  NodeFilter,
  Range,
  Selection,
  TreeWalker,
  XMLDocument,
  buildHTMLDocument,
} from './document.ts';
import { BaseEvent, G, defineHandler, entryDocumentSource, isWorkerScope, warn } from './env.ts';
import { DOMMatrix, DOMMatrixReadOnly, DOMQuad, DOMRect, DOMRectList, DOMRectReadOnly, installPoints } from './geometry.ts';
import { GLOBAL_HANDLERS, HTMLAudioElement, HTMLOptionElement, HTML_INTERFACES } from './html-elements.ts';
import {
  Attr,
  CDATASection,
  CharacterData,
  Comment,
  DOMTokenList,
  DocumentFragment,
  DocumentType,
  Element,
  HTMLCollection,
  NamedNodeMap,
  Node,
  NodeList,
  ProcessingInstruction,
  ShadowRoot,
  Text,
  connectedCanvasCount,
  setDefaultDocument,
} from './nodes.ts';
import {
  IntersectionObserver,
  IntersectionObserverEntry,
  MutationObserver,
  MutationRecord,
  ResizeObserver,
  ResizeObserverEntry,
  ResizeObserverSize,
  setNodeListClass,
} from './observers.ts';
import { UI_EVENTS } from './ui-events.ts';
import { CSS, Screen, ScreenOrientation, VisualViewport, Window, installWindowMembers } from './window.ts';
import { XMLSerializer } from './document.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const DOM_REGISTRY_KEY: unique symbol = Symbol.for('iwn.dom') as never;

export interface InstallDomOptions {
  /** 'missing' (default) keeps globals another layer already defined; 'all' replaces them. */
  mode?: 'missing' | 'all';
  /** Entry document markup (default: the core's `documentSource()`, i.e. the app's index.html). */
  html?: string | null;
}

export interface DomRegistry {
  version: 1;
  document: Document;
  installed: string[];
  /** Builds a document tree from markup (DOMParser and the entry document use it). */
  buildHTMLDocument: typeof buildHTMLDocument;
  stats(): { elements: number; connectedCanvases: number };
}

/** Named constructors `new Audio(src)` and `new Option(text, value, defaultSelected, selected)` (HTML). */
function namedConstructors(doc: Document): Record<string, unknown> {
  const Audio = function Audio(this: unknown, src?: string) {
    if (!new.target) throw new TypeError("Failed to construct 'Audio': Please use the 'new' operator.");
    const el = doc.createElement('audio');
    el.setAttribute('preload', 'auto');
    if (src !== undefined) el.setAttribute('src', String(src));
    return el;
  } as unknown as { prototype: unknown };
  Object.defineProperty(Audio, 'prototype', { value: HTMLAudioElement.prototype, writable: false });
  const Option = function Option(this: unknown, text?: string, value?: string, defaultSelected?: boolean, selected?: boolean) {
    if (!new.target) throw new TypeError("Failed to construct 'Option': Please use the 'new' operator.");
    const el = doc.createElement('option');
    if (text !== undefined && text !== '') el.textContent = String(text);
    if (value !== undefined) el.setAttribute('value', String(value));
    if (defaultSelected || selected) el.setAttribute('selected', '');
    return el;
  } as unknown as { prototype: unknown };
  Object.defineProperty(Option, 'prototype', { value: HTMLOptionElement.prototype, writable: false });
  return { Audio, Option };
}

export function installDom(global: typeof globalThis = globalThis, options: InstallDomOptions = {}): DomRegistry | null {
  const g = global as any;
  if (isWorkerScope()) return null;
  const mode = options.mode ?? 'missing';
  if (mode === 'missing' && g.document && typeof g.document === 'object') {
    warn('a document already exists; the DOM stand-ins stand down');
    return null;
  }
  const installed: string[] = [];
  const def = (name: string, value: unknown) => {
    if (mode === 'missing' && typeof g[name] !== 'undefined') return;
    Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });
    installed.push(name);
  };

  setNodeListClass(NodeList as unknown as new () => unknown[]);

  const interfaces: Record<string, unknown> = {
    Node, CharacterData, Text, CDATASection, Comment, ProcessingInstruction, DocumentType, DocumentFragment, ShadowRoot,
    Attr, NamedNodeMap, NodeList, HTMLCollection, DOMTokenList, Element, Document, HTMLDocument: Document, XMLDocument,
    DOMImplementation, DOMParser, XMLSerializer, Range, Selection, TreeWalker, NodeIterator: TreeWalker, NodeFilter,
    CSSStyleDeclaration, MutationObserver, MutationRecord, ResizeObserver, ResizeObserverEntry, ResizeObserverSize,
    IntersectionObserver, IntersectionObserverEntry, DOMRectReadOnly, DOMRect, DOMRectList, DOMMatrixReadOnly, DOMMatrix,
    WebKitCSSMatrix: DOMMatrix, DOMQuad, Screen, ScreenOrientation, VisualViewport, Window, CSS,
    ...HTML_INTERFACES,
    ...UI_EVENTS,
  };
  for (const [name, value] of Object.entries(interfaces)) def(name, value);
  installed.push(...installPoints(g));

  // The page's document.
  const doc = new Document();
  doc._inert = false;
  doc._defaultView = g;
  setDefaultDocument(doc);
  const markup = options.html !== undefined ? options.html : entryDocumentSource();
  try {
    buildHTMLDocument(doc, markup ?? '<!doctype html><html><head></head><body></body></html>');
  } catch (e) {
    warn(`the entry document could not be parsed (${e instanceof Error ? e.message : String(e)}); starting from an empty one`);
    for (const k of [...doc.childNodes]) doc.removeChild(k);
    buildHTMLDocument(doc, '<!doctype html><html><head></head><body></body></html>');
  }
  Object.defineProperty(g, 'document', { get: () => doc, configurable: true, enumerable: true });
  installed.push('document');

  // readystatechange before the core's DOMContentLoaded and load (registered first, so it runs first; the core
  // updates readyState before dispatching each).
  const fireReadyState = () => {
    try {
      doc.dispatchEvent(new BaseEvent('readystatechange'));
    } catch {
      // never break boot
    }
  };
  doc.addEventListener('DOMContentLoaded', fireReadyState);
  if (typeof g.addEventListener === 'function') g.addEventListener('load', fireReadyState);

  installed.push(...installWindowMembers(g, mode));
  for (const t of GLOBAL_HANDLERS) {
    if (!(`on${t}` in g)) defineHandler(g, t);
  }
  for (const [name, value] of Object.entries(namedConstructors(doc))) def(name, value);

  // structuredClone: nodes are platform objects that cannot be cloned (DataCloneError); geometry types clone.
  const glue = g[Symbol.for('iwn.glue')];
  const reg = glue?.cloneRegistry;
  if (reg) {
    try {
      reg.registerNonSerializable?.((v: unknown) => v instanceof Node);
      reg.registerCloneable?.({
        is: (v: object) => v instanceof DOMRectReadOnly,
        clone: (v: object) => {
          const r = v as DOMRectReadOnly;
          return v instanceof DOMRect ? new DOMRect(r.x, r.y, r.width, r.height) : new DOMRectReadOnly(r.x, r.y, r.width, r.height);
        },
      });
      reg.registerCloneable?.({
        is: (v: object) => v instanceof DOMMatrixReadOnly,
        clone: (v: object) => (v instanceof DOMMatrix ? DOMMatrix.fromMatrix(v as any) : DOMMatrixReadOnly.fromMatrix(v as any)),
      });
    } catch {
      // the clone registry is optional
    }
  }

  const registry: DomRegistry = {
    version: 1,
    document: doc,
    installed,
    buildHTMLDocument,
    stats: () => ({ elements: doc.getElementsByTagName('*').length, connectedCanvases: connectedCanvasCount() }),
  };
  Object.defineProperty(g, DOM_REGISTRY_KEY, { value: registry, configurable: true, enumerable: false, writable: false });
  void Element;
  void G;
  return registry;
}
