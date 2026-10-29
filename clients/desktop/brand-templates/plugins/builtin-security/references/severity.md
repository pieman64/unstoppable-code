# Severity calibration

Calibrate severity from demonstrated impact and realistic exploitability, not from vulnerability category names alone.

- **Critical**: straightforward compromise of a principal security boundary with severe, broad impact, such as unauthenticated remote code execution, systemic credential compromise, or cross-tenant administrative control.
- **High**: substantial confidentiality, integrity, or availability impact that is realistically exploitable, but has meaningful prerequisites, narrower reach, or reduced blast radius.
- **Medium**: real security impact with constrained reach, stronger prerequisites, significant user interaction, or limited affected assets.
- **Low**: limited but concrete security impact, generally requiring unusual conditions or affecting low-value assets.

When a host-provided schema uses a different scale, map the calibrated result conservatively to that schema and explain the concrete impact in the finding. Never inflate severity to compensate for uncertainty.
