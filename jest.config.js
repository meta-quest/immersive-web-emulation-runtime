/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'], // Remove .js since it's inferred from package.json
  setupFiles: ['<rootDir>/tests/polyfill.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.(ts|js)$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          allowJs: true,
        },
      },
    ],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(webxr-layers-polyfill|gl-matrix)/)',
  ],
  testEnvironment: 'jsdom',
};
