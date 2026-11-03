# Mobile identity artwork

The launcher uses the striped U from
[`brands/unstoppable-code/logo.svg`](../../../../brands/unstoppable-code/logo.svg).
The mark is white on the desktop and mobile primary blue, `#2264FF`.
This is the Unstoppable theme's `bg-accent` value in both color modes.

The source canvas is 1024 × 1024. The 64 × 64 logo viewBox occupies 70% of
the canvas. Its visible mark spans about 64% of the canvas width, about 10%
smaller than the previous icon. The logo moves 20 pixels left and 20 pixels
down for visual centering and clearance at its top-right corner.

`app_icon.png` is an opaque square. The platform applies its own icon mask.
`app_icon_foreground.png` contains the same white mark on transparency.
Android applies the configured 16% foreground inset. This keeps the mark
inside the protected 66dp circle on its 108dp adaptive layer. Android's
monochrome icon uses the same silhouette; the launcher supplies its theme color.

Regenerate launcher, splash, and login sources and all Android and iOS sizes
from the repository root.
This command requires the installed Node dependencies and Dart:

```sh
node scripts/brand/generate-mobile-launcher-icons.mjs
```

The command runs `flutter_launcher_icons` and `flutter_native_splash:create`
from `apps/mobile`. It preserves the Xcode project and status-bar settings.
Version 0.14.4 of `flutter_launcher_icons` changes an unrelated Swift
asset-symbol setting when it generates icons.

Check the committed source and platform assets from the repository root:

```sh
node --test scripts/brand/mobile-launcher-icons.test.mjs
```

Splash and login use the same artwork with rounded corners (22% radius).
`splash_mark.png` is a 576px tile drawn at 144dp by native splash screens and
`LaunchView`. The Android 12 source centers that tile on a transparent 1152px
canvas so the full tile fits inside the system mask. `splash_logo.png` is the
256px login tile. Both themes use the same white-on-blue artwork.
