# Choosing a display

Pick the display from what the reader has to do with the data, before
thinking about libraries or color.

## Is it a visual at all?

| The answer is                                        | Use                           |
| ---------------------------------------------------- | ----------------------------- |
| One or two numbers                                   | A sentence                    |
| Up to about 8 rows to look up                        | A markdown table in the reply |
| A simple flow, sequence, or state diagram            | A mermaid fence in the reply  |
| A shape: trend, ranking, spread, schedule, structure | A visual                      |
| Many exact values the reader will sort or scan       | A visual with a table         |

A chart with one bar, a pie with two slices, or a gauge for one number is a
stat tile. A chart nobody needs to compare anything in is a sentence.

## The display for each job

"Default" is the form to reach for first, with the example to adapt.
"Advanced" lists what to use when the default does not fit; the libraries are
in [libraries.md](libraries.md).

| The reader needs to                     | Default                                                                            | Advanced options                                                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Read a few headline numbers             | Stat tiles with a change and a sparkline: `stat-tiles.html`                        | A meter for one ratio against a limit, in HTML and CSS                                                                                |
| Compare categories                      | Horizontal bars, sorted, one emphasized: `bar-ranked.html`                         | Grouped bars for 2 measures (Chart.js); dot plot or dumbbell for before and after (Observable Plot)                                   |
| See a trend over time                   | Line chart with labels at the line ends: `line-chartjs.html`                       | Area for one series; small multiples for 5 or more series (Plot); uPlot beyond a few thousand points                                  |
| See parts of a whole                    | Stacked horizontal bars, one per period or group: `stacked-bars.html`              | Treemap or sunburst for a hierarchy (ECharts); stacked area over time (Chart.js)                                                      |
| See a distribution                      | Histogram: `distribution-plot.html`                                                | Box or violin plots to compare many groups (Plot, Plotly); a strip of dots for under 200 values (Plot)                                |
| Relate two measures                     | Scatter plot (Chart.js or Plot)                                                    | Bubble for a third measure; hexbin or density for many points (Plot); regression line (Plot)                                          |
| Find hot spots across two dimensions    | Heatmap in one hue with values printed: `heatmap-echarts.html`                     | Calendar heatmap (ECharts); the `cell` mark in Plot                                                                                   |
| Follow quantities through stages        | Sankey: `sankey-d3.html`                                                           | Funnel as sorted bars with the drop between them; ECharts `sankey` or `funnel`                                                        |
| Read a hierarchy                        | Indented list or nested HTML                                                       | Tree, treemap, sunburst, or circle packing (ECharts, D3). Area already shows size, so color a treemap in one hue and label the groups |
| Follow a short process                  | Steps with a state each: `flow-steps.html`                                         | A mermaid fence for branches; ELK or dagre layout for large flows                                                                     |
| Understand dependencies or architecture | Directed graph with automatic layout: `graph-cytoscape.html`                       | A mermaid fence for under about 12 nodes; force layout for undirected networks (Cytoscape, D3)                                        |
| Follow messages between parties         | A mermaid `sequenceDiagram` fence in the reply                                     | Mermaid inside a visual when it must sit beside other content                                                                         |
| Read a schedule                         | Timeline on a grid: `timeline-gantt.html`                                          | A mermaid `gantt` fence; vis-timeline for a zoomable timeline                                                                         |
| Weigh options against criteria          | Matrix with a glyph and a few words per cell: `comparison-matrix.html`             | Radar chart only for 3 or fewer options on comparable scales (Chart.js)                                                               |
| Look up or sort records                 | A real table, in a fixed-height scroller past about 12 rows: `table-sortable.html` | Tabulator past about 1,000 rows, or for grouping and frozen columns; simple-datatables for search and paging                          |
| See prices over time                    | Line chart                                                                         | Candlesticks (Lightweight Charts)                                                                                                     |
| See values on a map                     | Sorted bars by region. A map only when geography is the point                      | D3 `geoPath` or ECharts `map` with inline GeoJSON. Tile maps cannot load                                                              |
| See a surface or 3D data                | Heatmap or small multiples                                                         | Plotly `surface` or `scatter3d`. It is a 4.6 MB download; use it only when depth is the point                                         |
| Read formulas                           | Unicode and HTML `<sup>` and `<sub>`                                               | KaTeX                                                                                                                                 |
| Judge a layout or UI idea               | Mockup in HTML and CSS with theme variables                                        | —                                                                                                                                     |
| Compare images                          | CSS grid of `<figure>` with captions, workspace image paths                        | A before and after pair side by side at the same size                                                                                 |

## Rules that hold for every display

- **One point per visual.** Say it in the reply; the visual is the evidence.
- **Sort bars** by value unless the categories have a natural order. Start
  bar axes at zero.
- **One scale per chart.** Never two y-axes. For two measures of different
  size, use two charts stacked on a shared x-axis, or index both to 100.
- **Name every series.** Label a line at its end and a bar beside it. Use a
  legend where direct labels do not fit, such as stacked parts. Two or more
  series always get one or the other.
- **Few colors.** One accent plus gray answers most questions. The theme has
  six series colors; see [theme.md](theme.md) for how to use them.
- **Small multiples beat spaghetti.** Five lines in one plot become five
  small panels on one scale.
- **Avoid pies and donuts** unless there are 2 to 4 slices with clearly
  different sizes and the point is a share of the whole. Never 3D effects,
  gradients, or shadows on marks.
- **Show the number when it matters.** If the reader will quote a value,
  print it: in the cell, on the bar, or in a table under the chart. For a
  line, print the values that carry the point (the peak, the latest, the
  change), not every point.
- **Ordered categories keep their order.** Weekdays, stages, and sizes are
  not sorted by value.
- **Time runs left to right**, with even spacing for even intervals.
- **Round for reading.** `48.2k`, `182 ms`, `0.4%`. Put the unit in the label
  or the note, once.

## Size

The frame is 360 to 960 pixels wide. Design for about 600, then check 360.

| Display             | Height to plan for                                |
| ------------------- | ------------------------------------------------- |
| Stat tiles          | About 100 in one row; they wrap on narrow columns |
| Horizontal bars     | 24 to 30 per row                                  |
| Line, area, scatter | 240 to 320                                        |
| Small multiples     | 90 to 120 per panel                               |
| Heatmap             | 36 to 56 per row, plus the axis                   |
| Table               | About 36 per row; let more than 12 rows scroll    |
| Graph               | 240 to 400, taller when it lays out top to bottom |

On a narrow column, drop the least important table column, show every other
axis label, and turn a left-to-right flow into a top-to-bottom one. The
examples show each of these. Do not let the page scroll sideways.

## When the data is large

- Aggregate before you draw: bins, percentiles, top 10 plus "Other".
- Canvas (Chart.js, uPlot, ECharts) draws thousands of points; SVG slows
  past a few thousand marks.
- The document is limited to 512,000 bytes. A long series as a JSON array of
  numbers is compact; repeated object keys are not.
- If the reader needs every row, a table with a fixed height and a sticky
  header holds more than a chart can. A plain table handles a few hundred
  rows; it needs no library until the row count or the features outgrow it.
