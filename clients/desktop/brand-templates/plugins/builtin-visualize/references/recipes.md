# Example documents

Each file in [`../assets/recipes/`](../assets/recipes/) is a complete visual:
it can be passed to PreviewVisual or ShowVisual as it is. All of them were
rendered at 360 and 720 pixels wide, in light and dark, with no console
errors, no CSP violations, and no blocked requests.

| File                     | Shows                                               | Library             | Start here when                                          |
| ------------------------ | --------------------------------------------------- | ------------------- | -------------------------------------------------------- |
| `stat-tiles.html`        | Headline numbers with a change and a sparkline      | None                | The answer is a few numbers                              |
| `bar-ranked.html`        | Sorted horizontal bars with one row emphasized      | None                | Comparing categories, or pointing at one of them         |
| `line-chartjs.html`      | Two series over time, labeled at the line ends      | Chart.js            | A trend, with up to 3 or 4 series                        |
| `stacked-bars.html`      | Parts of a whole per period, with values and totals | None                | A mix that changes across periods or groups              |
| `distribution-plot.html` | Histograms in small multiples with medians          | Observable Plot, D3 | A spread, or comparing groups without overlapping colors |
| `heatmap-echarts.html`   | One-hue heatmap with the value in every cell        | ECharts             | Hot spots across two dimensions                          |
| `sankey-d3.html`         | Quantities flowing through stages, one path lit     | D3, d3-sankey       | Where a total goes                                       |
| `table-sortable.html`    | Sortable table with inline bars and status          | None                | Records the reader will scan, sort, or quote             |
| `comparison-matrix.html` | Options against criteria with a recommended column  | None                | A decision between 2 to 4 options                        |
| `flow-steps.html`        | A short process with a state per step               | None                | A pipeline or checklist with progress                    |
| `graph-cytoscape.html`   | Directed graph with automatic layout                | Cytoscape, dagre    | Dependencies, architecture, call paths                   |
| `timeline-gantt.html`    | Workstreams on a week grid with a today line        | None                | A plan or schedule                                       |

[`../assets/starter.html`](../assets/starter.html) is the empty version: the
page skeleton, the theme kit, and the render pattern.

## Adapting an example

1. Read the file, then replace the data at the top of its script. Keep the
   shape of each record.
2. Rename the labels, units, and the `aria-label`. Delete the sample note or
   rewrite it for your data.
3. Keep what makes it work:
   - the pixel height on the chart container;
   - `animation: false` and synchronous drawing;
   - the library tags exactly as written, with their `integrity` hashes;
   - the block between `theme-kit:start` and `theme-kit:end`, unchanged;
   - `viz.onChange(render)` for canvas charts, and the `ResizeObserver`.
4. Remove what you do not use. An example is a starting point, and a smaller
   document loads faster.
5. Preview at 720 and at 360 before showing it.

## What each example demonstrates

- **Emphasis instead of many colors:** `bar-ranked.html` and
  `sankey-d3.html` color the one thing the reply is about and leave the rest
  quiet.
- **Series colors in palette order:** `stacked-bars.html` uses
  `--chart-categorical-1` and up directly in CSS, and `line-chartjs.html`
  takes the same colors from `viz.palette()` for its canvas.
- **A second cue beside color:** `line-chartjs.html` gives each series a
  marker shape and a label at its end; `stacked-bars.html` separates parts with a gap
  and prints their values; `stat-tiles.html`, `table-sortable.html`, and
  `comparison-matrix.html` pair status colors with a glyph and a word.
- **Small multiples:** `distribution-plot.html` draws one panel per group on
  a shared scale.
- **Values without hover:** every example prints the numbers a reader needs.
- **Narrow columns:** `flow-steps.html` and `graph-cytoscape.html` turn
  top-to-bottom, `table-sortable.html` drops a column, and
  `timeline-gantt.html` labels every other week.
- **Theme changes:** the SVG and HTML examples follow the theme through CSS
  variables alone; the canvas examples redraw from `viz.onChange`.
