export function encodePng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Buffer;
export function decodePng(buf: Uint8Array): { width: number; height: number; data: Uint8Array };
export function comparePixels(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  width: number,
  height: number,
  threshold?: number,
): { fraction: number; bad: number; maxDiff: number };
export function diffImage(a: ArrayLike<number>, b: ArrayLike<number>, width: number, height: number, threshold?: number): Uint8Array;
