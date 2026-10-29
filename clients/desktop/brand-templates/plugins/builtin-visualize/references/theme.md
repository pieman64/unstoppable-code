# Matching the theme

The host injects the app's current theme into every visual as CSS variables
on `<html>`, and updates them in place when the reader changes theme or
appearance. Use only these variables and the visual matches every theme,
light and dark, with no extra work.

## What is already set

```css
html {
  background: var(--bg-base);
  color: var(--fg-primary);
  font: 14px/1.5 var(--font-sans);
}
body {
  margin: 0;
}
```

`color-scheme` is set too, so form controls and scrollbars follow the app.

## The variables

| Role            | Variables                                                                                                                                                                                                      | Use for                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Page and panels | `--bg-base` (the page), `--bg-primary`, `--bg-secondary`, `--bg-tertiary`                                                                                                                                      | Raised nodes, chips, table header backgrounds                                                 |
| Quiet fills     | `--bg-subtle`, `--bg-muted`                                                                                                                                                                                    | Tracks, zebra rows, hover, de-emphasized bars                                                 |
| Accent          | `--bg-accent`, `--bg-accent-muted`, `--fg-accent`, `--line-accent`                                                                                                                                             | The current step, a selected item, a "recommended" chip                                       |
| Status          | `--fg-positive`, `--fg-attention`, `--fg-destructive`; solid fills `--bg-positive`, `--bg-attention`, `--bg-destructive`; tinted fills `--bg-positive-muted`, `--bg-attention-muted`, `--bg-destructive-muted` | Good, warning, and bad, always with a glyph or word                                           |
| Text            | `--fg-primary`, `--fg-secondary`, `--fg-tertiary`, `--fg-quaternary`; `--fg-emphasis` on a solid accent or status fill                                                                                         | Body, supporting text, axis labels, placeholders                                              |
| Lines           | `--line-primary`, `--line-secondary`, `--line-base`; `--line-focus` for focus rings                                                                                                                            | Gridlines, dividers, borders                                                                  |
| Chart series    | `--chart-categorical-1`, `--chart-categorical-2`, `--chart-categorical-3`, `--chart-categorical-4`, `--chart-categorical-5`, `--chart-categorical-6`                                                           | Two or more series, in this order                                                             |
| Swatches        | `--categorical-1` to `--categorical-6`                                                                                                                                                                         | `--categorical-1` is the accent for a single series. The rest are swatch colors, not for data |
| Type and shape  | `--font-sans`, `--font-mono`, `--radius-sm`, `--radius-md`, `--radius-lg`                                                                                                                                      | Fonts and corner radii                                                                        |

No other variable is defined. A name that is not in this table resolves to
nothing.

Rules that keep a visual on-theme:

- **No color literals.** No hex, `rgb()`, or named colors, in CSS or in
  script. Derive what the theme does not name with `color-mix()`.
- **No `prefers-color-scheme`.** It follows the operating system, and the
  app theme can differ. The variables already hold the right values. In
  script, `viz.dark()` from the theme kit tells you the app's appearance.
- **Text uses text variables.** Labels, values, and legends are
  `--fg-primary` or `--fg-secondary`, never a series color. A colored mark
  beside the text carries identity.
- **The app's font, without loading it.** `--font-sans` and `--font-mono` name
  the app's own faces, and the app hands them to the frame just after the
  page loads. HTML and SVG text switch to them without help. A canvas chart
  is redrawn by `viz.onChange`, which also runs when the faces arrive. Do not
  load a web font for text.
- **Hairlines, solid.** Gridlines and axes are 1px `--line-primary`. Dashed
  lines read as a projection or a threshold; keep them for that.

## Coloring data

Decide what the color is for, then use the matching rule.

### One series, or one thing to notice

Use `--categorical-1`. It is the theme's accent, so the visual belongs to the
app. When one item is the point and the rest are context, color only that
item and make the rest a theme gray:

