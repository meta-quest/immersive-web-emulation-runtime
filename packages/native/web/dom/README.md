# web/dom

The DOM stand-ins of the @iwer/native runtime (spec `docs/spec/12-browser-globals.md`, DOM-2, DOM-3, DOM-6..10):
`document` and the node/element interfaces an unmodified IWSDK / three.js / Vite bundle touches, without layout or
rendering. Built as one IIFE, `dist/dom.min.js` (about 117 KB, 36 KB gzip). The template evaluates it right after the
web glue (`release/template-assets.json`), before the image, canvas2d, webgl, audio and xr preludes, on the page
global only; in a worker it does nothing (and the template's `workers.preludes` leave it out).

```
node build.mjs                                       # dist/dom.js + dist/dom.min.js (esbuild from web/glue's devDependencies)
node --test test/*.test.ts                           # evaluates glue.min.js + dom.min.js in a bare V8 context
../../node_modules/.bin/tsc -p .                     # from packages/native: node_modules/.bin/tsc -p web/dom
```

## What it provides

- **The tree** (`src/nodes.ts`): `Node`, `CharacterData`/`Text`/`Comment`/`CDATASection`/`ProcessingInstruction`,
  `DocumentType`, `DocumentFragment`, `ShadowRoot` (open/closed, no slotting), `Attr`/`NamedNodeMap`,
  `NodeList`/`HTMLCollection`, `Element` (attributes incl. namespaced, `classList`, `dataset`, `style`, `innerHTML`/
  `outerHTML`/`insertAdjacentHTML`, `textContent`, the ParentNode/ChildNode methods, `querySelector(All)`/`matches`/
  `closest`, `getElementsBy*`, pointer capture/lock and fullscreen requests that resolve), `DOMTokenList`. Nodes
  subclass the glue's `EventTarget` and implement its `GET_THE_PARENT` hook, so events capture and bubble element →
  … → `document` → `window` (a document's `load` does not reach the window, as in HTML).
- **Elements** (`src/html-elements.ts`): `HTMLElement` and the interfaces apps create: canvas, div/span/p/headings/
  lists/tables, a, label, link, style, script, meta/title/base, input/textarea/button/select/option/form/fieldset,
  iframe (no content), template (parsed children go into `content`; deep clones copy it), source/track/picture,
  video/audio (inert), plus `HTMLUnknownElement`,
  `SVGElement`/`SVGSVGElement`. Reflected attributes follow HTML (URL attributes resolve against the document URL).
  `GlobalEventHandlers` (`onclick`, `onpointerdown`, …) on elements, `document` and `window`.
- **The document** (`src/document.ts`): built at boot from the entry document's markup (the core's
  `__iwn.core.documentSource()`, i.e. the app's `index.html`): ids, classes, attributes, text and structure are there
  when the entry module evaluates (DOM-7); the entry document's scripts are never run again (the core ran them).
  `readyState`, `visibilityState`/`hidden` and `hasFocus()` read the core's lifecycle state; `readystatechange`
  fires before the core's `DOMContentLoaded` and window `load`. `title` from `<title>`, `URL`/`baseURI` from the
  glue's navigation state, `cookie`/`referrer` empty, `activeElement` (focus moves it and fires focus/blur/focusin/
  focusout), `fullscreenElement`/`pointerLockElement` null, `currentScript` during a classic script the DOM runs,
  `createElement(NS)`/`createTextNode`/`createDocumentFragment`/`createEvent`/`createRange`/`createTreeWalker`/
  `importNode`/`adoptNode`. `document.fonts` comes from the canvas2d prelude. `DOMParser` (`text/html` and the XML
  types; its documents are inert: scripts never run, not even when imported into the page, because clones keep a
  script's "already started" flag), `XMLSerializer`, a minimal `Range` and `Selection`.
- **Scripts and links** (DOM-9): a `<script src>` the app inserts runs as a classic script (fetched with the runtime's
  `fetch`, evaluated in the global scope with a `sourceURL`) or a module (`import()`), then fires `load`; a failed
  fetch fires `error`; inline scripts run when inserted; data blocks (`type="application/json"`, …) never run.
  `<link>` (stylesheet, preload, modulepreload, prefetch, icon) and `<style>` are accepted and fire `load`; nothing is
  styled. `link.relList.supports('modulepreload')` is true (Vite's preload helper checks it).
- **Media** (DOM-6, out of the alpha scope): `<video>`/`<audio>`/`new Audio()` exist so feature tests work, but
  `canPlayType()` returns `''`, `play()` rejects with a `NotSupportedError` naming `HTMLVideoElement.play()` /
  `HTMLMediaElement.play()`, and setting `src` fires `error` with `MEDIA_ERR_SRC_NOT_SUPPORTED`.
- **Observers** (DOM-10): `MutationObserver` with real records (childList, attributes, characterData, subtree,
  attributeFilter, old values; delivered in a microtask), `ResizeObserver` (fires once per observed element that has
  a box: the window size of DOM-3), `IntersectionObserver` (fires once, `isIntersecting: true`).
- **Geometry** (DOM-10): `DOMRect(ReadOnly)`, `DOMRectList`, `DOMMatrix(ReadOnly)` (4x4, transform-list strings,
  multiply/invert/transformPoint) and `DOMQuad`; `DOMPoint(ReadOnly)` are web/xr's classes (the ones IWER host mode
  uses), installed here when missing so the page has one set.
- **Window members** (DOM-3, `src/window.ts`): `innerWidth`/`innerHeight`/`outerWidth`/`outerHeight`, `screen` (+
  `orientation`), `visualViewport` from config `viewport` (default 1280x720, the glue's matchMedia uses the same
  size; it never changes, so no `resize`), scroll offsets 0 and scrolling no-ops, `getComputedStyle` (a read-only copy
  of the inline declarations: no cascade), `alert`/`confirm`/`prompt`/`print`/`open` (logged, default answers),
  `getSelection`, `CSS.supports()` (false) / `CSS.escape()`, and `Window` for `instanceof`. UI event constructors
  (`UIEvent`, `MouseEvent`, `PointerEvent`, `WheelEvent`, `KeyboardEvent`, `FocusEvent`, `InputEvent`,
  `CompositionEvent`) and `PageTransitionEvent` (the core's pagehide/pageshow), `StorageEvent`, `BeforeUnloadEvent`.

Geometry has no layout: `getBoundingClientRect()`, `client*`/`offset*` are the window rect for a canvas, `<html>`,
`<body>` and every ancestor of a connected canvas, and zeros for everything else. Nothing dispatches pointer or
keyboard input on this runtime (XR input comes through WebXR): listeners are accepted and never fire.

`structuredClone` of a node throws `DataCloneError`; `DOMRect`/`DOMMatrix` clone.

`globalThis[Symbol.for('iwn.dom')]` is the registry other runtime JS and diagnostics read: `{ version, document,
installed, buildHTMLDocument, stats() }`.

## Not provided

Layout and CSS (no cascade, no computed values beyond inline styles), custom elements (`customElements` is absent:
feature-detectable), slotting and shadow-tree event retargeting, `document.write`/`open` (logged and ignored),
editing (`execCommand` returns false), form submission and link navigation (logged; DOM-5 keeps one document), media
playback, drag and drop, the clipboard, and the DOM-11 miss report (later). Collections (`children`,
`getElementsBy*`, `document.images`/`scripts`) are snapshots, not live; a template's contents belong to its own
document rather than an inert one; sibling access is linear in the number of children (to optimise later).

## Sources

Sources: the DOM Living Standard (nodes, events dispatch, mutation observers, ranges/tree walkers), the HTML
Living Standard (element interfaces, reflection, script/link processing, document readiness, named constructors),
CSSOM and CSSOM View (CSSStyleDeclaration, geometry of `getBoundingClientRect`, `matchMedia` sizes), UI Events and
Pointer Events (event constructors), Geometry Interfaces Level 1 (DOMMatrix/DOMRect/DOMQuad), Resize Observer,
Intersection Observer, DOM Parsing (DOMParser/XMLSerializer), Selectors Level 4 (the selector subset), and the spec in
`docs/spec/12-browser-globals.md`. The XR module's TEST-ONLY scaffolding (`runtime/xr/tools/showcase-dom/dom-shim.js`) was
read for the list of members the showcase touches. No third-party code.
