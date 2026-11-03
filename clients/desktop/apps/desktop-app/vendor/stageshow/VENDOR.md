# Vendored: Stageshow kit

`kit/` is the React kit from Stageshow, a skill by Benji Taylor
(`benjitaylor/skills`, skill `stageshow`, package version 0.1.0, copied
2026-11-01). It is MIT licensed; the license is in [`LICENSE`](LICENSE) and
travels with the copy.

Only the localhost components lab uses it
(`apps/desktop-app/src/renderer/components-lab.vite.mts`). It frames the real
shared components in stages and moves an authored cursor; it never ships in
the desktop app's production bundles, which do not import it.

## What was left out

- `kit/brands/` and `kit/parts/BrandMark.*`: third-party logo artwork under
  other licenses (SVGL, payment-icons, Cryptocurrency Icons and vendor marks).
  The lab has no use for it, so none of it is copied.
- The skill's `scripts/`, `examples/`, `playground/`, `references/` and
  `teaching/`. Filming and the rehearsal gate run from an installed copy of
  the skill (`pnpm dlx skills add benjitaylor/skills --skill stageshow`); see
  the lab's `REHEARSAL.md`.

## What was changed

- `kit/index.ts`, `kit/parts/index.ts`, `kit/stageshow.css`: the `BrandMark`,
  `brandMarks` and brand type exports, and the BrandMark stylesheet import,
  removed with the artwork.
- `kit/stage.css`: the unlayered host-element reset
  (`:where(.ss-stage) :is(p, …, button, input, label) { all: revert }`)
  removed. It beat Canopy's layered Tailwind utilities and stripped the real
  components the lab renders inside its stages. A comment marks the spot.
- `kit/phone.tsx`: an unused `useLayoutEffect` import removed for the
  renderer's `noUnusedLocals` typecheck.

Everything else is byte-for-byte upstream. The folder is excluded from
ESLint, oxlint and Prettier so later updates can be copied over cleanly;
reapply the changes above when updating.
