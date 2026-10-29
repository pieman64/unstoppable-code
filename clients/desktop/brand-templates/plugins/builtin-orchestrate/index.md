# Built-In Orchestrate

Generic orchestration toolkit bundled with {{BRAND_DISPLAY_NAME}}: create worktrees, hand planned
work to fresh, fully briefed agents in other workspaces, and review changes through the bundled
multi-provider pipeline.

## The model

This plugin supplies the generic spawn, kickoff, and review toolkit. Workflow plugins — a team's
"orchard" — build opinionated home-base arrangements, onboarding conventions, and PR-driving
workflows on top of these mechanics.

## Commands

| Command   | Description                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kickoff` | Create a workspace worktree (branch + checkout) for ticket work, base-branch-aware. No agent is started.                                         |
| `handoff` | Plan → running implementer: create a code worktree or cowork task, send the brief through project tools, and watch the implementer’s completion. |

## Skills

| Skill    | Description                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `review` | Run the bundled Code Review (Multi-Provider) pipeline from a chat — dispatch, monitoring, result verification, and posting discipline. |

## References

- [platform-mechanics](references/platform-mechanics.md) — settled facts: tool surfaces per chat
  kind, the messaging policy, the watcher model, spawn lifecycle, stacked-PR rules.

## Enabling the plugin

`builtin-orchestrate` is bundled but **disabled by default** — enable it where it is needed:

- **Per workspace:** set it in the workspace's default plugin selections, so every new chat there
  has the commands.
- **Per chat:** use the plugin picker in any chat; selecting one of its commands from the slash
  menu also enables it for that chat.
- **Per user:** use the global plugin defaults in Settings if it should be available everywhere.
- **Per repo:** a `{{BRAND_CONFIG_FILE}}` `plugins` entry can recommend it to everyone opening
  that repo.

Enable this plugin in the target project defaults or chat picker before handoff if its skills
are needed there. Project creation and send actions do not accept plugin selections. Handoffs
require the project tools in a supported root chat; they do not fall back to messaging automations.
