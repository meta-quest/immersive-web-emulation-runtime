/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * `pack`: template APK + Vite dist + config → signed APK, in Node, with no
 * Android SDK, NDK, Gradle or JDK (PKG-1, PKG-4..9, PKG-11).
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
import path from 'node:path';
import { CAMERA_SIGNAL, scanDist } from '../../compat/src/scan.ts';
import { withFeature } from '../../src/config/resolve.ts';
import type { ResolvedNativeTarget } from '../../src/config/types.ts';
import { signApk, verifyApk, type VerifyResult } from './apk-sign.ts';
import { decodeAxml, encodeAxml } from './axml.ts';
import {
  detectInjection,
  listDist,
  scanIndexHtml,
  storeUncompressed,
  type IndexInfo,
} from './dist.ts';
import { loadKeystoreFile } from './keystore.ts';
import {
  applyManifest,
  summarizeManifest,
  templateContractWarnings,
  type ManifestSummary,
} from './manifest.ts';
import {
  decodePng,
  encodePng,
  imageSize,
  isPng,
  isWebp,
  placeholderIcon,
  resize,
} from './png.ts';
import { buildRuntimeConfig, type BuildType } from './runtime-config.ts';
import {
  buildSplash,
  SPLASH_ENTRY,
  SPLASH_FONT_ENTRY,
  type SplashBuild,
} from './splash.ts';
import {
  checkIdentity,
  loadOrCreateDebugIdentity,
  type SigningIdentity,
} from './signing-key.ts';
import {
  APP_ASSET_PREFIX,
  TEMPLATE_CONFIG_ENTRY,
  type LoadedTemplate,
} from './template.ts';
import {
  copyEntry,
  entryData,
  findEntry,
  METHOD_STORED,
  prepareEntry,
  readZip,
  writeZip,
  checkAlignment,
  type PreparedEntry,
} from './zip.ts';

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

export const SO_ALIGNMENT = 16384;

export interface PackInput {
  target: ResolvedNativeTarget;
  /** Absolute paths of files the config references (from loadNativeProject). */
  files: {
    icon: string | null;
    keystore: string | null;
    splash?: string | null;
  };
  distDir: string;
  outFile: string;
  template: LoadedTemplate;
  buildType: BuildType;
  /** Release build that still serves the inspector (PKG-8: then INTERNET is added). */
  inspector?: boolean;
  /** Extra exclude globs; release builds always exclude `*.map`. */
  exclude?: string[];
  env?: NodeJS.ProcessEnv;
  /** Where the debug key lives (tests); default: the user's config dir. */
  configDir?: string;
  /** `com.oculus.supportedDevices` override. */
  supportedDevices?: string | null;
  packerVersion: string;
  /** Identity override (tests). */
  identity?: SigningIdentity;
}

export interface PackResult {
  outFile: string;
  size: number;
  sha256: string;
  /** Bytes (as stored in the APK) that come from the template: runtime, resources. */
  runtimeBytes: number;
  /** Bytes (as stored) of the app's dist. */
  assetBytes: number;
  assetCount: number;
  /** Largest dist files by stored size. */
  largest: { rel: string; size: number; stored: number; compressed: boolean }[];
  excluded: string[];
  index: IndexInfo;
  manifest: ManifestSummary;
  signing: { mode: 'debug' | 'release'; description: string; created: boolean };
  verify: VerifyResult;
  /** The launch splash written to assets/vr_splash.png (native.splash), or null when off. */
  splash: {
    source: 'image' | 'generated';
    width: number;
    height: number;
    text: string | null;
    icon: boolean;
  } | null;
  /** native.splash.background: "contextual", "black" or "#rrggbb" (with or without a splash image). */
  splashBackground: string;
  warnings: string[];
  millis: number;
}

/** Template entries the packer never copies. */
function isDroppedTemplateEntry(name: string, iconPaths: Set<string>): boolean {
  return (
    name.startsWith('META-INF/') ||
    name === 'AndroidManifest.xml' ||
    name === TEMPLATE_CONFIG_ENTRY ||
    name === SPLASH_ENTRY ||
    name.startsWith(APP_ASSET_PREFIX) ||
    iconPaths.has(name)
  );
}

