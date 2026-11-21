/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { Env } from './core.ts';
import { domError, unsignedLong } from './util.ts';

export const ENV = Symbol('iwn.audio.env');

export interface AudioBufferOptions {
  numberOfChannels?: number;
  length: number;
  sampleRate: number;
}

type NativeBuffer = [number, number, number, number, ...Float32Array[]];

let adopting: NativeBuffer | null = null;

const bufferRegistry = new FinalizationRegistry<{ env: Env; id: number }>((held) => {
  held.env.natives.releaseBuffer(held.id);
});

/**
 * AudioBuffer (AUD-7). Channel data lives in native memory shared with the render thread;
 * getChannelData() returns the same Float32Array every call. Install binds a subclass to its
 * environment (`[ENV]`), which is the class apps see as `AudioBuffer`.
 */
export class AudioBuffer {
  #id: number;
  #channels: Float32Array[];
  #sampleRate: number;
  #length: number;

  constructor(options: AudioBufferOptions) {
    const env = (new.target as unknown as { [ENV]?: Env })[ENV];
    if (!env) throw new TypeError('Illegal constructor');
    const adopt = adopting;
    adopting = null;
    if (adopt) {
      this.#id = adopt[0];
      this.#length = adopt[2];
      this.#sampleRate = adopt[3];
      this.#channels = adopt.slice(4) as Float32Array[];
    } else {
      if (options === null || typeof options !== 'object') {
        throw new TypeError("AudioBuffer: options with 'length' and 'sampleRate' are required");
      }
      const channels = options.numberOfChannels === undefined ? 1 : unsignedLong(options.numberOfChannels, 'numberOfChannels');
      const length = unsignedLong(options.length, 'length');
      const sampleRate = Number(options.sampleRate);
      if (channels < 1 || channels > 32) throw domError('NotSupportedError', `numberOfChannels ${channels} is outside [1, 32]`);
      if (length < 1) throw domError('NotSupportedError', 'length must be at least 1');
      // Same ceiling as decodeAudioData and OfflineAudioContext (1 GiB of samples): a larger buffer would be
      // a low-memory kill on the headset rather than an exception.
      if (length * channels * 4 > 2 ** 30) throw domError('NotSupportedError', `AudioBuffer of ${channels} x ${length} frames exceeds the 1 GiB limit`);
      if (!(sampleRate >= 3000 && sampleRate <= 768000)) {
        throw domError('NotSupportedError', `sampleRate ${options.sampleRate} is outside [3000, 768000]`);
      }
      const created = env.natives.createBuffer(channels, length, sampleRate);
      this.#id = created[0];
      this.#channels = created.slice(1) as Float32Array[];
      this.#length = length;
      this.#sampleRate = sampleRate;
    }
    bufferRegistry.register(this, { env, id: this.#id });
  }

  /** Wraps native storage (decode / offline render results) without copying. */
  static adopt<T>(cls: new (o: AudioBufferOptions) => T, native: NativeBuffer): T {
    adopting = native;
    try {
      return new cls({ length: native[2], sampleRate: native[3] });
    } finally {
      adopting = null;
    }
  }

  /** Native buffer id (for SetBuffer). */
  static idOf(b: AudioBuffer): number {
    return b.#id;
  }

  get sampleRate(): number {
    return this.#sampleRate;
  }
  get length(): number {
    return this.#length;
  }
  get duration(): number {
    return this.#length / this.#sampleRate;
  }
  get numberOfChannels(): number {
    return this.#channels.length;
  }

  getChannelData(channel: number): Float32Array {
    const c = unsignedLong(channel, 'channel');
    if (c >= this.#channels.length) throw domError('IndexSizeError', `channel ${channel} out of range`);
    return this.#channels[c];
  }

  copyFromChannel(destination: Float32Array, channelNumber: number, bufferOffset = 0): void {
    if (!(destination instanceof Float32Array)) throw new TypeError('destination must be a Float32Array');
    const c = unsignedLong(channelNumber, 'channelNumber');
    if (c >= this.#channels.length) throw domError('IndexSizeError', `channel ${channelNumber} out of range`);
    const off = unsignedLong(bufferOffset, 'bufferOffset');
    const src = this.#channels[c];
    if (off >= src.length) return;
    const n = Math.min(destination.length, src.length - off);
    destination.set(src.subarray(off, off + n));
  }

  copyToChannel(source: Float32Array, channelNumber: number, bufferOffset = 0): void {
    if (!(source instanceof Float32Array)) throw new TypeError('source must be a Float32Array');
    const c = unsignedLong(channelNumber, 'channelNumber');
    if (c >= this.#channels.length) throw domError('IndexSizeError', `channel ${channelNumber} out of range`);
    const off = unsignedLong(bufferOffset, 'bufferOffset');
    const dst = this.#channels[c];
    if (off >= dst.length) return;
    const n = Math.min(source.length, dst.length - off);
    dst.set(source.subarray(0, n), off);
  }
}
