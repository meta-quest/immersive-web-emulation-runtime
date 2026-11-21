/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// DOM stand-ins (web/dom) against the spec's checks (docs/spec/12-browser-globals.md, DOM-1..10), evaluated as
// shipped: glue.min.js then dom.min.js in a bare V8 context.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDomContext, tick } from './harness.ts';

const SHOWCASE_HTML = `<!--
  comment before the doctype
-->
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>IWSDK Showcase: Interaction Lab</title>
    <link rel="icon" href="data:," />
    <script type="module" crossorigin src="./assets/index-qIbsdvrm.js"></script>
    <script>globalThis.__ranInline = (globalThis.__ranInline || 0) + 1;</script>
  </head>
  <body style="margin: 0">
    <div id="scene-container"></div>
    <div id="loading" class="x overlay" data-step="2"><p>Loading <b>assets</b>&hellip;</p></div>
  </body>
</html>`;

test('DOM-7: elements of the entry document exist at boot with ids, classes, attributes and text', () => {
  const { run } = createDomContext({ html: SHOWCASE_HTML });
  assert.equal(run(`document.getElementById('loading').className`), 'x overlay');
  assert.equal(run(`document.getElementById('scene-container').parentNode === document.body`), true);
  assert.equal(run(`document.title`), 'IWSDK Showcase: Interaction Lab');
  assert.equal(run(`document.body.getAttribute('style')`), 'margin: 0');
  assert.equal(run(`document.body.style.margin`), '0');
  assert.equal(run(`document.querySelector('#loading p').textContent`), 'Loading assets…');
  assert.equal(run(`document.getElementById('loading').dataset.step`), '2');
  assert.equal(run(`document.head.querySelectorAll('script').length`), 2);
  assert.equal(run(`document.doctype && document.doctype.name`), 'html');
  assert.equal(run(`document.documentElement.tagName`), 'HTML');
  // the core ran the entry document's scripts; the DOM never runs them again
  assert.equal(run(`globalThis.__ranInline`), undefined);
});

test('DOM-6: document basics, readyState and visibility follow the core lifecycle', () => {
  const c = createDomContext({ html: SHOWCASE_HTML });
  const { run } = c;
  assert.equal(run(`document.readyState`), 'loading');
  c.lifecycle.readyState = 'interactive';
  assert.equal(run(`document.readyState`), 'interactive');
  assert.equal(run(`document.visibilityState`), 'visible');
  c.lifecycle.visibilityState = 'hidden';
  assert.equal(run(`document.hidden`), true);
  assert.equal(run(`document.hasFocus()`), true);
  assert.equal(run(`document.URL`), 'https://app.local/');
  assert.equal(run(`new URL('x', document.baseURI).href`), 'https://app.local/x');
  assert.equal(run(`document.cookie`), '');
  assert.equal(run(`(document.cookie = 'a=1', document.cookie)`), '');
  assert.equal(run(`document.referrer`), '');
  assert.equal(run(`document.currentScript`), null);
  assert.equal(run(`document.fullscreenElement`), null);
  assert.equal(run(`document.pointerLockElement`), null);
  assert.equal(run(`document.activeElement === document.body`), true);
  assert.equal(run(`document.defaultView === globalThis`), true);
  assert.equal(run(`document instanceof Document && document instanceof Node && document instanceof EventTarget`), true);
  assert.equal(run(`Object.prototype.toString.call(document)`), '[object HTMLDocument]');
  return run(`document.exitFullscreen()`);
});