const isNativeLib = (name: string) => /^lib\/[^/]+\/[^/]+\.so$/.test(name);

/** Pick the signing key (PKG-7). */
export function resolveIdentity(input: PackInput): {
  identity: SigningIdentity;
  mode: 'debug' | 'release';
  created: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  if (input.identity)
    return {
      identity: input.identity,
      mode: 'release',
      created: false,
      warnings,
    };
  const env = input.env ?? process.env;
  const signing = input.target.signing;
  if (input.buildType === 'release' && signing.mode === 'release') {
    const storePassword = env[signing.storePasswordEnv];
    if (storePassword === undefined)
      throw new PackError(
        `release signing: the environment variable ${signing.storePasswordEnv} (keystore password) is not set`,
      );
    const keyPassword = env[signing.keyPasswordEnv];
    if (
      keyPassword === undefined &&
      signing.keyPasswordEnv !== signing.storePasswordEnv
    )
      throw new PackError(
        `release signing: the environment variable ${signing.keyPasswordEnv} (key password) is not set`,
      );
    const keystore = input.files.keystore ?? signing.keystore;
    const identity = loadKeystoreFile(keystore, {
      storePassword,
      keyPassword: keyPassword ?? storePassword,
      alias: signing.keyAlias,
    });
    checkIdentity(identity);
    return { identity, mode: 'release', created: false, warnings };
  }
  if (input.buildType === 'release')
    warnings.push(
      'release build signed with the debug key (no "signing" section): fine for sideloading, not for the store',
    );
  const debug = loadOrCreateDebugIdentity({ configDir: input.configDir });
  if (debug.created)
    warnings.push(`created a debug signing key in ${debug.dir}`);
  return { identity: debug, mode: 'debug', created: debug.created, warnings };
}

async function iconEntries(
  template: LoadedTemplate,
  iconFile: string | null,
  warnings: string[],
): Promise<PreparedEntry[]> {
  const out: PreparedEntry[] = [];
  const icons = template.meta.icons ?? [];
  if (icons.length === 0) {
    if (iconFile)
      warnings.push(
        'the template declares no icon files; the configured icon is ignored',
      );
    return out;
  }
  if (!iconFile) {
    for (const icon of icons) {
      const e = findEntry(template.zip, icon.path)!;
      out.push(copyEntry(template.zip, e, 4));
    }
    return out;
  }
  const bytes = readFileSync(iconFile);
  if (isPng(bytes)) {
    const img = decodePng(bytes);
    if (img.width !== img.height)
      warnings.push(
        `icon ${iconFile} is ${img.width}x${img.height}; it is stretched to a square`,
      );
    const largest = Math.max(...icons.map((i) => i.px));
    if (img.width < largest)
      warnings.push(
        `icon ${iconFile} is ${img.width}px; ${largest}px or more looks sharper`,
      );
    for (const icon of icons) {
      const png = encodePng(resize(img, icon.px, icon.px));
      out.push(await prepareEntry(icon.path, png, { compress: false }));
    }
    return out;
  }
  if (isWebp(bytes)) {
    const size = imageSize(bytes);
    warnings.push(
      `icon ${iconFile} is WebP${size ? ` (${size.width}x${size.height})` : ''}: used as-is for every density (use a PNG to get resized icons)`,
    );
    for (const icon of icons)
      out.push(await prepareEntry(icon.path, bytes, { compress: false }));
    return out;
  }
  throw new PackError(`icon ${iconFile} is neither a PNG nor a WebP image`);
}

/**
 * Features the dist implies when the config does not list them (no `native.features`): a bundle that calls
 * getUserMedia uses the camera. Every IWSDK bundle carries IWSDK's camera code whether the app uses it or not, so
 * for IWSDK apps only `world.features.camera` counts (resolve.ts featuresFromWorld).
 */
function distFeatures(
  target: ResolvedNativeTarget,
  distDir: string,
  warnings: string[],
): ResolvedNativeTarget {
  if (!target.featuresDerived || target.features.camera) return target;
  const scan = scanDist(distDir, [CAMERA_SIGNAL]);
  const hit = scan.hits[0];
  if (scan.iwsdk || !hit) return target;
  warnings.push(
    `${hit.files[0]?.file ?? 'the dist'} calls getUserMedia: declared the camera feature (optional; CAMERA and HEADSET_CAMERA, asked for on first use). Set native.features to leave it out`,
  );
  return withFeature(target, 'camera', 'optional');
}

