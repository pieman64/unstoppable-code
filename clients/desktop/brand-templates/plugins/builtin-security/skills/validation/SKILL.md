---
name: validation
description: Validate or reject candidate diff-security findings by tracing reachability, attacker control, security controls, sensitive sinks, and concrete impact.
---

# Validate security candidates

Read `../../references/finding-criteria.md` and `../../references/severity.md`. For each candidate, trace attacker capability, source, transformations, security controls, sink, and consequence through actual callers and configuration.

Actively search for disproof: upstream validation, authorization, escaping, safe framework defaults, unreachable code, trusted-only inputs, tests, runtime isolation, or deployment constraints. Reject candidates that require unsupported assumptions or have no concrete security consequence. Merge duplicates sharing one root cause.

For survivors, cite the smallest useful changed line range, record the decisive evidence, and calibrate severity from demonstrated impact and exploitability.
