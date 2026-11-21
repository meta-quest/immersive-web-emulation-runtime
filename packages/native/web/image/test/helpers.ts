/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Test helpers: a minimal PNG encoder (RGBA8, filter 0) and an installed image global over fake natives.
import { deflateSync } from 'node:zlib';
import { createFakeImageNatives, type FakeImageNatives } from '../fake-natives.ts';
import { installImage, type ImageRegistry, type InstallImageOptions } from '../install.ts';

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const chunk = (type: string, body: Uint8Array) => {
    const out = new Uint8Array(12 + body.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, body.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(body, 8);
    dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** IMG-6's check image: 4x4 grey, corners red / green / blue / yellow at alpha 128. */
export function corners(): Uint8Array {
  const d = new Uint8Array(64);
  for (let i = 0; i < 16; i++) d.set([60, 60, 60, 255], i * 4);
  d.set([255, 0, 0, 128], 0);
  d.set([0, 255, 0, 128], 3 * 4);
  d.set([0, 0, 255, 128], 12 * 4);
  d.set([255, 255, 0, 128], 15 * 4);
  return d;
}

export function px(data: ArrayLike<number>, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
}

export function dataURL(bytes: Uint8Array, type = 'image/png'): string {
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
}

export interface TestGlobal {
  g: any;
  natives: FakeImageNatives;
  registry: ImageRegistry;
}

/** A fresh global (inherits Node's EventTarget, Event, DOMException, Blob, URL) with the image globals installed. */
export function makeGlobal(options: InstallImageOptions = {}): TestGlobal {
  const natives = createFakeImageNatives();
  const g: any = Object.create(globalThis);
  const registry = installImage(g as typeof globalThis, {
    natives,
    worker: false,
    baseURL: () => 'https://app.local/',
    ...options,
  });
  return { g, natives, registry };
}

export function nextTask(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

export function waitFor(target: EventTarget, type: string): Promise<Event> {
  return new Promise((resolve) => target.addEventListener(type, resolve, { once: true }));
}
