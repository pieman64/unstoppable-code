# Colors and corner radii

Desktop and mobile share the brand palette. `brand.g.dart` is generated;
change the brand/theme sources through the existing brand generator rather
than editing generated values or copying hex colors into widgets.

`AppTheme` registers `AppColors` for both appearances. Use semantic colors for
surfaces, text, borders, and interaction states:

```dart
final colors = AppColors.of(context);
Container(
  decoration: BoxDecoration(
    color: colors.surface,
    border: Border.all(color: colors.border),
    borderRadius: BorderRadius.circular(AppRadii.md),
  ),
  child: Text('Example', style: TextStyle(color: colors.foreground)),
);
```

The complete vocabulary is available by its desktop name, such as
`colors['bg-positive-muted']` or `colors['fg-positive']`. The map is immutable;
unknown names throw an argument error. Theme interpolation preserves alpha.
Use the existing `StatusColors` extension for operational statuses.

`colors.disabledTint` is the normal secondary foreground tint with alpha 0.5.
Shared icon buttons use it for their disabled glyph and Material foreground.

The radius scale mirrors `packages/ui-shared/src/styles/canopy-tokens.css`:

| Dart token      | Desktop token | Logical pixels     |
| --------------- | ------------- | ------------------ |
| `AppRadii.sm`   | `radius-sm`   | 4                  |
| `AppRadii.md`   | `radius-md`   | 8                  |
| `AppRadii.lg`   | `radius-lg`   | 12                 |
| `AppRadii.xl`   | `radius-xl`   | 16                 |
| `AppRadii.xxl`  | `radius-2xl`  | 20                 |
| `AppRadii.xxxl` | `radius-3xl`  | 24                 |
| `AppRadii.full` | `radius-full` | 9999 (pill/circle) |

`AppRadii.none` is zero; `AppRadii.defaultRadius` follows `Brand.radius`
independently of the fixed scale. Existing Material component defaults remain
in place; adopt the shared tokens as individual components are styled.

Developer options → Design system provides Colors (Semantic/Primitives) and
Corner radii reference pages that follow the current app appearance.

## Padding and border widths

Import `package:mobile/ui/core/dimens.dart` for shared `AppDimens` constants.
All values use Flutter logical pixels:

- Padding: `padding4`, `padding8`, `padding16`, `padding32`.
- Border widths: `border1`, `border2`.

```dart
Container(
  padding: const EdgeInsets.symmetric(
    horizontal: AppDimens.padding16,
    vertical: AppDimens.padding8,
  ),
  decoration: BoxDecoration(
    border: Border.all(color: colors.border, width: AppDimens.border1),
  ),
);
```

## App bar and scaffold

`core/design-system/app-bar/` provides `CanopyAppBar` and `CanopyScaffold`.
The scaffold body fills the viewport, with keyboard resizing retained. The app
bar overlays it, including the top system inset, and uses `AppColors.background`
with a vertical fade to zero alpha and a clipped backdrop blur (sigma 3 at the top,
tapered linearly to zero in eight non-overlapping horizontal bands). The background
extends 14px below the toolbar, retaining an extra 8px for the lower fade. Content stays
centered between equally sized leading/trailing slots (48px by default); use
`CanopyIconButton` for actions. Slots center their children with loose constraints
so the 40px square ink surface retains its 48px touch target. `actionExtent` can reserve wider slots.

Use `CanopyScaffold.contentPaddingOf(context)` from a **body descendant** and
add it to the scroll view's padding, not to a `SafeArea` outside the scroll
view. These insets reserve the status bar + toolbar, horizontal cutouts and
bottom system controls while allowing content to scroll through them. The
14px decorative fade is also reserved initially; centered forms may opt out
with `includeFade: false` when their own internal spacing clears the fade. Non-scrolling content can use a
`Padding` with the same insets. All root screens except Usage, plus Settings and its drill-downs, organization/member drill-downs,
Chat search, remote chat, and developer previews use this chrome.
Pushed routes opt into `automaticallyImplyLeading` for the design-system back
button; it uses `Navigator.maybePop` so route pop guards remain effective.
Remote chat passes `scaffoldKey` and `endDrawer` through the shared scaffold,
and applies body insets once around its fixed tabs/transcript/composer layout. See Developer options → Design system → App bars for a working
scroll and overflow-menu preview.

