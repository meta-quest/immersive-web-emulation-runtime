#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Verifies that every bundled native and JS dependency has an entry.
//
//   node release/verify-third-party.mjs [--apk <template.apk>] [--build <cmake build dir>] [--json]
//
// Detects what the build bundles, from the tree (and from a built template APK when given):
//   - native: every `set(IWN_<X>_DIR ... CACHE PATH)` source directory in runtime/**/CMakeLists.txt and *.cmake,
//     every vendored runtime/<module>/third_party/<dir>, every library added to IWN_APK_LIBS / listed by
//     runtime/app (libv8android.so, libc++_shared.so), every font in runtime/canvas2d/fonts;
//   - JS: every `dependencies` entry of web/<area>/package.json and of the package itself, every key of a
//     web/<area>/build.mjs `BUNDLED` table, every node_modules package with bytes in a web/<area>/dist/meta.json
//     esbuild metafile, every node_modules package named by an esbuild path comment in an unminified
//     web/<area>/dist/*.js (esbuild writes `// node_modules/<pkg>/...` before each bundled module);
//   - with --apk: every lib/<abi>/*.so and assets/iwn/fonts/* in the template;
//   - with --build: every source file in the build's compile_commands.json (CMAKE_EXPORT_COMPILE_COMMANDS=ON).
//     Files outside this package and the build dir must lie under a recorded IWN_<X>_DIR (resolved through
//     CMakeCache.txt) or a vendored third_party dir; this catches a plain set() + add_subdirectory or an
//     add_library over third-party files that the CMake text scan cannot see.
// Each detected item must map to a release/components.json entry, and each such entry must be named in a table
// of THIRD_PARTY.md. Shipped entries (ships: apk | prelude) must also have a notice: resolvable license files,
// or a section in the committed THIRD_PARTY_NOTICES.txt (CI machines without the third-party trees / the V8 tree).
// Exit 0 when complete, 1 with the list of problems.

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  expand,
  hasThirdPartyEntry,
  isMain,
  loadComponents,
  PKG,
  placeholders,
  thirdPartyNames,
  walk,
} from './lib.mjs';

