export type LifecycleRole =
  | 'turn start'
  | 'turn end'
  | 'session state'
  | 'background set'
  | 'child'
  | 'informational'
  | 'ignored';
