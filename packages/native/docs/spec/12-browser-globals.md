# 12. The browser surface: window, document, navigator and friends

Scope: the non-graphics globals an unmodified IWSDK/three/Vite bundle touches. This is not a browser:
no layout, no CSS, no DOM tree rendering (see the app-developer page, PKG-14). The surface is sized to what
the 23 proto samples use and grows by sweeping them headlessly, then on device.

Sources: HTML Living Standard (Window, Location, History, Navigator, `document`), DOM Living Standard
(EventTarget, Event, Node/Element basics, MutationObserver), UI Events, Pointer Events, CSSOM View
(`matchMedia`, `getBoundingClientRect`, `devicePixelRatio`), Resize Observer, Intersection Observer,
WebIDL (`DOMException`); IWSDK source (what `World.create` and the Vite preload helper touch; the
injected-emulator check on `navigator.userAgent`); `docs/headless-showcase.md` (ours: the DOM and global
misses a headless sweep of the showcase reported).

**DOM-1 (MUST).** `window === globalThis === self`, `top`/`parent` are `window`, `frameElement` null,
`isSecureContext` true, `crossOriginIsolated` false, `origin` the app origin, `name` ''.
*Check:* runtime test.

**DOM-2 (MUST).** Events: `EventTarget` (capture/bubble phases along stand-in parent chains, `once`,
`passive`, `signal`), `Event`, `CustomEvent`, `ErrorEvent`, `PromiseRejectionEvent`, `MessageEvent`,
`ProgressEvent`, `UIEvent`, `MouseEvent`, `PointerEvent`, `WheelEvent`, `KeyboardEvent`, `FocusEvent`,
`StorageEvent` constructors with standard fields; `window.dispatchEvent`; `onX` handler attributes on
`window`, `document` and elements for the common events.
*Check:* WPT `dom/events` subset that needs no layout.

**DOM-3 (MUST).** `window`: `innerWidth/innerHeight` and `outerWidth/outerHeight` (fixed, documented
values, since there is no 2D panel (XR-IDLE); unchanged during XR), `devicePixelRatio` (1), `screen` (`width`, `height`,
`availWidth`, `availHeight`, `colorDepth`, `orientation`), `visualViewport` (minimal), `scrollX/Y` 0,
`scrollTo` no-op, `matchMedia(q)` (a `MediaQueryList` evaluated for width/height/orientation/
`prefers-color-scheme` (dark)/`prefers-reduced-motion` (no-preference)/`pointer`; others false; `change`
listeners accepted), `getComputedStyle` (returns a declaration with empty values), no `resize` events (the size never changes), `focus/blur`, `alert/confirm/prompt` (log and return defaults), `open` (log, returns
null), `postMessage` to self, `location` (DOM-5), `history` (`pushState`/`replaceState` update
`location` without navigation; `popstate` on `back()`), `requestIdleCallback`, `reportError`.
*Check:* runtime tests; showcase boot logs no misses.

**DOM-4 (MUST).** `navigator`: `userAgent` (see the open question in the index: it must contain
`Android` and identify the runtime and version; whether it also carries Quest Browser tokens is an open
question), `userAgentData` absent or minimal, `platform` (`Linux armv8l` or as Quest Browser), `vendor`,
`language`, `languages` (from the device locale), `onLine`, `hardwareConcurrency` (WRK-12), `deviceMemory`
(SHOULD), `maxTouchPoints`, `xr` (IWER), `getGamepads()` (IN-9), `vibrate()` false, `sendBeacon()` false,
`permissions.query` (resolves `granted` for features the app already has, `prompt` otherwise),
`storage.estimate`, `mediaCapabilities` absent, `mediaDevices` absent unless the app declares the camera
(then the passthrough cameras, XR-CAM-1), `gpu` absent (no WebGPU),
`serviceWorker` absent, `clipboard` absent, `wakeLock` absent, `share` absent.
*Check:* runtime test listing `typeof` for each.

