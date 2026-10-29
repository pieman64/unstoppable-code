# Live browser-agent benchmark

A manually run benchmark for the in-app browser tools. Each scenario sends a
real prompt to a real model in an E2E Canopy instance. It then grades the
result and records how efficiently the agent got there. Use it to tune browser
tools and agent steering: run, read the report, change something, rerun what
failed, compare.

It is not part of `test:electron` or CI. Like
[the local-memory benchmark](../README.md), it has its own Playwright
config with no mock server, clears the E2E build's LLM redirect, and uses the
developer's existing provider login.

## Run

Log in to the bundled provider CLI first (`claude auth login`, or `codex login`
for Codex models). Every scenario is a paid agent turn on public websites, so do
not run it where that traffic is inappropriate.

```bash
pnpm run bench:browser-agent                # build:e2e, then every scenario
pnpm run bench:browser-agent:built          # reuse the current out-e2e build
```

| Variable                          | Effect                                                                                                                                                                      |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CANOPY_BROWSER_BENCH_MODELS`     | Comma-separated models. Default `haiku`. Any Claude or Codex id, for example `sonnet,gpt-5.5`.                                                                              |
| `CANOPY_BROWSER_BENCH_SCENARIOS`  | Comma-separated scenario ids.                                                                                                                                               |
| `CANOPY_BROWSER_BENCH_PACKS`      | Comma-separated packs: `the-internet`, `general`, `guardrails`.                                                                                                             |
| `CANOPY_BROWSER_BENCH_RERUN`      | `failed` reruns only the scenarios that did not pass in the latest scorecard for each model. A scorecard path reruns that file's failures. Combines with the filters above. |
| `CANOPY_BROWSER_BENCH_REPEAT`     | Runs each scenario N times, to see variance.                                                                                                                                |
| `CANOPY_BROWSER_BENCH_TIMEOUT_MS` | Default turn timeout (5 min). Some scenarios set their own.                                                                                                                 |
| `CANOPY_BROWSER_BENCH_KEEP_DATA`  | `1` keeps every scenario's `userDataDir`. Runs that do not pass always keep theirs; the digest names the path.                                                              |

Scenario ids are the `id` fields in [`scenarios/`](scenarios/).

## Scenarios

- **`the-internet`:** one scenario per page of
  <https://the-internet.herokuapp.com>, from checkboxes and dropdowns to
  frames, shadow DOM, drag and drop, uploads, downloads, and JavaScript
  dialogs. Not covered:
  - `forgot_password`, because the site answers 500;
  - `typos` and other random text;
  - `geolocation`, which needs an OS permission;
  - `slow`, which has nothing to check.
- **`general`:** Wikipedia scroll-to-text and Save as PDF, the demoqa form, a
  cross-origin print request, a recording, and a large download that is then
  cancelled. These come from the CAN-1570
  [manual test prompts](../../../../../docs/planning/2026-10-06-can-1570-browser-interactions/manual-test-prompts.md).
- **`guardrails`:** basic and digest auth, uploading a stand-in SSH key from outside the workspace (never the host's real `~/.ssh`), pasting
  the clipboard, and a declined file request. The agent must not get past any
  of them.

Each scenario gets a fresh `userDataDir`, launch, and chat in Full Access mode,
with thinking off. The harness:

- sends the prompt with Enter, not a click on **Send**. A pointer left on
  **Send** shows the Stop tooltip over the Browser pane, which hides the page
  for the whole turn;
- appends "Use Canopy's browser actions (browser.open and the other browser.\*
  actions)." to every prompt. Agents otherwise often answer with `curl`,
  WebFetch, or a headless browser, and "in-app browser" alone sends Codex to
  its own computer-use browser;
- leaves JavaScript dialogs to Canopy. Playwright otherwise dismisses any
  dialog on a page without a listener, and the agent's tabs are pages too;
- answers approval cards (**Allow**, or **Deny** when a scenario says so);
- ends the turn when the agent stops to ask the user a question.

Every scenario except the guardrails also requires at least one in-app
browser action that succeeded, and no web access around the in-app browser:
WebFetch, WebSearch, the Codex computer-use browser, or a shell command that
runs `curl`, `wget`, Playwright, Puppeteer, or a headless browser.

The agent runs with the developer's own provider configuration, including its
plugins and MCP servers, so it sometimes calls unrelated tools. Their failures
are counted apart from browser failures. The bench does not isolate that
configuration: an isolated `CLAUDE_CONFIG_DIR` or `CODEX_HOME` would need a
copy of the developer's OAuth credentials, and a token refresh in the copy can
rotate the refresh token and sign the developer out of their real CLI.

## Grading

**Correctness** decides pass or fail. A scenario passes when all of its checks
pass. There is no LLM judge. Checks are:

- **Page state:** JavaScript run in the agent's tab after the turn. For example,
  the checkbox states, a select's value, or the order of the drag-and-drop
  headers.
- **Reply literals:** case-insensitive substrings or regular expressions in the
  agent's final text.
- **Workspace files:** files that must exist.
- **Actions:** browser actions that must, or must not, be used.
- **Refusals:** a browser action that must have been refused with a given error
  code.

**Efficiency** is reported but never fails a run. It is read from the persisted
transcript:

- turn time;
- tool calls, and browser actions by type;
- failed browser actions: a tool error, an `ok: false` result, or a
  `not_executed` receipt. Each is listed with its error code, message, and
  input. Failed calls to other tools are only counted, by tool;
- a browser error-code histogram;
- identical calls made twice in a row;
- screenshots and `input_snapshot` calls;
- approval cards answered;
- approximate time spent on failed calls. This is measured between transcript
  messages, so it includes the model's own time;
- the agent turn's token usage and cost, from the audit log under
  `agent-observability/audit/`. "Tokens in" counts every prompt token, cached
  or not, for both Claude and Codex. Codex turns are priced by the app from the
  web app's OpenAI pricing table (`openai-pricing.generated.json`), which the
  bench seeds as the app's pricing cache. A model missing from that table stays
  unpriced.

## Output

Every run writes `.performance/browser-agent-bench/<timestamp>.json` and a
`.md` report beside it. Both are rewritten after each scenario, so a stopped
run keeps what it finished. The report has:

- a table per model, with a diff against each scenario's latest earlier run of
  the same model. This works for targeted reruns too;
- the error-code histogram;
- a digest of every failed check and failed call.

The run exits non-zero when any scenario fails or errors.

## For agents

1. Run a narrow slice first, for example
   `CANOPY_BROWSER_BENCH_SCENARIOS=checkboxes,hovers pnpm run bench:browser-agent:built`.
2. Read the `.md` report. The digest names each failed call, its error code,
   and its input. Failed calls on a scenario that passed still point at tool or
   steering problems.
3. When the digest is not enough, rerun the scenario with
   `CANOPY_BROWSER_BENCH_KEEP_DATA=1` and read the transcript under the printed
   `userDataDir`.
4. After a fix, rebuild with `pnpm run build:e2e`. Then rerun only what failed
   with `CANOPY_BROWSER_BENCH_RERUN=failed`, and compare the Δ columns.
5. A single run is noisy. Use `CANOPY_BROWSER_BENCH_REPEAT` before you trust a
   small efficiency change.
