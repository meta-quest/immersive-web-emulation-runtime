/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Prelude entry (dist/audio.min.js): installs the Web Audio globals over globalThis.__iwn.audio.
// Runs after the web glue (EventTarget, Event, DOMException, performance) and before the app.

import type { AudioNatives } from './natives.ts';
import { installWebAudio } from './install.ts';

type Iwn = { audio?: AudioNatives; config?: { audio?: { experimental?: unknown } } };
const iwn = (globalThis as { __iwn?: Iwn }).__iwn;
const natives = iwn?.audio;
// Web Audio beyond the alpha's basic set stays off unless the runtime config opts in:
// assets/iwn/config.json "glue": {"audio": {"experimental": true}} (handed to JS as __iwn.config).
if (natives) installWebAudio(globalThis, natives, { experimental: iwn?.config?.audio?.experimental === true });
