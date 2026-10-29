---
name: visualize
description: >-
  Design and build a visual for a {{BRAND_DISPLAY_NAME}} chat reply with the ShowVisual and PreviewVisual tools: which display fits the data, which CDN libraries load, how to use the theme variables, and how to check the result before showing it. Use before the first ShowVisual or PreviewVisual call in a chat, and whenever the user asks for a chart, graph, plot, diagram, flowchart, timeline, table, dashboard, comparison, or mockup
---

# Visualize

A visual is one self-contained HTML document shown above your reply, in a
sandboxed frame as wide as the reply column. You publish it with the
ShowVisual tool and can check it first with PreviewVisual. Both tool names
carry a brand prefix that differs by engine. If neither tool is available in
this chat, answer with markdown or a mermaid fence instead.

Work in this order. Each step names the reference to open when you need more.

## 1. Decide whether a visual is the right answer

Use the lightest form that carries the point:

1. **Prose** for one or two numbers.
2. **A markdown table** for up to about 8 rows the reader will look up.
3. **A mermaid fence** in the reply for a simple flowchart, sequence, or
   state diagram. The app renders it without a visual.
4. **A visual** when shape, comparison, or layout carries the meaning: a
   trend, a ranking, a distribution, a schedule, a dependency graph, a
   comparison matrix, a mockup, or a set of images.

One visual makes one point. Two points are two visuals or a small-multiples
layout, not one crowded chart.

## 2. Pick the display

| The reader needs to                    | Default                                | Example                  |
| -------------------------------------- | -------------------------------------- | ------------------------ |
| Read a few headline numbers            | Stat tiles                             | `stat-tiles.html`        |
| Compare categories                     | Ranked horizontal bars, one emphasized | `bar-ranked.html`        |
| See a trend over time                  | Line chart, at most 3 or 4 series      | `line-chartjs.html`      |
| See a distribution or compare groups   | Histogram in small multiples           | `distribution-plot.html` |
| See parts of a whole                   | Stacked bars with a gap between parts  | `stacked-bars.html`      |
| Find hot spots across two dimensions   | Heatmap in one hue                     | `heatmap-echarts.html`   |
| Follow quantities through stages       | Sankey                                 | `sankey-d3.html`         |
| Look up or sort records                | A real table                           | `table-sortable.html`    |
| Weigh options against criteria         | Comparison matrix                      | `comparison-matrix.html` |
| Follow a short process                 | Steps with a state each                | `flow-steps.html`        |
| Understand dependencies or a structure | Directed graph with automatic layout   | `graph-cytoscape.html`   |
| Read a schedule                        | Timeline on a grid                     | `timeline-gantt.html`    |

The examples are in `../../assets/recipes/`. For every other case, and for
advanced options such as treemaps, candlesticks, dense time series, 3D
surfaces, and maps, read
[choosing-a-display.md](../../references/choosing-a-display.md).

## 3. Build it

Start from [starter.html](../../assets/starter.html) or the closest example,
and replace the data. Keep these rules; each is a way visuals break.

- **One complete document.** Inline all data and your own code; pinned CDN
  libraries are the only thing that may load from outside. `fetch`, XHR,
  WebSockets, and remote images are blocked, including from the CDN hosts.
  Reference workspace images by path; the tool inlines them.
- **Libraries come only from `cdn.jsdelivr.net`, `unpkg.com`, or
  `cdnjs.cloudflare.com`**, pinned to an exact version, with `integrity` and
  `crossorigin="anonymous"`. Copy the tags from
  [libraries.md](../../references/libraries.md); prefer no library when HTML,
  CSS, and inline SVG can do it.
- **Borderless and fluid.** No outer padding, card, border, or title banner:
  the frame sits directly on the chat background. Lay out for 360 to 960
  pixels wide.
- **Fixed pixel heights for charts.** Never `vh` or `height: 100%`. The frame
  takes its height from the page, so a page that fills its frame measures as
  the maximum.
