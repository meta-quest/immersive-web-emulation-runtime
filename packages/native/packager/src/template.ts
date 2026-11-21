/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The template APK: where it comes from (PKG-1, PKG-2) and what the packer
 * expects inside it (the template contract, packager/README.md).
 *
 * Resolution order:
 *   1. an explicit path (`pack --template <apk>` or `$IWER_NATIVE_TEMPLATE`);
 *   1b. the template bundled in the npm package (`templates.json` "bundled":
 *      file + SHA-256, checked on every use; the alpha ships this way, see
 *      RELEASE.md);
 *   2. the version pinned in `packager/templates.json` (URL + SHA-256),
 *      downloaded once into the user's cache directory and verified on every
 *      use (a tampered or truncated file is deleted and fetched again);
 *   3. a template built in this checkout (`packager/template/out/`), for
 *      runtime developers.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { entryData, findEntry, readZip, type ZipArchive } from './zip.ts';

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

export const TEMPLATE_META_ENTRY = 'assets/iwn/template.json';
export const TEMPLATE_CONFIG_ENTRY = 'assets/iwn/config.json';
export const APP_ASSET_PREFIX = 'assets/app/';
export const TEMPLATE_FORMAT = 1;

/** `assets/iwn/template.json`: written by the template build. */
export interface TemplateMetadata {
  format: number;
  /** Runtime version the template was built from. */
  runtimeVersion: string;
  /** Build id (git hash) for symbol lookup. */
  buildId?: string;
  /** Package id the template ships with; the packer replaces it. */
  placeholderPackage: string;
  /** Launcher icon files the packer replaces, with their pixel size. */
  icons: { path: string; px: number }[];
  abis: string[];
  /** Set by the packer when the template had no metadata file. */
  synthesized?: boolean;
  /** Native build type; the packer warns when packing a release app on a debug runtime. */
  nativeBuild?: 'release' | 'debug';
}

export interface PinnedTemplate {
  version: string;
  url: string;
  sha256: string;
  size?: number;
}

export interface LoadedTemplate {
  file: string;
  buffer: Buffer;
  zip: ZipArchive;
  meta: TemplateMetadata;
  sha256: string;
  source: 'explicit' | 'bundled' | 'cache' | 'download' | 'checkout';
}

/** `templates.json` "bundled": a template shipped inside the npm package. */
export interface BundledTemplate {
  /** Path relative to the package root, e.g. `prebuilt/iwer-native-template.apk`. */
  file: string;
  version: string;
  sha256: string;
  size?: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** packages/native root, from either packager/src (sources) or lib/packager/src (built). */
export function packageRoot(): string {
  let dir = here;
  for (let i = 0; i < 5; i++) {
    if (
      existsSync(path.join(dir, 'package.json')) &&
      existsSync(path.join(dir, 'packager'))
    )
      return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(here, '..', '..');
}

export function userCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.IWER_NATIVE_CACHE_DIR) return env.IWER_NATIVE_CACHE_DIR;
  if (process.platform === 'win32' && env.LOCALAPPDATA)
    return path.join(env.LOCALAPPDATA, 'iwer-native', 'cache');
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Caches', 'iwer-native');
  return path.join(
    env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
    'iwer-native',
  );
}

export function readPinnedTemplate(
  root = packageRoot(),
): PinnedTemplate | null {
  const file = path.join(root, 'packager', 'templates.json');
  if (!existsSync(file)) return null;
  let json: { template?: PinnedTemplate | null };
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new TemplateError(
      `${file} is not valid JSON: ${(e as Error).message}`,
    );
  }
  const t = json.template;
  if (!t || !t.url || !t.sha256) return null;
  return t;
}

