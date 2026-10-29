# Diff scan methodology

## Scope

Review security-relevant behavior introduced by a diff. Read unchanged code only when it establishes whether a changed path is reachable, attacker-controlled, protected, or exploitable. Do not turn a diff review into a repository-wide audit.

Establish the exact comparison before reviewing:

1. Prefer an explicit diff or patch file supplied by the host.
2. Otherwise use the requested pull request, commit, or branch comparison.
3. Otherwise inspect the working tree against `HEAD`, including staged and unstaged changes.

Record renamed, copied, deleted, generated, binary, and submodule changes. Deleted validation, authorization, escaping, or tests can be as security-relevant as added code.

## Threat-model delta

For each changed surface, identify only what the patch changes:

- assets or privileges newly reachable;
- attacker-controlled sources and newly trusted data;
- trust-boundary crossings;
- security controls added, weakened, bypassed, reordered, or removed;
- new sinks such as command execution, filesystem access, deserialization, rendering, network requests, redirects, credentials, or authorization decisions.

## Discovery passes

Perform focused passes rather than one broad skim:

1. Input handling and injection.
2. Authentication, authorization, tenancy, and privilege boundaries.
3. Secrets, cryptography, privacy, and logging.
4. Filesystem, process, network, parser, and deserialization boundaries.
5. Browser, client/server, IPC, callback, and redirect boundaries.
6. Concurrency, state transitions, replay, and fail-open behavior.
7. Dependency, build, deployment, and security-control regressions.

## Validation

For every candidate, trace:

`attacker capability -> source -> transformations -> security controls -> sink -> consequence`

Reject it unless the trace is supported by repository evidence. Search for callers, guards, sanitizers, framework defaults, tests, and deployment constraints that could invalidate the path. A code smell, missing hardening, hypothetical misuse, or defense-in-depth suggestion is not a vulnerability by itself.

## Coverage

Before finishing, account for every security-relevant changed file and every discovery pass that applies. A clean result means no validated findings in the reviewed diff, not proof that the repository is vulnerability-free.
