/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.(ts|js)$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          // Tests pull in node + jest globals; relax unused checks for fixtures.
          types: ['jest', 'node'],
          noUnusedLocals: false,
          noUnusedParameters: false,
        },
      },
    ],
  },
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  // The compiled MCP SDK / ws ship ESM; let ts-jest transform our TS but pass
  // node_modules through untouched (they are already ESM/CJS-resolvable).
  transformIgnorePatterns: ['/node_modules/'],
  testTimeout: 30000,
};
