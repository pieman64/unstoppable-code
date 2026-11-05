// Local memory consolidation shared by the desktop and Canopy Cloud (design:
// docs/planning/2026-10-27-cloud-memory-sync/README.md §3, §10.5, §12). Every
// module is environment-neutral: hosts supply storage, the model and the
// clock through `runMemoryConsolidation`'s ports.
//
// Desktop main imports the subpaths, so modules on its startup path never
// load the Markdown parser in `topic-reference`.
export * from './boundary-truncation';
export * from './chat-history-profile';
export * from './input';
export * from './input-budget';
export * from './limits';
export * from './memory-index';
export * from './output';
export * from './prompt';
export * from './pruning';
export * from './recall';
export * from './redaction';
export * from './run';
export * from './text';
export * from './topic-identity';
export * from './topic-reference';
export * from './version';
