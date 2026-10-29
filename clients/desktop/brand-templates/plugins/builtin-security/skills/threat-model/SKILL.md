---
name: threat-model
description: Identify security-relevant trust-boundary, attacker-capability, asset, entry-point, control, and sink changes introduced by a code diff.
---

# Threat-model a diff

Use this phase when asked to explain the security model changed by a patch. Read `../../references/diff-scan-methodology.md`, establish the exact diff, and describe only deltas supported by the code.

Cover changed assets, actors, attacker-controlled inputs, entry points, trust boundaries, security controls, sensitive operations, and plausible abuse cases. Tie every claim to a changed path or to unchanged context necessary to understand that path. Clearly distinguish repository evidence from inference.

Do not produce vulnerability findings unless the user also asks for them; hand concrete abuse hypotheses to discovery and validation.