**DOM-5 (MUST).** `location` reflects the app URL: the configured origin (PKG-CFG-2) + `/` (or the
entry document's path) + an optional query string set by the app's config or a debug launch override
(PKG-CFG-3) + hash. `href`, `origin`, `protocol`, `host`, `hostname`, `port`, `pathname`, `search` and
`hash` are consistent with that URL. `assign`/`replace` to the same document change the hash or reload
(PROC-8); cross-origin navigation logs and is ignored. `document.baseURI`, `document.URL` and
`document.documentURI` agree with it.
*Check:* pack with a query string `?a=1`; `location.search` is `?a=1` and `new URL('x', document.baseURI)`
resolves under the origin.

**DOM-6 (MUST).** `document`: `readyState` progression `loading` → `interactive` → `complete` with
`readystatechange`, `DOMContentLoaded` and `window` `load` fired at the right points relative to module
evaluation (deferred-module semantics: DOMContentLoaded after the entry module evaluates, as in browsers);
`visibilityState`/`hidden` and `visibilitychange` follow the app's foreground state (not the XR session);
`hasFocus()`; `title` (from `index.html`); `head`, `body`, `documentElement`; `createElement`/
`createElementNS` for any tag returning an element of the right interface (`HTMLCanvasElement`,
`HTMLImageElement`, `HTMLDivElement`, `HTMLLinkElement`, `HTMLScriptElement`, `HTMLStyleElement`,
`HTMLVideoElement`/`HTMLAudioElement` (no decoder: `canPlayType('')`, `play()` rejects `NotSupportedError`, a
`src` fires `error`; a camera `MediaStream` as `srcObject` plays, XR-CAM-1), generic `HTMLElement` otherwise); `createTextNode`, `createDocumentFragment`,
`createEvent`; `getElementById`, `getElementsByTagName/ClassName`, `querySelector/All` for simple
selectors (tag, `#id`, `.class`, `[attr]`, descendant combinator) over the stand-in tree;
`activeElement`, `fullscreenElement` null with `exitFullscreen` resolving, `pointerLockElement` null;
`cookie` ''; `referrer` ''; `currentScript`; `fonts` (C2D-10).
*Check:* WPT-style tests for event order; the showcase and 23 samples report no DOM misses headlessly.

**DOM-7 (MUST).** Elements present in the app's `index.html` exist at boot with their ids, classes,
attributes, text content and parent/child structure (the packer extracts them; no CSS applied), so apps
that look up their loading overlay or scene container find it.
*Check:* an `index.html` with `<div id="loading" class="x">` — `getElementById('loading').className`
is `x` at entry evaluation.

**DOM-8 (MUST).** Element stand-ins support: `id`, `className`, `classList`, `dataset`, attributes API,
`style` (a `CSSStyleDeclaration` accepting any property, `setProperty/getPropertyValue/removeProperty/
cssText`), `textContent`, `innerHTML`/`outerHTML` (stored strings; `innerHTML` parses simple markup into
stand-ins SHOULD), `appendChild/insertBefore/removeChild/replaceChild/append/prepend/remove/
replaceWith/cloneNode/contains`, `children`, `childNodes`, `parentNode/parentElement`,
`firstChild/lastChild/nextSibling/previousSibling`, `isConnected`, `addEventListener`,
`getBoundingClientRect` (the canvas and its ancestors: the window rect of DOM-3; others zeros), `clientWidth/Height`,
`offsetWidth/Height` (same rule), `focus/blur`, `requestPointerLock`/`requestFullscreen` (resolve or no-op),
`setPointerCapture/releasePointerCapture`, `closest`, `matches` (simple selectors).
*Check:* tests.

**DOM-9 (MUST).** A `<script>` element appended to the document with `src` loads and runs as a classic
script (or module for `type="module"`) and fires `load`/`error`; a `<link rel="modulepreload">` follows
MOD-7; `<link rel="stylesheet">` and `<style>` are accepted and fire `load` (no styling).
*Check:* tests.

**DOM-10 (MUST).** `MutationObserver` (records for childList/attributes changes on the stand-in tree, or
accepted no-op if records are never needed — choose by sweep), `ResizeObserver` (fires once on observe
for the canvas/container with the fixed window size of DOM-3), `IntersectionObserver` (fires once with
`isIntersecting: true`), `DOMParser` (`parseFromString` for `text/html`/`application/xml` producing a
stand-in tree SHOULD; at least returns a document whose queries return null), `XMLSerializer` (SHOULD),
`DOMRect`, `DOMMatrix`/`DOMPoint`/`DOMPointReadOnly`/`DOMQuad` (geometry interfaces, used by WebXR and
some math code), `DOMException` (all names and legacy codes), `DOMTokenList`, `AbortController/
AbortSignal` (`timeout`, `any`), `Notification`/`ServiceWorker` absent.
*Check:* tests; sweep shows which observers produce records.

**DOM-11 (MUST).** Missing-surface diagnostics: reading a property the runtime knows browsers have but it
does not implement is silent (returns `undefined`, as feature detection expects), but calling a stand-in
method that exists only as a placeholder throws a `TypeError` naming the interface and member; a debug
switch records all global and DOM misses with counts (the headless runner's report and the device's
debug endpoint both expose it).
*Check:* the miss report lists `VideoFrame` (three's feature test) and nothing unexpected for the showcase.

**DOM-12 (MUST).** `structuredClone`, `queueMicrotask`, `setTimeout` family, `crypto`, `performance`,
`TextEncoder/Decoder`, `URL`, `Blob`, `fetch` are on the window global with the semantics of
[01](01-process-event-loop.md) and [04](04-fetch-assets-network-storage.md).
*Check:* covered there.
