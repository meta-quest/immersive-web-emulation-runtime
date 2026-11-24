/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodePng, placeholderIcon } from '../src/png.ts';
import {
  openTemplate,
  type LoadedTemplate,
  type TemplateMetadata,
} from '../src/template.ts';
import { prepareEntry, writeZip } from '../src/zip.ts';

export const FIXTURES = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'fixtures',
);
export const STORE_PASSWORD = 'iwn-test-store';

/** aapt2 (build-tools 34) output for packager/template/AndroidManifest.xml. */
export function templateManifest(): Buffer {
  return readFileSync(path.join(FIXTURES, 'template-manifest.axml'));
}

/** The 2.9.0 template's manifest: no Horizon OS SDK declaration. */
export function templateManifest290(): Buffer {
  return readFileSync(path.join(FIXTURES, 'template-manifest-2.9.0.axml'));
}

export function scratchDir(name: string): string {
  return mkdtempSync(path.join(tmpdir(), `iwn-pack-${name}-`));
}

export const ICON_SIZES = [48, 72, 96, 144, 192];

/** A template APK shaped like the real one, built in memory. */
export async function buildTestTemplate(
  dir: string,
  options: {
    config?: unknown;
    meta?: Partial<TemplateMetadata>;
    arscCompressed?: boolean;
    /** Leave out assets/iwn/template.json (a bare runtime APK). */
    noMeta?: boolean;
    /** Replace the manifest (binary XML). */
    manifest?: Buffer;
    /** Extra template entries (name -> bytes), e.g. the bundled font, stored. */
    extra?: Record<string, Buffer>;
  } = {},
): Promise<LoadedTemplate> {
  const icons = ICON_SIZES.map((px, i) => ({
    path: `res/mipmap-${['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'][i]}-v4/ic_launcher.png`,
    px,
  }));
  const meta: TemplateMetadata = {
    format: 1,
    runtimeVersion: '0.0.0-test',
    placeholderPackage: 'org.iwer.nativetemplate',
    icons,
    abis: ['arm64-v8a'],
    nativeBuild: 'release',
    ...options.meta,
  };
  const so = Buffer.alloc(20000, 0x7f);
  so.write('\x7fELF', 0, 'latin1');
  const entries = [
    await prepareEntry(
      'AndroidManifest.xml',
      options.manifest ?? templateManifest(),
      { compress: true },
    ),
    await prepareEntry('resources.arsc', Buffer.alloc(1000, 1), {
      compress: !!options.arscCompressed,
      align: 4,
    }),
    ...(await Promise.all(
      (options.noMeta ? [] : icons).map(async (i) =>
        prepareEntry(i.path, encodePng(placeholderIcon(i.px)), {
          compress: false,
        }),
      ),
    )),
    await prepareEntry('lib/arm64-v8a/libiwntemplate.so', so, {
      compress: false,
      align: 16384,
    }),
    await prepareEntry(
      'assets/iwn/prelude/glue.js',
      Buffer.from('/* runtime */'),
      { compress: true },
    ),
    ...(options.noMeta
      ? []
      : [
          await prepareEntry(
            'assets/iwn/template.json',
            Buffer.from(JSON.stringify(meta)),
            { compress: true },
          ),
        ]),
    await prepareEntry(
      'assets/iwn/config.json',
      Buffer.from(
        JSON.stringify(
          options.config ?? {
            origin: 'https://app.local',
            preludes: ['iwn/prelude/glue.js'],
            inspector: { port: 9229 },
          },
        ),
      ),
      { compress: true },
    ),
    await prepareEntry(
      'META-INF/MANIFEST.MF',
      Buffer.from('Manifest-Version: 1.0\n'),
      { compress: true },
    ),
    ...(await Promise.all(
      Object.entries(options.extra ?? {}).map(([name, data]) =>
        prepareEntry(name, data, { compress: false, align: 4 }),
      ),
    )),
  ];
  const z = writeZip(entries);
  const buf = Buffer.concat([z.entries, z.centralDirectory, z.eocd]);
  const file = path.join(
    dir,
    options.extra ? 'template-extra.apk' : 'template.apk',
  );
  writeFileSync(file, buf);
  return openTemplate(file, buf, 'explicit');
}

/** A small Vite-like dist with awkward names. */
export function buildTestDist(
  dir: string,
  overrides: Record<string, string | Buffer> = {},
): string {
  const dist = path.join(dir, 'dist');
  const files: Record<string, string | Buffer> = {
    'index.html':
      '<!doctype html><html><head><title>Test App</title>' +
      '<link rel="modulepreload" href="./assets/vendor.js">' +
      '<script type="module" crossorigin src="./assets/index.js"></script></head>' +
      '<body><div id="scene-container"></div></body></html>',
    'assets/index.js': 'import "./vendor.js"; console.log("hello");'.repeat(50),
    'assets/vendor.js': 'export const x = 1;'.repeat(100),
    'assets/index.js.map': '{"version":3}',
    'models/robot.glb': Buffer.alloc(70000, 3),
    'audio/click.mp3': Buffer.alloc(5000, 4),
    '_underscore/data.json': '{"a":1}',
    '.well-known/thing.txt': 'dot',
    'textures/ü-name.ktx2': Buffer.alloc(3000, 5),
    ...overrides,
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dist, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dist;
}

/** Android SDK build-tools for optional cross-checks (apksigner, aapt2, zipalign). */
export function buildTools(): string | null {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  if (!sdk) return null;
  for (const v of ['35.0.0', '34.0.0']) {
    const dir = path.join(sdk, 'build-tools', v);
    if (
      existsSync(path.join(dir, 'apksigner')) &&
      existsSync(path.join(dir, 'aapt2'))
    )
      return dir;
  }
  return null;
}
