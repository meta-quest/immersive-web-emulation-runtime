/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { Channel, ChannelEngine } from '../../src/remote/channels.js';
import { ease } from '../../src/remote/hand-motion.js';

const last = (values: number[]) => values[values.length - 1];

const recorder = (
  device: string,
  kind: Channel['kind'],
  durationMs: number,
  extra: Partial<Channel> = {},
) => {
  const values: number[] = [];
  let begun = 0;
  const channel: Channel = {
    device,
    kind,
    durationMs,
    easing: 'linear',
    begin: () => {
      begun++;
    },
    apply: (progress) => values.push(progress),
    ...extra,
  };
  return { channel, values, begun: () => begun };
};

describe('ChannelEngine', () => {
  test('a run applies eased progress, ends on exactly 1 and returns the time left over', () => {
    const engine = new ChannelEngine();
    const { channel, values, begun } = recorder('hand-right', 'pinch', 100, {
      easing: 'minimum-jerk',
    });
    const run = engine.run([channel]);
    expect(begun()).toBe(0);
    expect(run.advance(25)).toBe(-1);
    expect(begun()).toBe(1);
    expect(values[0]).toBeCloseTo(ease('minimum-jerk', 0.25), 10);
    expect(engine.isActive()).toBe(true);
    expect(engine.isActive('hand-right')).toBe(true);
    expect(engine.isActive('hand-left')).toBe(false);
    expect(run.advance(105)).toBe(30);
    expect(last(values)).toBe(1);
    expect(begun()).toBe(1);
    expect(run.done).toBe(true);
    expect(run.elapsedMs).toBe(130);
    expect(engine.isActive()).toBe(false);
  });

  test('channels of one run advance together; the run ends with the last', () => {
    const engine = new ChannelEngine();
    const move = recorder('hand-right', 'transform', 100);
    const pose = recorder('hand-right', 'pose', 50);
    const pinch = recorder('hand-right', 'pinch', 40, { delayMs: 60 });
    const run = engine.run([move.channel, pose.channel, pinch.channel]);
    expect(run.endMs).toBe(100);
    expect(run.advance(50)).toBe(-1);
    expect(move.values).toEqual([0.5]);
    expect(pose.values).toEqual([1]);
    // The delayed channel has not started yet.
    expect(pinch.begun()).toBe(0);
    expect(run.advance(30)).toBe(-1);
    expect(pinch.begun()).toBe(1);
    expect(pinch.values[0]).toBeCloseTo(0.5, 10);
    expect(run.advance(30)).toBe(10);
    expect(last(move.values)).toBe(1);
    expect(last(pinch.values)).toBe(1);
  });

  test('a zero-length channel applies 1 on its first advance', () => {
    const engine = new ChannelEngine();
    const { channel, values } = recorder('controller-right', 'pinch', 0);
    expect(engine.run([channel]).advance(16)).toBe(16);
    expect(values).toEqual([1]);
  });

  test('a new channel of the same kind on the same device replaces the old one where it is', () => {
    const engine = new ChannelEngine();
    const first = recorder('hand-right', 'pose', 100);
    const other = recorder('hand-left', 'pose', 100);
    const firstRun = engine.run([first.channel, other.channel]);
    firstRun.advance(40);
    const second = recorder('hand-right', 'pose', 100);
    const secondRun = engine.run([second.channel]);
    firstRun.advance(20);
    // Replaced: no more writes from the first right-hand channel.
    expect(first.values).toEqual([0.4]);
    expect(other.values).toEqual([0.4, 0.6]);
    secondRun.advance(100);
    expect(second.values).toEqual([1]);
    // The replaced channel no longer holds the device.
    firstRun.advance(40);
    expect(last(other.values)).toBe(1);
    expect(engine.isActive()).toBe(false);
  });

  test('stop() lets go of every channel, or of one device, where it is', () => {
    const engine = new ChannelEngine();
    const right = recorder('hand-right', 'transform', 100);
    const left = recorder('hand-left', 'transform', 100);
    const run = engine.run([right.channel, left.channel]);
    run.advance(10);
    engine.stop('hand-right');
    expect(engine.isActive('hand-right')).toBe(false);
    expect(engine.isActive('hand-left')).toBe(true);
    run.advance(10);
    expect(right.values).toEqual([0.1]);
    expect(left.values).toEqual([0.1, 0.2]);
    engine.stop();
    expect(engine.isActive()).toBe(false);
    // A run whose channels were all stopped finishes on its next advance.
    expect(run.advance(10)).toBe(0);
    expect(left.values).toEqual([0.1, 0.2]);
  });

  test('a stopped run frees its channels', () => {
    const engine = new ChannelEngine();
    const { channel } = recorder('hand-right', 'pinch', 100);
    const run = engine.run([channel]);
    run.advance(10);
    run.stop();
    expect(run.done).toBe(true);
    expect(engine.isActive()).toBe(false);
  });

  test('a channel stopped before it finishes is cancelled once, whatever stops it; a finished one never is', () => {
    const engine = new ChannelEngine();
    const cancels: string[] = [];
    const make = (name: string, device: string, kind: Channel['kind']) =>
      recorder(device, kind, 100, { cancel: () => cancels.push(name) }).channel;

    // Finishing does not cancel.
    const done = engine.run([make('done', 'hand-right', 'thumb')]);
    done.advance(150);
    done.stop();
    engine.stop();
    expect(cancels).toEqual([]);

    // run.stop(), begun or not (a delayed channel).
    const stopped = engine.run([
      make('begun', 'hand-right', 'thumb'),
      { ...make('waiting', 'hand-right', 'pose'), delayMs: 50 },
    ]);
    stopped.advance(10);
    stopped.stop();
    stopped.stop();
    expect(cancels).toEqual(['begun', 'waiting']);

    // engine.stop(), for one device.
    cancels.length = 0;
    const both = engine.run([
      make('right', 'hand-right', 'thumb'),
      make('left', 'hand-left', 'thumb'),
    ]);
    both.advance(10);
    engine.stop('hand-right');
    both.advance(10);
    expect(cancels).toEqual(['right']);

    // A later run taking the slot; the earlier run then stopping changes
    // nothing for it.
    const later = engine.run([make('later', 'hand-left', 'thumb')]);
    expect(cancels).toEqual(['right', 'left']);
    both.stop();
    expect(cancels).toEqual(['right', 'left']);
    later.advance(100);
    expect(cancels).toEqual(['right', 'left']);
  });
});