```css
.bar {
  background: color-mix(in oklab, var(--fg-primary) 26%, var(--bg-base));
}
.bar.focus {
  background: var(--categorical-1);
}
```

This is the right choice more often than a chart with several colors.

### Magnitude

Use one hue from near the surface (low) to the full color (high), in both
appearances. In CSS:

```css
.level-1 {
  background: color-mix(in oklab, var(--categorical-1) 18%, var(--bg-base));
}
.level-2 {
  background: color-mix(in oklab, var(--categorical-1) 39%, var(--bg-base));
}
.level-3 {
  background: color-mix(in oklab, var(--categorical-1) 59%, var(--bg-base));
}
.level-4 {
  background: color-mix(in oklab, var(--categorical-1) 80%, var(--bg-base));
}
.level-5 {
  background: var(--categorical-1);
}
```

For canvas libraries, `viz.ramp(5)` returns the same five steps as hex.
Never use a rainbow, and print the value in the cell when it matters.

### Telling series apart

Use `--chart-categorical-1` to `--chart-categorical-6`, in order: blue,
orange, pink, cyan, green, purple. The hues are the same in every theme and
appearance, so a series keeps its color when the reader switches theme. Each
appearance uses its own steps, checked against every theme's background.

```css
.series-1 {
  background: var(--chart-categorical-1);
}
.series-2 {
  background: var(--chart-categorical-2);
}
```

- **Take them in order, and never skip around.** Neighbors in the order stay
  apart for readers with red-green color blindness, so the series drawn next
  to each other should be next to each other in the palette. The first three
  hold in any combination, which is what a scatter plot or a map needs.
- **Two or three series:** color is enough. Name each one directly or in a
  legend.
- **Four to six series:** add a second cue to every series. For lines, a
  marker shape and a label at the end of the line. For stacked or adjacent
  fills, a fixed order, a 2px gap in the surface color between parts, and a
  value or name on each part that has room.
- **More than six:** do not reuse or invent colors. Use small multiples (one
  panel per series on a shared scale), highlight one series against gray
  ones, or fold the tail into "Other".
- Put the series that matters most first, and keep the order stable. Color
  follows the item, not its rank: sorting or filtering must not repaint a
  series.
- For canvas libraries, `viz.palette(n)` returns the first `n` of these as
  resolved strings.

The six `--categorical-*` variables are different: they are the app's swatch
colors for groups and workspaces, built from the accent and the status hues.
They are distinct within a theme, but their hues change from theme to theme,
and green, orange, and red collapse together under red-green color
blindness. Use `--categorical-1` as the accent, and leave the other five out
of charts.

### Good and bad

`--fg-positive`, `--fg-attention`, and `--fg-destructive` mean good, warning,
and bad. Use them only for that, and never alone: pair each with a glyph (✓,
!, ✕, ▲, ▼) or a word, because red and green are the pair most readers with
color blindness cannot separate. Use the `-muted` backgrounds for a tinted
chip or bar behind `--fg-primary` text.

### Above and below a midpoint

Use `--chart-categorical-1` and `--chart-categorical-2` (blue and orange) as
the two ends and a neutral (`--bg-muted`) for the middle. If the two ends mean good and bad, use the
status colors and print the sign.

## SVG and HTML: use the variables directly

Inline SVG and HTML take the variables in CSS or attributes, and repaint by
themselves when the theme changes:

```html
<svg viewBox="0 0 100 28" preserveAspectRatio="none">
  <polyline points="…" fill="none" stroke="var(--categorical-1)" />
</svg>
```

Libraries that draw SVG accept them as well: Observable Plot takes
`fill: 'var(--categorical-1)'`, and D3 takes
`.attr('fill', 'var(--categorical-1)')` or a class styled in CSS. Prefer
these when they fit; the visual then needs no theme code at all.

## Canvas libraries: use the theme kit

