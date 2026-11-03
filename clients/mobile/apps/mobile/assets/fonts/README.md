# Bundled mobile typography

Both families are shipped offline under SIL OFL 1.1. Their notices are bundled
assets and registered with Flutter's `LicenseRegistry` in `main()`.

- **Inter 4.001:** the same normal/italic variable fonts used by desktop in
  `packages/ui-shared/src/assets/fonts/inter`. Converted losslessly from WOFF2
  to TrueType with fontTools 4.62.1 (`TTFont(path); font.flavor = None;
font.save(destination)`). No glyphs, names, or variation axes are changed.
  To update, convert both shared sources again and copy their `LICENSE.txt`
  into `inter/OFL.txt`.
- **JetBrains Mono 2.304:** normal/italic variable TTFs and OFL.txt from
  https://github.com/JetBrains/JetBrainsMono/tree/v2.304.
  Source filenames under `fonts/variable/` are `JetBrainsMono[wght].ttf` and
  `JetBrainsMono-Italic[wght].ttf`; local filenames omit the brackets.

`lib/ui/core/typography.dart` defines all Material text roles. Regular uses
`wght=400`; emphasis uses `wght=450` with `FontWeight.w500` as Flutter's nearest
face-selection hint. Always set both `fontWeight` and `fontVariations` when
changing emphasis, including on copied styles. Do not add raw w600/w700 styles.
Code uses `AppTypography.monoFamily`; general UI uses Inter. Both italic faces
are bundled. Dense 10/11px styles are opt-in, body uses 13/14/16px, and system
accessibility scaling stays enabled.

Visual verification: from `apps/mobile`, run
`flutter test tool/typography/capture_test.dart --update-goldens`.
See the capture file header for the before-stage command. Artifacts go to
`.playwright/mobile-typography/` at the repository root.
