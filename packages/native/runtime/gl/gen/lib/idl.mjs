/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Minimal WebIDL parser for the subset the WebGL IDL files use: interface / interface mixin / partial
// interface / dictionary / typedef / includes, consts, operations (with overloads, optional args and
// defaults), attributes, and extended attributes (kept as raw strings). Written from the WebIDL grammar
// (https://webidl.spec.whatwg.org/#idl-grammar); no third-party code.

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

// Tokens: identifiers, numbers (hex/dec/float), strings, punctuation, '...'.
function tokenize(src) {
  const tokens = [];
  const re = /\s+|(\.\.\.)|(0[xX][0-9a-fA-F]+)|(-?\d+\.\d*(?:[eE][+-]?\d+)?|-?\d+(?:[eE][+-]?\d+)?)|("[^"]*")|([A-Za-z_][A-Za-z0-9_\-]*)|([{}()[\];,=<>?:])/y;
  let m;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    m = re.exec(src);
    if (!m) throw new Error(`IDL tokenize error near: ${src.slice(i, i + 40)}`);
    i = re.lastIndex;
    if (m[1]) tokens.push({ t: 'punct', v: '...' });
    else if (m[2]) tokens.push({ t: 'num', v: m[2] });
    else if (m[3]) tokens.push({ t: 'num', v: m[3] });
    else if (m[4]) tokens.push({ t: 'str', v: m[4].slice(1, -1) });
    else if (m[5]) tokens.push({ t: 'id', v: m[5] });
    else if (m[6]) tokens.push({ t: 'punct', v: m[6] });
  }
  return tokens;
}

class Parser {
  constructor(tokens, file) {
    this.toks = tokens;
    this.i = 0;
    this.file = file;
  }
  peek(o = 0) {
    return this.toks[this.i + o];
  }
  next() {
    return this.toks[this.i++];
  }
  is(v, o = 0) {
    const t = this.peek(o);
    return t && t.v === v;
  }
  eat(v) {
    const t = this.next();
    if (!t || t.v !== v) throw new Error(`${this.file}: expected '${v}', got '${t && t.v}' at token ${this.i}`);
    return t;
  }
  maybe(v) {
    if (this.is(v)) {
      this.i++;
      return true;
    }
    return false;
  }
  ident() {
    const t = this.next();
    if (!t || t.t !== 'id') throw new Error(`${this.file}: expected identifier, got '${t && t.v}'`);
    return t.v;
  }

