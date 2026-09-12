# Project brief: Packed-Circle Venn — Splunk Dashboard Studio extension

## Who's building this
Daniel — Splunk admin/dev, SplunkTrust member, leads the Melbourne Splunk User
Group. Builds custom Splunk Dashboard Studio visualizations as Splunkbase apps
using the `@splunk/dashboard-studio-extension` CLI framework (not the classic
`SplunkVisualizationBase` API).

## Existing apps (for reference / consistency)
- **Sankey Viz** — shipped on Splunkbase (app id 7977), 5-star rating,
  1000+ downloads. Most recent shipped app; useful as the template for build
  tooling, packaging, and options-panel conventions.
- Network Diagram Viz, Event Timeline Viz (built on `vis-timeline`, had to
  solve an HTML-sanitization issue affecting Font Awesome icon rendering),
  Olly Dashboard Cloner, YAML Validator — earlier Splunkbase apps.
- A FullCalendar-based (`@fullcalendar/react` v7) calendar visualization is
  also in progress separately — has its own dark/light theming and
  `VisualizationAPI.addOptionsListener` patterns worth reusing if this app
  needs live options updates.

## What this app is
A hybrid visualization: a **3-set Venn diagram** (via `venn.js`, built on D3)
where each region is filled with **individually packed mini-circles**, one
per entity (host), rather than just a number. Dot size can encode a secondary
metric (e.g. alert volume). Think "Venn diagram meets beeswarm/circle-pack."

**Use case (current prototype)**: security event correlation — sets are
"Failed logins", "Malware alerts", "Firewall blocks"; each dot is a host;
overlapping regions show hosts hit by multiple signals, which is the
actionable triage insight.

**Known constraint**: true proportional Venn geometry only works for 2–3
sets. This is a narrower, specialized viz (like a correlation/overlap tool),
not a general-purpose chart type — don't try to generalize past 3 sets.

## SPL shape this needs to consume
```spl
| eval in_A=if(<condition_A>, 1, 0)
| eval in_B=if(<condition_B>, 1, 0)
| eval in_C=if(<condition_C>, 1, 0)
| stats max(in_A) as in_A, max(in_B) as in_B, max(in_C) as in_C, count as alerts by host
```
This gives one row per entity with region membership flags + an optional
secondary metric (alerts) for dot sizing. The viz needs to group rows into
the 7 possible region combinations (A / B / C / A,B / A,C / B,C / A,B,C).

## Prototype status
A working HTML/D3/venn.js prototype exists (browser-only, not yet ported to
the Dashboard Studio extension scaffolding). It went through several rounds
of debugging — the fixes below are load-bearing and should carry over
directly into the extension, not get re-derived:

### 1. `venn.js` circle geometry is private — must be recomputed manually
`venn.js`'s `VennDiagram()` chart never exposes its final scaled circle
geometry (not on the datum, not on the DOM). Its actual internal pipeline is:
```js
let solution = venn.venn(vennSets);
solution = venn.normalizeSolution(solution, Math.PI/2, null); // easy to miss — reorients the whole layout
const circles = venn.scaleSolution(solution, width, height, padding); // default padding: 15
```
**Skipping `normalizeSolution` was the root cause of a bug** where computed
containment geometry didn't match what was actually drawn (dots scattered
outside their circles) — sizes were right but orientation was wrong. All
three steps are required, with matching `width`/`height`/`padding` to
whatever `VennDiagram()` was configured with.

### 2. Containment needs an iterative constraint solver, not a single pass
Checking "inside A, inside B, outside C" once per tick in sequence lets
fixing one boundary re-break another (classic Gauss-Seidel problem). Fix:
run the same clamp function ~6 times per node per tick. Validated numerically
(see below) at 0 constraint violations across 116 synthetic hosts.

### 3. Seed positions via rejection sampling, not centroid + jitter
Guessing a starting position near a region's centroid means the simulation
has to migrate nodes across boundaries, which is unreliable. Instead: sample
random points within the bounding box of the node's *included* circles,
test against all 3 constraints, retry until valid (with an iterative-clamp
fallback after ~400 attempts for degenerate cases). This means the
simulation only has to resolve collisions, not fix containment from scratch.

### 4. Region density must be capped via Monte Carlo area estimation
Thin crescent regions (e.g. "A only" when A overlaps heavily with B and C)
have real, limited area. If the requested dot count doesn't geometrically
fit, dots must shrink — not spill outside the boundary. Approach: sample
~40k random points across the canvas, classify each into a region by
circle-membership, use the ratio to estimate each region's real area, then
scale dot radius down (with a packing-efficiency factor of ~0.82) if
requested dot area exceeds capacity.

### Verification method (worth reusing before trusting any future change)
Before trusting any fix to this containment logic, it was verified in a
**headless Node harness** using the actual `venn.js` and `d3-force` npm
packages (not just visual inspection or re-reasoning about the code):
seed all hosts, run the simulation for a few hundred ticks, then assert
zero constraint violations and zero significant dot-dot overlaps. This
caught two distinct real bugs that "looks right" reasoning missed. Recommend
keeping this kind of numeric check as part of the extension's test setup,
since the geometry is easy to silently break during refactors.

## Current visual/UX design (validated, described as "more Splunk-like")
- Dark theme: `--bg:#0d1117`, `--panel:#121820`, `--line:#263140`,
  `--text:#d5dde5`, `--muted:#7c8a99`, category colors
  `--a:#5fb3d9` (blue), `--b:#d9a441` (amber), `--c:#d9564f` (red)
- Base Venn circles rendered as faint outlines only (backdrop), not filled —
  the dots are the data now, not the regions
- Legend: color swatch + category name only (no set-combination swatches —
  overlaps are visually obvious from the diagram itself)
- **Legend position should be a configurable option** (top/bottom/left/right)
  in the eventual options panel. The prototype's CSS already anticompiles for
  this: a `.viz-wrap` wrapper takes a `legend-bottom` / `legend-top` /
  `legend-left` / `legend-right` class that flips `flex-direction`; adding
  the option panel control just needs to toggle that class.
- No extra chrome: no descriptive sidebar cards, no "insight" callout box,
  no footer hint text — just title, diagram, legend.
- Dot hover tooltip: entity id, which sets it belongs to, secondary metric.

## Suggested next steps in this session
1. Set up `@splunk/dashboard-studio-extension` scaffolding (Daniel is doing
   this before this session starts).
2. Port the prototype's D3/venn.js logic into the extension's render function.
3. Wire real SPL result data into the region-membership + host generation
   logic (replacing the synthetic `regionCounts` object).
4. Build the options panel: field mappings for sets A/B/C, category colors,
   legend position, optional secondary-metric field for dot sizing.
5. Re-run the headless containment verification against real data shapes
   before considering it done — thin/skewed real-world set sizes may stress
   the density-capping logic differently than the synthetic test did.