export function detect(root = PKG, apkFile = null, buildDir = null) {
  const found = []; // { kind, key, where }
  // --- CMake source directories
  const cmakeFiles = walk(path.join(root, 'runtime'), (r) =>
    /(^|\/)CMakeLists\.txt$|\.cmake$/.test(r),
  );
  for (const rel of cmakeFiles) {
    const text = readFileSync(path.join(root, 'runtime', rel), 'utf8');
    const re = /set\(\s*(IWN_[A-Z0-9_]+_DIR)\b/g;
    let m;
    while ((m = re.exec(text))) {
      const tail = text.slice(m.index);
      const end = tail.search(/\)[ \t]*(\r?\n|$)/);
      if (/CACHE\s+PATH/.test(tail.slice(0, end < 0 ? 400 : end + 1)))
        found.push({ kind: 'cmakeVar', key: m[1], where: `runtime/${rel}` });
    }
    const libRe = /APPEND\s+PROPERTY\s+IWN_APK_LIBS\s+([^\s)]+)/g;
    while ((m = libRe.exec(text))) {
      if (m[1].includes('/abs/path/')) continue; // the documentation example in runtime/app
      found.push({
        kind: 'lib',
        key: path.basename(m[1]),
        where: `runtime/${rel}`,
      });
    }
  }
  const appCmake = path.join(root, 'runtime', 'app', 'CMakeLists.txt');
  if (existsSync(appCmake)) {
    const text = readFileSync(appCmake, 'utf8').replace(/^\s*#.*$/gm, '');
    for (const m of text.matchAll(/\/(lib[\w+-]+\.so)\b/g))
      if (m[1] !== 'libfoo.so')
        found.push({
          kind: 'lib',
          key: m[1],
          where: 'runtime/app/CMakeLists.txt',
        });
  }
  // --- vendored third_party dirs
  const runtime = path.join(root, 'runtime');
  if (existsSync(runtime))
    for (const mod of readdirSync(runtime).sort()) {
      const tp = path.join(runtime, mod, 'third_party');
      if (!existsSync(tp) || !statSync(tp).isDirectory()) continue;
      for (const d of readdirSync(tp).sort())
        if (statSync(path.join(tp, d)).isDirectory())
          found.push({
            kind: 'vendoredDir',
            key: `runtime/${mod}/third_party/${d}`,
            where: `runtime/${mod}/third_party`,
          });
    }
  // --- fonts
  const fonts = path.join(root, 'runtime', 'canvas2d', 'fonts');
  if (existsSync(fonts))
    for (const f of readdirSync(fonts).sort())
      if (/\.(ttf|otf|ttc|woff2?)$/i.test(f))
        found.push({ kind: 'font', key: f, where: 'runtime/canvas2d/fonts' });
  // --- JS: package dependencies, BUNDLED tables, metafiles
  const rootPkg = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8'),
  );
  for (const name of Object.keys(rootPkg.dependencies ?? {}))
    found.push({ kind: 'npm', key: name, where: 'package.json dependencies' });
  const web = path.join(root, 'web');
  const assetsFile = path.join(root, 'release', 'template-assets.json');
  const notShipped = new Set(
    existsSync(assetsFile)
      ? (JSON.parse(readFileSync(assetsFile, 'utf8')).notShipped ?? [])
      : [],
  );
  if (existsSync(web))
    for (const area of readdirSync(web).sort()) {
      const dir = path.join(web, area);
      if (!statSync(dir).isDirectory()) continue;
      const pj = path.join(dir, 'package.json');
      if (existsSync(pj)) {
        const p = JSON.parse(readFileSync(pj, 'utf8'));
        for (const name of Object.keys(p.dependencies ?? {}))
          found.push({
            kind: 'npm',
            key: name,
            where: `web/${area}/package.json`,
          });
      }
      const bm = path.join(dir, 'build.mjs');
      if (existsSync(bm)) {
        const m = /export const BUNDLED\s*=\s*\{([\s\S]*?)\}/.exec(
          readFileSync(bm, 'utf8'),
        );
        if (m)
          for (const k of m[1].matchAll(
            /['"]((?:@[\w.-]+\/)?[\w.-]+)['"]\s*:/g,
          ))
            found.push({
              kind: 'npm',
              key: k[1],
              where: `web/${area}/build.mjs BUNDLED`,
            });
      }
      const distDir = path.join(dir, 'dist');
      if (existsSync(distDir))
        for (const f of readdirSync(distDir).filter(
          (f) => f.endsWith('.js') && !f.endsWith('.min.js'),
        )) {
          if (
            notShipped.has(`web/${area}/dist/${f.replace(/\.js$/, '.min.js')}`)
          )
            continue; // e.g. IndexedDB (alpha scope)
          const seen = new Set();
          for (const m of readFileSync(path.join(distDir, f), 'utf8').matchAll(
            /^[ \t]*\/\/ (\S*node_modules\/\S+)$/gm,
          )) {
            const nm = /.*node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(m[1]);
            if (nm && !seen.has(nm[1]))
              (seen.add(nm[1]),
                found.push({
                  kind: 'npm',
                  key: nm[1],
                  where: `web/${area}/dist/${f}`,
                }));
          }
        }
      if (existsSync(distDir))
        for (const f of readdirSync(distDir).filter((f) =>
          /meta.*\.json$/.test(f),
        )) {
          let meta;
          try {
            meta = JSON.parse(readFileSync(path.join(distDir, f), 'utf8'));
          } catch {
            continue;
          }
          for (const out of Object.values(meta.outputs ?? {}))
            for (const [input, info] of Object.entries(out.inputs ?? {})) {
              const nm = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(
                input,
              );
              if (nm && info.bytesInOutput > 0)
                found.push({
                  kind: 'npm',
                  key: nm[1],
                  where: `web/${area}/dist/${f}`,
                });
            }
        }
    }
  // --- the built template
  if (apkFile)
    for (const name of listZip(readFileSync(apkFile))) {
      const lib = /^lib\/[^/]+\/([^/]+\.so)$/.exec(name);
      if (lib) found.push({ kind: 'lib', key: lib[1], where: apkFile });
      const font = /^assets\/iwn\/fonts\/([^/]+)$/.exec(name);
      if (font) found.push({ kind: 'font', key: font[1], where: apkFile });
    }
  if (buildDir) found.push(...compiledSources(root, buildDir));
  return found;
}

