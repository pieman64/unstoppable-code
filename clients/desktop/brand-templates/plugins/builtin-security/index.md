# {{BRAND_DISPLAY_NAME}} Security

A compact, self-contained security review plugin for code changes. It preserves the diff-scan workflow from Codex Security while deliberately omitting its scan-lifecycle MCP server, deep-scan orchestration, external issue tracking, and persistent report machinery.

## Skills

- `security-diff-scan` — end-to-end security review of a pull request, commit, branch diff, or working-tree patch.
- `threat-model` — identify trust-boundary and attacker-capability changes introduced by a diff.
- `finding-discovery` — generate concrete vulnerability candidates from changed behavior.
- `validation` — reject speculative candidates and verify exploitability from source to impact.
- `attack-path-analysis` — trace source, transformations, security controls, sink, and consequence for a candidate finding.

## Runtime dependencies

None beyond the agent's normal repository and terminal tools. This plugin contains no MCP, app, LSP, or authentication configuration.
