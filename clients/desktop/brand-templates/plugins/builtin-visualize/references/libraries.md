# Libraries on the allowed CDNs

Scripts, stylesheets, and fonts load only from these three hosts:

| Host                           | URL pattern                                              |
| ------------------------------ | -------------------------------------------------------- |
| `https://cdn.jsdelivr.net`     | `/npm/<package>@<version>/<file>`                        |
| `https://unpkg.com`            | `/<package>@<version>/<file>`                            |
| `https://cdnjs.cloudflare.com` | `/ajax/libs/<name>/<version>/<file>` (not every package) |

jsDelivr and unpkg mirror npm, so the same package, version, and file path
work on both, and the same `integrity` hash applies. Every tag below uses
jsDelivr.

This guide covers what is different inside the frame: which files load, how
to theme each library, and what to switch off. Each library's own API is
unchanged, so use it as you normally would.

## Rules for every library tag

- **Pin the exact version.** `chart.js@4.5.1`, never `chart.js`, `@4`, or
  `@latest`: an unpinned URL changes under a saved visual.
- **Add `integrity` and `crossorigin="anonymous"`.** The hash stops a changed
  file from running. Copy the tags below unchanged.
- **Classic `<script src>` tags, in order, before your inline script.** They
  finish loading before the page is measured.
- **Only code loads.** A data file on a CDN (JSON, CSV, TopoJSON) cannot be
  fetched or imported. Inline the data.
- **Prefer no library.** HTML, CSS, and inline SVG draw tiles, bars,
  sparklines, tables, timelines, and short flows with nothing to download.

For a file that is not listed, compute the hash from the exact URL and check
the result with PreviewVisual:

```bash
curl -sL "https://cdn.jsdelivr.net/npm/<package>@<version>/<file>" \
  | openssl dgst -sha384 -binary | openssl base64 -A
```

Prefix the output with `sha384-`. If a hash is wrong, the preview's console
names the hash it computed. A wrong version or path fails silently, and the
first sign is `<Library> is not defined`.

Do not load libraries with `import`. A module URL has nowhere to carry an
`integrity` hash, so it would run unchecked code; use a package's browser
build in a classic `<script src>` tag instead.

## Default choices

Reach for these first. Sizes are the download before compression; the CDN
compresses to roughly a third.

### Chart.js 4.5.1 — standard charts (204 KB)

Line, area, bar, stacked bar, scatter, bubble, doughnut, radar. Draws on
canvas; global `Chart`. Example: `line-chartjs.html`.

```html
<script
  src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js"
  integrity="sha384-jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ"
  crossorigin="anonymous"
></script>
```

- Wrap the canvas in a `position: relative` container with a pixel height,
  and set `maintainAspectRatio: false` and `animation: false`.
- Colors come from the theme kit; see [theme.md](theme.md).
- A time axis (`type: 'time'`) needs a date adapter, and labels on the marks
  need the data labels plugin (pass it in `plugins: [ChartDataLabels]`):

```html
<script
  src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"
  integrity="sha384-cVMg8E3QFwTvGCDuK+ET4PD341jF3W8nO1auiXfuZNQkzbUUiBGLsIQUE+b1mxws"
  crossorigin="anonymous"
></script>
<script
  src="https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js"
  integrity="sha384-y49Zu59jZHJL/PLKgZPv3k2WI9c0Yp3pWB76V8OBVCb0QBKS8l4Ff3YslzHVX76Y"
  crossorigin="anonymous"
></script>
```

### Observable Plot 0.6.17 with D3 7.9.0 — statistical charts (477 KB)

Histograms, dot and box plots, small multiples, heatmap cells, regression
lines, in a few lines each. Draws SVG, so theme variables work directly and
follow theme changes with no code; globals `Plot` and `d3`. Load D3 first.
Example: `distribution-plot.html`.

```html
<script
  src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"
  integrity="sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i"
  crossorigin="anonymous"
></script>
<script
  src="https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.17/dist/plot.umd.min.js"
  integrity="sha384-JUpn2GgRr0gxU0xOBd8D8P634jhRCwobtG8G2MMEkX1RnGJ7/FJNnuukpfT+H2w1"
  crossorigin="anonymous"
></script>
```

- Pass `width: document.body.clientWidth` and a pixel `height`, and redraw
  when the width changes.
- D3 alone covers anything bespoke: hierarchies, force layouts, chords, and
  maps from inline GeoJSON with `d3.geoPath`.

