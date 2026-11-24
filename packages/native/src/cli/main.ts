/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  describeSplashBackground,
  formatPackReport,
  pack as packApk,
  type PackResult,
} from '../../packager/src/pack.ts';
import {
  readApkManifest,
  readApkRuntimeConfig,
} from '../../packager/src/manifest.ts';
import { userConfigDir } from '../../packager/src/signing-key.ts';
import { resolveTemplate } from '../../packager/src/template.ts';
import {
  loadNativeProject,
  type LoadedNativeProject,
  type LoadNativeProjectOptions,
} from '../config/load.ts';
import { NativeConfigError } from '../config/validate.ts';
import {
  defaultExec,
  locateAdb,
  parseAdbDevices,
  type Exec,
} from '../util/exec.ts';
import { VERSION } from '../version.ts';
import { runDoctor, type CheckStatus } from './doctor.ts';
import { checkProject, runCompatCommand } from '../../compat/src/cli.ts';
import { formatCompatReport } from '../../compat/src/check.ts';
import { phaseMsProblem } from '../../compat/src/trace-run.ts';

/** Exit codes. */
export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
} as const;

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  exec: Exec;
  isExecutable?: (file: string) => boolean;
}

export function defaultIo(): CliIo {
  return {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    cwd: process.cwd(),
    env: process.env,
    nodeVersion: process.versions.node,
    exec: defaultExec,
  };
}

const COMMANDS = {
  pack: 'Build dist-metavr/<name>.apk from the Vite dist/ (template APK + assets, signed in Node)',
  install: 'Install the packed APK (or a given one) on the connected headset',
  run: 'Launch the app on the connected headset (debug switches as intent extras)',
  doctor: 'Check Node, adb, connected headsets and the native config',
  validate:
    'Validate the "native" section of iwsdk.config.json and print the resolved target',
  compat:
    'Check the built dist/ for web APIs the native runtime lacks (static scan; --trace adds a headless run)',
} as const;
type Command = keyof typeof COMMANDS;

export const HELP = `iwer-native ${VERSION}: run a WebXR app natively on Android OpenXR headsets

Usage: iwer-native <command> [options]

Commands:
${Object.entries(COMMANDS)
  .map(([name, text]) => `  ${name.padEnd(10)}${text}`)
  .join('\n')}

Common options:
  --project <dir>   IWSDK project root (default: current directory)
  --serial <id>     adb device serial (install, run; needed when several devices are
                    connected, unless $ANDROID_SERIAL is set)
  --json            machine-readable output (doctor, validate, pack)
  --dry-run         print the adb commands instead of running them (install, run)
  -h, --help        show help
  -v, --version     show version

pack options:
  --release         release build: not debuggable, no inspector, *.map excluded,
                    signed with the "signing" keystore (else the debug key)
  --inspector       release build that still serves the inspector/debug endpoint
  --dist <dir>      Vite output to pack (default: <project>/dist)
  --out <apk>       output (default: <project>/dist-metavr/<appName>.apk,
                    <appName>-release.apk with --release; install --release installs that one)
  --template <apk>  template APK (default: $IWER_NATIVE_TEMPLATE, the one bundled in the package, the pinned download, or a checkout build)
  --exclude <glob>  leave matching dist files out (repeatable)
  --install, --run  install and launch after packing

run options (launch extras: a release build ignores them, run warns when it does):
  --inspect         turn the inspector on (extra iwn.inspector; debug builds, or
                    release builds packed with --inspector)
  --inspect-brk     wait for the debugger before the entry module (extra iwn.inspectBrk; debug builds only)
  --query <qs>      URL query string the app sees (extra iwn.query; debug builds, or
                    release builds packed with --inspector)
  --v8-flags <f>    diagnostic V8 flags (extra iwn.v8flags; debug builds only)
  --forward <port>  adb forward tcp:<port> to the device's inspector port (read from
                    the packed APK, else from the installed APK's runtime config)
  --device-port <p> the device-side inspector port to forward to (overrides the lookup)
  --activity <cls>  launcher activity (default android.app.NativeActivity)

compat options (pack runs the static check first; --skip-compat turns it off):
  --dist <dir>      Vite output to check (default: <project>/dist)
  --trace           also run the app headlessly (Playwright + IWER from the project);
                    native.network.allow origins are let through, others blocked;
                    a run that never reaches XR fails the check (exit 1)
  --mirror <p>=<d>  trace run: answer requests under URL prefix <p> from directory <d> (repeatable)
  --boot-ms <ms>    trace run: wait this long for the app to offer or request a session
                    (default 25000; heavy apps load slowly under SwiftShader)
  --strict          fail on warnings and on static mentions of unsupported calls
  --verbose         show informational findings and evidence

Exit codes: 0 ok, 1 failure, 2 usage error.
`;