test('DOM-6: createElement returns the right interface for each tag', () => {
  const { run } = createDomContext({ html: '' });
  const cases: Record<string, string> = {
    canvas: 'HTMLCanvasElement', div: 'HTMLDivElement', link: 'HTMLLinkElement', script: 'HTMLScriptElement',
    style: 'HTMLStyleElement', video: 'HTMLVideoElement', audio: 'HTMLAudioElement', span: 'HTMLSpanElement',
    input: 'HTMLInputElement', a: 'HTMLAnchorElement', section: 'HTMLElement', 'my-widget': 'HTMLElement',
    blink: 'HTMLUnknownElement',
  };
  for (const [tag, iface] of Object.entries(cases)) {
    assert.equal(run(`document.createElement(${JSON.stringify(tag)}) instanceof ${iface}`), true, tag);
    assert.equal(run(`document.createElement(${JSON.stringify(tag)}) instanceof HTMLElement`), true, tag);
  }
  assert.equal(run(`document.createElement('CANVAS').tagName`), 'CANVAS');
  assert.equal(run(`document.createElement('canvas').localName`), 'canvas');
  assert.equal(run(`document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas') instanceof HTMLCanvasElement`), true);
  assert.equal(run(`document.createElementNS('http://www.w3.org/2000/svg', 'svg') instanceof SVGSVGElement`), true);
  assert.equal(run(`document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient').tagName`), 'linearGradient');
  assert.throws(() => run(`document.createElement('a b')`), /InvalidCharacterError|not a valid name/);
  assert.equal(run(`document.createTextNode('t').nodeType`), 3);
  assert.equal(run(`document.createDocumentFragment().nodeType`), 11);
  assert.equal(run(`document.createComment('c').nodeName`), '#comment');
  assert.equal(run(`document.createEvent('Event').type`), '');
  assert.equal(run(`(() => { const e = document.createEvent('CustomEvent'); e.initEvent('x', true, false); return e.type + e.bubbles; })()`), 'xtrue');
});

test('DOM-8: element API (attributes, classList, dataset, style, tree operations, queries)', () => {
  const { run } = createDomContext({ html: '<body><div id="root"></div></body>' });
  run(`
    var root = document.getElementById('root');
    var a = document.createElement('div'); a.id = 'a'; a.className = 'one two';
    var b = document.createElement('span'); b.classList.add('three'); b.setAttribute('data-foo-bar', 'baz');
    root.append(a, 'text', b);
  `);
  assert.equal(run(`root.childNodes.length`), 3);
  assert.equal(run(`root.children.length`), 2);
  assert.equal(run(`root.firstElementChild.id`), 'a');
  assert.equal(run(`a.nextSibling.nodeType`), 3);
  assert.equal(run(`a.nextElementSibling === b`), true);
  assert.equal(run(`b.previousElementSibling === a`), true);
  assert.equal(run(`a.classList.contains('two') && !a.classList.contains('three')`), true);
  assert.equal(run(`a.classList.toggle('two'), a.className`), 'one');
  assert.equal(run(`b.dataset.fooBar`), 'baz');
  assert.equal(run(`(b.dataset.newKey = 'v', b.getAttribute('data-new-key'))`), 'v');
  assert.equal(run(`Object.keys(b.dataset).join()`), 'fooBar,newKey');
  assert.equal(run(`a.style.backgroundColor = 'red', a.style.setProperty('z-index', '2'), a.getAttribute('style')`), 'background-color: red; z-index: 2;');
  assert.equal(run(`a.style.cssText = 'width: 10px; height: 5px', a.style.width + '|' + a.style.getPropertyValue('height') + '|' + a.style.length`), '10px|5px|2');
  assert.equal(run(`a.setAttribute('style', 'color: blue'), a.style.color + a.style.width`), 'blue');
  assert.equal(run(`a.style.removeProperty('color'), a.hasAttribute('style')`), false);
  assert.equal(run(`a.getAttributeNames().join()`), 'id,class');
  assert.equal(run(`a.attributes.length + a.attributes[0].name`), '2id');
  assert.equal(run(`root.querySelector('.three') === b`), true);
  assert.equal(run(`root.querySelectorAll('div, span').length`), 2);
  assert.equal(run(`document.querySelector('#root > span[data-foo-bar="baz"]') === b`), true);
  assert.equal(run(`document.querySelector('body div#a.one') === a`), true);
  assert.equal(run(`document.querySelector('div:not(#root)') === a`), true);
  assert.equal(run(`root.querySelector('span:first-child')`), null);
  assert.equal(run(`root.querySelector(':scope > div') === a`), true);
  assert.throws(() => run(`document.querySelector('div[')`), /SyntaxError|not a valid selector/);
  assert.equal(run(`b.closest('#root') === root && b.matches('span.three')`), true);
  assert.equal(run(`root.contains(b) && !b.contains(root)`), true);
  assert.equal(run(`var c = a.cloneNode(true); c.id === 'a' && c !== a && c.parentNode === null`), true);
  assert.equal(run(`root.replaceChild(c, a) === a && a.parentNode === null && root.firstChild === c`), true);
  assert.equal(run(`root.insertBefore(a, c), root.firstChild === a`), true);
  assert.equal(run(`c.remove(), root.children.length`), 2);
  assert.equal(run(`b.replaceWith(c), root.lastChild === c && b.parentNode === null`), true);
  assert.equal(run(`root.prepend(b), root.firstChild === b`), true);
  assert.throws(() => run(`root.removeChild(document.createElement('i'))`), /NotFoundError|not a child/);
  assert.throws(() => run(`a.appendChild(root)`), /HierarchyRequestError|contains the parent/);
  assert.equal(run(`a.isConnected && !document.createElement('x').isConnected`), true);
  assert.equal(run(`root.textContent`), 'text');
  assert.equal(run(`a.textContent = 'hi <b>', a.innerHTML`), 'hi &lt;b&gt;');
  assert.equal(run(`a.innerHTML = '<p class="k">one<br>two</p><!--c-->', a.firstChild.tagName + a.firstChild.childNodes.length + a.childNodes.length`), 'P32');
  assert.equal(run(`a.innerHTML`), '<p class="k">one<br>two</p><!--c-->');
  assert.equal(run(`a.outerHTML`), '<div id="a" class="one">' + '<p class="k">one<br>two</p><!--c-->' + '</div>');
  assert.equal(run(`a.insertAdjacentHTML('beforeend', '<i>x</i>'), a.lastChild.tagName`), 'I');
  assert.equal(run(`document.getElementsByTagName('p').length + document.getElementsByClassName('k').length`), 2);
});

