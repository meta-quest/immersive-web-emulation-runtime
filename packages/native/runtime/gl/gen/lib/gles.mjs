// Parser for the Khronos GLES C headers as shipped in the Android NDK sysroot (GLES3/gl32.h, GLES2/gl2ext.h).
// Extracts every `GL_APICALL <ret> GL_APIENTRY gl<Name> (<params>);` prototype (with the extension block it
// sits in) and every `#define GL_<NAME> 0x...` enum. Written from the header layout; no third-party code.

const PROTO = /GL_APICALL\s+([\w\s\*]+?)\s*GL_APIENTRY\s+(gl\w+)\s*\(([^)]*)\)\s*;/g;
const ENUM = /^#define\s+(GL_\w+)\s+(0x[0-9A-Fa-f]+|\d+)u?(?:ull)?\s*$/gm;
const BLOCK = /^#ifndef\s+(GL_[A-Za-z0-9_]+)\s*$/gm;

function parseParams(text) {
  const t = text.trim();
  if (t === 'void' || t === '') return [];
  return t.split(',').map((p) => {
    let s = p.trim().replace(/\s+/g, ' ');
    // `GLuint baseAndCount[2]` -> pointer
    let array = false;
    if (/\[\d*\]$/.test(s)) {
      s = s.replace(/\s*\[\d*\]$/, '');
      array = true;
    }
    const m = s.match(/^(.*?)([A-Za-z_]\w*)$/);
    if (!m) throw new Error(`cannot parse GL parameter '${s}'`);
    const type = m[1].replace(/\s*\*\s*/g, '*').replace(/\s+/g, ' ').trim() + (array ? '*' : '');
    return { type, name: m[2] };
  });
}

/**
 * @param {{file: string, text: string, ext: boolean}[]} headers
 * @returns {{functions: Record<string, {ret: string, params: {type: string, name: string}[], ext: string|null, file: string}>, enums: Record<string, number>}}
 */
export function parseGles(headers) {
  const functions = {};
  const enums = {};
  for (const { file, text, ext } of headers) {
    // Map each offset to the extension block (#ifndef GL_EXT_foo) or core version block (#ifndef GL_ES_VERSION_3_0).
    const blocks = [];
    for (const m of text.matchAll(BLOCK)) blocks.push({ at: m.index, name: m[1] });
    const blockAt = (pos) => {
      let cur = null;
      for (const b of blocks) {
        if (b.at > pos) break;
        cur = b.name;
      }
      return cur;
    };
    for (const m of text.matchAll(PROTO)) {
      const name = m[2];
      if (functions[name]) continue;
      functions[name] = {
        ret: m[1].replace(/\s*\*\s*/g, '*').trim(),
        params: parseParams(m[3]),
        ext: ext ? blockAt(m.index) : null,
        version: ext ? null : blockAt(m.index),
        file,
      };
    }
    for (const m of text.matchAll(ENUM)) {
      if (!(m[1] in enums)) enums[m[1]] = Number(m[2]);
    }
  }
  return { functions, enums };
}