const OPTIONS = {
  project: { type: 'string' },
  serial: { type: 'string', short: 's' },
  out: { type: 'string', short: 'o' },
  json: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  release: { type: 'boolean' },
  install: { type: 'boolean' },
  run: { type: 'boolean' },
  inspector: { type: 'boolean' },
  dist: { type: 'string' },
  template: { type: 'string' },
  exclude: { type: 'string', multiple: true },
  inspect: { type: 'boolean' },
  'inspect-brk': { type: 'boolean' },
  query: { type: 'string' },
  'v8-flags': { type: 'string' },
  forward: { type: 'string' },
  'device-port': { type: 'string' },
  activity: { type: 'string' },
  trace: { type: 'boolean' },
  mirror: { type: 'string', multiple: true },
  'boot-ms': { type: 'string' },
  strict: { type: 'boolean' },
  verbose: { type: 'boolean' },
  'skip-compat': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

/** Run the CLI. Returns the exit code; never calls process.exit. */
export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo(),
): Promise<number> {
  let parsed: ReturnType<
    typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
  >;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    io.stderr(
      `iwer-native: ${(error as Error).message}\nRun "iwer-native --help" for usage.\n`,
    );
    return EXIT.usage;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout(`${VERSION}\n`);
    return EXIT.ok;
  }
  const [command, ...rest] = positionals;
  if (values.help || command === undefined || command === 'help') {
    io.stdout(HELP);
    return EXIT.ok;
  }
  if (!(command in COMMANDS)) {
    io.stderr(
      `iwer-native: unknown command "${command}". Commands: ${Object.keys(COMMANDS).join(', ')}\n`,
    );
    return EXIT.usage;
  }
  const projectRoot = path.resolve(io.cwd, values.project ?? '.');
  const ctx: CommandContext = { io, projectRoot, values, rest };
  switch (command as Command) {
    case 'doctor':
      return doctor(ctx);
    case 'validate':
      return validate(ctx);
    case 'pack':
      return pack(ctx);
    case 'install':
      return install(ctx);
    case 'run':
      return run(ctx);
    case 'compat':
      return compat(ctx);
  }
}

interface CommandContext {
  io: CliIo;
  projectRoot: string;
  values: {
    serial?: string;
    out?: string;
    json?: boolean;
    'dry-run'?: boolean;
    release?: boolean;
    install?: boolean;
    run?: boolean;
    inspector?: boolean;
    dist?: string;
    template?: string;
    exclude?: string[];
    inspect?: boolean;
    'inspect-brk'?: boolean;
    query?: string;
    'v8-flags'?: string;
    forward?: string;
    'device-port'?: string;
    activity?: string;
    trace?: boolean;
    mirror?: string[];
    'boot-ms'?: string;
    strict?: boolean;
    verbose?: boolean;
    'skip-compat'?: boolean;
  };
  rest: string[];
}

const MARK: Record<CheckStatus, string> = {
  ok: '[ok]  ',
  warn: '[warn]',
  fail: '[fail]',
  skip: '[skip]',
};

async function doctor({
  io,
  projectRoot,
  values,
  rest,
}: CommandContext): Promise<number> {
  if (rest.length > 0)
    return usage(io, `doctor takes no arguments (got "${rest.join(' ')}")`);
  const checks = await runDoctor({
    nodeVersion: io.nodeVersion,
    env: io.env,
    projectRoot,
    exec: io.exec,
    isExecutable: io.isExecutable,
  });
  const failed = checks.some((c) => c.status === 'fail');
  if (values.json) {
    io.stdout(`${JSON.stringify({ ok: !failed, checks }, null, 2)}\n`);
  } else {
    for (const c of checks) {
      io.stdout(`${MARK[c.status]} ${c.summary}\n`);
      for (const d of c.details ?? []) io.stdout(`         ${d}\n`);
      if (c.hint && c.status !== 'ok') io.stdout(`         -> ${c.hint}\n`);
    }
    io.stdout(
      failed ? '\nSome checks failed.\n' : '\nAll required checks passed.\n',
    );
  }
  return failed ? EXIT.failure : EXIT.ok;
}