test('DOM-8: geometry is the window rect for the canvas and what holds it, zeros otherwise', () => {
  const { run } = createDomContext({ html: '<body><div id="wrap"><div id="host"></div></div><div id="side"></div></body>', config: { viewport: { width: 1600, height: 900 } } });
  run(`var canvas = document.createElement('canvas'); document.getElementById('host').appendChild(canvas);`);
  assert.equal(run(`JSON.stringify(canvas.getBoundingClientRect())`), JSON.stringify({ x: 0, y: 0, width: 1600, height: 900, top: 0, right: 1600, bottom: 900, left: 0 }));
  assert.equal(run(`document.getElementById('wrap').clientWidth`), 1600);
  assert.equal(run(`document.body.offsetHeight`), 900);
  assert.equal(run(`document.getElementById('side').getBoundingClientRect().width`), 0);
  assert.equal(run(`canvas.remove(), document.getElementById('wrap').clientWidth`), 0);
  assert.equal(run(`innerWidth + 'x' + innerHeight + ' ' + screen.width + ' ' + visualViewport.height + ' ' + devicePixelRatio`), '1600x900 1600 900 1');
  assert.equal(run(`matchMedia('(min-width: 1500px)').matches && matchMedia('(orientation: landscape)').matches`), true);
});

test('DOM-2: events capture and bubble through the tree to document and window; handler attributes', () => {
  const { run } = createDomContext({ html: '<body><div id="p"><button id="b"></button></div></body>' });
  const order = run<string[]>(`
    var log = [];
    var p = document.getElementById('p'), b = document.getElementById('b');
    window.addEventListener('click', () => log.push('window-capture'), true);
    document.addEventListener('click', () => log.push('document-capture'), true);
    p.addEventListener('click', () => log.push('p-capture'), { capture: true });
    b.addEventListener('click', (e) => log.push('target:' + e.eventPhase));
    p.addEventListener('click', () => log.push('p-bubble'));
    document.body.onclick = () => log.push('body-onclick');
    document.addEventListener('click', () => log.push('document-bubble'));
    window.addEventListener('click', () => log.push('window-bubble'));
    b.click();
    log;
  `);
  assert.deepEqual([...order], ['window-capture', 'document-capture', 'p-capture', 'target:2', 'p-bubble', 'body-onclick', 'document-bubble', 'window-bubble']);
  assert.equal(run(`var e = new PointerEvent('pointerdown', { pointerId: 3, pointerType: 'pen', clientX: 5, bubbles: true }); e.pointerId + e.pointerType + e.clientX + e.pageX + e.bubbles + (e instanceof MouseEvent) + (e instanceof UIEvent) + (e instanceof Event)`), '3pen55truetruetruetrue');
  assert.equal(run(`var k = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true }); k.key + k.code + k.getModifierState('Control')`), 'aKeyAtrue');
  assert.equal(run(`new WheelEvent('wheel', { deltaY: 3 }).deltaY + WheelEvent.DOM_DELTA_LINE`), 4);
  assert.equal(run(`new FocusEvent('focus').relatedTarget`), null);
  assert.equal(run(`new PageTransitionEvent('pagehide', { persisted: true }).persisted`), true);
  // load on an element does not bubble to window through the document
  assert.equal(run(`var hits = 0; window.addEventListener('load', () => hits++); document.dispatchEvent(new Event('load', { bubbles: true })); hits`), 0);
});

