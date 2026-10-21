/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Easing, ease } from './hand-motion.js';

/**
 * What a channel animates on its device: where it is (`transform`), a hand's
 * pose (`pose`) or its select value (`pinch`).
 */
export type ChannelKind = 'transform' | 'pose' | 'pinch';

/**
 * One aspect of one device animated over time. Remote control's timed
 * commands each run one channel; several channels of a device can run
 * together (run_sequence, tests).
 */
export interface Channel {
  device: string;
  kind: ChannelKind;
  /** Milliseconds from the start of the run to the start of this channel. */
  delayMs?: number;
  durationMs: number;
  easing: Easing;
  /** Called when the channel starts: captures where it animates from. */
  begin?: () => void;
  /** Applies eased progress, from 0 to 1 (exactly 1 on its last frame). */
  apply: (progress: number) => void;
}

interface ChannelState {
  channel: Channel;
  begun: boolean;
  done: boolean;
}

const channelKey = (channel: Channel) => `${channel.device}:${channel.kind}`;

/**
 * Channels started together. A run advances only on the time it is given
 * (remote control's queue time), so a frame's leftover time can carry into
 * whatever runs next.
 */
export class ChannelRun {
  private states: ChannelState[];
  private elapsed = 0;
  /** When the last channel ends, in milliseconds from the start of the run. */
  readonly endMs: number;

  constructor(
    private engine: ChannelEngine,
    channels: Channel[],
  ) {
    this.states = channels.map((channel) => ({
      channel,
      begun: false,
      done: false,
    }));
    this.endMs = Math.max(
      0,
      ...channels.map((c) => (c.delayMs ?? 0) + c.durationMs),
    );
  }

  /** Milliseconds this run has advanced. */
  get elapsedMs(): number {
    return this.elapsed;
  }

  /** True once every channel has finished or been stopped. */
  get done(): boolean {
    return this.states.every((state) => state.done);
  }

  /**
   * Advances every channel by `deltaMs`. Returns the time left over once all
   * of them have finished (for whatever runs next), or -1 while any is still
   * running. A channel replaced by a later run stops where it is.
   */
  advance(deltaMs: number): number {
    this.elapsed += deltaMs;
    for (const state of this.states) {
      if (state.done) continue;
      const { channel } = state;
      if (!this.engine.owns(this, channel)) {
        state.done = true;
        continue;
      }
      const startMs = channel.delayMs ?? 0;
      if (this.elapsed < startMs) continue;
      if (!state.begun) {
        state.begun = true;
        channel.begin?.();
      }
      const t =
        channel.durationMs > 0
          ? (this.elapsed - startMs) / channel.durationMs
          : 1;
      channel.apply(t >= 1 ? 1 : ease(channel.easing, t));
      if (t >= 1) {
        state.done = true;
        this.engine.release(this, channel);
      }
    }
    return this.done ? Math.max(0, this.elapsed - this.endMs) : -1;
  }

  /** Stops every channel of this run where it is. */
  stop(): void {
    for (const state of this.states) {
      if (!state.done) {
        state.done = true;
        this.engine.release(this, state.channel);
      }
    }
  }
}

/**
 * Keeps track of which run owns each device's channels: one channel of each
 * kind per device. Starting a channel replaces the one of the same kind on
 * the same device, which stops where it is.
 */
export class ChannelEngine {
  private owners = new Map<string, ChannelRun>();

  /** Starts `channels` together; nothing moves until the run advances. */
  run(channels: Channel[]): ChannelRun {
    const run = new ChannelRun(this, channels);
    for (const channel of channels) {
      this.owners.set(channelKey(channel), run);
    }
    return run;
  }

  /** True while any channel (of `device`, when given) is running. */
  isActive(device?: string): boolean {
    if (device === undefined) {
      return this.owners.size > 0;
    }
    for (const key of this.owners.keys()) {
      if (key.startsWith(`${device}:`)) return true;
    }
    return false;
  }

  /** Stops every channel, or every channel of `device`, where it is. */
  stop(device?: string): void {
    for (const key of [...this.owners.keys()]) {
      if (device === undefined || key.startsWith(`${device}:`)) {
        // Its run notices on its next advance that it no longer owns it.
        this.owners.delete(key);
      }
    }
  }

  /** @internal Whether `run` still owns `channel`'s slot. */
  owns(run: ChannelRun, channel: Channel): boolean {
    return this.owners.get(channelKey(channel)) === run;
  }

  /** @internal Frees `channel`'s slot if `run` still owns it. */
  release(run: ChannelRun, channel: Channel): void {
    if (this.owns(run, channel)) {
      this.owners.delete(channelKey(channel));
    }
  }
}
