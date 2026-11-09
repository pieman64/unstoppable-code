# Direct Remote Control E2E harness

Headless end-to-end specs for Remote Control over the encrypted device relay
(CAN-5985). They reuse the [Portal harness](../portal/README.md) (its web
server, Postgres database and seeded accounts) and add a real relay, so they
run in the Playwright `portal` project and the CI Portal lane, not the
Electron lane.

| Spec                  | Covers                                                                                                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hosted-mcp.spec.mjs` | Hosted agents: SSE pairing with desktop approval and the direct Tasks tools on `/api/v1/mcp/tasks`.                                                                                                                                                            |
| `direct-web.spec.mjs` | Web `/chat` in Chromium over the production connection owner: link and code pairing, a streamed chat turn, offline and reconnect, host refusals, owner lifecycle (tabs, hidden suspend, leader takeover, key store, device cap), Portal off, sign-out, revoke. |

| Module                 | Provides                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relay.mjs`            | `startDeviceRelay()`: the production relay entry point on an ephemeral loopback port with a generated token secret. Exposes `url`, `secret`, `connectedDeviceIds()`, `connectionCount()`, `connectionsOpenedBy(deviceId)`, `refusedOverLimit()`, `waitFor(predicate)` (from the relay's own logs), `signToken(claims)` and `stop()`. `maxDevicesPerAccount` lowers the device cap. |
| `relayCappedEntry.mjs` | The production relay server with a per-account device cap the spec chooses; started by `startDeviceRelay({ maxDevicesPerAccount })`.                                                                                                                                                                                                                                               |
| `directWebHarness.mjs` | `directWebServerOptions({ relay })` for `portalServerManager.acquire`, `launchRemoteControlDesktop({ relay, seeded })` (signed in, Remote Control on, connected to the relay; `quit()` and `relaunch()` keep its data), hosted pairing (`startHostedPairing`, `pairHostedAgents`, `answerDesktopPairingPrompt`) and database readers.                                              |
| `hostedController.mjs` | Test-driven `@canopy/remote-session` clients: unseal the account's hosted root, open delegated sessions with a chosen expiry, attempt raw handshakes, connect relay devices for any account and pair a browser-kind controller by link (`pairTestBrowserController`).                                                                                                              |
| `mcpAgent.mjs`         | `connectTasksAgent(page, seeded)`: a real OAuth grant through the consent page, and `call` / `ok` for `/api/v1/mcp/tasks` tools.                                                                                                                                                                                                                                                   |

The device and direct rollout flags need no opt-in: the harness runs without
LaunchDarkly, where both default on. `directWebServerOptions` adds the hosted
MCP opt-ins and the canonical MCP origin. A spec that must change a flag while
the server runs (the direct golden turns Portal off) passes
`CANOPY_PORTAL_E2E_FLAG_OVERRIDES_FILE` in the server `env` and rewrites that
JSON file; the web server reads it on each evaluation, only in the harness.

Prerequisites are the Portal suite's: `pnpm run build:e2e`, a pgvector
Postgres reachable through `CANOPY_PORTAL_E2E_PG_ADMIN_URL`, and
`pnpm run prisma:generate:web`. Run a registered spec with:

```bash
pnpm run test:electron:built apps/desktop-app/tests/electron/remote-control/hosted-mcp.spec.mjs --reporter=list
```

Only [golden tests](../../../../../docs/golden-tests.md) are committed. Write
other scenarios under the gitignored `.playwright/<slug>/`.
