declare const __IS_UMD__: boolean;

declare module '*.json' {
  const value: unknown;
  export default value;
}