test('DOM-6: readystatechange fires before DOMContentLoaded and before window load', () => {
  const c = createDomContext({ html: SHOWCASE_HTML });
  c.run(`var seen = []; document.addEventListener('readystatechange', () => seen.push('rsc:' + document.readyState));
    document.addEventListener('DOMContentLoaded', () => seen.push('dcl')); window.addEventListener('load', () => seen.push('load'));`);
  c.lifecycle.readyState = 'interactive';
  c.run(`document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }))`);
  c.lifecycle.readyState = 'complete';
  c.run(`window.dispatchEvent(new Event('load'))`);
  assert.deepEqual([...c.run<string[]>('seen')], ['rsc:interactive', 'dcl', 'rsc:complete', 'load']);
});

test('DOM-9: <script src> runs classic scripts and fires load; failures fire error; link and style fire load', async () => {
  const c = createDomContext({ html: '', files: { '/lib/a.js': 'globalThis.fromA = (globalThis.fromA || 0) + 1; var declared = 7;' } });
  c.run(`var events = [];
    var s = document.createElement('script'); s.src = 'lib/a.js';
    s.onload = () => events.push('load:' + globalThis.fromA + ':' + globalThis.declared);
    document.head.appendChild(s);
    var bad = document.createElement('script'); bad.src = '/missing.js'; bad.onerror = () => events.push('error');
    document.body.appendChild(bad);
    var l = document.createElement('link'); l.rel = 'modulepreload'; l.href = '/assets/x.js'; l.onload = () => events.push('link');
    document.head.appendChild(l);
    var st = document.createElement('style'); st.textContent = 'body{}'; st.onload = () => events.push('style');
    document.head.appendChild(st);
    var inline = document.createElement('script'); inline.textContent = 'globalThis.inlineRan = document.currentScript === inline;'; document.body.appendChild(inline);`);
  await tick(20);
  assert.equal(c.run(`globalThis.inlineRan`), true);
  assert.deepEqual([...c.run<string[]>('events')].sort(), ['error', 'link', 'load:1:7', 'style']);
  assert.deepEqual(c.fetched, ['https://app.local/lib/a.js', 'https://app.local/missing.js']);
  assert.equal(c.run(`document.createElement('link').relList.supports('modulepreload')`), true);
  assert.equal(c.run(`s.src`), 'https://app.local/lib/a.js');
  // a script moved again never runs twice; a data block never runs
  c.run(`document.body.appendChild(s); var d = document.createElement('script'); d.type = 'application/json'; d.textContent = 'throw 1'; document.body.appendChild(d);`);
  await tick(10);
  assert.equal(c.run(`globalThis.fromA`), 1);
});