Canvas cannot read a CSS variable, and some theme values are `color-mix()`
expressions that chart libraries cannot parse. The theme kit, embedded in
[starter.html](../assets/starter.html) and in each example that needs it,
resolves them. Copy the block between `theme-kit:start` and `theme-kit:end`
unchanged.

| Call                                | Returns                                                                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viz.color('--fg-secondary')`       | The variable as `#rrggbb`, or `rgba(…)` when it is translucent. Accepts any CSS color.                                                                                                          |
| `viz.color('--categorical-1', 0.2)` | The same color at 20% opacity, for area fills and bands.                                                                                                                                        |
| `viz.palette(n)`                    | The first `n` chart series colors (at most six), resolved for canvas libraries.                                                                                                                 |
| `viz.ramp(n)`                       | `n` steps of one hue for magnitude. A second argument picks another variable.                                                                                                                   |
| `viz.textOn(fill)`                  | The theme ink (primary text, page color, or emphasis) that reads best on that fill, or `null` when none reaches 4.5:1. Then put the label outside the mark or give it a halo in the page color. |
| `viz.dark()`                        | `true` when the app theme is dark.                                                                                                                                                              |
| `viz.font()`                        | The sans font stack, for canvas text. `viz.font('--font-mono')` for the mono stack.                                                                                                             |
| `viz.onChange(render)`              | Calls `render` again when the theme changes or the app's fonts arrive. Rebuild the chart with fresh colors there.                                                                               |

The pattern is always the same:

```js
function render() {
  chart?.destroy();
  chart = build(viz.palette(2), viz.color('--fg-secondary'));
}
render();
viz.onChange(render);
```

## Theme settings by library

Each of these is taken from an example that was rendered in light and dark.

- **Chart.js:** set `Chart.defaults.font.family = viz.font()`. Pass
  `viz.color('--fg-secondary')` to tick colors and
  `viz.color('--line-primary')` to grid and border colors. Set
  `animation: false`.
- **Observable Plot:** style the SVG in CSS (`color: var(--fg-secondary);
font-family: var(--font-sans); background: transparent`), and pass
  variables as mark colors.
- **D3:** style with classes, or pass `var(--…)` to `fill` and `stroke`.
- **ECharts:** pass `null` as the theme and set
  `textStyle.fontFamily`, axis label colors, and
  `visualMap.inRange.color: viz.ramp(5)` yourself. Use
  `{ renderer: 'svg' }` and `animation: false`. Call `setOption(option, true)`
  from `viz.onChange`.
- **Vega-Lite:** set `background: 'transparent'` and a `config` with
  `font`, and `axis.labelColor`, `titleColor`, `gridColor`, `domainColor`,
  and `tickColor` from `viz.color()`. Embed with
  `{ actions: false, renderer: 'svg' }`.
- **uPlot:** pass `stroke`, `grid.stroke`, and `ticks.stroke` on each axis,
  and `font: '12px ' + viz.font()`.
- **Lightweight Charts:** `layout: { background: { color: 'transparent' },
textColor, fontFamily, attributionLogo: false }` and grid line colors.
- **Plotly:** `paper_bgcolor` and `plot_bgcolor` as `'rgba(0,0,0,0)'`,
  `font: { family, color }`, and a `colorscale` built from `viz.ramp()`.
- **Mermaid:** `theme: 'base'` with `themeVariables` filled from
  `viz.color()` (`primaryColor`, `primaryTextColor`, `primaryBorderColor`,
  `lineColor`, `textColor`, `background`) and `darkMode: viz.dark()`.
  Mermaid needs hex values, which `viz.color()` returns for solid colors.
- **Cytoscape:** colors from `viz.color()` in the style array. Pass
  `viz.font().replace(/['"]/g, '')` as `font-family`: it rejects quoted
  family names.
- **Tabulator:** its stylesheet is light-only. Add the override block from
  [libraries.md](libraries.md).