## Advanced charts

### ECharts 6.1.0 — the widest range (1.1 MB)

Heatmap and calendar, treemap, sunburst, sankey, funnel, graph, candlestick,
box plot, parallel coordinates, gauge, radar, maps from inline GeoJSON
(`echarts.registerMap`), and large data sets. Global `echarts`. Example:
`heatmap-echarts.html`.

```html
<script
  src="https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js"
  integrity="sha384-C2iskrW/uPW46KzOjrvJIQo4YkV8lkD+QS0CrDN18IIPIpT/g2USu8bTP3nvmIAD"
  crossorigin="anonymous"
></script>
```

- `echarts.init(element, null, { renderer: 'svg' })` and `animation: false`.
- It ships its own colors. Set text, axis, and series colors from the theme
  kit, and call `chart.resize()` from a `ResizeObserver`.

### d3-sankey 0.12.3 — flows between stages (6 KB, with D3)

Adds `d3.sankey()`. Load after D3. Example: `sankey-d3.html`.

```html
<script
  src="https://cdn.jsdelivr.net/npm/d3-sankey@0.12.3/dist/d3-sankey.min.js"
  integrity="sha384-SM54CE5h+qdDI046d2Y5ym7wq1kq4uxcQ1cqGq5/+5jrE5tPLeDJSq711Q8sIska"
  crossorigin="anonymous"
></script>
```

### uPlot 1.6.32 — dense time series (50 KB)

Tens of thousands of points on canvas with little code. Global `uPlot`. Its
stylesheet is small and neutral.

```html
<link
  rel="stylesheet"
  href="https://cdn.jsdelivr.net/npm/uplot@1.6.32/dist/uPlot.min.css"
  integrity="sha384-IfV0B7MIOYuO95kO9G5ySKPz/85zqFNOAs8iy4tkK5zd9izhJAB8b7lHrwYqqmYE"
  crossorigin="anonymous"
/>
<script
  src="https://cdn.jsdelivr.net/npm/uplot@1.6.32/dist/uPlot.iife.min.js"
  integrity="sha384-Gx3t0zdBAuQOuvvmaLZj7HKEiSgWTAs+VdtNY7wt19QDPTDQjFIwAuXDj0zeN00c"
  crossorigin="anonymous"
></script>
```

- Pass `width` and `height` in pixels and set `legend: { show: false }`
  unless you style the legend.

### Vega-Lite 6.5.0 — charts from a JSON spec (820 KB)

Layered, faceted, and aggregated charts described as data. Global
`vegaEmbed`. Use it when you already think in a grammar of graphics; Plot is
lighter for the same charts.

```html
<script
  src="https://cdn.jsdelivr.net/npm/vega@6.4.0/build/vega.min.js"
  integrity="sha384-VKdcJr3ZaBIJMbVcopTAI/JEuUkSY6qnwVu9iLuw0DnQ9gQ1JjsfZJhXFQAgNi43"
  crossorigin="anonymous"
></script>
<script
  src="https://cdn.jsdelivr.net/npm/vega-lite@6.5.0/build/vega-lite.min.js"
  integrity="sha384-pV2l7nzmyxZh02knvUH7N8zvtyCYsYiGt+SsE/emG/dFiBI6G0YJZFZ2FzEX72P3"
  crossorigin="anonymous"
></script>
<script
  src="https://cdn.jsdelivr.net/npm/vega-embed@7.3.0/build/vega-embed.min.js"
  integrity="sha384-Muy1QRxYFeNrA1zShc1KtN4OfipkR/61gt+HWqN57c1Zxu3Oe16TsilsruVVjfKL"
  crossorigin="anonymous"
></script>
```

- Put the rows in `data.values`. A `data.url` is a fetch and is blocked.
- `vegaEmbed(element, spec, { actions: false, renderer: 'svg' })`.

### Lightweight Charts 5.2.1 — prices (193 KB)

Candlesticks, bars, and baseline series on a time scale. Global
`LightweightCharts`.

```html
<script
  src="https://cdn.jsdelivr.net/npm/lightweight-charts@5.2.1/dist/lightweight-charts.standalone.production.js"
  integrity="sha384-KkYqTZlM13Zya6fVUF3IGCBOQ1ehFeJVVgxaVvD/0MebineF9EI8Jkd3NnWNChqN"
  crossorigin="anonymous"
></script>
```

