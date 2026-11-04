/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as hostEntry from '../../src/host';
import * as fullEntry from '../../src/index';
import { XRDeviceBase } from '../../src/device/XRDeviceBase';

const SRC = path.resolve(__dirname, '../../src');

/**
 * Modules reachable from `entry` through value imports and re-exports
 * (`import type` / `export type` are erased by TypeScript and skipped).
 */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  const pattern =
    /^\s*(import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      const spec = match[2];
      if (!spec.startsWith('.')) {
        seen.add(spec);
        continue;
      }
      const resolved = path
        .resolve(path.dirname(file), spec)
        .replace(/\.js$/, '.ts');
      queue.push(resolved);
    }
  }
  return seen;
}

const rel = (files: Set<string>) =>
  [...files].map((f) => (f.startsWith(SRC) ? path.relative(SRC, f) : f));

describe('iwer/host entry', () => {
  test('leaves out remote control, action recording/playback, the native override and the layers polyfill', () => {
    const modules = rel(reachable(path.join(SRC, 'host.ts')));
    expect(modules).toContain('host/XRHostSession.ts');
    expect(modules).toContain('device/XRDeviceBase.ts');
    expect(modules).not.toContain('device/XRDevice.ts');
    expect(modules.filter((m) => m.startsWith('remote/'))).toEqual([]);
    expect(modules.filter((m) => m.startsWith('action/'))).toEqual([]);
    expect(modules.filter((m) => m.startsWith('native/'))).toEqual([]);
    expect(modules).not.toContain('webxr-layers-polyfill');
  });

  test('the full entry still reaches all of them', () => {
    const modules = rel(reachable(path.join(SRC, 'index.ts')));
    expect(modules).toContain('remote/RemoteControlInterface.ts');
    expect(modules).toContain('action/ActionPlayer.ts');
    expect(modules).toContain('native/XRNativeOverride.ts');
    expect(modules).toContain('webxr-layers-polyfill');
  });

  test('exports the WebXR classes and host contract the full entry has', () => {
    expect(hostEntry.XRDevice).toBe(XRDeviceBase);
    for (const name of [
      'XRSystem',
      'XRSession',
      'XRFrame',
      'XRReferenceSpace',
      'XRBoundedReferenceSpace',
      'XRRigidTransform',
      'XRWebGLLayer',
      'XRProjectionLayer',
      'XRHostWebGLBinding',
      'XRHostInput',
      'NativePlane',
      'NativeMesh',
      'metaQuest3',
      'P_SESSION',
    ] as const) {
      expect(hostEntry[name]).toBe(fullEntry[name]);
    }
    expect('RemoteControlInterface' in hostEntry).toBe(false);
    expect('ActionPlayer' in hostEntry).toBe(false);
    expect('installNativeOverride' in hostEntry).toBe(false);
  });

  test('a host-entry device has no remote, no action player and no layers polyfill', () => {
    const device = new hostEntry.XRDevice(hostEntry.metaQuest3, {
      host: { beginSwapchain: () => null, endSession: () => {} },
    });
    expect(device.remote).toBeNull();
    expect(() =>
      device.createActionPlayer(device.viewerSpace, {} as never),
    ).toThrow(expect.objectContaining({ name: 'NotSupportedError' }));

    const emulated = new hostEntry.XRDevice(hostEntry.metaQuest3);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const globals: Record<string, unknown> = {};
    emulated.installRuntime({
      globalObject: globals,
      polyfillLayers: true,
      forceInstall: true,
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    emulated.uninstallRuntime();
  });

  test('the full XRDevice still builds its remote control interface', () => {
    const device = new fullEntry.XRDevice(fullEntry.metaQuest3);
    expect(device.remote).toBeInstanceOf(fullEntry.RemoteControlInterface);
    expect(device).toBeInstanceOf(XRDeviceBase);
  });
});
