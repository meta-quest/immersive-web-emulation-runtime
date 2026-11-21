/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * The native storage module as JS sees it: `globalThis.__iwn.storage`, installed by
 * `iwn_register_storage` (runtime/storage/binding/storage_binding.cc). Callbacks run as tasks on the
 * isolate's JS thread. test/fake-natives.ts implements the same contract over node:sqlite.
 */
export interface StorageNatives {
  /**
   * localStorage's current entries (key, value, key, value, ...): what the file held at launch plus every
   * mutation since, so a page context recreated in the same process (reload) sees its own writes.
   */
  kvOpen(): { entries: string[]; warning: string; persistent: boolean };
  kvSet(key: string, value: string): void;
  kvRemove(key: string): void;
  kvClear(): void;
  /** Starts a write of everything pending (never blocks). */
  kvFlush(): void;

  /** Opens `name` in an area ("idb" | "cache"); throws TypeError for unsafe names. */
  sqlOpen(area: SqlArea, name: string): number;
  /**
   * Runs the statements in order on the connection's worker thread. `atomic`: one transaction; if any
   * statement fails, everything is rolled back (the failing statement keeps its error, later ones report
   * "not executed: transaction rolled back").
   */
  sqlExec(
    handle: number,
    sql: string[],
    args: SqlValue[][],
    readOnly: boolean,
    cb: (results: SqlResult[]) => void,
    atomic?: boolean,
  ): void;
  sqlClose(handle: number, cb: (error: string | null) => void): void;
  sqlDelete(area: SqlArea, name: string, cb: (error: string | null) => void): void;

  estimate(): { usage: number; quota: number };
}

export type SqlArea = 'idb' | 'cache';
export type SqlValue = null | number | bigint | boolean | string | ArrayBuffer | ArrayBufferView;

export interface SqlResult {
  error?: string;
  insertId?: number;
  rowsAffected?: number;
  rows?: Array<Record<string, number | string | ArrayBuffer | null>>;
}