## Text field

`core/design-system/text-field/` provides `CanopyTextField` for form inputs.
It owns the filled `surfaceRaised` surface, `AppRadii.lg` corners, focus tint,
disabled text, and wrapping helper/error text. Callers supply the controller,
label, keyboard type, validation message, and edit callbacks. Pipeline dispatch
uses it for string and number inputs. Developer options → Design system →
Text fields shows empty, with-text, error, and disabled states.

This mobile treatment refines DESIGN.md's `shadow-field` and
`shadow-field-focus` rules for desktop/web inputs. Mobile form inputs retain
the shipped search field's borderless surface and focus tint so both input
types use one consistent native component.

## Search field

`core/design-system/search-field/` provides `CanopySearchField`, the one search
input for list filters. It composes `CanopyTextField` for its surface and focus.
It fills with `surfaceRaised` at `AppRadii.lg` corners
and draws no underline or outline in any state; focus tints the fill with
`focus`. A 20px magnifier and the hint use `foregroundSecondary`. While the
field has text, a trailing `CanopyIconButton` named "Clear" empties it and
calls `onChanged('')`; it never submits. The caller owns the controller and
decides what a change or keyboard submit means. Developer options → Design
system → Search field shows the empty, with-text and focused states.

## Settings list

`core/design-system/settings-list/` provides grouped settings rows. Settings,
its Login methods, Two-factor authentication and API keys screens, and the
Usage limits card use them.

- `CanopySettingsSection` places an optional `AppTypography.settingsHeading` in `foregroundSecondary`
  above a `surfaceRaised` card with `AppRadii.xxl` corners on the page
  `background`. The card clips row ink to its corners, with no dividers
  between rows. The heading uses the row title's 16px size and 24px line height
  with bold 700 weight. It starts 2px beyond the leading row inset
  (`AppDimens.navRowLeadingInset + 2`).
- `CanopySettingsRow` has an optional 24px `CanopyGlyph`, a wrapping title, an
  optional subtitle and value, and a trailing slot. Rows share the navigation
  row grid and have a minimum height of `AppDimens.settingsRowMinHeight` (56).
  The title never truncates. A value that does not fit beside it moves below
  it and ellipsizes on one line. A null `onTap` makes a read-only row.
  Screen readers announce a row with an `onTap` as one button.
  `enabled: false` dims the row with `disabledTint` and ignores taps.
  `CanopySettingsRow.destructive` uses `fg-destructive` for the glyph and
  title, with no value or accessory.
- `CanopySettingsValue` is the one-line secondary value.
  `CanopySettingsValue.loading()` is a still placeholder bar, announced as
  "Loading". Loading rows stay in place; they never spin.
- Trailing accessories are widgets: `CanopySettingsChevron` for drill-downs,
  `CanopyIconButton` for row actions and an inline `CanopyButton` for Retry.
- `CanopySettingsSwitchRow` adds a brand-colored switch (`accent` track,
  `onAccent` thumb when on). A tap anywhere on the row toggles it, and the
  row is one toggle for screen readers.
- `CanopySettingsMenuRow` shows the current option and an up/down indicator
  built from `chevronTopSmall` and `chevronDownSmall`. A tap opens a popup
  menu route (`showMenu`) anchored under the row, on a `surfaceRaised` surface
  with `AppRadii.lg` corners. A `checkmark1` glyph marks the current option.
  Choosing the current option or dismissing the menu changes nothing, and focus
  returns to the row. Do not use `MenuAnchor` here: on the pinned Flutter
  version, iOS VoiceOver misplaces its options (flutter/flutter#182604).

The page owns spacing between sections (`AppDimens.padding32`). Developer
options → Design system → Settings list shows every variant in the current
appearance.

`CanopyButton.semanticsLabel` overrides the spoken name when a short visible
label needs context; its leading glyph is excluded from semantics.