  // [A, B=C, D=(x,y)] -> raw strings
  extAttrs() {
    const out = [];
    if (!this.is('[')) return out;
    this.eat('[');
    let depth = 0;
    let cur = '';
    for (;;) {
      const t = this.next();
      if (!t) throw new Error(`${this.file}: unterminated extended attribute list`);
      if (depth === 0 && t.v === ']') break;
      if (depth === 0 && t.v === ',') {
        out.push(cur.trim());
        cur = '';
        continue;
      }
      if (t.v === '(') depth++;
      if (t.v === ')') depth--;
      cur += (cur && !/[=(),]$/.test(cur) && !/^[=(),]/.test(t.v) ? ' ' : '') + t.v;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  // Types: [ext] (A or B)? , sequence<T>, Promise<T>, unsigned long long, unrestricted float, ...
  type() {
    const ext = this.extAttrs();
    let base;
    if (this.is('(')) {
      this.eat('(');
      const members = [this.type()];
      while (this.maybe('or')) members.push(this.type());
      this.eat(')');
      base = { kind: 'union', members };
    } else {
      const words = [];
      const w = this.ident();
      words.push(w);
      if (w === 'unsigned' || w === 'unrestricted') words.push(this.ident());
      if ((words.at(-1) === 'long') && this.is('long')) words.push(this.ident());
      const name = words.join(' ');
      if (this.is('<')) {
        this.eat('<');
        const inner = [this.type()];
        while (this.maybe(',')) inner.push(this.type());
        this.eat('>');
        base = { kind: 'generic', name, inner };
      } else {
        base = { kind: 'named', name };
      }
    }
    base.ext = ext;
    base.nullable = this.maybe('?');
    return base;
  }

  constValue() {
    const t = this.next();
    if (t.t === 'num') return t.v.startsWith('0x') || t.v.startsWith('0X') ? parseInt(t.v, 16) : Number(t.v);
    if (t.v === 'true') return true;
    if (t.v === 'false') return false;
    if (t.v === 'null') return null;
    if (t.t === 'str') return t.v;
    if (t.v === '[') {
      this.eat(']');
      return [];
    }
    if (t.v === '{') {
      this.eat('}');
      return {};
    }
    if (t.v === '-' ) return -this.constValue();
    if (t.t === 'id') return t.v; // Infinity, NaN, ...
    throw new Error(`${this.file}: bad constant ${t.v}`);
  }

  args() {
    const args = [];
    this.eat('(');
    while (!this.is(')')) {
      const ext = this.extAttrs();
      const optional = this.maybe('optional');
      const type = this.type();
      const variadic = this.maybe('...');
      const name = this.ident();
      let def;
      if (this.maybe('=')) def = this.constValue();
      args.push({ name, type, optional, variadic, default: def, ext });
      if (!this.maybe(',')) break;
    }
    this.eat(')');
    return args;
  }

  member(owner) {
    const ext = this.extAttrs();
    if (this.maybe('const')) {
      const type = this.type();
      const name = this.ident();
      this.eat('=');
      const value = this.constValue();
      this.eat(';');
      owner.consts.push({ name, type, value, ext });
      return;
    }
    let readonly = false;
    let isStatic = this.maybe('static');
    if (this.is('readonly') && this.is('attribute', 1)) {
      this.next();
      readonly = true;
    }
    if (this.maybe('attribute')) {
      const type = this.type();
      const name = this.ident();
      this.eat(';');
      owner.attrs.push({ name, type, readonly, ext, isStatic });
      return;
    }
    if (owner.kind === 'dictionary') {
      const required = this.maybe('required');
      const type = this.type();
      const name = this.ident();
      let def;
      if (this.maybe('=')) def = this.constValue();
      this.eat(';');
      owner.members.push({ name, type, required, default: def, ext });
      return;
    }
    if (this.is('constructor') && this.is('(', 1)) {
      this.next();
      const args = this.args();
      this.eat(';');
      owner.ctors = owner.ctors ?? [];
      owner.ctors.push({ args, ext });
      return;
    }
    // operation (stringifier / getter etc. are not used by WebGL IDL)
    const ret = this.type();
    const name = this.ident();
    const args = this.args();
    this.eat(';');
    owner.ops.push({ name, ret, args, ext, isStatic });
  }

  definition(out) {
    const ext = this.extAttrs();
    if (this.maybe('typedef')) {
      const type = this.type();
      const name = this.ident();
      this.eat(';');
      out.typedefs[name] = type;
      return;
    }
    const partial = this.maybe('partial');
    if (this.is('interface') || this.is('dictionary') || this.is('callback')) {
      let kind = this.next().v;
      if (kind === 'interface' && this.maybe('mixin')) kind = 'mixin';
      const name = this.ident();
      let inherits = null;
      if (this.maybe(':')) inherits = this.ident();
      const def = out.interfaces[name] ?? {
        name,
        kind,
        inherits,
        ext: [],
        consts: [],
        attrs: [],
        ops: [],
        members: [],
        file: this.file,
      };
      if (!partial) {
        def.kind = kind;
        def.inherits = inherits;
        def.file = this.file;
      }
      def.ext.push(...ext);
      out.interfaces[name] = def;
      this.eat('{');
      while (!this.is('}')) this.member(def);
      this.eat('}');
      this.eat(';');
      return;
    }
    if (this.is('includes', 1)) {
      const target = this.ident();
      this.eat('includes');
      const mixin = this.ident();
      this.eat(';');
      out.includes.push({ target, mixin });
      return;
    }
    if (this.maybe('enum')) {
      const name = this.ident();
      this.eat('{');
      const values = [];
      while (!this.is('}')) {
        values.push(this.next().v);
        this.maybe(',');
      }
      this.eat('}');
      this.eat(';');
      out.enums[name] = values;
      return;
    }
    throw new Error(`${this.file}: unexpected '${this.peek()?.v}' at token ${this.i}`);
  }
}

/** Parse several IDL sources into one model. `sources` = [{ file, text }]. */
export function parseIdl(sources) {
  const out = { interfaces: {}, typedefs: {}, includes: [], enums: {} };
  for (const { file, text } of sources) {
    const p = new Parser(tokenize(stripComments(text)), file);
    while (p.peek()) p.definition(out);
  }
  return out;
}

/** Flattened view of an interface: its own members plus included mixins (not inherited interfaces). */
export function flatten(model, name) {
  const iface = model.interfaces[name];
  if (!iface) throw new Error(`no interface ${name}`);
  const parts = [iface, ...model.includes.filter((i) => i.target === name).map((i) => model.interfaces[i.mixin])];
  return {
    name,
    ext: iface.ext,
    inherits: iface.inherits,
    consts: parts.flatMap((p) => p.consts),
    attrs: parts.flatMap((p) => p.attrs),
    ops: parts.flatMap((p) => p.ops),
  };
}

/** Resolve typedef chains (one level is enough for WebGL, but loop anyway). */
export function resolveType(model, type) {
  let t = type;
  for (let n = 0; n < 8 && t.kind === 'named' && model.typedefs[t.name]; n++) {
    const r = model.typedefs[t.name];
    t = { ...r, nullable: t.nullable || r.nullable, ext: [...(r.ext ?? []), ...(t.ext ?? [])], alias: type.name };
  }
  return t;
}

export function typeToString(t) {
  if (t.kind === 'union') return `(${t.members.map(typeToString).join(' or ')})${t.nullable ? '?' : ''}`;
  if (t.kind === 'generic') return `${t.name}<${t.inner.map(typeToString).join(', ')}>${t.nullable ? '?' : ''}`;
  return `${t.name}${t.nullable ? '?' : ''}`;
}

/** WebIDL Function.length for an overload set: the shortest required-argument prefix. */
export function overloadLength(ops) {
  return Math.min(...ops.map((op) => op.args.filter((a) => !a.optional && !a.variadic).length));
}