async function validate({
  io,
  projectRoot,
  values,
  rest,
}: CommandContext): Promise<number> {
  if (rest.length > 0)
    return usage(io, `validate takes no arguments (got "${rest.join(' ')}")`);
  // The release keystore is only needed by pack --release: missing, it is a warning here.
  const loaded = load(io, projectRoot, values.json, { requireKeystore: false });
  if (!loaded) return EXIT.failure;
  if (values.json) {
    io.stdout(
      `${JSON.stringify({ ok: true, configPath: loaded.configPath, target: loaded.target, warnings: loaded.warnings }, null, 2)}\n`,
    );
    return EXIT.ok;
  }
  printWarnings(io, loaded);
  const t = loaded.target;
  io.stdout(
    [
      `${loaded.configPath}: native target is valid`,
      `  package      ${t.packageId}`,
      `  app name     ${t.appName}`,
      `  version      ${t.version} (versionCode ${t.versionCode})`,
      `  icon         ${t.icon ?? '(default)'}`,
      `  splash       ${t.splash.enabled ? `${t.splash.image ?? 'generated from the icon and app name'}, ${describeSplashBackground(t.splash.background)}` : `off (no image or spinner), ${describeSplashBackground(t.splash.background)}`}`,
      `  frame rate   ${t.frameRate ? `${t.frameRate} Hz` : '(runtime default)'}`,
      `  foveation    ${t.foveation.level}${t.foveation.dynamic ? ', dynamic' : ''}`,
      `  features     ${
        Object.entries(t.features)
          .map(([k, v]) => `${k} (${v})`)
          .join(', ') || '(none)'
      }`,
      `  permissions  ${t.permissions.join(', ') || '(none)'}`,
      `  network      ${t.network.allow.join(', ') || '(APK assets only)'}`,
      `  signing      ${t.signing.mode === 'release' ? `release, ${t.signing.keystore}, passwords from $${t.signing.storePasswordEnv}` : 'debug key (sideloading only)'}`,
      '',
    ].join('\n'),
  );
  return EXIT.ok;
}

async function pack({
  io,
  projectRoot,
  values,
  rest,
}: CommandContext): Promise<number> {
  if (rest.length > 0)
    return usage(io, `pack takes no arguments (got "${rest.join(' ')}")`);
  // Debug packs never use the release keystore (PKG-7), so it may be absent.
  const loaded = load(io, projectRoot, values.json, {
    requireKeystore: !!values.release,
  });
  if (!loaded) return EXIT.failure;
  if (!values.json) printWarnings(io, loaded);
  const out = path.resolve(
    io.cwd,
    values.out ??
      defaultApkPath(projectRoot, loaded.target.appName, !!values.release),
  );
  const distDir = path.resolve(projectRoot, values.dist ?? 'dist');
  const buildType = values.release ? 'release' : 'debug';
  // what the compat gate found, kept for --json output when it passes (warnings and the unsupported-API advice)
  let compatSummary: Record<string, unknown> | undefined;
  if (!values['skip-compat'] && existsSync(path.join(distDir, 'index.html'))) {
    // the build:metavr compat gate: static scan of the dist, the app's source and config (compat/README.md)
    let report: Awaited<ReturnType<typeof checkProject>>;
    try {
      report = await checkProject({
        projectRoot,
        distDir,
        strict: values.strict,
        allow: loaded.target.network.allow,
        features: {
          names: Object.keys(loaded.target.features),
          derived: !!loaded.target.featuresDerived,
        },
      });
    } catch (error) {
      const message = `compat check could not run: ${(error as Error).message} (pass --skip-compat to pack anyway)`;
      if (values.json)
        io.stdout(
          `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`,
        );
      else io.stderr(`iwer-native pack: ${message}\n`);
      return EXIT.failure;
    }
    if (!values.json && (!report.ok || report.warnings > 0))
      io.stderr(formatCompatReport(report, { verbose: values.verbose }));
    compatSummary = {
      ok: report.ok,
      errors: report.errors,
      warnings: report.warnings,
      findings: report.findings.filter((f) => f.severity !== 'info'),
      ...(report.advice ? { advice: report.advice } : {}),
    };
    if (!report.ok || (values.strict && report.warnings > 0)) {
      if (values.json)
        io.stdout(
          `${JSON.stringify({ ok: false, error: 'compat check failed (pass --skip-compat to pack anyway)', compat: report }, null, 2)}\n`,
        );
      else
        io.stderr(
          'iwer-native pack: compat check failed (pass --skip-compat to pack anyway)\n',
        );
      return EXIT.failure;
    }
  }
  let result: PackResult;
  try {
    const template = await resolveTemplate({
      explicit: values.template ? path.resolve(io.cwd, values.template) : null,
      env: io.env,
      log: (m) => io.stderr(`${m}\n`),
    });
    result = await packApk({
      target: loaded.target,
      files: loaded.files,
      distDir,
      outFile: out,
      template,
      buildType,
      inspector: values.inspector ?? false,
      exclude: values.exclude ?? [],
      env: io.env,
      configDir: userConfigDir(io.env),
      packerVersion: VERSION,
    });
  } catch (error) {
    const e = error as Error & { code?: unknown };
    // Packer errors are the user's to fix; Node system and OpenSSL errors
    // (ENOENT, EACCES, EISDIR, ERR_OSSL_*) carry a code and are usually about
    // a path or a file the user named. Anything else is a bug: keep the stack.
    if (!PACK_ERRORS.has(e.name) && typeof e.code !== 'string') throw error;
    if (values.json)
      io.stdout(
        `${JSON.stringify({ ok: false, error: e.message }, null, 2)}\n`,
      );
    else io.stderr(`iwer-native pack: ${e.message}\n`);
    return EXIT.failure;
  }
  if (values.json) {
    io.stdout(
      `${JSON.stringify({ ok: true, ...result, ...(compatSummary ? { compat: compatSummary } : {}) }, null, 2)}\n`,
    );
  } else {
    for (const w of result.warnings) io.stderr(`warning: ${w}\n`);
    io.stdout(formatPackReport(result));
  }
  if (values.install || values.run) {
    const refused = await refuseAmbiguousDevice(io, values);
    if (refused !== null) return refused;
  }
  if (values.install) {
    const code = await installApk(io, values, out, loaded.target.packageId);
    if (code !== EXIT.ok) return code;
  }
  if (values.run)
    return launch(io, values, loaded.target.packageId, inspectorPortOf(out), {
      // with --install the app on the device is the one just packed
      installed: values.install ? apkBuildInfo(out) : null,
      localRelease: values.release ? out : null,
    });
  return EXIT.ok;
}

