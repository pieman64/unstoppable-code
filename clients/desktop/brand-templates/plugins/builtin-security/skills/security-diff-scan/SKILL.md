---
name: security-diff-scan
description: Review a pull request, commit, branch diff, patch file, or working-tree change for high-confidence security vulnerabilities introduced or materially worsened by the diff.
---

# Security diff scan

Review security-relevant behavior introduced by a diff and report only validated, actionable vulnerabilities. This workflow is read-only unless the user separately asks for fixes.

This skill is self-contained. It does not require or use an MCP server, remote scanner, authentication flow, or persistent scan state. Use normal repository search, file reading, Git, and terminal tools available in the host.

## Required references

Read and apply these bundled references before reporting findings:

- `../../references/diff-scan-methodology.md`
- `../../references/finding-criteria.md`
- `../../references/severity.md`
- `../../references/output-contract.md`

## Workflow

1. Resolve the exact diff scope. Prefer a host-supplied diff file; otherwise derive the requested PR, commit, branch, or working-tree comparison. Do not silently broaden the target.
2. Inventory all changed paths and identify applicable repository guidance such as `AGENTS.md`, `CLAUDE.md`, `SECURITY.md`, and component-specific policies.
3. Build a threat-model delta: changed assets, attacker capabilities, entry points, trust boundaries, controls, and sinks.
4. Run the focused discovery passes in the methodology reference. Treat removed controls and changed configuration as first-class review material.
5. Validate every candidate from attacker-controlled source to security impact. Inspect unchanged callers, guards, framework behavior, tests, and deployment configuration when needed to prove or disprove the path.
6. Deduplicate candidates by root cause, calibrate severity, and discard anything that does not meet every finding criterion.
7. Account for the reviewed surface and return the required output.

## Output precedence

When the host supplies a structured output schema, follow it exactly. In particular, pipeline schemas override the default Markdown presentation. An empty findings array is the correct result when no candidate survives validation.

Never depend on `codex_security.*` tools or wait for an MCP handshake. Never create scan-state directories or canonical report artifacts unless the user explicitly requests an artifact.