/** Write the APK atomically; file-system problems become PackErrors. */
function writeOutput(outFile: string, apk: Buffer): void {
  if (existsSync(outFile) && statSync(outFile).isDirectory())
    throw new PackError(`--out ${outFile} is a directory; name an .apk file`);
  const tmp = `${outFile}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(tmp, apk);
    renameSync(tmp, outFile);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new PackError(`cannot write ${outFile}: ${(e as Error).message}`);
  }
}

/** Run `pack`. Writes the APK atomically and returns the report. */
export async function pack(input: PackInput): Promise<PackResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const { template } = input;

  // ---- the app's dist -------------------------------------------------------
  const exclude = [
    ...(input.exclude ?? []),
    ...(input.buildType === 'release' ? ['*.map'] : []),
  ];
  const { files: distFiles, excluded } = listDist(input.distDir, exclude);
  const indexFile = distFiles.find((f) => f.rel === 'index.html');
  if (!indexFile)
    throw new PackError(
      `${input.distDir} has no index.html; is this a Vite build output?`,
    );
  const indexHtml = readFileSync(indexFile.abs, 'utf8');
  const index = scanIndexHtml(indexHtml);
  if (index.moduleScripts.length === 0 && index.inlineModules === 0)
    throw new PackError(
      `${indexFile.abs} has no <script type="module">: the runtime boots the page's module entry. Build the app with Vite (npm run build:metavr).`,
    );
  const injected = detectInjection(input.distDir, distFiles, indexHtml);
  if (injected.length > 0)
    throw new PackError(
      [
        `the dist contains an injected WebXR emulator (${injected.map((f) => `${f.what} in ${f.file}`).join('; ')}).`,
        'It would take over navigator.xr inside the native runtime. Build with `npm run build:metavr` (vite build',
        '--mode metavr, which leaves the emulator out whatever dev.emulator.injectOnBuild says), or set',
        'dev.emulator.injectOnBuild to false in iwsdk.config.json, then rebuild.',
      ].join('\n'),
    );
  const target = distFeatures(input.target, input.distDir, warnings);
  if (template.meta.synthesized)
    warnings.push(
      `the template has no ${'assets/iwn/template.json'}: no launcher icon is set and its runtime version is unknown`,
    );
  if (template.meta.nativeBuild === 'debug' && input.buildType === 'release')
    warnings.push(
      'the template APK has a debug native build (slow); measure with a release template',
    );

  // ---- signing key first: fail before doing the heavy work ------------------
  const signing = resolveIdentity(input);
  warnings.push(...signing.warnings);

  // ---- the launch splash (native.splash) -------------------------------------
  // One PNG for Horizon OS's system splash and the runtime's loading screen.
  let splash: SplashBuild | null = null;
  if (target.splash.enabled) {
    if (target.splash.image && !input.files.splash)
      throw new PackError(
        `native.splash.image (${target.splash.image}) was not resolved to a file; pass files.splash`,
      );
    const fontEntry = findEntry(template.zip, SPLASH_FONT_ENTRY);
    splash = buildSplash({
      appName: target.appName,
      iconFile: input.files.icon,
      // Without an icon the launcher shows the template's placeholder: the splash shows the same design.
      defaultIcon: input.files.icon ? null : placeholderIcon(256),
      imageFile: target.splash.image ? (input.files.splash ?? null) : null,
      fontBytes: fontEntry ? entryData(template.zip, fontEntry) : null,
    });
    warnings.push(...splash.warnings.map((w) => `splash: ${w}`));
  }

  // ---- manifest -------------------------------------------------------------
  const manifestDoc = decodeAxml(
    entryData(template.zip, findEntry(template.zip, 'AndroidManifest.xml')!),
  );
  warnings.push(...templateContractWarnings(manifestDoc));
  applyManifest(manifestDoc, {
    target,
    debuggable: input.buildType === 'debug',
    servesInspector: input.buildType === 'debug' || !!input.inspector,
    supportedDevices: input.supportedDevices ?? null,
    splash: splash !== null,
    // The launch transition's background: Horizon OS knows black and contextual passthrough only ("contextual" is
    // accepted only for apps that declare passthrough, whose loading screen can show the room too).
    splashBackground:
      target.splash.background === 'contextual'
        ? 'passthrough-contextual'
        : 'black',
  });
  const manifestBytes = encodeAxml(manifestDoc);

  // ---- runtime config -------------------------------------------------------
  const templateConfigEntry = findEntry(template.zip, TEMPLATE_CONFIG_ENTRY);
  let templateConfig: unknown = {};
  if (templateConfigEntry) {
    try {
      templateConfig = JSON.parse(
        entryData(template.zip, templateConfigEntry).toString('utf8'),
      );
    } catch {
      warnings.push(
        `the template's ${TEMPLATE_CONFIG_ENTRY} is not valid JSON; ignoring its defaults`,
      );
    }
  }
  const configText = buildRuntimeConfig(templateConfig, {
    target,
    buildType: input.buildType,
    inspector: !!input.inspector,
    index,
    packerVersion: input.packerVersion,
    templateVersion: template.meta.runtimeVersion,
  });

  // ---- entries --------------------------------------------------------------
  const iconPaths = new Set((template.meta.icons ?? []).map((i) => i.path));
  const runtimeEntries: PreparedEntry[] = [];
  for (const e of template.zip.entries) {
    if (isDroppedTemplateEntry(e.name, iconPaths)) continue;
    if (e.name.endsWith('/')) continue; // directory entries
    if (e.name === 'resources.arsc' && e.method !== METHOD_STORED) {
      // Android 11+ refuses compressed or unaligned resources.arsc (targetSdk >= 30).
      runtimeEntries.push(
        await prepareEntry(e.name, entryData(template.zip, e), {
          compress: false,
          align: 4,
        }),
      );
      continue;
    }
    if (isNativeLib(e.name) && e.method !== METHOD_STORED) {
      // With extractNativeLibs=false (the default for current templates) the
      // installer maps libraries straight from the APK: they must be stored.
      warnings.push(
        `the template's ${e.name} is compressed; it is stored uncompressed in the app APK`,
      );
      runtimeEntries.push(
        await prepareEntry(e.name, entryData(template.zip, e), {
          compress: false,
          align: SO_ALIGNMENT,
        }),
      );
      continue;
    }
    runtimeEntries.push(
      copyEntry(template.zip, e, e.name.endsWith('.so') ? SO_ALIGNMENT : 4),
    );
  }
  const icons = await iconEntries(template, input.files.icon, warnings);
  const manifestEntry = await prepareEntry(
    'AndroidManifest.xml',
    manifestBytes,
    { compress: true },
  );
  const configEntry = await prepareEntry(
    TEMPLATE_CONFIG_ENTRY,
    Buffer.from(configText, 'utf8'),
    { compress: true },
  );
  // Stored: a PNG does not compress further, and the runtime maps it.
  const splashEntries = splash
    ? [
        await prepareEntry(SPLASH_ENTRY, splash.png, {
          compress: false,
          align: 4,
        }),
      ]
    : [];

  // Dist files: compress concurrently (zlib runs on the libuv pool).
  const assetEntries: PreparedEntry[] = new Array(distFiles.length);
  let next = 0;
  const worker = async () => {
    while (next < distFiles.length) {
      const i = next++;
      const f = distFiles[i];
      const data = readFileSync(f.abs);
      assetEntries[i] = await prepareEntry(APP_ASSET_PREFIX + f.rel, data, {
        compress: !storeUncompressed(f.rel),
        align: 4,
      });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));

  const all = [
    manifestEntry,
    ...runtimeEntries,
    ...icons,
    configEntry,
    ...splashEntries,
    ...assetEntries,
  ];
  const zip = writeZip(all);
  const apk = signApk(zip, signing.identity);

  // ---- self-check -------------------------------------------------------------
  const verify = verifyApk(apk);
  const written = readZip(apk);
  const alignment = [
    ...checkAlignment(written, { soAlign: SO_ALIGNMENT }),
    ...written.entries
      .filter((e) => isNativeLib(e.name) && e.method !== METHOD_STORED)
      .map((e) => `${e.name} is compressed (native libraries must be stored)`),
  ];
  if (alignment.length)
    throw new PackError(`internal error: ${alignment.join('; ')}`);

  writeOutput(input.outFile, apk);

  const stored = (e: PreparedEntry) => e.data.length;
  const largest = distFiles
    .map((f, i) => ({
      rel: f.rel,
      size: f.size,
      stored: stored(assetEntries[i]),
      compressed: assetEntries[i].method !== METHOD_STORED,
    }))
    .sort((a, b) => b.stored - a.stored || (a.rel < b.rel ? -1 : 1))
    .slice(0, 5);
  return {
    outFile: input.outFile,
    size: apk.length,
    sha256: createHash('sha256').update(apk).digest('hex'),
    runtimeBytes: runtimeEntries.reduce((n, e) => n + stored(e), 0),
    assetBytes: assetEntries.reduce((n, e) => n + stored(e), 0),
    assetCount: assetEntries.length,
    largest,
    excluded,
    index,
    manifest: summarizeManifest(manifestDoc),
    signing: {
      mode: signing.mode,
      description: signing.identity.description,
      created: signing.created,
    },
    verify,
    splash: splash
      ? {
          source: splash.source,
          width: splash.width,
          height: splash.height,
          text: splash.text,
          icon: splash.icon,
        }
      : null,
    splashBackground: target.splash.background,
    warnings,
    millis: Date.now() - started,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** How native.splash.background reads in reports. */
export function describeSplashBackground(background: string): string {
  if (background === 'contextual')
    return 'contextual background (passthrough from a passthrough home, else black)';
  return background === 'black'
    ? 'black background'
    : `background ${background}`;
}

function formatSplash(s: PackResult['splash'], background: string): string {
  const bg = describeSplashBackground(background);
  if (!s) return `off (no image or spinner; ${bg} until the first XR frame)`;
  if (s.source === 'image')
    return `your image, ${s.width}x${s.height}, + loading spinner, ${bg}`;
  const parts = [s.icon ? 'icon' : null, s.text ? `"${s.text}"` : null].filter(
    Boolean,
  );
  return `generated ${s.width}x${s.height} (${parts.join(' + ') || 'empty'}) + loading spinner, ${bg}`;
}

/** Human-readable pack report (PKG-11). */
export function formatPackReport(r: PackResult): string {
  const lines = [
    `wrote ${r.outFile}`,
    `  package     ${r.manifest.packageId} "${r.manifest.label}" ${r.manifest.versionName} (${r.manifest.versionCode})${r.manifest.debuggable ? ', debuggable' : ''}`,
    `  size        ${formatBytes(r.size)}: runtime ${formatBytes(r.runtimeBytes)}, app assets ${formatBytes(r.assetBytes)} in ${r.assetCount} files`,
    `  entry       ${r.index.moduleScripts[0] ?? '(inline module)'}${r.index.title ? `  title "${r.index.title}"` : ''}`,
    `  largest     ${r.largest.map((l) => `${l.rel} ${formatBytes(l.stored)}${l.compressed ? '' : ' (stored)'}`).join(', ')}`,
    `  permissions ${r.manifest.permissions.join(', ') || '(none)'}`,
    `  features    ${r.manifest.features.map((f) => `${f.name} (${f.required ? 'required' : 'optional'})`).join(', ') || '(none)'}`,
    `  splash      ${formatSplash(r.splash, r.splashBackground)}`,
    `  signed      v2${r.verify.v3 ? '+v3' : ''} with ${r.signing.description} (${r.verify.signers[0]?.certificateSha256 ?? '?'})`,
    `  sha256      ${r.sha256}`,
    `  took        ${(r.millis / 1000).toFixed(1)} s`,
  ];
  if (r.excluded.length)
    lines.push(
      `  excluded    ${r.excluded.length} file(s) (${r.excluded.slice(0, 3).join(', ')}${r.excluded.length > 3 ? ', …' : ''})`,
    );
  return `${lines.join('\n')}\n`;
}
