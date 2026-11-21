// @iwer/native core bootstrap: runs once per page context, before any prelude (web glue) or page script.
// Installs what the event loop owns: console (Console Living Standard formatter -> logcat via __iwn.core.log,
// forwarded to V8's console while DevTools is attached), timers (HTML §8.6, scheduled natively), window
// requestAnimationFrame (HTML §8.10, snapshot per frame, callbacks called natively), queueMicrotask, requestIdleCallback, structuredClone,
// reportError, a minimal performance object, and the hooks the native side calls (timer, frame, error,
// unhandled rejection, lifecycle, document readiness). Page-facing DOM objects (EventTarget, Event, document,
// location, ...) belong to the web glue; this file only uses them when they exist.
//
// Evaluates to a function (natives, global). Spec IDs: CON-1..4, TMR-1..5, LOOP-1, LOOP-4, PROC-6.
(function iwnCoreBootstrap(natives, global) {
  'use strict';

  const core = natives.core;
  const clock = natives.clock;
  const v8console = global.console;
  const ReflectApply = Reflect.apply;
  const ObjectDefineProperty = Object.defineProperty;
  const workerPrefix = core.isWorker && core.workerName ? '[' + core.workerName + '] ' : '';

  function define(target, name, value) {
    ObjectDefineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Inspection (one level deep by default, bounded; CON-2)

  const MAX_ITEMS = 100;
  const MAX_KEYS = 50;
  const MAX_CHARS = 4000;
  const TypedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
  const typedArrayTag = Object.getOwnPropertyDescriptor(TypedArrayProto, Symbol.toStringTag).get;

  function quote(s) {
    return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
  }

  function constructorName(obj) {
    try {
      const tag = obj[Symbol.toStringTag];
      if (typeof tag === 'string' && tag) return tag;
      const proto = Object.getPrototypeOf(obj);
      if (proto === null) return '[Object: null prototype]';
      const ctor = proto && Object.prototype.hasOwnProperty.call(proto, 'constructor') ? proto.constructor : null;
      if (ctor && typeof ctor.name === 'string' && ctor.name) return ctor.name;
    } catch {
      // exotic objects (revoked proxies, throwing getters)
    }
    return 'Object';
  }

  function inspect(value, depth, seen, nested) {
    switch (typeof value) {
      case 'string':
        return nested ? quote(value) : value;
      case 'number':
        return Object.is(value, -0) ? '-0' : String(value);
      case 'bigint':
        return String(value) + 'n';
      case 'symbol':
        return value.toString();
      case 'undefined':
        return 'undefined';
      case 'boolean':
        return String(value);
      case 'function': {
        let src = '';
        try {
          src = Function.prototype.toString.call(value);
        } catch {
          // ignore
        }
        const name = value.name ? value.name : '';
        if (/^class\b/.test(src)) return '[class ' + (name || '(anonymous)') + ']';
        return '[Function: ' + (name || '(anonymous)') + ']';
      }
      default:
        break;
    }
    if (value === null) return 'null';
    if (seen.includes(value)) return '[Circular]';
    try {
      if (value instanceof Error) {
        const stack = typeof value.stack === 'string' ? value.stack : '';
        return stack || String(value.name) + ': ' + String(value.message);
      }
      if (value instanceof Date) return isNaN(value) ? 'Invalid Date' : value.toISOString();
      if (value instanceof RegExp) return String(value);
      if (value instanceof Promise) return 'Promise {…}';
      if (value instanceof WeakMap || value instanceof WeakSet) return constructorName(value) + ' { <items unknown> }';
      if (value instanceof ArrayBuffer) return 'ArrayBuffer { byteLength: ' + value.byteLength + ' }';
      if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
        return 'SharedArrayBuffer { byteLength: ' + value.byteLength + ' }';
      }
    } catch {
      return '[object]';
    }
    if (depth < 0) {
      if (Array.isArray(value)) return '[Array]';
      return '[' + constructorName(value) + ']';
    }
    seen.push(value);
    let out;
    try {
      out = inspectObject(value, depth, seen);
    } finally {
      seen.pop();
    }
    return out.length > MAX_CHARS ? out.slice(0, MAX_CHARS) + '…' : out;
  }

  function inspectObject(value, depth, seen) {
    const parts = [];
    if (Array.isArray(value)) {
      const n = Math.min(value.length, MAX_ITEMS);
      for (let i = 0; i < n; i++) parts.push(i in value ? inspect(value[i], depth - 1, seen, true) : '<empty>');
      if (value.length > n) parts.push('... ' + (value.length - n) + ' more items');
      return '[' + parts.join(', ') + ']';
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const tag = typedArrayTag.call(value);
      const n = Math.min(value.length, MAX_ITEMS);
      for (let i = 0; i < n; i++) parts.push(inspect(value[i], 0, seen, true));
      if (value.length > n) parts.push('... ' + (value.length - n) + ' more items');
      return tag + '(' + value.length + ') [' + parts.join(', ') + ']';
    }
    if (value instanceof Map) {
      let i = 0;
      for (const [k, v] of value) {
        if (i++ >= MAX_ITEMS) {
          parts.push('...');
          break;
        }
        parts.push(inspect(k, depth - 1, seen, true) + ' => ' + inspect(v, depth - 1, seen, true));
      }
      return 'Map(' + value.size + ') {' + parts.join(', ') + '}';
    }
    if (value instanceof Set) {
      let i = 0;
      for (const v of value) {
        if (i++ >= MAX_ITEMS) {
          parts.push('...');
          break;
        }
        parts.push(inspect(v, depth - 1, seen, true));
      }
      return 'Set(' + value.size + ') {' + parts.join(', ') + '}';
    }
    let keys;
    try {
      keys = Object.keys(value);
    } catch {
      return '[' + constructorName(value) + ']';
    }
    const shown = Math.min(keys.length, MAX_KEYS);
    for (let i = 0; i < shown; i++) {
      const k = keys[i];
      const desc = Object.getOwnPropertyDescriptor(value, k);
      let rendered;
      if (desc && (desc.get || desc.set)) {
        rendered = desc.get && desc.set ? '[Getter/Setter]' : desc.get ? '[Getter]' : '[Setter]';
      } else {
        rendered = inspect(desc ? desc.value : undefined, depth - 1, seen, true);
      }
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : quote(k);
      parts.push(key + ': ' + rendered);
    }
    if (keys.length > shown) parts.push('...');
    const name = constructorName(value);
    const body = parts.length ? '{' + parts.join(', ') + '}' : '{}';
    return name === 'Object' ? body : name + ' ' + body;
  }

  // Console standard "Formatter" (%s %d %i %f %o %O %c %%), then the remaining arguments space-separated.
  function format(args) {
    if (args.length === 0) return '';
    let out = '';
    let next = 0;
    const first = args[0];
    if (typeof first === 'string') {
      next = 1;
      let i = 0;
      while (i < first.length) {
        const c = first.charCodeAt(i);
        if (c === 37 /* % */ && i + 1 < first.length) {
          const spec = first[i + 1];
          if (spec === '%') {
            out += '%';
            i += 2;
            continue;
          }
          if ('sdifoOc'.includes(spec) && next < args.length) {
            const arg = args[next++];
            if (spec === 's') {
              out += typeof arg === 'object' && arg !== null ? inspect(arg, 1, [], true) : typeof arg === 'bigint' ? arg + 'n' : String(arg);
            } else if (spec === 'd' || spec === 'i') {
              out += typeof arg === 'symbol' ? 'NaN' : typeof arg === 'bigint' ? arg + 'n' : String(parseInt(arg, 10));
            } else if (spec === 'f') {
              out += typeof arg === 'symbol' ? 'NaN' : String(parseFloat(arg));
            } else if (spec === 'o' || spec === 'O') {
              out += inspect(arg, spec === 'O' ? 1 : 2, [], true);
            }
            // %c: styling, consumed and ignored in logcat
            i += 2;
            continue;
          }
        }
        out += first[i];
        i++;
      }
    }
    for (; next < args.length; next++) {
      const a = args[next];
      out += (out.length || next > 0 ? ' ' : '') + (typeof a === 'string' ? a : inspect(a, 1, [], false));
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // console (CON-1..4)

  const LEVEL = { debug: 0, info: 1, warn: 2, error: 3 };
  let groupIndent = '';
  const counts = new Map();
  const timers = new Map();

  function emit(level, text) {
    let line = workerPrefix + text;
    if (groupIndent) line = line.replace(/^/gm, groupIndent);
    core.log(level, line);
  }
  function forward(name, args) {
    if (!v8console || core.inspectorSessions() === 0) return;
    const f = v8console[name];
    if (typeof f === 'function') {
      try {
        ReflectApply(f, v8console, args);
      } catch {
        // never let DevTools forwarding break the page
      }
    }
  }
  function stackLines(skip) {
    const s = new Error().stack || '';
    return s.split('\n').slice(skip).join('\n');
  }

  const console = {};
  const simple = { log: LEVEL.info, info: LEVEL.info, debug: LEVEL.debug, warn: LEVEL.warn, error: LEVEL.error, dirxml: LEVEL.info };
  for (const name of Object.keys(simple)) {
    const level = simple[name];
    const fn = {
      [name](...args) {
        emit(level, format(args));
        forward(name, args);
      },
    }[name];
    define(console, name, fn);
    ObjectDefineProperty(console, name, { enumerable: true });
  }
  const extra = {
    trace(...args) {
      emit(LEVEL.info, 'Trace' + (args.length ? ': ' + format(args) : '') + '\n' + stackLines(2));
      forward('trace', args);
    },
    assert(condition, ...args) {
      if (condition) return;
      emit(LEVEL.error, 'Assertion failed' + (args.length ? ': ' + format(args) : ''));
      forward('assert', [condition, ...args]);
    },
    dir(item, options) {
      const depth = options && typeof options.depth === 'number' ? options.depth : 1;
      emit(LEVEL.info, typeof item === 'string' ? quote(item) : inspect(item, depth, [], false));
      forward('dir', [item, options]);
    },
    table(data, columns) {
      emit(LEVEL.info, renderTable(data, columns));
      forward('table', [data, columns]);
    },
    group(...label) {
      emit(LEVEL.info, label.length ? format(label) : 'console.group');
      groupIndent += '  ';
      forward('group', label);
    },
    groupCollapsed(...label) {
      emit(LEVEL.info, label.length ? format(label) : 'console.groupCollapsed');
      groupIndent += '  ';
      forward('groupCollapsed', label);
    },
    groupEnd() {
      groupIndent = groupIndent.slice(2);
      forward('groupEnd', []);
    },
    count(label = 'default') {
      label = String(label);
      const n = (counts.get(label) || 0) + 1;
      counts.set(label, n);
      emit(LEVEL.info, label + ': ' + n);
      forward('count', [label]);
    },
    countReset(label = 'default') {
      label = String(label);
      if (counts.has(label)) counts.set(label, 0);
      else emit(LEVEL.warn, "Count for '" + label + "' does not exist");
      forward('countReset', [label]);
    },
    time(label = 'default') {
      label = String(label);
      if (timers.has(label)) emit(LEVEL.warn, "Timer '" + label + "' already exists");
      else timers.set(label, clock.now());
      forward('time', [label]);
    },
    timeLog(label = 'default', ...data) {
      label = String(label);
      if (!timers.has(label)) {
        emit(LEVEL.warn, "Timer '" + label + "' does not exist");
      } else {
        const ms = clock.now() - timers.get(label);
        emit(LEVEL.info, label + ': ' + ms.toFixed(3) + ' ms' + (data.length ? ' ' + format(data) : ''));
      }
      forward('timeLog', [label, ...data]);
    },
    timeEnd(label = 'default') {
      label = String(label);
      if (!timers.has(label)) {
        emit(LEVEL.warn, "Timer '" + label + "' does not exist");
      } else {
        const ms = clock.now() - timers.get(label);
        timers.delete(label);
        emit(LEVEL.info, label + ': ' + ms.toFixed(3) + ' ms');
      }
      forward('timeEnd', [label]);
    },
    clear() {
      forward('clear', []);
    },
  };
  for (const name of Object.keys(extra)) {
    ObjectDefineProperty(console, name, { value: extra[name], writable: true, configurable: true, enumerable: true });
  }
  ObjectDefineProperty(console, Symbol.toStringTag, { value: 'console', configurable: true });

  function renderTable(data, columns) {
    if (data === null || typeof data !== 'object') return format([data]);
    const rows = [];
    const cols = [];
    const addCol = (c) => {
      if (!cols.includes(c)) cols.push(c);
    };
    const entries = data instanceof Map ? [...data.entries()] : Object.entries(data);
    let hasValues = false;
    for (const [k, v] of entries.slice(0, MAX_ITEMS)) {
      const row = { '(index)': String(k) };
      if (v !== null && typeof v === 'object') {
        for (const c of Object.keys(v)) {
          if (columns && !columns.includes(c)) continue;
          addCol(c);
          row[c] = inspect(v[c], 0, [], true);
        }
      } else {
        hasValues = true;
        row.Values = inspect(v, 0, [], true);
      }
      rows.push(row);
    }
    const header = ['(index)', ...cols, ...(hasValues ? ['Values'] : [])];
    const widths = header.map((h) => Math.max(h.length, ...rows.map((r) => (r[h] === undefined ? 0 : r[h].length))));
    const line = (cells) => '│ ' + cells.map((c, i) => c.padEnd(widths[i])).join(' │ ') + ' │';
    const out = [line(header)];
    for (const r of rows) out.push(line(header.map((h) => (r[h] === undefined ? '' : r[h]))));
    return out.join('\n');
  }

  define(global, 'console', console);

  // ---------------------------------------------------------------------------------------------------------------
  // Error reporting (HTML "report an exception", LOOP-4)

  function makeEvent(ctorName, type, init) {
    const Ctor = typeof global[ctorName] === 'function' ? global[ctorName] : null;
    if (Ctor) {
      try {
        return new Ctor(type, init);
      } catch {
        // fall through to Event
      }
    }
    if (typeof global.Event === 'function') {
      const ev = new global.Event(type, init);
      for (const k of Object.keys(init)) {
        if (!(k in ev)) {
          try {
            ObjectDefineProperty(ev, k, { value: init[k], enumerable: true });
          } catch {
            // ignore
          }
        }
      }
      return ev;
    }
    return null;
  }

  function dispatchOn(target, ev, type, legacyArgs) {
    if (target && typeof target.dispatchEvent === 'function' && ev) {
      target.dispatchEvent(ev);
      return !ev.defaultPrevented;
    }
    // No EventTarget yet (glue not loaded): honour an on<type> handler.
    const handler = target ? target['on' + type] : undefined;
    if (typeof handler === 'function') {
      let prevented = false;
      const fake = {
        type,
        preventDefault() {
          prevented = true;
        },
      };
      Object.assign(fake, legacyArgs && legacyArgs.init);
      const r = legacyArgs && legacyArgs.positional ? ReflectApply(handler, target, legacyArgs.positional) : ReflectApply(handler, target, [fake]);
      if (type === 'error' && r === true) prevented = true;
      return !prevented;
    }
    return true;
  }

  function dispatchError(error, message, filename, lineno, colno) {
    const init = { cancelable: true, message, filename, lineno, colno, error };
    const ev = makeEvent('ErrorEvent', 'error', init);
    return dispatchOn(global, ev, 'error', { positional: [message, filename, lineno, colno, error] });
  }

  // reportError(e): native "report an exception" (error event with the error's own location, then logcat and
  // DevTools unless cancelled; error reporting mode handles a handler that reports again).
  function reportError(error) {
    core.reportError(error);
  }
  define(global, 'reportError', reportError);

  // ---------------------------------------------------------------------------------------------------------------
  // Timers (HTML §8.6; scheduling, ids, nesting clamp in native code: TMR-1, TMR-2)

  const timerCallbacks = new Map();
  let warnedStringHandler = false;

  function toHandler(handler) {
    if (typeof handler === 'function') return handler;
    if (!warnedStringHandler) {
      warnedStringHandler = true;
      emit(LEVEL.warn, 'setTimeout/setInterval with a string handler: the string is evaluated as script');
    }
    const code = String(handler);
    return function stringTimerHandler() {
      (0, eval)(code);
    };
  }
  function toTimeout(timeout) {
    // WebIDL `long`: ToNumber, then ToInt32 (wraps); negative means 0 (handled natively).
    return Number(timeout) | 0;
  }
  function setTimeout(handler, timeout = 0, ...args) {
    const fn = toHandler(handler);
    const id = core.timerAdd(toTimeout(timeout), false);
    timerCallbacks.set(id, { fn, args, repeat: false });
    return id;
  }
  function setInterval(handler, timeout = 0, ...args) {
    const fn = toHandler(handler);
    const id = core.timerAdd(toTimeout(timeout), true);
    timerCallbacks.set(id, { fn, args, repeat: true });
    return id;
  }
  function clearTimer(id = 0) {
    id = Number(id) | 0;
    if (timerCallbacks.delete(id)) core.timerClear(id);
  }
  define(global, 'setTimeout', setTimeout);
  define(global, 'setInterval', setInterval);
  define(global, 'clearTimeout', { clearTimeout: (id) => clearTimer(id) }.clearTimeout);
  define(global, 'clearInterval', { clearInterval: (id) => clearTimer(id) }.clearInterval);

  // ---------------------------------------------------------------------------------------------------------------
  // queueMicrotask, structuredClone

  define(global, 'queueMicrotask', function queueMicrotask(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError("Failed to execute 'queueMicrotask': The callback provided as parameter 1 is not a function.");
    }
    // Called from a native microtask with no JS try/catch around it: an exception is reported natively with its
    // location, and DevTools' "pause on uncaught exceptions" stops at the throw (CDP-5, LOOP-4).
    core.enqueueMicrotask(callback);
  });

  if (natives.clone && typeof natives.clone.structuredClone === 'function') {
    define(global, 'structuredClone', function structuredClone(value, options = undefined) {
      const transfer = options && options.transfer ? [...options.transfer] : [];
      return natives.clone.structuredClone(value, transfer);
    });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Window animation frames (HTML §8.10, TMR-5) and idle callbacks (TMR-3)

  let frameCallbacks = new Map();
  let nextFrameHandle = 0;
  let lastFrameTime = -Infinity;

  define(global, 'requestAnimationFrame', function requestAnimationFrame(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError("Failed to execute 'requestAnimationFrame': The callback provided as parameter 1 is not a function.");
    }
    const handle = ++nextFrameHandle;
    frameCallbacks.set(handle, callback);
    core.requestFrame();
    return handle;
  });
  define(global, 'cancelAnimationFrame', function cancelAnimationFrame(handle) {
    frameCallbacks.delete(Number(handle));
  });

  // HTML "run the animation frame callbacks", split so that native code calls each callback (no JS try/catch
  // around page code, CDP-5): frameBegin snapshots the handles (callbacks requested during this round wait for
  // the next frame); native code then calls frameCallback(handle, now) for each, with a microtask checkpoint
  // after every callback (LOOP-1).
  function frameBegin(now) {
    lastFrameTime = now;
    return [...frameCallbacks.keys()];
  }
  function frameCallback(handle, now) {
    const cb = frameCallbacks.get(handle);
    if (cb === undefined) return; // cancelled by an earlier callback of this round
    frameCallbacks.delete(handle);
    cb(now);
  }

  const idleCallbacks = new Map();
  let nextIdleHandle = 0;
  const FRAME_MS = 1000 / 60;
  define(global, 'requestIdleCallback', function requestIdleCallback(callback, options = undefined) {
    if (typeof callback !== 'function') {
      throw new TypeError("Failed to execute 'requestIdleCallback': The callback provided as parameter 1 is not a function.");
    }
    const handle = ++nextIdleHandle;
    const timerId = core.timerAdd(1, false);
    idleCallbacks.set(handle, timerId);
    timerCallbacks.set(timerId, {
      repeat: false,
      args: [],
      fn() {
        if (!idleCallbacks.delete(handle)) return;
        const start = clock.now();
        const framePending = frameCallbacks.size > 0;
        const deadline = framePending ? Math.max(start, lastFrameTime + FRAME_MS) : start + 50;
        callback({
          didTimeout: false,
          timeRemaining() {
            return Math.max(0, deadline - clock.now());
          },
        });
      },
    });
    void options;
    return handle;
  });
  define(global, 'cancelIdleCallback', function cancelIdleCallback(handle) {
    const timerId = idleCallbacks.get(Number(handle));
    if (timerId === undefined) return;
    idleCallbacks.delete(Number(handle));
    clearTimer(timerId);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // performance (TMR-4, minimal; the glue may replace it with a fuller one)

  if (typeof global.performance === 'undefined') {
    const entries = [];
    const timeOrigin = clock.timeOrigin();
    const mkEntry = (name, entryType, startTime, duration, detail) => ({ name, entryType, startTime, duration, detail: detail === undefined ? null : detail, toJSON() { return { name, entryType, startTime, duration }; } });
    const performance = {
      now: () => clock.now(),
      timeOrigin,
      mark(name, options = undefined) {
        const e = mkEntry(String(name), 'mark', options && typeof options.startTime === 'number' ? options.startTime : clock.now(), 0, options && options.detail);
        entries.push(e);
        return e;
      },
      measure(name, start = undefined, end = undefined) {
        const find = (n) => {
          for (let i = entries.length - 1; i >= 0; i--) if (entries[i].name === n && entries[i].entryType === 'mark') return entries[i].startTime;
          throw new SyntaxError("The mark '" + n + "' does not exist.");
        };
        let s = 0;
        let t = clock.now();
        if (start && typeof start === 'object') {
          s = typeof start.start === 'string' ? find(start.start) : start.start || 0;
          t = typeof start.end === 'string' ? find(start.end) : typeof start.end === 'number' ? start.end : t;
        } else {
          if (typeof start === 'string') s = find(start);
          if (typeof end === 'string') t = find(end);
        }
        const e = mkEntry(String(name), 'measure', s, t - s, start && start.detail);
        entries.push(e);
        return e;
      },
      getEntries: () => entries.slice(),
      getEntriesByName: (n, type) => entries.filter((e) => e.name === n && (!type || e.entryType === type)),
      getEntriesByType: (type) => entries.filter((e) => e.entryType === type),
      clearMarks(n) {
        for (let i = entries.length - 1; i >= 0; i--) if (entries[i].entryType === 'mark' && (n === undefined || entries[i].name === n)) entries.splice(i, 1);
      },
      clearMeasures(n) {
        for (let i = entries.length - 1; i >= 0; i--) if (entries[i].entryType === 'measure' && (n === undefined || entries[i].name === n)) entries.splice(i, 1);
      },
      toJSON: () => ({ timeOrigin }),
    };
    define(global, 'performance', performance);
  }

  if (typeof global.window === 'undefined') define(global, 'window', global);
  if (typeof global.self === 'undefined') define(global, 'self', global);

  // ---------------------------------------------------------------------------------------------------------------
  // Hooks the native side calls

  core.setHooks({
    timer(id) {
      const t = timerCallbacks.get(id);
      if (t === undefined) return;
      if (!t.repeat) timerCallbacks.delete(id);
      ReflectApply(t.fn, global, t.args);
    },
    frameBegin,
    frameCallback,
    error(error, message, filename, lineno, colno) {
      return dispatchError(error, message, filename, lineno, colno);
    },
    rejection(promise, reason) {
      const ev = makeEvent('PromiseRejectionEvent', 'unhandledrejection', { cancelable: true, promise, reason });
      return dispatchOn(global, ev, 'unhandledrejection', { init: { promise, reason } });
    },
    rejectionHandled(promise, reason) {
      const ev = makeEvent('PromiseRejectionEvent', 'rejectionhandled', { promise, reason });
      dispatchOn(global, ev, 'rejectionhandled', { init: { promise, reason } });
    },
    lifecycle(type, targetName) {
      const target = targetName === 'document' ? global.document : global;
      if (!target) return;
      let ev = null;
      if (type === 'pagehide') ev = makeEvent('PageTransitionEvent', 'pagehide', { persisted: false });
      else if (type === 'visibilitychange') ev = makeEvent('Event', 'visibilitychange', { bubbles: true });
      else ev = makeEvent('FocusEvent', type, {});
      dispatchOn(target, ev, type, { init: {} });
    },
    documentReady(phase) {
      if (phase === 'interactive') {
        const doc = global.document;
        if (doc) dispatchOn(doc, makeEvent('Event', 'DOMContentLoaded', { bubbles: true }), 'DOMContentLoaded', { init: {} });
      } else if (phase === 'complete') {
        dispatchOn(global, makeEvent('Event', 'load', {}), 'load', { init: {} });
        dispatchOn(global, makeEvent('PageTransitionEvent', 'pageshow', { persisted: false }), 'pageshow', { init: {} });
      }
    },
  });
})
