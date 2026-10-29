// Verified against tree-sitter-typescript 0.23.2 during the Phase 0 spike
// (docs/planning/2026-07-07-code-graph-asts/spike-results.md).
export const CANOPY_TS_SUPPLEMENTAL_QUERY = `
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
`;
