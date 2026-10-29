import {
  parseSubagentReference,
  type SubagentReference,
} from '@canopy/agent-transcript';

/**
 * Splits a leading subagent reference from its blank-line-separated body.
 * Desktop bubble renderers use this helper too so both transcript surfaces
 * keep the same parsing and fallback behavior.
 */
export function splitSubagentReference(text: string): {
  readonly reference: SubagentReference | null;
  readonly body: string;
} {
  const parsed = parseSubagentReference(text);
  return parsed
    ? { reference: parsed.reference, body: parsed.body }
    : { reference: null, body: text };
}