export function readBundledTemplate(
  root = packageRoot(),
): BundledTemplate | null {
  const file = path.join(root, 'packager', 'templates.json');
  if (!existsSync(file)) return null;
  let json: { bundled?: BundledTemplate | null };
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new TemplateError(
      `${file} is not valid JSON: ${(e as Error).message}`,
    );
  }
  const b = json.bundled;
  if (!b || !b.file || !b.sha256) return null;
  if (path.isAbsolute(b.file) || b.file.split(/[\\/]/).includes('..'))
    throw new TemplateError(
      `${file}: bundled.file must be a path inside the package (got ${b.file})`,
    );
  return b;
}

/**
 * Open the template bundled in the package. Returns null when templates.json
 * names none or the file is absent (a checkout without a release build); a
 * file that is present but does not match its checksum is refused.
 */
export function openBundledTemplate(
  root = packageRoot(),
): LoadedTemplate | null {
  const bundled = readBundledTemplate(root);
  if (!bundled) return null;
  const file = path.join(root, bundled.file);
  if (!existsSync(file)) return null;
  const buffer = readFileSync(file);
  const got = sha256(buffer);
  if (got !== bundled.sha256.toLowerCase())
    throw new TemplateError(
      [
        `the template bundled with @iwer/native (${file}) does not match its checksum`,
        `(expected ${bundled.sha256}, got ${got}). The package is damaged or was modified:`,
        'reinstall it (npm install @iwer/native), or pass --template <apk>.',
      ].join('\n'),
    );
  return openTemplate(file, buffer, 'bundled');
}