async function compat({
  io,
  projectRoot,
  values,
  rest,
}: CommandContext): Promise<number> {
  if (rest.length > 0)
    return usage(io, `compat takes no arguments (got "${rest.join(' ')}")`);
  const bootProblem =
    values['boot-ms'] === undefined
      ? undefined
      : phaseMsProblem('--boot-ms', values['boot-ms']);
  if (bootProblem) return usage(io, bootProblem);
  return runCompatCommand({
    projectRoot,
    distDir: values.dist,
    trace: values.trace,
    mirrors: values.mirror,
    bootMs:
      values['boot-ms'] === undefined ? undefined : Number(values['boot-ms']),
    strict: values.strict,
    verbose: values.verbose,
    json: values.json,
    stdout: io.stdout,
    stderr: io.stderr,
  });
}

/** Errors from the packer that are the user's to fix (printed, exit 1). */
const PACK_ERRORS = new Set([
  'PackError',
  'TemplateError',
  'DistError',
  'KeystoreError',
  'ApkSignatureError',
  'ZipFormatError',
  'AxmlError',
  'PngError',
  'DerError',
  'SigningKeyError',
  'SplashError',
]);

/** dist-metavr/<appName>.apk, and <appName>-release.apk for release builds, so a release pack keeps the debug APK. */
export function defaultApkPath(
  projectRoot: string,
  appName: string,
  release = false,
): string {
  return path.join(
    projectRoot,
    'dist-metavr',
    `${safeFileName(appName)}${release ? '-release' : ''}.apk`,
  );
}

async function install({
  io,
  projectRoot,
  values,
  rest,
}: CommandContext): Promise<number> {
  if (rest.length > 1) return usage(io, 'install takes at most one APK path');
  let apk = rest[0];
  let packageId: string | null = null;
  if (!apk) {
    const loaded = load(io, projectRoot, false, { requireKeystore: false });
    if (!loaded) return EXIT.failure;
    apk = defaultApkPath(projectRoot, loaded.target.appName, !!values.release);
    packageId = loaded.target.packageId;
    if (!existsSync(apk) && !values['dry-run']) {
      io.stderr(
        `iwer-native install: ${apk} does not exist; run "iwer-native pack" first (or pass an APK path)\n`,
      );
      return EXIT.failure;
    }
  } else if (!apk.toLowerCase().endsWith('.apk'))
    return usage(io, `"${apk}" is not an .apk file`);
  const refused = await refuseAmbiguousDevice(io, values);
  if (refused !== null) return refused;
  return installApk(io, values, path.resolve(io.cwd, apk), packageId);
}

