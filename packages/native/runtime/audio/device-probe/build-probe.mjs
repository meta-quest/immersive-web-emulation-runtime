#!/usr/bin/env node
// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Builds the audio device probe APK with the runtime template's scripted APK builder:
//   node build-probe.mjs --libs <runtime android build>/apk-libs.txt --out /tmp/iwn-audio-probe.apk [--long 600] [--route-test 40]
//     [--lifecycle relaunch|reloadbusy]
// Preludes: web/glue/dist/glue.min.js then web/audio/dist/audio.min.js (build both first).
// The decode fixtures are embedded as base64 (no dependency on fetch).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, '../../..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
if (!args.libs || !args.out) {
  console.error('usage: build-probe.mjs --libs <apk-libs.txt> --out <apk>');
  process.exit(2);
}
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'iwn-audio-probe-'));
fs.cpSync(path.join(here, 'app'), stage, { recursive: true });
const fixturesDir = path.resolve(here, '../test/fixtures');
const names = fs.readdirSync(fixturesDir).filter((f) => /\.(mp3|ogg|wav|m4a|flac)$/.test(f)).sort();
const entries = names.map((n) => `  ${JSON.stringify(n)}: ${JSON.stringify(fs.readFileSync(path.join(fixturesDir, n)).toString('base64'))},`);
fs.writeFileSync(path.join(stage, 'fixtures.js'), `export const FIXTURES = {\n${entries.join('\n')}\n};\n`);
// --long <seconds>: adds the AUD-10 long run (e.g. 600 for the spec's 10 minutes).
// --route-test <seconds>: only the AUD-12 check (restart audioserver meanwhile).
// --lifecycle relaunch|reloadbusy: only the PROC-7 / PROC-8 lifecycle loop (see app/main.js).
fs.writeFileSync(path.join(stage, 'config.js'),
  `export const LONG_RUN_SECONDS = ${Number(args.long || 0)};\nexport const ROUTE_TEST_SECONDS = ${Number(args['route-test'] || 0)};\n` +
  `export const LIFECYCLE_MODE = ${JSON.stringify(args.lifecycle || '')};\n`);
// The probe exercises Web Audio beyond the alpha's basic set (oscillators, filters, convolver, analyser,
// OfflineAudioContext): opt in through the runtime config (handed to the prelude as __iwn.config).
const runtimeConfig = path.join(stage, '..', `${path.basename(stage)}-config.json`);
fs.writeFileSync(runtimeConfig, JSON.stringify({ glue: { audio: { experimental: true } } }));
execFileSync(process.execPath, [
  path.join(pkg, 'runtime/app/template/build-apk.mjs'),
  '--libs', args.libs, '--out', args.out, '--dist', stage,
  '--prelude', path.join(pkg, 'web/glue/dist/glue.min.js'),
  '--prelude', path.join(pkg, 'web/audio/dist/audio.min.js'),
  '--config', runtimeConfig,
  '--package', args.package || 'com.iwernative.audioprobe', '--label', 'iwer-native audio probe',
], { stdio: 'inherit' });
console.log(args.out);
