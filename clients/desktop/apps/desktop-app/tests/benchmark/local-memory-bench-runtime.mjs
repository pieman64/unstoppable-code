import { require as tsxRequire } from 'tsx/cjs/api';

const evaluator = tsxRequire(
  './local-memory-bench-evaluator.ts',
  import.meta.url,
);

export default evaluator;