async function installApk(
  io: CliIo,
  values: CommandContext['values'],
  apk: string,
  packageId: string | null,
): Promise<number> {
  const result = await adb(io, values, ['install', '-r', apk], 300_000);
  if (result.code === EXIT.ok) return EXIT.ok;
  const text = result.output;
  if (
    /INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(text)
  ) {
    packageId ??= readApkManifest(apk)?.packageId ?? null;
    io.stderr(
      [
        "iwer-native: the installed app was signed with a different key (debug vs release, or another machine's",
        'debug key). Android refuses such updates. Uninstall it first (this deletes its data):',
        `  adb${values.serial ? ` -s ${values.serial}` : ''} uninstall ${packageId ?? '<package id>'}`,
        '',
      ].join('\n'),
    );
  } else if (/INSTALL_FAILED_VERSION_DOWNGRADE/.test(text)) {
    io.stderr(
      'iwer-native: the installed app has a higher versionCode; raise "versionCode" (or "version") in the native config.\n',
    );
  } else if (/INSTALL_FAILED_NO_MATCHING_ABIS/.test(text)) {
    io.stderr(
      'iwer-native: this device is not arm64-v8a; the runtime ships arm64 only.\n',
    );
  }
  return result.code;
}

async function run({
  io,
  projectRoot,
  values,
  rest,
}: CommandContext): Promise<number> {
  if (rest.length > 1) return usage(io, 'run takes at most one package id');
  let packageId = rest[0];
  let devicePort: number | null = null;
  if (values['device-port'] !== undefined) {
    devicePort = parsePort(values['device-port']);
    if (devicePort === null)
      return usage(
        io,
        `--device-port wants a TCP port, got "${values['device-port']}"`,
      );
  }
  let localRelease: string | null = null;
  if (!packageId) {
    const loaded = load(io, projectRoot, false, { requireKeystore: false });
    if (!loaded) return EXIT.failure;
    packageId = loaded.target.packageId;
    devicePort ??= inspectorPortOf(
      defaultApkPath(projectRoot, loaded.target.appName),
    );
    localRelease = defaultApkPath(projectRoot, loaded.target.appName, true);
  }
  const refused = await refuseAmbiguousDevice(io, values);
  if (refused !== null) return refused;
  if (devicePort === null && values.forward !== undefined)
    devicePort = await installedInspectorPort(io, values, packageId);
  return launch(io, values, packageId, devicePort ?? INSPECTOR_DEVICE_PORT, {
    installed: null,
    localRelease,
  });
}

/**
 * install/run without --serial: refuse when several devices are ready, listing them (adb would fail with "more than
 * one device/emulator", or a wrapper could pick one). $ANDROID_SERIAL, or a device selector in
 * IWER_NATIVE_ADB_ARGS, picks one as it does for adb. Returns the exit code when refused, else null; when
 * `adb devices` itself fails the command goes ahead and reports adb's own error.
 */
async function refuseAmbiguousDevice(
  io: CliIo,
  values: CommandContext['values'],
): Promise<number | null> {
  if (values.serial || io.env.ANDROID_SERIAL || values['dry-run']) return null;
  let prefix: string[];
  try {
    prefix = splitShellWords(io.env.IWER_NATIVE_ADB_ARGS ?? '');
  } catch {
    return null; // adb() reports the bad IWER_NATIVE_ADB_ARGS
  }
  if (prefix.some((a) => /^-[sdet]$/.test(a))) return null;
  const quiet = { ...io, stdout: () => {}, stderr: () => {} };
  const listed = await adb(quiet, values, ['devices', '-l'], 10_000);
  if (listed.code !== EXIT.ok) return null;
  const devices = parseAdbDevices(listed.output);
  const ready = devices.filter((d) => d.state === 'device');
  if (ready.length < 2) return null;
  io.stderr(
    [
      `iwer-native: ${ready.length} devices are connected; pass --serial <id> (or set ANDROID_SERIAL) to pick one:`,
      ...devices.map(
        (d) => `  ${d.serial} ${d.state}${d.model ? ` (${d.model})` : ''}`,
      ),
      '',
    ].join('\n'),
  );
  return EXIT.failure;
}

/** What a build does with launch extras (runtime/core runtime.cc): debuggable, and whether it honours overrides. */
export interface LaunchBuildInfo {
  debuggable: boolean;
  /** --inspect/--query are honoured (debug builds, release builds packed with --inspector); null: unknown. */
  overridesAllowed: boolean | null;
}