- `createChart(element, { autoSize: true, layout: { attributionLogo: false } })`,
  then `chart.addSeries(LightweightCharts.CandlestickSeries, options)`.

### Plotly 4.1.2 — 3D and scientific (4.6 MB)

Surfaces, 3D scatter, contours, violins, ternary plots. Global `Plotly`. It
is the heaviest library here and takes seconds to load the first time; use
it only when nothing lighter draws the chart.

```html
<script
  src="https://cdn.jsdelivr.net/npm/plotly.js-dist-min@4.1.2/plotly.min.js"
  integrity="sha384-hHv6D3tTUUBpp4tVv6t2Dc3oGuRhphmWOTKUR8jWyN0Pnon1g3iebKCNDNmKmxo8"
  crossorigin="anonymous"
></script>
```

- Pass `{ displayModeBar: false }` as the config. Its map traces fetch
  geometry and do not work.

## Diagrams and graphs

A mermaid fence in the reply is the default for a simple diagram and needs no
visual. Use these when the diagram must be themed, sized, or combined with
other content.

### Cytoscape 3.34.3 with dagre — directed graphs (747 KB)

Dependency graphs, architecture, state machines, and networks, with automatic
layout. Global `cytoscape`; the dagre layout registers itself. Example:
`graph-cytoscape.html`.

```html
<script
  src="https://cdn.jsdelivr.net/npm/cytoscape@3.34.3/dist/cytoscape.min.js"
  integrity="sha384-qPKQxl9uMXOw7vSTUDAnpUilhLuulovw6P5Z4db4bqxW5VhumS7przEmHX0iM0Oc"
  crossorigin="anonymous"
></script>
<script
  src="https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js"
  integrity="sha384-2IH3T69EIKYC4c+RXZifZRvaH5SRUdacJW7j6HtE5rQbvLhKKdawxq6vpIzJ7j9M"
  crossorigin="anonymous"
></script>
<script
  src="https://cdn.jsdelivr.net/npm/cytoscape-dagre@4.0.1/dist/cytoscape-dagre.min.js"
  integrity="sha384-CIu9EFddQ0GplFvevqHZ1sIPo1IRXFvxHd0A6jaJ3m052fy+mDfer/ItnvIS5uY3"
  crossorigin="anonymous"
></script>
```

- `layout: { name: 'dagre', rankDir: 'LR', animate: false }`. The built-in
  `cose`, `breadthfirst`, and `concentric` layouts need no extension.
- Turn off zooming and panning so the graph reads as a figure.

### Mermaid 12.1.0 — diagrams from text (5.2 MB)

Flowcharts, sequence, state, class, entity, and gantt diagrams. Global
`mermaid`. Large: prefer the fence in the reply.

```html
<script
  src="https://cdn.jsdelivr.net/npm/mermaid@12.1.0/dist/mermaid.min.js"
  integrity="sha384-EbBpjO7rlR6eqZEcG7GaPpyk9H9WrMyPWX4d3KvPYltgt8Z8l0z6R56B1qP40pR4"
  crossorigin="anonymous"
></script>
```

- `mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'base', themeVariables })`,
  then `mermaid.run()`. Fill `themeVariables` from the theme kit; see
  [theme.md](theme.md).

### ELK 0.12.0 — layout only (1.5 MB)

Computes positions for large layered diagrams with ports and nested groups;
you draw the result as SVG. Global `ELK`. `new ELK().layout(graph)` returns a
promise, so reserve the height in CSS.

```html
<script
  src="https://cdn.jsdelivr.net/npm/elkjs@0.12.0/lib/elk.bundled.js"
  integrity="sha384-ww57TDqx4cGknIavPm0QKO+aygLUR1BLSn2Vhbnt1XdYKWcwLyWTFKX7aZMaKIi2"
  crossorigin="anonymous"
></script>
```

## Tables

A plain `<table>` styled with theme variables is the default; see
`table-sortable.html` and `comparison-matrix.html`.

### Tabulator 6.6.1 — large or interactive tables (472 KB)

Thousands of rows with virtual scrolling, grouping, frozen columns, and
column totals. Global `Tabulator`. A plain table in a fixed-height scroller
is simpler up to a few hundred rows.

