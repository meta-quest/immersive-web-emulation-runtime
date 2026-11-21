/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// NET-13: URL / URLSearchParams against WPT's url/resources data (fetched from Chromium's WPT mirror),
// and against Node's own URL (Ada) for URLSearchParams behaviour.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { both, createGlueContext } from './harness.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (n: string): unknown => JSON.parse(readFileSync(join(fixtures, n), 'utf8'));

type UrlCase = {
  input: string;
  base: string | null;
  failure?: boolean;
  href?: string;
  origin?: string;
  [k: string]: unknown;
};

const FIELDS = ['href', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];

describe('URL (NET-13)', () => {
  test('WPT urltestdata.json: >= 99% pass in the glue realm', async (t) => {
    const cases = (load('wpt-urltestdata.json') as unknown[]).filter((x): x is UrlCase => typeof x === 'object');
    const { g } = await createGlueContext();
    const URLG = g.URL as unknown as typeof URL;
    const failures: string[] = [];
    for (const t of cases) {
      let ok = true;
      try {
        const u = t.base == null ? new URLG(t.input) : new URLG(t.input, t.base);
        if (t.failure) ok = false;
        else {
          for (const k of FIELDS) if ((u as unknown as Record<string, unknown>)[k] !== t[k]) ok = false;
          if (t.origin !== undefined && u.origin !== t.origin) ok = false;
          if (u.toJSON() !== u.href) ok = false;
        }
      } catch {
        ok = !!t.failure;
      }
      if (t.failure && ok) {
        // URL.canParse must agree with the constructor.
        if ((URLG as unknown as { canParse(u: string, b?: string): boolean }).canParse(t.input, t.base ?? undefined)) ok = false;
      }
      if (!ok) failures.push(JSON.stringify([t.input, t.base]));
    }
    const rate = 1 - failures.length / cases.length;
    t.diagnostic(`urltestdata: ${cases.length - failures.length}/${cases.length} pass; failures: ${failures.join(' ')}`);
    assert.ok(rate >= 0.99, `pass rate ${(rate * 100).toFixed(2)}%; failures:\n${failures.join('\n')}`);
    // Recorded 2026-10-20 (whatwg-url 17.3.0 + the tr46 shim): no failures. The shim approximates UTS #46,
    // so a future WPT revision may add IDNA cases it misses; keep any such failure IDNA-only.
    for (const f of failures) assert.match(f, /[^\x00-\x7f]|%[89a-f]/i, `unexpected non-IDNA failure ${f}`);
  });

  test('WPT setters_tests.json', async (t) => {
    const data = load('wpt-setters_tests.json') as Record<string, unknown>;
    const { g } = await createGlueContext();
    const URLG = g.URL as unknown as typeof URL;
    let total = 0;
    const failures: string[] = [];
    for (const [setter, cases] of Object.entries(data)) {
      if (setter === 'comment') continue;
      for (const c of cases as { href: string; new_value: string; expected: Record<string, string> }[]) {
        total++;
        const u = new URLG(c.href);
        (u as unknown as Record<string, string>)[setter] = c.new_value;
        for (const [k, v] of Object.entries(c.expected)) {
          if ((u as unknown as Record<string, string>)[k] !== v) {
            failures.push(`${setter} ${c.href} <- ${JSON.stringify(c.new_value)}: ${k}=${JSON.stringify((u as unknown as Record<string, string>)[k])} want ${JSON.stringify(v)}`);
            break;
          }
        }
      }
    }
    const rate = 1 - failures.length / total;
    t.diagnostic(`setters: ${total - failures.length}/${total} pass; failures: ${failures.join(' | ')}`);
    assert.ok(rate >= 0.99, `setters pass rate ${(rate * 100).toFixed(2)}% (${failures.length}/${total}):\n${failures.join('\n')}`);
  });

  // IDNA through the build-time tr46 shim (UTS #46 approximated with NFKC + case folding, see
  // src/shims/tr46.ts). Recorded, not gating beyond the floor: the shim trades exotic IDNA cases
  // for ~240 KB of mapping table.
  test('WPT toascii.json through the tr46 shim (recorded)', async (t) => {
    const cases = (load('wpt-toascii.json') as unknown[]).filter(
      (x): x is { input: string; output: string | null } => typeof x === 'object' && x !== null,
    );
    const { g } = await createGlueContext();
    const URLG = g.URL as unknown as typeof URL;
    const failures: string[] = [];
    for (const c of cases) {
      let host: string | null;
      try {
        host = new URLG(`https://${c.input}/x`).host;
      } catch {
        host = null;
      }
      if (host !== c.output) failures.push(`${JSON.stringify(c.input)} -> ${JSON.stringify(host)} want ${JSON.stringify(c.output)}`);
    }
    t.diagnostic(`toascii: ${cases.length - failures.length}/${cases.length} pass; failures: ${failures.join(' | ')}`);
    assert.ok(failures.length / cases.length <= 0.05, failures.join('\n'));
  });

  test('URLSearchParams and URL statics match Node', async () => {
    const r = await both(`
      const p = new URLSearchParams('?a=1&b=2&a=3&c=%20x+y&d=%F0%9F%98%80');
      const out = [p.get('a'), p.getAll('a'), p.has('b'), p.has('a', '3'), p.get('c'), p.get('d'), p.size];
      p.append('e', 'ü &=');
      p.delete('a', '1');
      p.set('b', '9');
      p.sort();
      out.push(p.toString(), [...p.keys()], [...p.entries()]);
      out.push(new URLSearchParams({ x: '1', y: '2' }).toString());
      out.push(new URLSearchParams([['k', 'v'], ['k', 'w']]).toString());
      const u = new URL('https://app.local/p?q=1#h');
      u.searchParams.append('r', 's t');
      out.push(u.href, u.search);
      u.search = '?z=1';
      out.push(u.searchParams.get('z'), u.searchParams.get('q'));
      out.push(URL.canParse('x', 'https://a/'), URL.canParse('x'), URL.parse('nope') , URL.parse('/y', 'https://a/b').href);
      out.push(JSON.stringify(new URL('https://a.b/c')), String(new URL('HTTPS://EXAMPLE.com:443/./a/../b')));
      out.push(new URL('https://münchen.example/').hostname);
      out.push(Object.prototype.toString.call(u), Object.prototype.toString.call(p));
      try { new URL('http://[::1'); } catch (e) { out.push(e.name); }
      return out;
    `);
    assert.deepEqual(r.glue, r.node);
  });

  test('createObjectURL / revokeObjectURL format (NET-14)', async () => {
    const { run } = await createGlueContext({ config: { url: 'https://app.local/' } });
    const url = run<string>(`URL.createObjectURL(new Blob(['x']))`);
    assert.match(url, /^blob:https:\/\/app\.local\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.throws(() => run(`URL.createObjectURL('x')`), { name: 'TypeError' });
    assert.equal(run(`typeof URL.revokeObjectURL`), 'function');
  });
});