/** A local APK's build: the manifest's debuggable flag and its runtime config (launchOverrides.allowed). */
function apkBuildInfo(apk: string): LaunchBuildInfo | null {
  const manifest = readApkManifest(apk);
  if (!manifest) return null;
  const config = readApkRuntimeConfig(apk) as {
    launchOverrides?: { allowed?: unknown };
    inspector?: { enabled?: unknown };
  } | null;
  const allowed =
    config?.launchOverrides?.allowed ?? config?.inspector?.enabled;
  return {
    debuggable: manifest.debuggable,
    overridesAllowed:
      manifest.debuggable || (typeof allowed === 'boolean' ? allowed : null),
  };
}

/**
 * The installed app's build, from `dumpsys package` (pkgFlags DEBUGGABLE). A release build honours --inspect and
 * --query only when packed with --inspector, which the device does not show: the local release APK
 * (dist-metavr/<app>-release.apk) answers that when it is the same package.
 */
async function installedBuildInfo(
  io: CliIo,
  values: CommandContext['values'],
  packageId: string,
  localRelease: string | null,
): Promise<LaunchBuildInfo | null> {
  const quiet = { ...io, stdout: () => {}, stderr: () => {} };
  const dump = await adb(
    quiet,
    values,
    ['shell', 'dumpsys', 'package', packageId],
    15_000,
  );
  const flags = /pkgFlags=\[([^\]]*)\]/.exec(dump.output)?.[1];
  if (dump.code !== EXIT.ok || flags === undefined) return null;
  if (/\bDEBUGGABLE\b/.test(flags))
    return { debuggable: true, overridesAllowed: true };
  let overridesAllowed: boolean | null = null;
  if (localRelease && existsSync(localRelease)) {
    const local = apkBuildInfo(localRelease);
    if (
      local &&
      !local.debuggable &&
      readApkManifest(localRelease)?.packageId === packageId
    )
      overridesAllowed = local.overridesAllowed;
  }
  return { debuggable: false, overridesAllowed };
}

/**
 * The one-line warning when the build ignores launch extras the user passed (PKG-CFG-3): --inspect-brk and
 * --v8-flags need a debuggable build; --inspect and --query a debug build or a release build packed with
 * --inspector. Null when nothing is ignored, or when the build is unknown.
 */
export function ignoredExtrasWarning(
  packageId: string,
  values: CommandContext['values'],
  build: LaunchBuildInfo | null,
): string | null {
  if (!build || build.debuggable) return null;
  const debugOnly = [
    values['inspect-brk'] ? '--inspect-brk' : null,
    values['v8-flags'] !== undefined ? '--v8-flags' : null,
  ].filter((o): o is string => o !== null);
  const overrides = [
    values.inspect ? '--inspect' : null,
    values.query !== undefined ? '--query' : null,
  ].filter((o): o is string => o !== null);
  const allowed = build.overridesAllowed;
  const sure = allowed === false ? [...overrides, ...debugOnly] : debugOnly;
  const maybe = allowed === null ? overrides : [];
  if (sure.length === 0 && maybe.length === 0) return null;
  const unless = maybe.length
    ? `${maybe.join(', ')} unless it was packed with --inspector`
    : '';
  const what = sure.length
    ? `${sure.join(', ')}${unless ? `, and ${unless}` : ''}`
    : unless;
  return `${packageId} is a release build: the runtime ignores ${what}. Launch extras need a debug build (pack without --release); --inspect and --query also work in a release build packed with --inspector`;
}

