---
name: attack-path-analysis
description: Trace a suspected diff-security finding from attacker-controlled source through transformations and controls to a sensitive sink and consequence.
---

# Analyze an attack path

Read `../../references/finding-criteria.md`. Start from the claimed attacker capability and establish each edge of the path:

1. entry point and attacker-controlled value or action;
2. callers and transformations;
3. authentication, authorization, validation, encoding, isolation, or other controls;
4. security-sensitive sink or decision;
5. concrete confidentiality, integrity, availability, or boundary impact.

For every edge, cite repository evidence and note assumptions. Search for alternative paths and compensating controls. Conclude `validated`, `rejected`, or `needs evidence`; only `validated` paths are eligible for a final finding.
