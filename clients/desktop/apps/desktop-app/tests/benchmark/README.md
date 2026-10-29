# Local-memory real-model benchmark

CAN-2720 is a manually run benchmark for the desktop app's local-memory path.
It drives the real chat UI and bundled provider binary against live models; it
does not use the E2E mock LLM, an LLM judge, or visual timing assertions.

The ten default packs cover production injection of seeded user/workspace `MEMORY.md`
indexes and recent inbox notes; near-cap injection floors; preference for
newer inbox facts over stale index facts (the contradiction's older value is
planted in the injected index, its newer value in an injected recent note);
and production secret redaction before seeded stores reach disk. Topics are
seeded for realism and junk pressure but are never injected, so the pack
validator rejects any graded literal that cannot reach the injected block. It
also has one opt-in `consolidation-import` pack that seeds raw staged imports
in the production `import-state.json` ledger format plus an inbox correction,
invokes the E2E-build-only manual consolidation trigger once for each scope,
grades the resulting `MEMORY.md`/topics store, and only then sends probes
through production injection. The normal background scheduler remains
compiled out of E2E builds, and production builds expose neither the manual
IPC handler nor its preload method. Injected precision@K and citation
compliance (from the
`canopy.local_memory_citation_compliance` operation) are likewise deferred
past this work (plan decision D20): the scorecard covers the CAN-2720
metric set, and neither deferred dimension is measured or gated.

## Run

Authenticate the bundled Claude CLI first (`claude auth login`). The benchmark
uses the developer's existing provider login, so do not run it in an account or
environment where real model traffic is inappropriate. If an override includes
a Codex model, authenticate Codex with `codex login`; unauthenticated Codex
models are recorded as skipped instead of aborting the matrix. An
individually skipped model is fine, but a run in which every selected model
was skipped fails — a scorecard that measured nothing must never look green.

```bash
pnpm run bench:local-memory
```

The default matrix is Canopy's default model per provider (the current default
Claude and Codex chat models, read from the shared models module) plus the
cheap `claude-haiku-4-5-20251001` canary. Override it with a comma-separated
list:

```bash
CANOPY_MEMORY_BENCH_MODELS=opus[1m],gpt-5.5 pnpm run bench:local-memory
```

Select one or more pack ids for a structural or low-cost spot check:

```bash
CANOPY_MEMORY_BENCH_MODELS=claude-haiku-4-5-20251001 \
CANOPY_MEMORY_BENCH_PACKS=service-port pnpm run bench:local-memory
```

The consolidation lane is intentionally excluded from the default pack list
because it adds one paid consolidation generation per selected model. Run it
explicitly (prefer a single low-cost Claude model for a spot check):

```bash
CANOPY_MEMORY_BENCH_MODELS=claude-haiku-4-5-20251001 \
CANOPY_MEMORY_BENCH_PACKS=consolidation-import pnpm run bench:local-memory
```

The trigger uses production local memory model resolution and consolidation
routing. Each pack seeds the selected model as the local memory model, so a
Codex model consolidates through the Codex harness; there is no Claude
fallback.

The committed default currently sends 60 short turns (10 packs × 2 probes × 3
models). Model pricing and subscription accounting can change; check the
provider account before a run. Each probe gets a fresh empty chat, while each
model/pack pair gets a fresh Electron `userDataDir`. Provider auth state is the
only deliberately preserved host state.

## Scorecard

Each run writes a filesystem-safe ISO timestamped JSON file under
`.performance/local-memory-bench/`. The hierarchy is model → pack → probe. A
completed probe records the reply, latency, matched and missed required
literals, forbidden literal hits, secret leaks, and whether the old
contradiction value escaped. A launch, UI, or timeout failure instead records
an `error` probe with the harness error and no model metrics.

The opt-in consolidation pack also records `consolidationStore` with
`factsPresent`, `factsExpected`, `duplicateCopies` (required literals present
more than once across `MEMORY.md` and topics), and `junkRetained` (raw junk
marker lines that survived there). Every required literal must be present in
the consolidated store before probes begin; reply pass/fail remains the exact
literal result of the model replies.

Per-model aggregates report:

- recall: matched `mustContain` literals / all required literals;
- false-positive rate: hit `mustNotContain` literals / all forbidden literals;
- contradiction-escape rate: probes that emitted the old literal / probes that
  explicitly check the contradiction;
- leak count: planted secret literals found in replies;
- duplicate rate: exact occurrences of required literals beyond the first /
  matched required literals (reported, not pass/fail — repetition signals
  failed dedup pressure, not an incorrect answer);
- probe pass rate and nearest-rank p50/p95 end-to-end turn latency (send
  through fully rendered reply — dominated by provider generation time, kept
  as completion context rather than a memory-subsystem signal);
- memory injection latency: nearest-rank p50/p95 over repeated timings of the
  production retrieval + render path (`readMemoryIndex`,
  `readRecentInboxNotes`, `renderLocalMemoryBlock` — the same per-turn work
  `prepareLocalMemoryContext` does) against the seeded on-disk stores. This is
  the metric to watch for local-memory retrieval/injection regressions.

Errored probes are excluded from all probe, recall, false-positive,
contradiction, leak, and latency aggregates. Any errored probe marks its model
run and the overall scorecard `ERRORED`, distinct from a model-evaluated
`FAILED` result.

Matching is an exact, case-sensitive substring check. There is no semantic or
LLM judge. Any secret match hard-fails the whole run, regardless of all other
scores. Other missed or forbidden literals fail their probe and therefore the
run. A compact per-model summary and the scorecard path print at completion.

The Playwright config is intentionally separate from `playwright.config.mjs`,
has no mock-server `webServer`, runs serially, and is outside the normal
`test:electron`/`test:electron:built` test directory. Nightly scheduling,
baseline retention, trend alerts, and model-specific thresholds are later,
additive work after the manual scorecards establish a useful baseline.

See [packs/README.md](packs/README.md) for the scenario schema and extension
rules.
