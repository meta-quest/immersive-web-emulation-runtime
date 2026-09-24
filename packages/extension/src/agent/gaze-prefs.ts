/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { GazeCommitHand, GazeMode } from './prefs.js';

interface GazePreferenceTarget {
  devui?: {
    setGazeMode?(mode: GazeMode): void;
    setGazeCommitHand?(handedness: GazeCommitHand): void;
  };
}

export function applyGazePreferences(
  target: GazePreferenceTarget,
  mode: GazeMode,
  commitHand: GazeCommitHand,
): void {
  target.devui?.setGazeCommitHand?.(commitHand);
  target.devui?.setGazeMode?.(mode);
}