export function checkoutTemplatePath(root = packageRoot()): string {
  return path.join(
    root,
    'packager',
    'template',
    'out',
    'iwer-native-template.apk',
  );
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Parse and check a template APK. */
export function openTemplate(
  file: string,
  buffer: Buffer,
  source: LoadedTemplate['source'],
): LoadedTemplate {
  let zip: ZipArchive;
  try {
    zip = readZip(buffer);
  } catch (e) {
    throw new TemplateError(
      `template ${file} is not a valid APK: ${(e as Error).message}`,
    );
  }
  if (!findEntry(zip, 'AndroidManifest.xml'))
    throw new TemplateError(`template ${file} has no AndroidManifest.xml`);
  const metaEntry = findEntry(zip, TEMPLATE_META_ENTRY);
  let meta: TemplateMetadata;
  if (metaEntry) {
    try {
      meta = JSON.parse(
        entryData(zip, metaEntry).toString('utf8'),
      ) as TemplateMetadata;
    } catch (e) {
      throw new TemplateError(
        `template ${file}: ${TEMPLATE_META_ENTRY} is not valid JSON (${(e as Error).message})`,
      );
    }
    if (!meta || typeof meta !== 'object')
      throw new TemplateError(
        `template ${file}: ${TEMPLATE_META_ENTRY} is not a JSON object`,
      );
    if (meta.icons !== undefined && !Array.isArray(meta.icons))
      throw new TemplateError(
        `template ${file}: ${TEMPLATE_META_ENTRY} "icons" is not an array`,
      );
    if (meta.format !== TEMPLATE_FORMAT)
      throw new TemplateError(
        `template ${file} has format ${meta.format}; this packer reads format ${TEMPLATE_FORMAT}`,
      );
  } else {
    // A runtime APK without the metadata file (e.g. runtime/app's
    // build-apk.mjs output before it writes one): usable, without icons.
    if (!zip.entries.some((e) => e.name.startsWith('lib/')))
      throw new TemplateError(
        `template ${file} has no ${TEMPLATE_META_ENTRY} and no native libraries; is it an @iwer/native template APK?`,
      );
    meta = {
      format: TEMPLATE_FORMAT,
      runtimeVersion: 'unknown',
      placeholderPackage: '',
      icons: [],
      abis: [
        ...new Set(
          zip.entries
            .map((e) => /^lib\/([^/]+)\//.exec(e.name)?.[1])
            .filter((a): a is string => !!a),
        ),
      ],
      synthesized: true,
    };
  }
  for (const icon of meta.icons ?? [])
    if (!findEntry(zip, icon.path))
      throw new TemplateError(
        `template ${file}: icon ${icon.path} listed but missing`,
      );
  return { file, buffer, zip, meta, sha256: sha256(buffer), source };
}

export interface ResolveTemplateOptions {
  explicit?: string | null;
  env?: NodeJS.ProcessEnv;
  root?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

export async function resolveTemplate(
  options: ResolveTemplateOptions = {},
): Promise<LoadedTemplate> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const explicit = options.explicit ?? env.IWER_NATIVE_TEMPLATE ?? null;
  if (explicit) {
    if (!existsSync(explicit))
      throw new TemplateError(`template not found: ${explicit}`);
    if (!statSync(explicit).isFile())
      throw new TemplateError(
        `template ${explicit} is not a file (want an .apk)`,
      );
    return openTemplate(explicit, readFileSync(explicit), 'explicit');
  }
  const root = options.root ?? packageRoot();
  const bundled = openBundledTemplate(root);
  if (bundled) return bundled;
  const listed = readBundledTemplate(root);
  if (listed)
    throw new TemplateError(
      [
        `the template bundled with @iwer/native is missing (${path.join(root, listed.file)}).`,
        'The package is incomplete: reinstall it (npm install @iwer/native@alpha), or pass --template <apk>.',
      ].join('\n'),
    );
  const pinned = readPinnedTemplate(root);
  if (pinned)
    return fetchPinnedTemplate(pinned, {
      env,
      fetchImpl: options.fetchImpl,
      log,
    });
  const local = checkoutTemplatePath(root);
  if (existsSync(local))
    return openTemplate(local, readFileSync(local), 'checkout');
  throw new TemplateError(
    [
      'no template APK available.',
      'This @iwer/native build pins no template download yet (packager/templates.json), and no template was',
      `built in this checkout (${local}). Either pass --template <apk> (or set IWER_NATIVE_TEMPLATE),`,
      'or build one: node packager/template/build-template.mjs (needs the Android SDK/NDK; CI only).',
    ].join('\n'),
  );
}

/** Whole-download limit (the body included): a stalled mirror fails instead of hanging. */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** Download (or reuse the cached copy of) a pinned template; refuse checksum mismatches. */
export async function fetchPinnedTemplate(
  pinned: PinnedTemplate,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    log?: (m: string) => void;
  } = {},
): Promise<LoadedTemplate> {
  const log = options.log ?? (() => {});
  const dir = path.join(userCacheDir(options.env), 'templates', pinned.version);
  const file = path.join(
    dir,
    `iwer-native-template-${pinned.sha256.slice(0, 16)}.apk`,
  );
  if (existsSync(file)) {
    const buffer = readFileSync(file);
    if (sha256(buffer) === pinned.sha256)
      return openTemplate(file, buffer, 'cache');
    log(
      `cached template ${file} does not match its pinned checksum; downloading it again`,
    );
    rmSync(file, { force: true });
  }
  const doFetch = options.fetchImpl ?? fetch;
  log(`downloading template ${pinned.version} from ${pinned.url}`);
  let response: Response;
  try {
    response = await doFetch(pinned.url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    throw new TemplateError(
      `cannot download the template from ${pinned.url}: ${(e as Error).message}`,
    );
  }
  if (!response.ok)
    throw new TemplateError(
      `cannot download the template from ${pinned.url}: HTTP ${response.status}`,
    );
  let buffer: Buffer;
  try {
    buffer = Buffer.from(await response.arrayBuffer());
  } catch (e) {
    throw new TemplateError(
      `cannot download the template from ${pinned.url}: ${(e as Error).message}`,
    );
  }
  const got = sha256(buffer);
  if (got !== pinned.sha256)
    throw new TemplateError(
      `downloaded template does not match its pinned checksum (expected ${pinned.sha256}, got ${got}); refusing to use it`,
    );
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, buffer);
  renameSync(tmp, file);
  return openTemplate(file, buffer, 'download');
}
