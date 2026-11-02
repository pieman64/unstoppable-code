// Shared Jest transform: TypeScript and JavaScript through @swc/jest.
// Configs use `transform`; Jest loads this same file as the transformer.
const { createTransformer: createSwcTransformer } = require('@swc/jest');

// SWC defines CommonJS exports as non-configurable getters, so
// jest.spyOn(namespace, 'name') throws "Cannot redefine property". jest-mock
// already spies on getter exports when they are configurable, as ts-jest's
// plain assignments were. Both SWC export helpers (`_export`, `_export_star`)
// emit `enumerable: true,` followed by `get:`; editing that line keeps source
// map line numbers intact. The self-check test fails if SWC changes the shape.
const EXPORT_GETTER = /enumerable: true,(\s+get:)/g;
// `import * as fs from 'node:fs'` copies a CommonJS module's values into a
// per-file namespace, so a spy installed on the real module afterwards is
// never seen. TypeScript's __importStar reads through getters instead; match
// it on the same line so source maps stay intact.
const WILDCARD_COPY = 'newObj[key] = obj[key];';
const WILDCARD_LIVE =
  'Object.defineProperty(newObj, key, { enumerable: true, configurable: true, get: ((k) => () => obj[k])(key) });';
const matchTsJestInterop = (result) => ({
  ...result,
  code: result.code
    .replace(EXPORT_GETTER, 'enumerable: true, configurable: true,$1')
    .replace(WILDCARD_COPY, WILDCARD_LIVE),
});

function createTransformer(options) {
  const swc = createSwcTransformer(options);
  return {
    ...swc,
    process: (...args) => matchTsJestInterop(swc.process(...args)),
    processAsync: async (...args) =>
      matchTsJestInterop(await swc.processAsync(...args)),
    getCacheKey: (...args) =>
      `${swc.getCacheKey(...args)}:configurable-exports-v2`,
  };
}

const swcOptions = (parser) => ({
  swcrc: false,
  jsc: {
    parser,
    target: 'es2022',
    transform: {
      react: { runtime: 'automatic' },
      // ts-jest emitted assignments for class fields; keep that behavior.
      useDefineForClassFields: false,
    },
  },
});

// Separate .ts and .tsx entries: with `tsx: true`, `<T>value` assertions and
// some generic arrow functions do not parse.
const transform = {
  '^.+\\.ts$': [__filename, swcOptions({ syntax: 'typescript', tsx: false })],
  '^.+\\.tsx$': [__filename, swcOptions({ syntax: 'typescript', tsx: true })],
  '^.+\\.jsx?$': [__filename, swcOptions({ syntax: 'ecmascript', jsx: true })],
};

module.exports = { createTransformer, transform };