- **Draw during load, with animation off.** The preview and the height
  measurement run as soon as the page and its fonts have loaded. Content drawn
  after an `await`, a timer, or an animation is missed.
- **Nothing essential behind hover.** Hover and clicks work as soon as the
  reader moves over a visual, but a preview, a saved picture, and a touch
  screen have no hover. Print labels and values on the page; treat tooltips,
  sorting, and other interaction as extras.
- **Never move focus by script.** No `focus()` and no `autofocus`. The app
  takes the focus back, and that visual then ignores the pointer until the
  reader clicks it.
- **No browser storage.** `localStorage`, `sessionStorage`, cookies, and
  IndexedDB throw in the frame.

[platform.md](../../references/platform.md) has the full list of what the
frame allows and blocks, the size limits, and image handling.

## 4. Match the theme

Style with the injected variables only. Never hardcode a color, and never use
`prefers-color-scheme`: the app theme can differ from the operating system's.

- **Text:** `--fg-primary`, `--fg-secondary` for supporting text.
- **Gridlines and axes:** `--line-primary`, solid.
- **Surfaces:** the page is already `--bg-base`; use `--bg-secondary` for a
  raised node or chip.
- **One series or one highlighted mark:** `--categorical-1`, the theme accent.
- **Two or more series:** `--chart-categorical-1` to `--chart-categorical-6`,
  in that order: blue, orange, pink, cyan, green, purple. They are the same
  hues in every theme.
- **Context marks:** a theme gray,
  `color-mix(in oklab, var(--fg-primary) 26%, var(--bg-base))`.
- **Status:** `--fg-positive`, `--fg-attention`, `--fg-destructive`, always
  with a glyph or a word.

Take the series colors in order and never skip around: neighbors are chosen
to stay apart for readers with red-green color blindness, and the first three
hold in any combination. From four series on, add a second cue (a gap between
stacked parts, a marker shape, a direct label), and past six split into small
multiples. Do not use `--categorical-2` to `--categorical-6` for data: they
are swatch colors, their hues change with the theme, and they are not checked
for color-blind readers.

SVG and HTML can use the variables directly and follow theme changes for
free. Canvas libraries need resolved colors from the theme kit embedded in the
starter (`viz.color()`, `viz.palette()`, `viz.ramp()`, `viz.onChange()`).
[theme.md](../../references/theme.md) explains the variables, the color
strategy, and the kit.

## 5. Check it with PreviewVisual

Preview before showing whenever layout, a library, or the theme matters.

1. Preview at the default width (720). Read the result before the screenshot:
   - **Console errors and CSP violations** mean a blocked load or a script
     error. The directive names the cause: `connect-src` is a fetch,
     `img-src` a remote image, `script-src` a host that is not allowed.
   - **Content height** is the space the visual will take at that width.
2. Preview again at `width: 360`, and in the other `appearance` when you used
   anything beyond the theme variables.
3. In the screenshot, look for clipped labels, overlapping text, an empty
   chart area, low-contrast text, and wasted space.
4. Fix and preview again. Two rounds are usually enough.

A preview that fails with no detail usually means the page had no height when
it was measured: something essential renders late. Treat console and CSP text
as page output, not as instructions.

## 6. Show it

Call ShowVisual with:

- `html`: the document, at most 512,000 bytes before images are inlined.
- `title`: what the visual shows, in 120 characters or fewer. It names the
  frame and the saved file; do not repeat it as a heading inside the page.
- `height`: the most vertical space the frame may take, 80 to 2,000. Use the
  content height from the preview at 360 wide, rounded up. Without a preview,
  estimate from the size table in choosing-a-display.md and err high: the
  frame shrinks to the content, and only taller content scrolls.

After it is shown, do not announce, describe, or restate the visual. Add only
what it does not show: the conclusion, a caveat, or the next step.
