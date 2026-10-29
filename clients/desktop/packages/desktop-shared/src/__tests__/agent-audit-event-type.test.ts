import {
  AGENT_AUDIT_EVENT_TYPES,
  parseAgentAuditEventType,
} from '../types/observability';

describe('parseAgentAuditEventType', () => {
  it('round-trips every declared audit event type to itself', () => {
    // Also guards the self-mapping invariant of AUDIT_EVENT_TYPE_VALUES: a
    // mistyped value there (e.g. `chat_summary: 'archive_summary'`) still
    // type-checks, but would surface here as a mismatched round trip.
    expect(AGENT_AUDIT_EVENT_TYPES.length).toBeGreaterThan(0);
    for (const eventType of AGENT_AUDIT_EVENT_TYPES) {
      expect(parseAgentAuditEventType(eventType)).toBe(eventType);
    }
  });

  it('exposes each event type exactly once', () => {
    expect(new Set(AGENT_AUDIT_EVENT_TYPES).size).toBe(
      AGENT_AUDIT_EVENT_TYPES.length,
    );
  });

  it('rejects inherited Object.prototype keys', () => {
    // The lookup is a Map specifically so these return null. A refactor back
    // to plain-object indexing (`AUDIT_EVENT_TYPE_VALUES[value]`) would
    // resolve them through the prototype chain and hand callers a function
    // where an event type is expected — this test is what makes that a
    // failure rather than a silent regression.
    for (const key of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      '__proto__',
    ]) {
      expect(parseAgentAuditEventType(key)).toBeNull();
    }
  });

  it('rejects unknown and empty values', () => {
    expect(parseAgentAuditEventType('')).toBeNull();
    expect(parseAgentAuditEventType('code_graph_build')).toBeNull();
    expect(parseAgentAuditEventType('WORKTREE_CHAT')).toBeNull();
    expect(parseAgentAuditEventType('worktree_chat ')).toBeNull();
  });
});
