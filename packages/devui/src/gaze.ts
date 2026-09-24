/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { create } from 'zustand';

export type GazeMode = 'off' | 'cursor' | 'head-locked';
export type GazeCommitHand = 'left' | 'right';

interface GazeSettingsStore {
  mode: GazeMode;
  commitHand: GazeCommitHand;
  setMode: (mode: GazeMode) => void;
  setCommitHand: (handedness: GazeCommitHand) => void;
}

export const useGazeSettingsStore = create<GazeSettingsStore>((set) => ({
  mode: 'off',
  commitHand: 'right',
  setMode: (mode) => set({ mode }),
  setCommitHand: (commitHand) => set({ commitHand }),
}));

export interface CanvasRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Convert a canvas cursor position into a normalized viewer-local WebXR ray.
 * In stereo, each half of the canvas is treated as its own eye viewport so the
 * same relative point in either eye produces the same cyclopean direction.
 */
export function cursorToViewerDirection(
  clientX: number,
  clientY: number,
  rect: CanvasRect,
  stereoEnabled: boolean,
  verticalFovRadians: number,
): [number, number, number] {
  if (rect.width <= 0 || rect.height <= 0) {
    return [0, 0, -1];
  }

  const viewportWidth = stereoEnabled ? rect.width / 2 : rect.width;
  const localX = clientX - rect.left;
  const viewportX =
    stereoEnabled && localX >= viewportWidth ? localX - viewportWidth : localX;
  const ndcX = (viewportX / viewportWidth) * 2 - 1;
  const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
  const tanHalfFov = Math.tan(verticalFovRadians / 2);
  const aspect = viewportWidth / rect.height;

  const x = ndcX * aspect * tanHalfFov;
  const y = ndcY * tanHalfFov;
  const z = -1;
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}