test('DOM-6: <video>/<audio> are inert and say so (NotSupportedError naming the API, error event on src)', async () => {
  const c = createDomContext({ html: '' });
  assert.equal(c.run(`document.createElement('video').canPlayType('video/mp4')`), '');
  const msg = await c.run<Promise<string>>(`document.createElement('video').play().then(() => 'resolved', (e) => e.name + ': ' + e.message)`);
  assert.match(msg, /^NotSupportedError: HTMLVideoElement\.play\(\)/);
  c.run(`var v = document.createElement('video'); var got = null; v.addEventListener('error', () => got = v.error.code); v.src = 'clip.mp4';
    var au = new Audio('beep.mp3'); var auErr = false; au.onerror = () => auErr = true;`);
  await tick(5);
  assert.equal(c.run(`got`), 4);
  assert.equal(c.run(`auErr && au instanceof HTMLAudioElement && au.paused`), true);
});

test('DOM-10: MutationObserver records, ResizeObserver and IntersectionObserver fire once', async () => {
  const c = createDomContext({ html: '<body><div id="t"></div></body>' });
  c.run(`var records = []; var t = document.getElementById('t');
    new MutationObserver((rs) => { for (const r of rs) records.push(r.type + ':' + (r.attributeName || r.addedNodes.length + '/' + r.removedNodes.length) + ':' + r.oldValue); })
      .observe(document.body, { childList: true, attributes: true, subtree: true, attributeOldValue: true });
    t.setAttribute('class', 'a'); t.setAttribute('class', 'b'); var k = document.createElement('i'); t.appendChild(k); t.removeChild(k);`);
  await tick(0);
  assert.deepEqual([...c.run<string[]>('records')], ['attributes:class:null', 'attributes:class:a', 'childList:1/0:null', 'childList:0/1:null']);
  c.run(`var ro = []; var canvas = document.createElement('canvas'); document.body.appendChild(canvas);
    var r = new ResizeObserver((es) => { for (const e of es) ro.push(e.target.localName + ':' + e.contentRect.width + 'x' + e.contentBoxSize[0].blockSize); });
    r.observe(canvas); r.observe(document.createElement('div'));
    var io = []; new IntersectionObserver((es) => { for (const e of es) io.push(e.isIntersecting + ':' + e.intersectionRatio); }).observe(canvas);`);
  await tick(5);
  assert.deepEqual([...c.run<string[]>('ro')], ['canvas:1280x720']);
  assert.deepEqual([...c.run<string[]>('io')], ['true:1']);
});