/** IWN_<X>_DIR values from a CMake cache (any type: -D on the command line gives UNINITIALIZED). */
export function cacheDirs(buildDir) {
  const out = new Map();
  const cache = path.join(buildDir, 'CMakeCache.txt');
  if (!existsSync(cache)) return out;
  for (const m of readFileSync(cache, 'utf8').matchAll(
    /^(IWN_[A-Z0-9_]+_DIR):[A-Z]+=(.+)$/gm,
  ))
    if (m[2].trim()) out.set(m[1], path.resolve(m[2].trim()));
  return out;
}

/**
 * Attributes every compiled source of a CMake build: first-party (this package outside third_party/, or generated
 * in the build dir), a vendored runtime/<mod>/third_party/<dir>, or the most specific IWN_<X>_DIR containing it.
 */
export function compiledSources(root, buildDir) {
  const cc = path.join(buildDir, 'compile_commands.json');
  if (!existsSync(cc))
    return [
      {
        kind: 'compileCommands',
        key: cc,
        where: 'missing (configure with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON)',
      },
    ];
  const real = (p) => (existsSync(p) ? realpathSync(p) : p);
  const under = (f, dir) =>
    f === dir || f.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
  const pkgDirs = [path.resolve(root), real(path.resolve(root))];
  const buildDirs = [path.resolve(buildDir), real(path.resolve(buildDir))];
  const vars = [...cacheDirs(buildDir)].flatMap(([k, v]) => [
    [k, v],
    [k, real(v)],
  ]);
  const found = [];
  const seen = new Set();
  for (const e of JSON.parse(readFileSync(cc, 'utf8'))) {
    const files = [path.resolve(e.directory ?? buildDir, e.file)];
    files.push(real(files[0]));
    let item = null;
    const pkg = pkgDirs.find((d) => files.some((f) => under(f, d)));
    if (pkg) {
      const rel = path.relative(
        pkg,
        files.find((f) => under(f, pkg)),
      );
      const vd = /^(runtime\/[^/]+\/third_party\/[^/]+)\//.exec(rel);
      if (vd)
        item = {
          kind: 'vendoredDir',
          key: vd[1],
          where: 'compile_commands.json',
        };
      else continue; // first party
    } else if (buildDirs.some((d) => files.some((f) => under(f, d))))
      continue; // generated
    else {
      let best = null;
      for (const [k, v] of vars)
        if (
          files.some((f) => under(f, v)) &&
          (!best || v.length > best[1].length)
        )
          best = [k, v];
      item = best
        ? {
            kind: 'compiledVar',
            key: best[0],
            where: `compile_commands.json (${files[0]})`,
          }
        : {
            kind: 'compiledFile',
            key: files[0],
            where:
              'compile_commands.json: outside this package and every IWN_<X>_DIR',
          };
    }
    const id = `${item.kind}:${item.key}`;
    if (!seen.has(id)) (seen.add(id), found.push(item));
  }
  return found;
}

/** Entry names of a ZIP (central directory). */
export function listZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    const n = buf.readUInt16LE(off + 28),
      x = buf.readUInt16LE(off + 30),
      c = buf.readUInt16LE(off + 32);
    names.push(buf.subarray(off + 46, off + 46 + n).toString('utf8'));
    off += 46 + n + x + c;
  }
  return names;
}