function parsePort(text: string): number | null {
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** The inspector port in an APK's runtime config, or null when it names none. */
function apkInspectorPort(apk: string): number | null {
  const port = (
    readApkRuntimeConfig(apk) as { inspector?: { port?: unknown } } | null
  )?.inspector?.port;
  return typeof port === 'number' && Number.isInteger(port) ? port : null;
}

/** The inspector port the packed APK's runtime config asks for (default 9229). */
function inspectorPortOf(apk: string): number {
  return apkInspectorPort(apk) ?? INSPECTOR_DEVICE_PORT;
}

/**
 * `run <package> --forward`: read the inspector port from the APK installed on
 * the device (`pm path` + `adb pull`), since there may be no local build.
 */
async function installedInspectorPort(
  io: CliIo,
  values: CommandContext['values'],
  packageId: string,
): Promise<number | null> {
  if (values['dry-run']) return null;
  const quiet = { ...io, stdout: () => {}, stderr: () => {} };
  const where = await adb(
    quiet,
    values,
    ['shell', 'pm', 'path', packageId],
    30_000,
  );
  const remote = /^package:(\S+?base\.apk)\s*$/m.exec(where.output)?.[1];
  if (where.code !== EXIT.ok || !remote) return null;
  const dir = mkdtempSync(path.join(tmpdir(), 'iwn-run-'));
  try {
    const local = path.join(dir, 'base.apk');
    const pulled = await adb(quiet, values, ['pull', remote, local], 120_000);
    if (pulled.code !== EXIT.ok || !existsSync(local)) return null;
    const port = apkInspectorPort(local);
    if (port === null)
      io.stderr(
        `iwer-native: ${packageId} names no inspector port; forwarding to ${INSPECTOR_DEVICE_PORT} (use --device-port to choose)\n`,
      );
    return port;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Launch intent extras the runtime reads (PKG-10, PKG-CFG-3). */
export function launchArgs(
  packageId: string,
  values: CommandContext['values'],
): string[] {
  const activity = values.activity ?? 'android.app.NativeActivity';
  const args = [
    'shell',
    'am',
    'start',
    '-S', // stop a running instance first: config is read once at launch
    '-W',
    '-n',
    `${packageId}/${activity}`,
  ];
  if (values.inspect) args.push('--ez', 'iwn.inspector', 'true');
  if (values['inspect-brk']) args.push('--ez', 'iwn.inspectBrk', 'true');
  // `adb shell` joins its arguments into one command line for the device's
  // shell, so string extras are quoted for that shell.
  if (values.query !== undefined)
    args.push('--es', 'iwn.query', quote(values.query));
  if (values['v8-flags'] !== undefined)
    args.push('--es', 'iwn.v8flags', quote(values['v8-flags']));
  return args;
}

async function launch(
  io: CliIo,
  values: CommandContext['values'],
  packageId: string,
  devicePort = INSPECTOR_DEVICE_PORT,
  build: {
    /** The build on the device when known (pack --install --run), else read from the device. */
    installed: LaunchBuildInfo | null;
    localRelease: string | null;
  } = { installed: null, localRelease: null },
): Promise<number> {
  if (values.forward !== undefined) {
    const port = parsePort(values.forward);
    if (port === null)
      return usage(io, `--forward wants a TCP port, got "${values.forward}"`);
    const fwd = await adb(
      io,
      values,
      ['forward', `tcp:${port}`, inspectorSocket(packageId, devicePort)],
      30_000,
    );
    if (fwd.code !== EXIT.ok) return fwd.code;
    if (!values['dry-run'])
      io.stdout(
        `inspector: http://127.0.0.1:${port}/json/version (device port ${devicePort})\n`,
      );
  }
  const result = await adb(io, values, launchArgs(packageId, values), 60_000);
  if (result.timedOut) {
    // `am start -W` waits for the app's first frame; a system dialog in front of it holds the launch.
    const quiet = { ...io, stdout: () => {}, stderr: () => {} };
    const focus = await adb(
      quiet,
      values,
      [
        'shell',
        'dumpsys',
        'window',
        '|',
        'grep',
        '-E',
        "'mCurrentFocus|mFocusedApp'",
      ],
      10_000,
    );
    const hint = blockingDialogHint(focus.output, packageId);
    if (hint) io.stderr(`iwer-native: ${hint}\n`);
  }
  if (result.code !== EXIT.ok) return result.code;
  // `am start` exits 0 even when it fails; it says so in its output.
  if (/^Error:|Error type \d|does not exist/m.test(result.output)) {
    io.stderr(
      `iwer-native: could not launch ${packageId}; is it installed? ("iwer-native install")\n`,
    );
    return EXIT.failure;
  }
  const extras =
    values.inspect ||
    values['inspect-brk'] ||
    values.query !== undefined ||
    values['v8-flags'] !== undefined;
  if (extras && !values['dry-run']) {
    const info =
      build.installed ??
      (await installedBuildInfo(io, values, packageId, build.localRelease));
    const warning = ignoredExtrasWarning(packageId, values, info);
    if (warning) io.stderr(`warning: ${warning}\n`);
  }
  return EXIT.ok;
}

/**
 * After a launch timed out: name the system dialog that holds it, from `dumpsys window`'s focus lines. Horizon OS
 * shows these in front of a launching VR app: the "Turn on tracking" dialog when the headset has no 6DoF tracking
 * (too dark, or tracking off), and the boundary (Guardian) setup when it has lost its position.
 */
export function blockingDialogHint(
  dumpsys: string,
  packageId: string,
): string | null {
  const focus =
    /mCurrentFocus=Window\{[^}]*\s(\S+)\}/.exec(dumpsys)?.[1] ??
    /mFocusedApp=.*?\s(\S+\/\S+)/.exec(dumpsys)?.[1];
  if (!focus) return null;
  if (/6dof|Tracking/i.test(focus))
    return `the headset shows the "Turn on tracking" dialog (${focus}). It needs 6DoF tracking: turn tracking on, make the room brighter, and confirm the dialog on the headset; then run again.`;
  if (/guardian|boundary/i.test(focus))
    return `the headset shows the boundary (Guardian) setup (${focus}). Put the headset on and confirm or redraw the boundary; then run again.`;
  if (!focus.startsWith(`${packageId}/`))
    return `the headset's focused window is ${focus}, not ${packageId}: a system dialog may be holding the launch. Check the headset.`;
  return null;
}

/** The runtime's inspector port on the device (assets/iwn/config.json inspector.port default). */
export const INSPECTOR_DEVICE_PORT = 9229;

/**
 * The adb forward target of an app's inspector (CDP-1): on the headset the runtime listens on the abstract Unix
 * socket "<packageId>_devtools_<port>", which only adb, root and the app itself may connect to.
 */
export function inspectorSocket(packageId: string, devicePort: number): string {
  return `localabstract:${packageId}_devtools_${devicePort}`;
}

async function adb(
  io: CliIo,
  values: CommandContext['values'],
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; output: string; timedOut?: boolean }> {
  const location = locateAdb(io.env, io.isExecutable);
  let prefix: string[];
  try {
    prefix = splitShellWords(io.env.IWER_NATIVE_ADB_ARGS ?? '');
  } catch (error) {
    io.stderr(`iwer-native: ${(error as Error).message}\n`);
    return { code: EXIT.failure, output: '' };
  }
  const full = [
    ...prefix,
    ...(values.serial ? ['-s', values.serial] : []),
    ...args,
  ];
  if (values['dry-run']) {
    io.stdout(`${[location.command, ...full].map(quote).join(' ')}\n`);
    return { code: EXIT.ok, output: '' };
  }
  const result = await io.exec(location.command, full, { timeoutMs });
  if (result.stdout) io.stdout(result.stdout);
  if (result.stderr) io.stderr(result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.error === 'not-found') {
    io.stderr(
      'iwer-native: adb not found. Run "iwer-native doctor" for setup help.\n',
    );
    return { code: EXIT.failure, output };
  }
  if (result.error === 'timeout') {
    io.stderr(`iwer-native: adb did not finish within ${timeoutMs / 1000} s\n`);
    return { code: EXIT.failure, output, timedOut: true };
  }
  return { code: result.code === 0 ? EXIT.ok : EXIT.failure, output };
}

/**
 * Split an argument string the way a POSIX shell would for words: whitespace
 * separates, single quotes are literal, double quotes allow \\ escapes, and a
 * backslash outside quotes escapes the next character. No expansions.
 */
export function splitShellWords(text: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) throw new Error('IWER_NATIVE_ADB_ARGS: unterminated quote');
      word += text.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && /["\\$`]/.test(text[i + 1] ?? '')) i++;
        word += text[i++];
      }
      if (i >= text.length)
        throw new Error('IWER_NATIVE_ADB_ARGS: unterminated quote');
      inWord = true;
    } else if (c === '\\' && i + 1 < text.length) {
      word += text[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

function load(
  io: CliIo,
  projectRoot: string,
  json = false,
  options: LoadNativeProjectOptions = {},
): LoadedNativeProject | null {
  try {
    return loadNativeProject(projectRoot, options);
  } catch (error) {
    if (error instanceof NativeConfigError) {
      if (json)
        io.stdout(
          `${JSON.stringify({ ok: false, error: error.message.split('\n')[0], issues: error.issues }, null, 2)}\n`,
        );
      else io.stderr(`${error.message}\n`);
      return null;
    }
    throw error;
  }
}

function printWarnings(io: CliIo, loaded: LoadedNativeProject): void {
  for (const w of loaded.warnings)
    io.stderr(`warning: ${w.path}: ${w.message}\n`);
}

function usage(io: CliIo, message: string): number {
  io.stderr(`iwer-native: ${message}\n`);
  return EXIT.usage;
}

function safeFileName(name: string): string {
  return (
    name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'app'
  );
}

function quote(arg: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(arg)
    ? arg
    : `'${arg.replace(/'/g, `'\\''`)}'`;
}
