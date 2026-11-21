/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Test selection for the GL-CTS-1 runners (host harness.mjs and device-run.mjs): the subset list expanded
// through the official 00_test_list.txt files for one suite version, as the official runner does.
import fs from 'node:fs';
import path from 'node:path';

export const SUITE_VERSION = { 1: '1.0.4', 2: '2.0.1' };

function versionCmp(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Pages listed by `<dirRel>/00_test_list.txt` (recursively) for suite `version`, as the official runner does. */
function listedTests(ROOT, dirRel, version) {
  const out = [];
  const listFile = path.join(ROOT, dirRel, '00_test_list.txt');
  for (const raw of fs.readFileSync(listFile, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const parts = line.split(/\s+/);
    let min = null;
    let max = null;
    while (parts.length && parts[0].startsWith('--')) {
      const flag = parts.shift();
      if (flag === '--min-version') min = parts.shift();
      else if (flag === '--max-version') max = parts.shift();
      else if (flag === '--slow') continue;
      else parts.shift();
    }
    const name = parts.join(' ');
    if (
      (min && versionCmp(version, min) < 0) ||
      (max && versionCmp(version, max) > 0)
    )
      continue;
    const rel = path.join(dirRel, name);
    if (name.endsWith('.txt'))
      out.push(...listedTests(ROOT, path.dirname(rel), version));
    else out.push(rel);
  }
  return out;
}

/**
 * Pages of the subset list `LIST` for WebGL `pass` (1 or 2) under the CTS root `ROOT`, and the exclusions
 * ("!path reason", "!v1:path reason", "!v2:path reason"; a "host:" or "device:" prefix limits an exclusion to
 * the host harness or the device run) that apply to that pass on `where` ('host' | 'device').
 */
export function expandList(ROOT, LIST, pass, filterRe, where = 'host') {
  const entries = fs
    .readFileSync(LIST, 'utf8')
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean);
  const version = SUITE_VERSION[pass];
  const out = [];
  const exclude = new Map();
  for (const e of entries) {
    if (e.startsWith('!')) {
      let [p, ...why] = e.slice(1).split(/\s+/);
      const w = /^(host|device):(.*)$/.exec(p);
      if (w) {
        if (w[1] !== where) continue;
        p = w[2];
      }
      const m = /^v([12]):(.*)$/.exec(p);
      if (m) {
        if (Number(m[1]) !== pass) continue;
        p = m[2];
      }
      exclude.set(p, why.join(' '));
      continue;
    }
    if (pass === 1 && e.startsWith('conformance2/')) continue;
    // a subset entry is excluded from this pass when the official list for this version does not include it
    const full = path.join(ROOT, e);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      if (fs.existsSync(path.join(full, '00_test_list.txt'))) {
        out.push(...listedTests(ROOT, e, version));
      } else {
        const walk = (d) => {
          for (const f of fs.readdirSync(d).sort()) {
            const p = path.join(d, f);
            if (fs.statSync(p).isDirectory()) walk(p);
            else if (f.endsWith('.html')) out.push(path.relative(ROOT, p));
          }
        };
        walk(full);
      }
    } else {
      // a single page: keep it only if its directory's list includes it for this version
      const dir = path.dirname(e);
      const listed = fs.existsSync(path.join(ROOT, dir, '00_test_list.txt'))
        ? listedTests(ROOT, dir, version)
        : [e];
      if (listed.includes(e)) out.push(e);
    }
  }
  const filter = filterRe ? new RegExp(filterRe) : null;
  return {
    tests: [...new Set(out)].filter((t) => !filter || filter.test(t)),
    exclude,
  };
}