test('DOM-10: DOMParser, XMLSerializer and the geometry interfaces', () => {
  const { run } = createDomContext({ html: '' });
  assert.equal(run(`new DOMParser().parseFromString('<p id=x>hi</p>', 'text/html').getElementById('x').textContent`), 'hi');
  assert.equal(run(`new DOMParser().parseFromString('<p>x</p>', 'text/html').body.firstChild.tagName`), 'P');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><linearGradient id="g"/><path d="M0 0L10 10" style="fill:red"/></svg>`;
  assert.equal(run(`var x = new DOMParser().parseFromString(${JSON.stringify(svg)}, 'image/svg+xml'); x.documentElement.namespaceURI + '|' + x.documentElement.childNodes.length + '|' + x.querySelector('path').getAttribute('d') + '|' + x.getElementsByTagName('linearGradient').length`), 'http://www.w3.org/2000/svg|2|M0 0L10 10|1');
  assert.equal(run(`x.querySelector('path').style.fill`), 'red');
  assert.equal(run(`new XMLSerializer().serializeToString(x.documentElement).startsWith('<svg xmlns="http://www.w3.org/2000/svg"')`), true);
  // DOMParser documents are inert: their scripts never run
  assert.equal(run(`new DOMParser().parseFromString('<script>globalThis.pwned = 1</script>', 'text/html'); typeof globalThis.pwned`), 'undefined');
  assert.equal(run(`var r = new DOMRect(1, 2, 3, 4); '' + r.right + r.bottom + (r instanceof DOMRectReadOnly)`), '46true');
  assert.equal(run(`var m = new DOMMatrix().translate(10, 20).scale(2); var p = m.transformPoint({ x: 1, y: 1 }); p.x + ',' + p.y + ',' + (p instanceof DOMPoint)`), '12,22,true');
  assert.equal(run(`var inv = m.inverse(); var q = inv.transformPoint(p); q.x + ',' + q.y`), '1,1');
  assert.equal(run(`new DOMMatrix('translate(5px, 6px) rotate(90deg)').toString().startsWith('matrix(')`), true);
  assert.equal(run(`DOMQuad.fromRect({ x: 1, y: 1, width: 2, height: 3 }).getBounds().height`), 3);
  assert.equal(run(`typeof DOMPointReadOnly === 'function' && new DOMPointReadOnly(1, 2, 3).w`), 1);
  assert.throws(() => run(`structuredClone(document.body)`), /DataCloneError|could not be cloned/);
  assert.equal(run(`structuredClone(new DOMRect(1, 2, 3, 4)).width`), 3);
});

test('DOM-3: window members, Window instanceof, getComputedStyle, dialogs log and return defaults', () => {
  const { run } = createDomContext({ html: '<body><div id="d" style="width: 7px"></div></body>' });
  assert.equal(run(`window instanceof Window && !({} instanceof Window)`), true);
  assert.equal(run(`getComputedStyle(document.getElementById('d')).width`), '7px');
  assert.equal(run(`getComputedStyle(document.body).display`), '');
  assert.equal(run(`scrollX + scrollY + pageYOffset`), 0);
  assert.equal(run(`scrollTo(0, 100), confirm('ok?')`), false);
  assert.equal(run(`prompt('name?')`), null);
  assert.equal(run(`open('https://example.com')`), null);
  assert.equal(run(`screen.orientation.type + screen.availWidth`), 'landscape-primary1280');
  assert.equal(run(`typeof window.onpointerdown === 'object' && typeof document.onkeydown === 'object'`), true);
  assert.equal(run(`getSelection().rangeCount`), 0);
  assert.equal(run(`CSS.supports('display', 'grid')`), false);
});

test('focus moves activeElement and fires focus/blur', () => {
  const { run } = createDomContext({ html: '<body><input id="i"><button id="b"></button></body>' });
  assert.equal(run(`var log = []; var i = document.getElementById('i'), b = document.getElementById('b');
    i.addEventListener('focus', () => log.push('i-focus')); i.addEventListener('blur', () => log.push('i-blur'));
    document.addEventListener('focusin', (e) => log.push('focusin:' + e.target.id));
    i.focus(); b.focus(); log.join() + '|' + (document.activeElement === b)`), 'i-focus,focusin:i,i-blur,focusin:b|true');
  assert.equal(run(`b.blur(), document.activeElement === document.body`), true);
});

test('image prelude: createElement("img") is the image module\'s HTMLImageElement on top of HTMLElement', () => {
  const { run } = createDomContext({ html: '', image: true });
  assert.equal(run(`var img = document.createElement('img'); (img instanceof HTMLImageElement) + ',' + (img instanceof HTMLElement) + ',' + img.tagName + ',' + img.localName`), 'true,true,IMG,img');
  assert.equal(run(`img.setAttribute('alt', 'a'); img.setAttribute('data-x', '1'); img.alt + img.dataset.x + img.getAttribute('data-x')`), 'a11');
  assert.equal(run(`new Image() instanceof HTMLElement`), true);
  assert.equal(run(`document.body.appendChild(img); document.querySelector('img') === img`), true);
});

test('workers: the prelude is a no-op in a worker scope', () => {
  const { run } = createDomContext({ html: '<body></body>', worker: true });
  assert.equal(run(`typeof document`), 'undefined');
  assert.equal(run(`typeof Node`), 'undefined');
});

test('HTMLCanvasElement without canvas2d: width/height defaults and getContext asks the WebGL prelude', () => {
  const { run } = createDomContext({ html: '' });
  assert.equal(run(`var cv = document.createElement('canvas'); cv.width + 'x' + cv.height`), '300x150');
  assert.equal(run(`cv.width = 64; cv.getAttribute('width')`), '64');
  assert.equal(run(`cv.getContext('2d')`), null);
  assert.equal(run(`globalThis.__iwnWebGL = { createContext: (c, t) => ({ canvas: c, t }) }; var gl = cv.getContext('webgl2'); gl.t + (gl.canvas === cv) + (cv.getContext('webgl2') === gl) + (cv.getContext('webgl') === null)`), 'webgl2truetruetrue');
});

test('DOM-8/DOM-9: template contents, script "already started" across clones, getElementsByName is a NodeList', () => {
  const html = `<!doctype html><html><head><script>globalThis.__entry = (globalThis.__entry || 0) + 1;</script></head>
    <body><template id="tp"><b id="inside">x</b><script>globalThis.__tpl = (globalThis.__tpl || 0) + 1;</script></template>
    <input name="n"><input name="n"></body></html>`;
  const { run } = createDomContext({ html });
  // the parser puts a template's children into its contents: not in the element, not visible to document queries
  assert.equal(run(`var tp = document.getElementById('tp'); tp.content.childNodes.length + ':' + tp.childNodes.length`), '2:0');
  assert.equal(run(`document.getElementById('inside') === null && document.querySelector('#inside') === null`), true);
  assert.equal(run(`tp.content.querySelector('#inside').textContent + '|' + tp.innerHTML.startsWith('<b id="inside">x</b><script>')`), 'x|true');
  assert.equal(run(`var c = tp.cloneNode(true); c.content.childNodes.length + ':' + c.childNodes.length + ':' + tp.cloneNode(false).content.childNodes.length`), '2:0:0');
  assert.equal(run(`document.importNode(tp, true).content.childNodes.length + ':' + document.importNode(tp, false).content.childNodes.length`), '2:0');
  assert.equal(run(`var t2 = document.createElement('template'); t2.innerHTML = '<i>a</i><i>b</i>'; t2.content.childNodes.length + ':' + t2.childNodes.length`), '2:0');
  // a template-contents script was never started: imported into the page it runs (as in browsers)
  assert.equal(run(`document.body.appendChild(document.importNode(tp.content, true)); globalThis.__tpl`), 1);
  // cloning keeps "already started": an entry-document script, a DOMParser script and an innerHTML script never run
  assert.equal(run(`document.body.appendChild(document.head.querySelector('script').cloneNode(true)); String(globalThis.__entry)`), 'undefined');
  assert.equal(run(`var d = new DOMParser().parseFromString('<script>globalThis.__pw = 1<\/script>', 'text/html');
    document.body.appendChild(document.importNode(d.querySelector('script'), true));
    document.body.appendChild(d.querySelector('script').cloneNode(true)); String(globalThis.__pw)`), 'undefined');
  assert.equal(run(`var h = document.createElement('div'); h.innerHTML = '<script>globalThis.__ih = 1<\/script>';
    document.body.appendChild(h.firstChild.cloneNode(true)); String(globalThis.__ih)`), 'undefined');
  // createContextualFragment scripts do run when inserted (HTML), and a fresh script element still runs
  assert.equal(run(`document.body.appendChild(document.createRange().createContextualFragment('<script>globalThis.__cf = 1<\/script>')); globalThis.__cf`), 1);
  assert.equal(run(`var s = document.createElement('script'); s.textContent = 'globalThis.__fresh = 1'; document.body.appendChild(s.cloneNode(true)); globalThis.__fresh`), 1);
  assert.equal(run(`var l = document.getElementsByName('n'); Object.prototype.toString.call(l) + ':' + l.length + ':' + (l.item(1) === document.querySelectorAll('input')[1])`), '[object NodeList]:2:true');
});
