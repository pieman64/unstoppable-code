# CAN-1570 on-demand technical spikes

Evidence gathering only: these disposable Electron probes are **not wired into
CI**, package scripts, production code, Browser Lab, or the Phase A probes.

Run from the repository root, through the shared host e2e guard (wait if queued):

```sh
node scripts/run-guarded-dev-script.mjs --suite e2e -- \
  node scripts/probes/can-1570-spikes/spike-probe.mjs
```

The boundary-clean Node wrapper spawns `browser/run.mjs`. The runner prepares the
pinned Electron 42.3.0 through `scripts/lib/electron-binary.mjs`, then launches
`browser/app/main.mjs` with hidden windows, a minimal environment, disposable
HOME/profile/temp paths, and a whole-process-group deadline. Raw CDP commands,
responses, events, timings, platform, arch, and Electron version are saved to
`.playwright/can-1570-spikes/can1570-spikes-<run-id>.json` (uncommitted).

The app's `WebContentsView` preferences and flattened iframe auto-attach mirror
production `allocateProfileView` and `enableFrameObservations`. No production
preload is loaded. S5 alone adds a probe-local sandbox preload to compare
`contextBridge.executeInMainWorld`. The fixture HTTP listeners bind only
127.0.0.1. Main and cross-site pages use `127.0.0.1` and `localhost` respectively,
with different ports: the hostname distinction, not just the port, creates
out-of-process iframe targets. External DNS is disabled except loopback names.
No credentials, developer browser profiles, clipboard contents, or real user
files are used. Upload/drop/download files are synthetic disposable bytes.

A pane described as "visible" has `view.setVisible(true)` inside a **hidden**
window. These probes never show a window. They establish CDP behavior in
headless production-shaped views, not OS compositor visibility or actual
foreground-window focus. Negative protocol findings are recorded results, not
probe execution failures. Windows-only conclusions require a Windows run.

Qualification requires no top-level runner errors or recorded harness execution
failures: `*-error` finding kinds, non-empty `errors` or `sampleErrors` arrays,
error-status entries in `findings` maps, or an unobserved OOPIF attachment.
CDP `commandResults` errors and S5 `contextBridge.setupErrors` remain protocol
observations, not execution failures; raw evidence is not scanned.

## S2 cost measurement

The normal run does not measure Browser Lab `heavy` cost. The cost run serves
that case from the runner on the lab's paired 127.0.0.1 and localhost listeners:

```sh
node scripts/run-guarded-dev-script.mjs --suite e2e -- \
  node scripts/probes/can-1570-spikes/spike-probe.mjs \
  --measure-cost-on-lab-heavy \
  --out-dir=.playwright/can-1570-spikes/cost
```

`--measure-cost --external-page-url=http://127.0.0.1:PORT/PATH` measures another
synthetic loopback page instead; never authenticated or user content. Cost mode compares
cold/reload and warm CDP extraction, with and without bounded listener detection,
and reports at least 20 raw samples per mode plus p50/p95. It approximates
response handling and selector-based listener scanning, not production page-model
assembly, filtering, locators, pagination, or cache hits. Do not use these numbers
to qualify the plan's production performance budgets.

Other flags: `--prepare-only`, `--deadline-ms=900000`,
`--case-timeout-ms=12000`, `--settle-ms=400`, and
`--out-dir=.playwright/can-1570-spikes`. Output directories must remain under
`.playwright/can-1570-spikes/` without traversal segments.