```html
<link
  rel="stylesheet"
  href="https://cdn.jsdelivr.net/npm/tabulator-tables@6.6.1/dist/css/tabulator_simple.min.css"
  integrity="sha384-845p0lFU615QIduQrRBstSh/4oeH8AntnsjQxQorupjL89uYj3JAryzqwGRHHsT3"
  crossorigin="anonymous"
/>
<script
  src="https://cdn.jsdelivr.net/npm/tabulator-tables@6.6.1/dist/js/tabulator.min.js"
  integrity="sha384-G2ks3Wc8ERwZQbUnD+D54IZmFUlgMENIYP7tgDtz5ANc7yNyu+z0+4qn7Iit8jsH"
  crossorigin="anonymous"
></script>
```

Give the table a pixel `height` in its options. Its stylesheet is light-only,
so add this after it:

```css
.tabulator,
.tabulator .tabulator-header,
.tabulator .tabulator-header .tabulator-col,
.tabulator .tabulator-tableholder .tabulator-table,
.tabulator-row,
.tabulator-row.tabulator-row-even,
.tabulator .tabulator-footer {
  background: transparent;
  color: var(--fg-primary);
  border-color: var(--line-primary);
  font: 13px var(--font-sans);
}
.tabulator .tabulator-header {
  border-bottom: 1px solid var(--line-primary);
  color: var(--fg-secondary);
  font-weight: 500;
}
.tabulator .tabulator-header .tabulator-col {
  border-right: 0;
}
.tabulator-row .tabulator-cell {
  border-right: 0;
  border-bottom: 1px solid var(--line-primary);
}
.tabulator-row.tabulator-selectable:hover {
  background: var(--bg-subtle);
}
.tabulator
  .tabulator-col
  .tabulator-col-content
  .tabulator-col-sorter
  .tabulator-arrow {
  border-top-color: var(--fg-quaternary);
  border-bottom-color: var(--fg-quaternary);
}
```

Its download and clipboard features do not work in the frame.

### simple-datatables 10.3.0 — search and paging (107 KB)

Upgrades an existing `<table>` with search, sorting, and pages. Global
`simpleDatatables`. Its stylesheet inherits the page colors, so it needs no
override.

```html
<link
  rel="stylesheet"
  href="https://cdn.jsdelivr.net/npm/simple-datatables@10.3.0/dist/style.css"
  integrity="sha384-CinX6s1UC1GpaQwL9eKshF7JhtC8H2xchDD0dWqlCgZ8t+GCCcjluxCgmsbVpdEh"
  crossorigin="anonymous"
/>
<script
  src="https://cdn.jsdelivr.net/npm/simple-datatables@10.3.0/dist/umd/simple-datatables.js"
  integrity="sha384-OMR/OfeQC/fStE5yr0SBMKPPfMHctC+Ebr+QVzjdXw1FqbB0iBKgFkrAzvjhYByo"
  crossorigin="anonymous"
></script>
```

## Also checked

These load and run in the frame. They have no example here.

| Library               | For                               | Notes                                                                                  |
| --------------------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| KaTeX 0.19.0          | Math                              | `katex.min.js` and `katex.min.css` under `/npm/katex@0.19.0/dist/`; its fonts load too |
| vis-timeline 8.5.4    | Zoomable timelines                | Stylesheet is light-only; restyle items and axes with theme variables                  |
| vis-network 10.1.2    | Networks with physics             | Cytoscape covers the same ground with less to restyle                                  |
| topojson-client 3.1.0 | Decoding inline TopoJSON for maps | The TopoJSON itself must be inline                                                     |

## Checked and not recommended

- **Grid.js 6.2.0:** fills in its rows after the page is measured, so a
  preview shows a table with no rows, and its stylesheet is light-only.
- **Frappe Gantt 1.2.2:** light-only stylesheet with fixed colors throughout.
  Use `timeline-gantt.html`.
- **Leaflet, MapLibre, and other tile maps:** tiles are remote images and
  fetches, which the frame blocks.
- **three.js:** current versions ship only as ES modules, which cannot carry
  an `integrity` hash. WebGL works in the frame; use Plotly for 3D charts.

## Using another library or version

Nothing stops you from loading another package from the three hosts. Check
it the same way these were checked:

1. Pin the version and compute the hash.
2. Run PreviewVisual in light and dark.
3. Read the console and the CSP violations. A library that fetches, stores
   settings, or loads a worker by URL fails there.
4. Look at the screenshot for an empty area (it draws late) and for white
   boxes in dark (its own stylesheet).

The versions above were checked in the preview renderer in light and dark on
2026-10-09.
