#!/usr/bin/env node
// Scripted, offline APK build for the runtime template (and test apps such as hello-js), used on build machines
// where the Android SDK exists. No Gradle: aapt2 link (manifest only, hasCode=false), zip (stored entries for
// .so and already-compressed/mappable assets, PKG-4), zipalign -P 16 (PKG-3) and apksigner (v2/v3) with a
// debug key made by openssl. The M5 Node packer replaces this for app developers (no SDK on their machine).
//
//   node build-apk.mjs --libs <build>/apk-libs.txt --out out.apk
//        [--dist <vite dist dir>] [--prelude file.js]... [--config extra.json]
//        [--package com.iwernative.template] [--label "iwer-native"] [--version-code 1] [--version-name 0.1.0]
//        [--inspector-port 9229] [--debug-port 0] [--release] [--no-strip] [--toolchain <dir>]
//
// Asset layout (the runtime's contract, runtime/README.md): assets/iwn/config.json, assets/iwn/v8/snapshot_blob.bin,
// assets/iwn/prelude/*.js, assets/app/** (the dist, verbatim: '_' and '.' names kept, REG-3).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { prelude: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === 'release' || key === 'no-strip') {
      out[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${a} needs a value`);
    if (key === 'prelude') out.prelude.push(value);
    else out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.libs || !args.out) {
  console.error('usage: build-apk.mjs --libs <apk-libs.txt> --out <apk> [options]');
  process.exit(2);
}

const toolchain = args.toolchain || process.env.IWN_TOOLCHAIN_DIR;
if (!toolchain) throw new Error('pass --toolchain <dir> or set IWN_TOOLCHAIN_DIR (android/ SDK + NDK, v8-15.5/)');
const sdk = path.join(toolchain, 'android');
const buildTools = path.join(sdk, 'build-tools', args['build-tools'] || '35.0.0');
const androidJar = path.join(sdk, 'platforms', 'android-34', 'android.jar');
const ndk = path.join(sdk, 'ndk', '30.0.16248370');
const llvmStrip = path.join(ndk, 'toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip');
const v8Dir = path.join(toolchain, 'v8-15.5');
for (const p of [buildTools, androidJar, path.join(v8Dir, 'snapshot_blob.bin')]) {
  if (!fs.existsSync(p)) throw new Error(`missing ${p}`);
}

function findJava() {
  if (process.env.JAVA_HOME && fs.existsSync(path.join(process.env.JAVA_HOME, 'bin/java'))) {
    return path.join(process.env.JAVA_HOME, 'bin/java');
  }
  if (process.env.IWN_JAVA && fs.existsSync(process.env.IWN_JAVA)) return process.env.IWN_JAVA;
  return 'java';
}

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
}

const pkg = args.package || 'com.iwernative.template';
const label = args.label || 'iwer-native';
const versionCode = Number(args['version-code'] || 1);
const versionName = args['version-name'] || '0.1.0';
const debug = !args.release;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'iwn-apk-'));
const stage = path.join(work, 'stage');
fs.mkdirSync(path.join(stage, 'lib/arm64-v8a'), { recursive: true });
fs.mkdirSync(path.join(stage, 'assets/iwn/v8'), { recursive: true });

// Native libraries (stripped copies; keep the unstripped ones in the build dir for symbolisation).
const libs = fs
  .readFileSync(args.libs, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);
for (const lib of libs) {
  if (!fs.existsSync(lib)) throw new Error(`library listed in ${args.libs} not found: ${lib}`);
  const dst = path.join(stage, 'lib/arm64-v8a', path.basename(lib));
  if (args['no-strip']) fs.copyFileSync(lib, dst);
  else run(llvmStrip, ['--strip-unneeded', '-o', dst, lib]);
}

fs.copyFileSync(path.join(v8Dir, 'snapshot_blob.bin'), path.join(stage, 'assets/iwn/v8/snapshot_blob.bin'));

// Runtime config.
const config = {
  origin: 'https://app.local',
  appRoot: 'app',
  index: 'index.html',
  preludes: [],
  inspector: { enabled: debug, port: Number(args['inspector-port'] || 9229), waitForDebugger: false },
  debug: { enabled: debug, port: Number(args['debug-port'] || 0) },
  codeCache: { enabled: true, maxBytes: 64 * 1024 * 1024, delayMs: 5000 },
  stats: { logIntervalMs: 0 },
  app: { packageId: pkg, versionName, versionCode },
};
if (args.prelude.length) {
  fs.mkdirSync(path.join(stage, 'assets/iwn/prelude'), { recursive: true });
  for (const p of args.prelude) {
    const name = path.basename(p);
    fs.copyFileSync(p, path.join(stage, 'assets/iwn/prelude', name));
    config.preludes.push(`iwn/prelude/${name}`);
  }
}
if (args.config) {
  const extra = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  for (const [k, v] of Object.entries(extra)) {
    config[k] = v && typeof v === 'object' && !Array.isArray(v) && config[k] && typeof config[k] === 'object' ? { ...config[k], ...v } : v;
  }
}
fs.writeFileSync(path.join(stage, 'assets/iwn/config.json'), JSON.stringify(config, null, 2) + '\n');

if (args.dist) {
  if (!fs.existsSync(path.join(args.dist, 'index.html'))) throw new Error(`${args.dist} has no index.html`);
  fs.cpSync(args.dist, path.join(stage, 'assets/app'), { recursive: true, dereference: true });
}

// Manifest.
const manifest = fs
  .readFileSync(path.join(here, 'AndroidManifest.xml'), 'utf8')
  .replaceAll('${PACKAGE}', pkg)
  .replaceAll('${LABEL}', label.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'));
const manifestPath = path.join(work, 'AndroidManifest.xml');
fs.writeFileSync(manifestPath, manifest);

const base = path.join(work, 'base.apk');
const linkArgs = ['link', '-o', base, '--manifest', manifestPath, '-I', androidJar, '--min-sdk-version', '29',
  '--target-sdk-version', '32', '--version-code', String(versionCode), '--version-name', versionName];
if (debug) linkArgs.push('--debug-mode');
run(path.join(buildTools, 'aapt2'), linkArgs);

// Stored (uncompressed) entries: native libs and binary/compressed types the runtime maps (PKG-3, PKG-4, NET-3).
const stored = ['.so', '.bin', '.glb', '.ktx2', '.basis', '.wasm', '.mp3', '.ogg', '.wav', '.png', '.jpg', '.jpeg',
  '.webp', '.hdr', '.exr', '.m4a', '.woff2'];
run('zip', ['-q', '-X', '-D', '-r', '-n', stored.join(':'), base, 'lib', 'assets'], { cwd: stage });

const aligned = path.join(work, 'aligned.apk');
run(path.join(buildTools, 'zipalign'), ['-f', '-P', '16', '4', base, aligned]);

// Debug signing key (not a secret: like Android's debug keystore). Made once with openssl.
const keyDir = args['key-dir'] || path.join(os.homedir(), '.cache/iwer-native/debug-key');
const keyPk8 = path.join(keyDir, 'debug.pk8');
const certPem = path.join(keyDir, 'debug.x509.pem');
if (!fs.existsSync(keyPk8) || !fs.existsSync(certPem)) {
  fs.mkdirSync(keyDir, { recursive: true });
  const keyPem = path.join(keyDir, 'debug.key.pem');
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPem, '-out', certPem, '-days', '10950',
    '-subj', '/CN=iwer-native debug/O=iwer-native/C=US']);
  run('openssl', ['pkcs8', '-topk8', '-inform', 'PEM', '-outform', 'DER', '-in', keyPem, '-out', keyPk8, '-nocrypt']);
}
const java = findJava();
const apksigner = path.join(buildTools, 'lib/apksigner.jar');
fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
run(java, ['-jar', apksigner, 'sign', '--key', keyPk8, '--cert', certPem, '--min-sdk-version', '29',
  '--v1-signing-enabled', 'false', '--v2-signing-enabled', 'true', '--v3-signing-enabled', 'true', '--out',
  path.resolve(args.out), aligned]);
run(path.join(buildTools, 'zipalign'), ['-c', '-P', '16', '4', path.resolve(args.out)]);
const verify = run(java, ['-jar', apksigner, 'verify', '--print-certs', '--min-sdk-version', '29', path.resolve(args.out)]);

const size = fs.statSync(args.out).size;
console.log(`built ${args.out} (${(size / 1048576).toFixed(1)} MB, package ${pkg}, ${debug ? 'debug' : 'release'})`);
console.log(`signer: ${verify.split('\n').find((l) => l.includes('certificate DN')) || 'ok'}`);
fs.rmSync(work, { recursive: true, force: true });
