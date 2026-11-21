// Copyright (c) Meta Platforms, Inc. and affiliates.
// SPDX-License-Identifier: MIT
//
// Builds the host Node addon (runtime/audio, IWN_AUDIO_NODE_ADDON=ON) that native.test.ts loads.
// Output: $IWN_AUDIO_BUILD_DIR or <tmpdir>/iwn-audio-host/iwn_audio_node.node. Needs cmake + ninja.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../../runtime/audio');
const build = process.env.IWN_AUDIO_BUILD_DIR ?? path.join(tmpdir(), 'iwn-audio-host');
const nodeInclude = path.resolve(path.dirname(realpathSync(process.execPath)), '../include/node');

execFileSync('cmake', ['-S', src, '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=RelWithDebInfo',
  '-DIWN_AUDIO_NODE_ADDON=ON', `-DNODE_INCLUDE_DIR=${nodeInclude}`, '-DIWN_V8_DIR=/nonexistent'], { stdio: 'inherit' });
execFileSync('ninja', ['-C', build, '-j', '16', 'iwn_audio_node', 'iwn_audio_tests'], { stdio: 'inherit' });
console.log(path.join(build, 'iwn_audio_node.node'));