export function verify({
  root = PKG,
  apk = null,
  build = null,
  env = process.env,
} = {}) {
  const inv = loadComponents(root);
  const comps = inv.components;
  const ignore = inv.detectIgnore ?? {};
  const names = thirdPartyNames(root);
  const vars = placeholders(env, root);
  const noticesFile = path.join(root, 'THIRD_PARTY_NOTICES.txt');
  const notices = existsSync(noticesFile)
    ? readFileSync(noticesFile, 'utf8')
    : '';
  const problems = [];
  const used = new Set();
  const firstPartyLibs = new Set(['libiwernative.so']);
  for (const f of detect(root, apk, build)) {
    let c;
    if (f.kind === 'compileCommands' || f.kind === 'compiledFile') {
      problems.push(`${f.key}: ${f.where}`);
      continue;
    }
    if (f.kind === 'compiledVar') {
      // a generic root (IWN_THIRD_PARTY_DIR, the toolchain) is not an attribution: the file needs its own recorded directory
      c = (ignore.cmakeVars ?? []).includes(f.key)
        ? null
        : comps.find((x) => (x.cmakeVars ?? []).includes(f.key));
      if (!c) {
        problems.push(
          `compiled source under ${f.key} has no component directory in release/components.json: ${f.where}`,
        );
        continue;
      }
    } else if (f.kind === 'cmakeVar') {
      if (
        (ignore.cmakeVars ?? []).includes(f.key) ||
        (ignore.cmakeVarsTestOnly ?? []).includes(f.key)
      )
        continue;
      c = comps.find((x) => (x.cmakeVars ?? []).includes(f.key));
    } else if (f.kind === 'lib') {
      if (firstPartyLibs.has(f.key)) continue;
      c = comps.find((x) => (x.libs ?? []).includes(f.key));
    } else if (f.kind === 'vendoredDir')
      c = comps.find((x) => (x.vendoredDirs ?? []).includes(f.key));
    else if (f.kind === 'font') {
      if (/\.txt$/i.test(f.key)) continue;
      c = comps.find((x) => (x.fonts ?? []).includes(f.key));
    } else if (f.kind === 'npm') {
      if ((ignore.npmFirstParty ?? []).includes(f.key)) continue;
      c = comps.find((x) => (x.npm ?? []).includes(f.key));
    }
    if (!c) {
      problems.push(
        `${f.kind} ${f.key} (${f.where}) has no entry in release/components.json`,
      );
      continue;
    }
    used.add(c.id);
  }
  for (const c of comps) {
    const shipped = c.ships === 'apk' || c.ships === 'prelude';
    if (!used.has(c.id) && !shipped) continue;
    if (!c.firstParty && !hasThirdPartyEntry(c, names))
      problems.push(
        `${c.name} (${c.id}) is ${shipped ? 'shipped' : 'used by the build'} but THIRD_PARTY.md has no table row naming "${c.thirdPartyName ?? c.name}"`,
      );
    if (!shipped) continue;
    const n = c.notice ?? {};
    if (n.kind === 'mit' || n.kind === 'statement') {
      if (!n.copyright?.length)
        problems.push(`${c.id}: notice kind ${n.kind} needs copyright lines`);
      continue;
    }
    if (!n.files?.length) {
      problems.push(`${c.id} ships but has no notice files`);
      continue;
    }
    const missing = n.files
      .map((p) => expand(p, vars))
      .filter((p) => !existsSync(p));
    if (missing.length && !notices.includes(sectionTitle(c)))
      problems.push(
        `${c.id}: license file(s) not found (${missing.join(', ')}) and THIRD_PARTY_NOTICES.txt has no section for it`,
      );
  }
  problems.push(...unpinnedBuildTools(root));
  return { problems, used: [...used].sort() };
}

/**
 * Tools whose output is shipped bytes must be pinned exactly (lockfiles are not committed): esbuild in every
 * web/<area> (bundles + minifies the preludes) and the package's TypeScript (emits lib/).
 */
export function unpinnedBuildTools(root = PKG) {
  const problems = [];
  const check = (file, name) => {
    if (!existsSync(file)) return;
    const p = JSON.parse(readFileSync(file, 'utf8'));
    const v = p.dependencies?.[name] ?? p.devDependencies?.[name];
    if (v !== undefined && !/^\d+\.\d+\.\d+$/.test(v))
      problems.push(
        `${path.relative(root, file)}: ${name} "${v}" must be an exact version (its output ships)`,
      );
  };
  check(path.join(root, 'package.json'), 'typescript');
  const web = path.join(root, 'web');
  if (existsSync(web))
    for (const area of readdirSync(web).sort())
      check(path.join(web, area, 'package.json'), 'esbuild');
  return problems;
}

export function sectionTitle(c) {
  return `${c.name} ${c.version} (${c.license})`;
}

if (isMain(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      apk: { type: 'string' },
      build: { type: 'string' },
      json: { type: 'boolean' },
    },
  });
  const r = verify({ apk: values.apk ?? null, build: values.build ?? null });
  if (values.json) process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  else if (r.problems.length) {
    process.stderr.write(
      `verify-third-party: ${r.problems.length} problem(s)\n${r.problems.map((p) => `  - ${p}`).join('\n')}\n`,
    );
  } else
    process.stdout.write(
      `verify-third-party: OK (${r.used.length} detected components have entries)\n`,
    );
  process.exitCode = r.problems.length ? 1 : 0;
}
