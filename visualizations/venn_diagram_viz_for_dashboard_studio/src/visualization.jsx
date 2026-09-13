import { VisualizationAPI } from '@splunk/dashboard-studio-extension';
import {
    useDataSources,
    useDimensions,
    useOptions,
    useTheme,
} from '@splunk/dashboard-studio-extension/react';
import * as d3 from 'd3';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as venn from 'venn.js';
import './visualization.css';

// Fixed 3-set design — true proportional Venn geometry only works for 2-3
// sets, so this is intentionally not generalized past A/B/C.
const REGION_KEYS = ['A', 'B', 'C'];
const PAIR_COMBOS = [
    ['A', 'B'],
    ['A', 'C'],
    ['B', 'C'],
];
const TRIPLE_COMBO = ['A', 'B', 'C'];

// Category names/colors: the category NAMES are discovered from the data
// itself now (see discoverCategoryNames) rather than configured — A/B/C are
// purely internal bookkeeping slots colors and layout hang off of. Explicit
// naming/color overrides will move into the options panel later.
const CATEGORY_COLORS = { A: '#5fb3d9', B: '#d9a441', C: '#d9564f' };

// Row shapes are positional EXCEPT for `value`/`tooltip`: if a field is
// literally named one of those (case-insensitive), that column is used
// regardless of where it sits, and only the remaining columns (item +
// 1-3 categories) are read by position. Neither, either, or both may be
// named — whatever's left over always reads as item first, then
// categories, then (only for whichever of value/tooltip ISN'T named) that
// field last, in that order:
//   item, category(1-3)[, value][, tooltip]
// The same item can also span MULTIPLE rows (one row per category is the
// natural output of `stats ... by item, category` in SPL) — see buildItems.
const MIN_ROW_COLUMNS = 4; // item + 1 category + value + tooltip, all positional
const MAX_ROW_COLUMNS = 6; // item + 3 categories + value + tooltip, all positional

const PACKING_EFFICIENCY = 0.82;
const DENSITY_SAMPLES = 40000;
const PANEL_PADDING = 16;

const LEGEND_POSITIONS = ['top', 'bottom', 'left', 'right', 'none'];
const DEFAULT_LEGEND_POSITION = 'bottom';
// Space reserved for the legend, subtracted from the chart's own width/height
// before venn.js lays out circles (its SVG is a fixed pixel size, so this
// has to be decided up front rather than left to CSS/flexbox).
const LEGEND_RESERVE = { top: 34, bottom: 34, left: 130, right: 130, none: 0 };

const DEFAULT_BACKGROUND = '#0d1117';
const LEGEND_TEXT_COLOR = { light: '#3c444d', dark: '#ffffff' };
const CIRCLE_FILL_OPACITY = 0.16;
const CIRCLE_HOVER_FILL_OPACITY = 0.34;
const CIRCLE_DIMMED_FILL_OPACITY = 0.05;

const DOT_OPACITY = 0.9;
const ENTRANCE_DURATION_MS = 380;
const ENTRANCE_STAGGER_MAX_MS = 120;
const PULSE_DURATION_S = 2.6; // keep in sync with venn-dot-pulse's duration in visualization.css

const LABEL_OFFSET = 14; // px beyond each circle's own radius
// Truncation width scales with the chart's own size (see renderVenn)
// instead of one fixed number, so a bigger panel allows longer labels.
// Deliberately NOT computed as an exact per-label distance to the chart's
// outer edge: every label sits just outside its own circle, pointing away
// from the diagram's center — and venn.js's own internal padding plus our
// LABEL_OFFSET are both fixed pixel constants, not proportional to chart
// size, so labels near the edge of a 2-set (or edge-of-triangle 3-set)
// layout end up almost exactly as close to that edge in a huge panel as in
// a tiny one. An exact-edge-distance version of this was tried and always
// collapsed to LABEL_MIN_WIDTH regardless of panel size — the opposite of
// "less aggressive." Scaling off chartWidth instead sidesteps that.
const LABEL_WIDTH_FRACTION = 0.3;
const LABEL_MIN_WIDTH = 40;
const LABEL_MAX_WIDTH = 200;
const LABEL_FONT_SIZES = { small: 12, medium: 15, large: 18 };
const DEFAULT_LABEL_SIZE = 'small';
const LABEL_MAX_LINES = 2;
const LABEL_LINE_HEIGHT_MULTIPLIER = 1.15;
// Space reserved around the chart so labels (which sit OUTSIDE their own
// circle, per LABEL_OFFSET) can't clip the container's true edges —
// PANEL_PADDING alone is a small general gutter, not sized for label text.
// Vertical is the worst case (2 lines at the largest font size) since
// almost every label ends up top/bottom-anchored with the placement rules
// in renderVenn; horizontal covers the rarer side-anchored case (only when
// a circle's direction from center is closer to horizontal than the
// "points down" threshold allows), and a side-anchored label's own max
// width is capped to LABEL_SIDE_MAX_WIDTH to match exactly what's reserved
// for it — it can never grow wider than the room actually set aside.
const LABEL_SIDE_MAX_WIDTH = 90;
const LABEL_VERTICAL_MARGIN =
    LABEL_OFFSET + LABEL_MAX_LINES * LABEL_FONT_SIZES.large * LABEL_LINE_HEIGHT_MULTIPLIER;
const LABEL_HORIZONTAL_MARGIN = LABEL_OFFSET + LABEL_SIDE_MAX_WIDTH;

// Positional for item/categories — a search author can name those columns
// whatever they want (`| table host, category, description`). value and
// tooltip are the exception: if a field is literally named one of those,
// it's used by name regardless of position (see parseRow).
function toPositionalRows(data) {
    if (!data || !data.fields || !data.columns || data.columns.length === 0) {
        return { rows: [], namedIndices: { valueIndex: -1, tooltipIndex: -1 }, fieldNames: [] };
    }
    const numCols = data.fields.length;
    const numRows = data.columns[0]?.length ?? 0;
    const fieldNames = data.fields.map((f) => String(f?.name ?? f ?? '').trim());
    const findNamed = (name) => fieldNames.findIndex((n) => n.toLowerCase() === name);
    const namedIndices = { valueIndex: findNamed('value'), tooltipIndex: findNamed('tooltip') };
    const rows = Array.from({ length: numRows }, (_, i) =>
        Array.from({ length: numCols }, (_, j) => data.columns[j][i])
    );
    return { rows, namedIndices, fieldNames };
}

// One row -> { item, categories, value, tooltip }, or null if the row's
// column count doesn't match any supported shape or it names no categories.
// `namedIndices` gives the column index of a field literally named "value"
// and/or "tooltip" (-1 if absent) — those are pulled out by index first;
// whichever of the two ISN'T named still reads positionally from whatever
// columns are left, exactly as if that were the only supported shape.
function parseRow(row, namedIndices) {
    const { valueIndex, tooltipIndex } = namedIndices;
    const hasNamedValue = valueIndex >= 0 && valueIndex < row.length;
    const hasNamedTooltip = tooltipIndex >= 0 && tooltipIndex < row.length;
    const excluded = new Set([hasNamedValue ? valueIndex : -1, hasNamedTooltip ? tooltipIndex : -1]);
    const cells = row.filter((_, i) => !excluded.has(i));
    const numCols = cells.length;

    // Each named field removes one positional slot this row still needs to
    // fill by position (item + >=1 category, plus whichever of value/
    // tooltip wasn't named).
    const reservedTrailingSlots = (hasNamedValue ? 0 : 1) + (hasNamedTooltip ? 0 : 1);
    const minCols = MIN_ROW_COLUMNS - 2 + reservedTrailingSlots;
    const maxCols = MAX_ROW_COLUMNS - 2 + reservedTrailingSlots;
    if (numCols < minCols || numCols > maxCols) return null;

    const item = cells[0];
    if (item == null || item === '') return null;

    const categoryEnd = numCols - reservedTrailingSlots;
    const categories = cells
        .slice(1, categoryEnd)
        .map((c) => (c == null ? '' : String(c).trim()))
        .filter((c) => c !== '');
    if (categories.length === 0) return null;

    let valueRaw;
    let tooltipRaw;
    if (hasNamedValue && hasNamedTooltip) {
        valueRaw = row[valueIndex];
        tooltipRaw = row[tooltipIndex];
    } else if (hasNamedValue) {
        valueRaw = row[valueIndex];
        tooltipRaw = cells[numCols - 1];
    } else if (hasNamedTooltip) {
        valueRaw = cells[numCols - 1];
        tooltipRaw = row[tooltipIndex];
    } else {
        valueRaw = cells[numCols - 2];
        tooltipRaw = cells[numCols - 1];
    }

    const valueNum = valueRaw != null && valueRaw !== '' ? parseFloat(valueRaw) : 1;
    const value = Number.isFinite(valueNum) ? valueNum : 1;
    const tooltip = tooltipRaw != null ? String(tooltipRaw) : '';

    return { item: String(item), categories, value, tooltip };
}

// Groups parsed rows by item. The same item can arrive across MULTIPLE rows
// (one row per category — the natural shape of `stats ... by item,
// category` in SPL) as well as within a single row already listing 2-3
// categories at once; both collapse to the same shape here. Value SUMS
// across every contributing row (dot size reflects total signal for that
// item); tooltip keeps one line per row rather than picking or dropping one,
// so nothing observed for that item is silently lost.
//
// `rawFields` also accumulates the row's ORIGINAL column names (whatever the
// search author called them — `host`, `count`, etc., not our internal
// item/category/value/tooltip roles) so drilldown can expose every
// SPL-supplied field as a `row.<field>.value` token, same as other vizzes in
// this project do. When an item spans multiple rows, the last NON-BLANK
// value for a given field name wins (skips null/undefined/'') rather than a
// blind last-one-wins — the 5/6-column shapes (2-3 category columns) only
// populate whichever category column that particular row actually uses and
// leave the others blank, so a plain overwrite would let a later row's
// blank silently erase an earlier row's real value for an unrelated column.
function buildItems(rows, namedIndices, fieldNames) {
    const byItem = new Map();
    rows.forEach((row) => {
        const parsed = parseRow(row, namedIndices);
        if (!parsed) return;
        let entry = byItem.get(parsed.item);
        if (!entry) {
            entry = {
                id: parsed.item,
                categorySet: new Set(),
                totalValue: 0,
                tooltipLines: [],
                rawFields: {},
            };
            byItem.set(parsed.item, entry);
        }
        parsed.categories.forEach((c) => entry.categorySet.add(c));
        entry.totalValue += parsed.value;
        entry.tooltipLines.push({
            label: parsed.categories.join(' + '),
            value: parsed.value,
            text: parsed.tooltip,
        });
        fieldNames.forEach((name, i) => {
            if (name && row[i] != null && row[i] !== '') entry.rawFields[name] = row[i];
        });
    });
    return [...byItem.values()];
}

// Alphabetical, not first-seen-in-the-data order: SPL doesn't guarantee
// stable row order across refreshes, so first-seen order could shuffle
// which category lands on which region key (and therefore which color)
// from one search run to the next. Alphabetical is deterministic regardless
// of row order, as long as the same category strings keep appearing.
function discoverCategoryNames(items) {
    const all = new Set();
    items.forEach((item) => item.categorySet.forEach((c) => all.add(c)));
    return [...all].sort();
}

// Ties everything above together: rows -> { names, hosts, categoryNames }.
// `names` maps region keys (A/B/C) to the actual discovered category
// strings; `hosts` is empty (with categoryNames still populated) when there
// are more distinct categories than this 3-set-max viz can show.
// When there are more than 3 distinct categories, only the first 3
// (alphabetically) get shown — items exclusively in an excluded category
// are simply dropped. `categoryNames` is still the FULL discovered list
// (unfiltered) so the caller can tell how many/which were left out and
// show a warning about it, rather than this silently truncating.
function buildRenderModel(rows, namedIndices, fieldNames) {
    const items = buildItems(rows, namedIndices, fieldNames);
    const categoryNames = discoverCategoryNames(items);
    if (categoryNames.length === 0) {
        return { names: {}, hosts: [], categoryNames };
    }
    const usedCategoryNames = categoryNames.slice(0, REGION_KEYS.length);
    const names = {};
    REGION_KEYS.forEach((k, i) => {
        if (usedCategoryNames[i]) names[k] = usedCategoryNames[i];
    });
    const hosts = items
        .map((item) => {
            const memberships = REGION_KEYS.filter((k) => names[k] && item.categorySet.has(names[k]));
            if (memberships.length === 0) return null;
            return {
                id: item.id,
                memberships,
                value: item.totalValue,
                tooltipLines: item.tooltipLines,
                rawFields: item.rawFields,
            };
        })
        .filter(Boolean);
    return { names, hosts, categoryNames };
}

// Filters a full render model down to just the ENABLED categories, for the
// diagram itself — `names` here still comes from the FULL (unfiltered)
// model wherever the legend needs it, since the legend must keep showing
// every category (including disabled ones) so a disabled one stays
// clickable to bring back. Region-key assignment is deliberately done ONCE
// against the full discovered category list (in buildRenderModel), not
// recomputed against just the enabled subset — recomputing per-toggle would
// alphabetically reshuffle which key (and therefore color) a REMAINING
// category gets whenever a different one is disabled, making an untouched
// circle appear to change color.
function applyDisabledCategories(fullNames, fullHosts, disabledCategoryNames) {
    const names = {};
    REGION_KEYS.forEach((k) => {
        if (fullNames[k] && !disabledCategoryNames.has(fullNames[k])) names[k] = fullNames[k];
    });
    const hosts = fullHosts
        .map((h) => {
            const memberships = h.memberships.filter((k) => names[k]);
            if (memberships.length === 0) return null;
            return { ...h, memberships };
        })
        .filter(Boolean);
    return { names, hosts };
}

function regionKeyOf(memberships) {
    return memberships.slice().sort().join(',');
}

function blend(keys) {
    const rgbs = keys.map((k) => d3.rgb(CATEGORY_COLORS[k]));
    const r = d3.mean(rgbs, (c) => c.r);
    const g = d3.mean(rgbs, (c) => c.g);
    const b = d3.mean(rgbs, (c) => c.b);
    return d3.rgb(r, g, b).formatHex();
}

// Same text shown in the hover tooltip (see the dot's mouseover handler in
// renderVenn) — one line per contributing row plus a Total line when there's
// more than one, joined into a single string since a drilldown token is one
// flat value rather than several DOM nodes.
function buildDotTooltipText(d) {
    const lines = d.tooltipLines.map((line) => `${line.label} (${line.value}): ${line.text}`);
    if (d.tooltipLines.length > 1) lines.push(`Total: ${d.value}`);
    return lines.join('\n');
}

// A click drilldown payload is one flat object of token values. Dashboard
// Studio's own "Set Tokens" click interaction editor only ever reads THREE
// shapes of key out of this object — `name`, `value`, and `row.<fieldname>.
// value` (confirmed against Splunk's own docs on setting tokens on a
// visualization click); any other top-level key (an earlier version of this
// used plain `tooltip`/`color`) is simply invisible to it, and apparently
// having even ONE such unrecognized key reference configured can silently
// break the whole "on click" action rather than just that one token. So
// `tooltip` and `color` ride under the same `row.<name>.value` addressing
// real SPL fields use, as synthetic "row" fields of their own — computed
// AFTER the raw fields below are spread in, so they win over a same-named
// real SPL column (our combined multi-row tooltip is strictly more complete
// than any single row's raw value for it).
function buildDotDrilldownPayload(d) {
    const payload = { name: d.id, value: d.value };
    Object.entries(d.rawFields || {}).forEach(([field, value]) => {
        payload[`row.${field}.value`] = value ?? '';
    });
    payload['row.tooltip.value'] = buildDotTooltipText(d);
    payload['row.color.value'] = d.color;
    return payload;
}

// venn.js sets format: a single-set entry's `size` is that set's total
// membership (including hosts also in other sets); a multi-set entry's
// `size` is that exact region's exclusive count. Mixing cumulative
// single-set totals with exclusive combo counts is what the prototype
// validated against — see CLAUDE.md's containment verification notes.
function buildVennSets(hosts, names) {
    const regionCounts = {};
    hosts.forEach((h) => {
        const key = regionKeyOf(h.memberships);
        regionCounts[key] = (regionCounts[key] || 0) + 1;
    });

    const totalFor = (key) => hosts.filter((h) => h.memberships.includes(key)).length;

    const singleSets = REGION_KEYS.map((k) => ({ sets: [names[k]], size: totalFor(k) })).filter(
        (s) => s.size > 0
    );
    const multiCombos = [...PAIR_COMBOS, TRIPLE_COMBO];
    const multiSets = multiCombos
        .map((keys) => ({ sets: keys.map((k) => names[k]), size: regionCounts[keys.join(',')] || 0 }))
        .filter((s) => s.size > 0);

    return [...singleSets, ...multiSets];
}

// ---- Containment geometry, shared by seeding / density-capping / clamp ----
// (ported as-is from venn_circle_pack_prototype.html — see CLAUDE.md for why
// each step here is load-bearing)

function satisfiesRegion(circles, activeKeys, x, y, memberships, r, margin = 1) {
    for (const key of activeKeys) {
        const c = circles[key];
        const dx = x - c.x;
        const dy = y - c.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const include = memberships.includes(key);
        if (include && dist > c.radius - r - margin) return false;
        if (!include && dist < c.radius + r + margin) return false;
    }
    return true;
}

function clampOnce(circles, activeKeys, p, node) {
    let { x, y } = p;
    for (const key of activeKeys) {
        const c = circles[key];
        const dx = x - c.x;
        const dy = y - c.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        const include = node.memberships.includes(key);
        if (include) {
            const maxDist = c.radius - node.r - 1;
            if (dist > maxDist) {
                const s = maxDist / dist;
                x = c.x + dx * s;
                y = c.y + dy * s;
            }
        } else {
            const minDist = c.radius + node.r + 1;
            if (dist < minDist) {
                const s = minDist / dist;
                x = c.x + dx * s;
                y = c.y + dy * s;
            }
        }
    }
    return { x, y };
}

function bboxForIncluded(circles, keys) {
    let minX = -Infinity;
    let maxX = Infinity;
    let minY = -Infinity;
    let maxY = Infinity;
    keys.forEach((k) => {
        const c = circles[k];
        minX = Math.max(minX, c.x - c.radius);
        maxX = Math.min(maxX, c.x + c.radius);
        minY = Math.max(minY, c.y - c.radius);
        maxY = Math.min(maxY, c.y + c.radius);
    });
    return { minX, maxX, minY, maxY };
}

function classify(circles, activeKeys, x, y) {
    const included = activeKeys.filter((key) => {
        const c = circles[key];
        const dx = x - c.x;
        const dy = y - c.y;
        return Math.sqrt(dx * dx + dy * dy) <= c.radius;
    });
    return included.sort().join(',');
}

// Sets textEl's content to `text`, shortening it with a trailing "…" if it
// doesn't fit within maxWidth. Mutates and returns the final string shown.
function truncateLabel(textEl, text, maxWidth) {
    textEl.textContent = text;
    if (textEl.getComputedTextLength() <= maxWidth) return text;
    let truncated = text;
    while (truncated.length > 1) {
        truncated = truncated.slice(0, -1);
        textEl.textContent = `${truncated.trimEnd()}…`;
        if (textEl.getComputedTextLength() <= maxWidth) break;
    }
    return textEl.textContent;
}

// Word-wraps `text` into up to `maxLines` lines that each fit within
// maxWidth, only falling back to truncateLabel's character-level "…" on
// whichever line runs out of room — the last allowed line if there are
// leftover words after it, or (rare: a single word wider than maxWidth on
// its own) any line individually too wide. textEl is used purely to measure
// candidate strings via getComputedTextLength; its content is left mutated
// after this returns (callers replace it with <tspan> children).
function wrapLabel(textEl, text, maxWidth, maxLines) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return { lines: [''], truncated: false };

    const lines = [];
    let remaining = words;
    let truncated = false;

    while (remaining.length > 0 && lines.length < maxLines) {
        const isLastAllowedLine = lines.length === maxLines - 1;
        let line = remaining[0];
        let consumed = 1;
        while (consumed < remaining.length) {
            const candidate = `${line} ${remaining[consumed]}`;
            textEl.textContent = candidate;
            if (textEl.getComputedTextLength() > maxWidth) break;
            line = candidate;
            consumed++;
        }
        remaining = remaining.slice(consumed);

        if (isLastAllowedLine && remaining.length > 0) {
            // More words than fit in the allowed lines — collapse them onto
            // this line and let truncateLabel find the right ellipsis cut.
            line = truncateLabel(textEl, `${line} ${remaining.join(' ')}`, maxWidth);
            truncated = true;
            remaining = [];
        } else {
            textEl.textContent = line;
            if (textEl.getComputedTextLength() > maxWidth) {
                line = truncateLabel(textEl, line, maxWidth);
                truncated = true;
            }
        }
        lines.push(line);
    }
    return { lines, truncated };
}

// ---- The imperative D3/venn.js render, isolated from React's tree --------
function renderVenn(
    container,
    hosts,
    width,
    height,
    names,
    legendPos,
    fillCircles,
    animateItems,
    backgroundColor,
    labelSize,
    hoverTargetRef
) {
    container.innerHTML = '';

    const prefersReducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const isSideLegend = legendPos === 'left' || legendPos === 'right';
    const reserve = LEGEND_RESERVE[legendPos] ?? 0;
    const chartWidth = Math.max(
        80,
        width - PANEL_PADDING * 2 - LABEL_HORIZONTAL_MARGIN * 2 - (isSideLegend ? reserve : 0)
    );
    const chartHeight = Math.max(
        80,
        height - PANEL_PADDING * 2 - LABEL_VERTICAL_MARGIN * 2 - (isSideLegend ? 0 : reserve)
    );

    const noop = { stop: () => {}, setActiveSet: () => {}, animateOutCategory: (_name, onComplete) => onComplete() };

    const vennSets = buildVennSets(hosts, names);
    if (vennSets.length === 0) return noop;

    const wrap = d3.select(container).append('div').attr('class', 'venn-chart-wrap');
    const chartDiv = wrap.append('div').attr('class', 'venn-chart');
    // styled(false): venn.js's own default styling sets `fill` and
    // `fill-opacity: .25` INLINE on each circle path (and an inline color on
    // each label) using its own auto-assigned category colors — inline
    // styles always beat our external stylesheet rules, so left on, this
    // silently overrode both the fillCircles toggle and the hover rule below
    // no matter what we set our own CSS custom properties to.
    const chart = venn.VennDiagram().width(chartWidth).height(chartHeight).styled(false);
    const div = chartDiv.datum(vennSets).call(chart);

    // Replaced entirely by our own labels outside the circles (see the
    // circle-label-layer below) — venn.js's own <text> elements are
    // positioned/wrapped to fit INSIDE each circle, which is the opposite
    // of what we want here.
    div.selectAll('.venn-circle text').remove();

    // Colors are fed to the stylesheet via CSS custom properties rather than
    // set directly as `fill`/`stroke` inline styles, so the class-based
    // active/dimmed rules in visualization.css can actually override them —
    // an inline style always beats a stylesheet rule, custom properties
    // referenced through var() don't have that problem.
    div.selectAll('.venn-circle path').each(function (d) {
        const key = REGION_KEYS.find((k) => names[k] === d.sets[0]);
        const base = CATEGORY_COLORS[key];
        d3.select(this)
            .attr('data-set-key', key)
            .style('--circle-fill', base)
            .style('--circle-fill-dark', d3.color(base).darker(0.8).formatHex())
            .style('--circle-fill-opacity', fillCircles ? CIRCLE_FILL_OPACITY : 0)
            // Hover shouldn't show a fill at all when the Fill option is off
            // — only the thicker border does then. Same for the dimmed state
            // the OTHER circles get while one is active.
            .style('--circle-hover-fill-opacity', fillCircles ? CIRCLE_HOVER_FILL_OPACITY : 0)
            .style('--circle-dimmed-fill-opacity', fillCircles ? CIRCLE_DIMMED_FILL_OPACITY : 0)
            .style('--circle-stroke', base);
    });

    // venn.js's own .venn-intersection (overlap) paths get NO styling at all
    // once styled(false) is set — not even the fill-opacity:0 baseline
    // styled:true used to give them — so they fall back to SVG's spec
    // default: opaque BLACK fill with pointer-events:auto, silently eating
    // every hover/click in every overlap region. Always disable pointer
    // events regardless of fill below, so hover/click still reach the
    // circle fills beneath it. When Fill is off there's nothing to blend
    // (every circle fill-opacity is already 0), so paint the actual
    // configured background color instead — overlaps read as "punched
    // through" to the backdrop rather than an opaque black patch that would
    // show the moment someone picks a lighter background.
    div.selectAll('.venn-intersection path').each(function (d) {
        const keys = REGION_KEYS.filter((k) => d.sets.includes(names[k]));
        d3.select(this)
            .style('fill', fillCircles ? blend(keys) : backgroundColor)
            .style('fill-opacity', fillCircles ? CIRCLE_FILL_OPACITY : 1)
            .style('pointer-events', 'none');
    });

    // venn.js's VennDiagram() never exposes final scaled circle geometry on
    // the datum — it must be recomputed with the exact same pipeline
    // (venn -> normalizeSolution -> scaleSolution) and matching
    // width/height/padding, or containment math won't match what's drawn.
    let rawSolution = venn.venn(vennSets);
    rawSolution = venn.normalizeSolution(rawSolution, Math.PI / 2, null);
    const scaled = venn.scaleSolution(rawSolution, chartWidth, chartHeight, 15);
    const circles = {};
    REGION_KEYS.forEach((k) => {
        if (scaled[names[k]]) circles[k] = scaled[names[k]];
    });
    const activeKeys = REGION_KEYS.filter((k) => circles[k]);
    if (activeKeys.length === 0) return noop;

    const valueExtent = d3.extent(hosts, (h) => h.value);
    const rScale =
        valueExtent[0] === valueExtent[1]
            ? () => 3.5
            : d3.scaleSqrt().domain(valueExtent).range([2.2, 5.5]);
    hosts.forEach((h) => {
        h.r = rScale(h.value);
        h.color = blend(h.memberships);
    });

    // Region density must be capped via Monte Carlo area estimation: thin
    // crescent regions have real, limited area, so if requested dot area
    // exceeds what a region can hold, dots shrink rather than spill outside.
    const areaCounts = {};
    for (let i = 0; i < DENSITY_SAMPLES; i++) {
        const x = Math.random() * chartWidth;
        const y = Math.random() * chartHeight;
        const key = classify(circles, activeKeys, x, y);
        if (key) areaCounts[key] = (areaCounts[key] || 0) + 1;
    }
    const boxArea = chartWidth * chartHeight;
    const hostsByRegion = d3.group(hosts, (h) => regionKeyOf(h.memberships));
    hostsByRegion.forEach((regionHosts, key) => {
        const area = ((areaCounts[key] || 0) / DENSITY_SAMPLES) * boxArea;
        const capacity = area * PACKING_EFFICIENCY;
        const requestedArea = d3.sum(regionHosts, (h) => Math.PI * h.r * h.r);
        if (requestedArea > capacity && requestedArea > 0) {
            const scale = Math.sqrt(capacity / requestedArea);
            regionHosts.forEach((h) => {
                h.r = Math.max(1.3, h.r * scale);
            });
        }
    });

    // Seed each host via rejection sampling inside the bounding box of its
    // included circles, so the simulation only has to resolve collisions
    // rather than migrate nodes across boundaries from a guessed start.
    hosts.forEach((h) => {
        const bb = bboxForIncluded(circles, h.memberships);
        let found = false;
        for (let attempt = 0; attempt < 400; attempt++) {
            const x = bb.minX + Math.random() * (bb.maxX - bb.minX);
            const y = bb.minY + Math.random() * (bb.maxY - bb.minY);
            if (satisfiesRegion(circles, activeKeys, x, y, h.memberships, h.r)) {
                h.x = x;
                h.y = y;
                found = true;
                break;
            }
        }
        if (!found) {
            let p = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
            for (let i = 0; i < 40; i++) p = clampOnce(circles, activeKeys, p, h);
            h.x = p.x;
            h.y = p.y;
        }
    });

    const svg = div.select('svg');
    svg.style('overflow', 'visible');

    // Stroke lives on its own always-on-top-of-fills overlay (plain
    // <circle> elements using the same final geometry) instead of on
    // venn.js's own per-circle <path>. With stroke on the path itself, a
    // boundary segment lying inside ANOTHER circle's disc could be covered
    // by that other circle's (later-painted) fill — worst right in the
    // dead center where all 3 discs stack and their fills compound, which
    // is exactly where Daniel saw the boundary line go missing on first
    // load (clicking each circle "fixed" it only because bring-to-front
    // happened to also carry that circle's stroke to the top, one at a
    // time). A dedicated overlay painted after every fill makes every
    // circle's outline always fully visible regardless of z-order.
    const outlineLayer = svg.append('g').attr('class', 'circle-outline-layer');
    activeKeys.forEach((key) => {
        const c = circles[key];
        outlineLayer
            .append('circle')
            .attr('class', 'circle-outline')
            .attr('data-set-key', key)
            .attr('cx', c.x)
            .attr('cy', c.y)
            .attr('r', c.radius)
            .style('--circle-stroke', CATEGORY_COLORS[key]);
    });

    // Each label sits just outside its own circle, along the direction from
    // the diagram's overall center out through that circle's own center —
    // this is data-driven rather than hardcoded per letter, so whichever
    // circle actually ends up top/bottom-left/bottom-right for a given
    // dataset (venn.js's layout solver decides that, not us) gets a label
    // placed sensibly outside it rather than a label baked to a fixed
    // on-screen position that could end up wrong (or overlapping another
    // circle) for a different size mix.
    const labelLayer = svg.append('g').attr('class', 'circle-label-layer');
    const labelFontSize = LABEL_FONT_SIZES[labelSize] || LABEL_FONT_SIZES[DEFAULT_LABEL_SIZE];
    // Top/bottom (anchor 'middle') labels get the general, chartWidth-scaled
    // budget; side-anchored ones are capped to LABEL_SIDE_MAX_WIDTH instead,
    // matching exactly the horizontal margin actually reserved for them
    // above — computed per-label below, once `anchor` is known.
    const centerMaxLabelWidth = Math.min(
        LABEL_MAX_WIDTH,
        Math.max(LABEL_MIN_WIDTH, chartWidth * LABEL_WIDTH_FRACTION)
    );
    const centroid = {
        x: d3.mean(activeKeys, (k) => circles[k].x),
        y: d3.mean(activeKeys, (k) => circles[k].y),
    };
    // With exactly 2 circles, they sit side by side at roughly the same
    // height — the general "radially away from center" rule would put both
    // labels off to the side (left/right-anchored), each cramped toward
    // whichever side edge is nearer. Top/bottom instead gives each one the
    // full, symmetric width to wrap into. Left circle's label goes on top,
    // right circle's goes on the bottom (rather than e.g. both on top) so
    // they don't end up stacked in the same vertical space.
    const isTwoCircleLayout = activeKeys.length === 2;
    const leftKey = isTwoCircleLayout
        ? activeKeys.reduce((a, b) => (circles[a].x <= circles[b].x ? a : b))
        : null;
    // Placement below happens in two passes: first compute each label's
    // independent radial position/wrapping (as before), then nudge any pair
    // whose measured bounding boxes still overlap apart from each other. A
    // small circle sitting close to a much bigger one is the case that
    // needs this — each label is positioned only relative to its OWN
    // circle's radius, so with no cross-label awareness their text can
    // still collide even though each individual placement is "correct" in
    // isolation.
    const labelEntries = [];
    activeKeys.forEach((key) => {
        const c = circles[key];
        let ux;
        let effectiveUy;
        if (isTwoCircleLayout) {
            ux = 0;
            effectiveUy = key === leftKey ? -1 : 1;
        } else {
            const dx = c.x - centroid.x;
            const dy = c.y - centroid.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            // A single circle has nowhere to point "away from center" (it
            // IS the center) — default to straight up in that degenerate
            // case.
            const rawUx = dist > 0.01 ? dx / dist : 0;
            const uy = dist > 0.01 ? dy / dist : -1;
            // A downward-pointing label sits straight beneath its own
            // circle instead of diagonally out to the side — diagonal
            // placement crowds toward whichever side edge is nearer, while
            // straight-down keeps it centered under the circle with
            // symmetric room either way for wrapping.
            const pointsDown = uy > 0.15;
            ux = pointsDown ? 0 : rawUx;
            effectiveUy = pointsDown ? 1 : uy;
        }
        const labelX = c.x + ux * (c.radius + LABEL_OFFSET);
        const labelY = c.y + effectiveUy * (c.radius + LABEL_OFFSET);
        const anchor = ux < -0.15 ? 'end' : ux > 0.15 ? 'start' : 'middle';
        const maxLabelWidth = anchor === 'middle' ? centerMaxLabelWidth : LABEL_SIDE_MAX_WIDTH;

        const label = labelLayer
            .append('text')
            .attr('class', 'circle-label')
            .attr('data-set-key', key)
            .attr('text-anchor', anchor)
            .style('fill', CATEGORY_COLORS[key])
            // Set before measuring for wrapping below — text length
            // depends on font size, so this can't be applied afterward.
            .style('font-size', `${labelFontSize}px`);
        const fullName = names[key];
        const textEl = label.node();
        const { lines, truncated } = wrapLabel(textEl, fullName, maxLabelWidth, LABEL_MAX_LINES);

        // Measure the actual rendered width (not the wrap budget it fit
        // within) so collision checks below reflect real text extent —
        // most labels are shorter than their allotted maxLabelWidth, and
        // using the budget instead would flag pairs as colliding that
        // don't actually touch on screen.
        let measuredWidth = 0;
        lines.forEach((line) => {
            textEl.textContent = line;
            measuredWidth = Math.max(measuredWidth, textEl.getComputedTextLength());
        });

        const lineHeight = labelFontSize * LABEL_LINE_HEIGHT_MULTIPLIER;
        // Grow away from the circle rather than centering the block on
        // labelY — a top label's block should extend further up as it
        // wraps, not creep down into the circle it's labeling (and
        // vice versa for a bottom label). Side labels have no circle
        // directly above/below to avoid, so centering them is fine.
        const startY =
            effectiveUy < -0.15
                ? labelY - (lines.length - 1) * lineHeight
                : effectiveUy > 0.15
                  ? labelY
                  : labelY - ((lines.length - 1) * lineHeight) / 2;

        labelEntries.push({
            key,
            label,
            anchor,
            lines,
            truncated,
            fullName,
            lineHeight,
            width: measuredWidth,
            labelX,
            startY,
        });
    });

    // Resolve overlaps the same way the dot-containment solver above
    // handles boundary conflicts: a handful of relaxation passes rather
    // than a single pass, since nudging one pair apart can introduce (or
    // remove) an overlap with a third label. With at most 3 labels this
    // converges almost immediately. Each overlapping pair is pushed apart
    // along whichever axis (horizontal or vertical) has the smaller overlap
    // — the standard minimum-translation-vector approach — so a pair
    // overlapping mostly side-by-side slides apart sideways rather than
    // vertically, and vice versa.
    const LABEL_COLLISION_PADDING = 4;
    function labelBBox(entry) {
        const blockHeight = entry.lineHeight * (entry.lines.length - 1);
        const midY = entry.startY + blockHeight / 2;
        const halfHeight = blockHeight / 2 + entry.lineHeight / 2;
        let x0;
        let x1;
        if (entry.anchor === 'end') {
            x0 = entry.labelX - entry.width;
            x1 = entry.labelX;
        } else if (entry.anchor === 'start') {
            x0 = entry.labelX;
            x1 = entry.labelX + entry.width;
        } else {
            x0 = entry.labelX - entry.width / 2;
            x1 = entry.labelX + entry.width / 2;
        }
        return { x0, x1, y0: midY - halfHeight, y1: midY + halfHeight };
    }
    // A label can also end up sitting over a circle it doesn't belong to —
    // not just the one pair check above. Its own circle is avoided by
    // construction (LABEL_OFFSET pushes it clear), but a SMALL circle
    // positioned close to a bigger neighbor can still end up sitting right
    // along the bigger circle's own outward label direction, so the bigger
    // circle's label lands on top of the small circle's disc even though
    // the two labels' texts don't collide with each other. Treated as a
    // fixed obstacle (never moved itself, unlike the label-vs-label case
    // below) approximated by its bounding square — a conservative
    // approximation of the round disc, simpler than exact circle-rect
    // intersection and consistent with the rest of this placement logic.
    function circleBBox(key) {
        const c = circles[key];
        return { x0: c.x - c.radius, x1: c.x + c.radius, y0: c.y - c.radius, y1: c.y + c.radius };
    }
    for (let pass = 0; pass < 10; pass++) {
        let moved = false;

        labelEntries.forEach((entry) => {
            activeKeys.forEach((circleKey) => {
                const box = labelBBox(entry);
                const circleBox = circleBBox(circleKey);
                const overlapX =
                    Math.min(box.x1, circleBox.x1) - Math.max(box.x0, circleBox.x0) + LABEL_COLLISION_PADDING;
                const overlapY =
                    Math.min(box.y1, circleBox.y1) - Math.max(box.y0, circleBox.y0) + LABEL_COLLISION_PADDING;
                if (overlapX <= 0 || overlapY <= 0) return;
                moved = true;
                const c = circles[circleKey];
                const boxCx = (box.x0 + box.x1) / 2;
                const boxCy = (box.y0 + box.y1) / 2;
                if (overlapX < overlapY) {
                    const direction = boxCx - c.x >= 0 ? 1 : -1;
                    entry.labelX += direction * overlapX;
                } else {
                    const direction = boxCy - c.y >= 0 ? 1 : -1;
                    entry.startY += direction * overlapY;
                }
            });
        });

        for (let i = 0; i < labelEntries.length; i++) {
            for (let j = i + 1; j < labelEntries.length; j++) {
                const a = labelEntries[i];
                const b = labelEntries[j];
                const boxA = labelBBox(a);
                const boxB = labelBBox(b);
                const overlapX =
                    Math.min(boxA.x1, boxB.x1) - Math.max(boxA.x0, boxB.x0) + LABEL_COLLISION_PADDING;
                const overlapY =
                    Math.min(boxA.y1, boxB.y1) - Math.max(boxA.y0, boxB.y0) + LABEL_COLLISION_PADDING;
                if (overlapX <= 0 || overlapY <= 0) continue;
                moved = true;
                if (overlapX < overlapY) {
                    const push = overlapX / 2;
                    const direction = boxA.x0 < boxB.x0 ? -1 : 1;
                    a.labelX += direction * push;
                    b.labelX -= direction * push;
                } else {
                    const push = overlapY / 2;
                    const direction = boxA.y0 < boxB.y0 ? -1 : 1;
                    a.startY += direction * push;
                    b.startY -= direction * push;
                }
            }
        }
        if (!moved) break;
    }

    labelEntries.forEach((entry) => {
        entry.label.text(null); // clear measurement leftovers before adding tspans
        entry.lines.forEach((line, i) => {
            entry.label
                .append('tspan')
                .attr('x', entry.labelX)
                .attr('y', entry.startY + i * entry.lineHeight)
                .text(line);
        });
        if (entry.truncated) {
            entry.label.append('title').text(entry.fullName);
        }
    });

    const dotLayer = svg.append('g').attr('class', 'dot-layer');
    const dotSel = dotLayer
        .selectAll('circle.host-dot')
        .data(hosts, (d) => d.id)
        .join('circle')
        .attr('class', 'host-dot')
        .attr('fill', (d) => d.color);

    function startPulse(selection) {
        selection
            .classed('host-dot--pulse', true)
            .style('animation-delay', () => `-${(Math.random() * PULSE_DURATION_S).toFixed(2)}s`);
    }

    // Grow/fade dots in from nothing rather than popping straight to full
    // size — skipped (instant final state) under prefers-reduced-motion,
    // same as the physics settle below. The idle pulse (if enabled) is only
    // applied once a dot's own entrance transition has actually finished —
    // adding it up front, while r is still animating from 0, made the pulse
    // invisible in practice: `transform-box: fill-box` derives its reference
    // box from the element's current geometry, and starting that box at r=0
    // left nothing for `scale()` to visibly act on.
    if (prefersReducedMotion) {
        dotSel.attr('r', (d) => d.r).attr('opacity', DOT_OPACITY);
        if (animateItems) startPulse(dotSel);
    } else {
        dotSel
            .attr('r', 0)
            .attr('opacity', 0)
            .transition()
            .duration(ENTRANCE_DURATION_MS)
            .delay(() => Math.random() * ENTRANCE_STAGGER_MAX_MS)
            .attr('r', (d) => d.r)
            .attr('opacity', DOT_OPACITY)
            .on('end', function () {
                if (animateItems) startPulse(d3.select(this));
            });
    }

    const tooltip = wrap.append('div').attr('class', 'venn-tooltip');

    dotSel
        .on('mouseover', (_event, d) => {
            tooltip.selectAll('*').remove();
            tooltip.append('div').attr('class', 'venn-tooltip-id').text(d.id);
            // One line per contributing row rather than one combined line —
            // an item that showed up under both "timeouts" and "restarts"
            // keeps both, instead of only the last one read or a lossy sum
            // with no explanation of where it came from.
            d.tooltipLines.forEach((line) => {
                tooltip.append('div').text(`${line.label} (${line.value}): ${line.text}`);
            });
            if (d.tooltipLines.length > 1) {
                tooltip.append('div').text(`Total: ${d.value}`);
            }
            tooltip.classed('venn-tooltip--visible', true);
            // Drilldown fires from the ONE `addDrilldownListener` registered
            // once on the whole viz container (see VennVisualization) —
            // calling `triggerDrilldown` directly from each element's own
            // click handler doesn't actually create tokens in real Studio
            // (confirmed against a working reference viz in this repo:
            // working-drilldowns.jsx). That listener's payloadCallback reads
            // whatever's currently hovered at click time via this ref, so
            // hover (not click) is what needs to keep it up to date.
            if (hoverTargetRef) hoverTargetRef.current = buildDotDrilldownPayload(d);
        })
        .on('mousemove', (event) => {
            const [x, y] = d3.pointer(event, wrap.node());
            tooltip.style('left', `${x + 12}px`).style('top', `${y - 24}px`);
        })
        .on('mouseout', () => {
            tooltip.classed('venn-tooltip--visible', false);
            if (hoverTargetRef) hoverTargetRef.current = null;
        });

    // Activating a set (by hovering its circle OR the matching legend item —
    // setActiveSet is exposed on the returned handle for the latter, since a
    // legend item lives in a separate React-rendered DOM tree with no CSS
    // relationship to the SVG, so this can't be a plain :hover rule) darkens
    // that circle's own fill/border, dims the OTHER circles' fill (only
    // meaningful when fillCircles is on — otherwise every fill-opacity here
    // is already 0), and pauses the idle pulse on every dot that ISN'T a
    // member of that set.
    function setActiveSet(key) {
        div.selectAll('.venn-circle path').each(function (d) {
            const k = REGION_KEYS.find((rk) => names[rk] === d.sets[0]);
            d3.select(this)
                .classed('venn-circle--active', k === key)
                .classed('venn-circle--dimmed', fillCircles && key != null && k !== key);
        });
        outlineLayer.selectAll('.circle-outline').each(function () {
            const k = this.getAttribute('data-set-key');
            // The outline dims only when Fill is off — when it's on, the
            // fill paths above already dim for focus, so dimming the
            // outline too would be redundant. With Fill off, the outline
            // (plus the label) is the only thing there is to dim.
            d3.select(this)
                .classed('venn-circle--active', k === key)
                .classed('venn-circle--dimmed', !fillCircles && key != null && k !== key);
        });
        if (animateItems && !prefersReducedMotion) {
            dotSel.classed('host-dot--pulse-paused', (h) => key != null && !h.memberships.includes(key));
        }
    }

    // mouseenter/mouseleave (not mouseover/mouseout) since they don't bubble
    // — moving over the circle's own label text shouldn't cause flicker.
    // Click brings a circle's FILL in front of the other fills (still always
    // behind outlineLayer/dotLayer, both appended after all the venn-area
    // groups) — still meaningful when fillCircles is on, since that's still
    // z-order dependent; stroke visibility no longer is, now that it lives
    // on its own overlay. Hovering also updates the shared hoverTargetRef
    // (name/color only — a parent circle represents a whole category, not
    // one row, so it has no value/tooltip of its own) — the single
    // `addDrilldownListener` on the outer container reads this at actual
    // click time; see the comment on the dot's mouseover handler above for
    // why this indirection (rather than calling triggerDrilldown here
    // directly) is required.
    div.selectAll('.venn-circle path')
        .on('mouseenter', (_event, d) => {
            const key = REGION_KEYS.find((k) => names[k] === d.sets[0]);
            setActiveSet(key);
            if (hoverTargetRef && key) {
                hoverTargetRef.current = { name: names[key], 'row.color.value': CATEGORY_COLORS[key] };
            }
        })
        .on('mouseleave', () => {
            setActiveSet(null);
            if (hoverTargetRef) hoverTargetRef.current = null;
        })
        .on('click', function () {
            svg.node().insertBefore(this.parentNode, outlineLayer.node());
        });

    // Fades out one category's circle (fill/outline/label) and any dots
    // EXCLUSIVELY in it, then calls onComplete — used to animate a legend
    // toggle-off before the actual data refilter (and full rebuild) happens,
    // so removing a circle reads as a deliberate transition rather than a
    // hard cut. Dots that also belong to another (still-enabled) category
    // aren't touched here — they're not disappearing, just losing one
    // membership, which the subsequent full rebuild (with its own entrance
    // animation) already conveys reasonably well; interpolating their exact
    // old->new position across that rebuild isn't attempted (this component
    // fully tears down and rebuilds the DOM on every data/option change, so
    // a continuous cross-render position tween isn't available here without
    // a much larger restructuring).
    function animateOutCategory(categoryName, onComplete) {
        const key = REGION_KEYS.find((k) => names[k] === categoryName);
        if (!key || prefersReducedMotion) {
            onComplete();
            return;
        }
        const duration = 350;
        const transitions = [];

        const fillPath = div.select(`.venn-circle path[data-set-key="${key}"]`);
        if (!fillPath.empty()) {
            transitions.push(fillPath.transition().duration(duration).style('fill-opacity', 0).end());
        }
        const outline = outlineLayer.select(`.circle-outline[data-set-key="${key}"]`);
        if (!outline.empty()) {
            transitions.push(outline.transition().duration(duration).style('stroke-opacity', 0).end());
        }
        const label = labelLayer.select(`.circle-label[data-set-key="${key}"]`);
        if (!label.empty()) {
            transitions.push(label.transition().duration(duration).style('opacity', 0).end());
        }
        const exclusiveDots = dotSel.filter((h) => h.memberships.length === 1 && h.memberships[0] === key);
        if (!exclusiveDots.empty()) {
            transitions.push(
                exclusiveDots.transition().duration(duration).attr('r', 0).style('opacity', 0).end()
            );
        }

        // .end() rejects if a transition gets interrupted (e.g. the
        // container is torn down mid-fade) — proceed to onComplete either
        // way rather than leaving the toggle stuck.
        Promise.all(transitions).then(onComplete, onComplete);
    }

    // Checking A, then B, then C once each per tick lets fixing one boundary
    // re-break another (Gauss-Seidel problem) — run the clamp to convergence
    // (~6 passes) per node per tick instead.
    function clampToRegion(node) {
        let p = { x: node.x, y: node.y };
        for (let i = 0; i < 6; i++) p = clampOnce(circles, activeKeys, p, node);
        node.x = p.x;
        node.y = p.y;
    }

    const sim = d3
        .forceSimulation(hosts)
        .force('collide', d3.forceCollide((d) => d.r + 0.6).iterations(3))
        .alphaDecay(0.02)
        .on('tick', () => {
            hosts.forEach(clampToRegion);
            dotSel.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
        });

    if (prefersReducedMotion) {
        sim.stop();
        for (let i = 0; i < 300; i++) sim.tick();
    }

    return { stop: () => sim.stop(), setActiveSet, animateOutCategory };
}

// Inner content only — the outer .viz-container (background/corner-radius/
// sizing) is applied once, unconditionally, by VennVisualization itself, so
// every state (loading, empty, error, or the real diagram) respects those
// options instead of only the happy path.
function EmptyState({ message }) {
    return message ? <div className="viz-message">{message}</div> : null;
}

// `names` here is always the FULL (unfiltered) set — a legend item for a
// disabled category has to keep rendering (dimmed) or there'd be no way to
// click it again to bring the circle back.
// Drilldown for a legend item works the same way as the chart's own
// dots/circles (see the comment on the dot's mouseover handler in
// renderVenn): hovering updates the shared hoverTargetRef, and the single
// `addDrilldownListener` registered once in VennVisualization reads it at
// actual click time. Calling `triggerDrilldown` directly from onClick here
// (an earlier version did) doesn't create real tokens in Studio.
function Legend({ names, onHoverSet, onToggle, disabledCategoryNames, textColor, hoverTargetRef }) {
    return (
        <div className="venn-legend">
            {REGION_KEYS.filter((k) => names[k]).map((k) => {
                const isDisabled = disabledCategoryNames.has(names[k]);
                return (
                    <div
                        className={`venn-legend-item${isDisabled ? ' venn-legend-item--disabled' : ''}`}
                        key={k}
                        style={{ color: textColor }}
                        onMouseEnter={() => {
                            onHoverSet(k);
                            if (hoverTargetRef) {
                                hoverTargetRef.current = { name: names[k], 'row.color.value': CATEGORY_COLORS[k] };
                            }
                        }}
                        onMouseLeave={() => {
                            onHoverSet(null);
                            if (hoverTargetRef) hoverTargetRef.current = null;
                        }}
                        onClick={() => onToggle(names[k])}
                        title={isDisabled ? `Click to show ${names[k]}` : `Click to hide ${names[k]}`}
                    >
                        <span className="venn-legend-swatch" style={{ background: CATEGORY_COLORS[k] }} />
                        {names[k]}
                    </div>
                );
            })}
        </div>
    );
}

function VennVisualization() {
    const { dataSources, loading } = useDataSources();
    const { width, height } = useDimensions();
    const { options } = useOptions();
    const { theme } = useTheme();
    const chartRef = useRef(null);
    const rendererRef = useRef(null);
    // The single stable node `addDrilldownListener` registers against (see
    // the mount-once effect below) — must wrap chart AND legend, since both
    // fire drilldowns, and needs to persist across re-renders unlike
    // chartRef's contents (torn down/rebuilt by renderVenn on every change).
    const vizRootRef = useRef(null);
    // Whatever's currently hovered (a dot, a parent circle, or a legend
    // item), read by addDrilldownListener's payloadCallback at actual click
    // time — NOT set from a click handler. Per drilldown-and-tokens.md:
    // "payloadCallback fires synchronously before any click event... you
    // cannot set state in a click handler and read it inside the callback."
    // Updated directly (not via React state) by renderVenn's D3 hover
    // handlers and Legend's onMouseEnter/onMouseLeave — see their comments.
    const hoverTargetRef = useRef(null);
    // Tracked by category NAME, not region key — keys (A/B/C) are
    // reassigned alphabetically from whatever's currently discovered, so a
    // name is the only thing stable enough to survive across toggles (and
    // across data refreshes that still contain the same categories).
    const [disabledCategoryNames, setDisabledCategoryNames] = useState(() => new Set());

    const { rows, namedIndices, fieldNames } = useMemo(
        () => toPositionalRows(dataSources?.primary?.data),
        [dataSources]
    );
    const {
        names: fullNames,
        hosts: fullHosts,
        categoryNames,
    } = useMemo(
        () => buildRenderModel(rows, namedIndices, fieldNames),
        [rows, namedIndices, fieldNames]
    );
    // Not blocking — buildRenderModel already renders using just the first
    // 3 (alphabetically) when there are more; this only drives the warning
    // banner naming what got left out.
    const excludedCategoryNames = categoryNames.slice(REGION_KEYS.length);
    const { names, hosts } = useMemo(
        () => applyDisabledCategories(fullNames, fullHosts, disabledCategoryNames),
        [fullNames, fullHosts, disabledCategoryNames]
    );

    const legendPos = LEGEND_POSITIONS.includes(options?.legendPosition)
        ? options.legendPosition
        : DEFAULT_LEGEND_POSITION;
    const backgroundColor = options?.backgroundColor || DEFAULT_BACKGROUND;
    const fillCircles = options?.fillCircles === true;
    const animateItems = options?.animateItems === true;
    const labelSize = LABEL_FONT_SIZES[options?.labelSize] ? options.labelSize : DEFAULT_LABEL_SIZE;
    const legendTextColor = theme === 'light' ? LEGEND_TEXT_COLOR.light : LEGEND_TEXT_COLOR.dark;

    useEffect(() => {
        const container = chartRef.current;
        if (!container || hosts.length === 0 || width <= 0 || height <= 0) {
            // Clears a stale previous render (e.g. toggling off the last
            // remaining category) rather than leaving old content on screen
            // with nothing left to update it.
            if (container) container.innerHTML = '';
            rendererRef.current = null;
            return undefined;
        }
        const handle = renderVenn(
            container,
            hosts,
            width,
            height,
            names,
            legendPos,
            fillCircles,
            animateItems,
            backgroundColor,
            labelSize,
            hoverTargetRef
        );
        rendererRef.current = handle;
        return () => {
            rendererRef.current = null;
            handle.stop();
        };
    }, [hosts, width, height, names, legendPos, fillCircles, animateItems, backgroundColor, labelSize]);

    // ONE addDrilldownListener for the whole viz (dots, parent circles, and
    // legend items all funnel through it via hoverTargetRef) rather than
    // calling triggerDrilldown per element — confirmed against a working
    // reference viz in this repo (working-drilldowns.jsx) that
    // addDrilldownListener is the mechanism that actually creates real,
    // Studio-bindable tokens; triggerDrilldown called directly did not.
    // Registered once, not per render — vizRootRef's node itself never
    // unmounts while this component is mounted, only its children do.
    useEffect(() => {
        const node = vizRootRef.current;
        if (!node) return undefined;
        const cleanup = VisualizationAPI.addDrilldownListener({
            node,
            action: 'value',
            payloadCallback: () => hoverTargetRef.current || { name: '', value: '' },
        });
        return () => cleanup?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Hiding: fade the departing circle out in place first (so it reads as
    // a deliberate removal), then flip state — which drops it from `hosts`/
    // `names` and triggers the full rebuild that "refreshes with the
    // remaining circles". Showing: no fade-out needed, just flip state and
    // let the rebuild's own entrance animation bring it back in.
    const handleLegendToggle = (categoryName) => {
        if (disabledCategoryNames.has(categoryName)) {
            setDisabledCategoryNames((prev) => {
                const next = new Set(prev);
                next.delete(categoryName);
                return next;
            });
            return;
        }
        // Can't hide the only remaining visible category — `names` here is
        // already the enabled-only mapping, so its size IS the current
        // visible count.
        if (Object.keys(names).length <= 1) return;
        const disableNow = () =>
            setDisabledCategoryNames((prev) => new Set(prev).add(categoryName));
        if (rendererRef.current) {
            rendererRef.current.animateOutCategory(categoryName, disableNow);
        } else {
            disableNow();
        }
    };

    let chartContent;
    let isEmpty = true;
    let showLegend = false;
    if (loading) {
        chartContent = null;
    } else if (rows.length === 0) {
        chartContent = <EmptyState message="No data available" />;
    } else if (fullHosts.length === 0) {
        chartContent = (
            <EmptyState message="No valid rows found. Expected columns: item, category (1-3 of them), value, tooltip." />
        );
    } else {
        showLegend = true;
        if (hosts.length === 0) {
            // Every category toggled off — keep the legend mounted (below)
            // so there's still a way to click one back on.
            chartContent = (
                <div key="empty" className="venn-chart-container">
                    <EmptyState message="All categories are hidden — click a legend item to bring one back." />
                </div>
            );
        } else {
            isEmpty = false;
            // Keyed distinctly from the empty-state div above: renderVenn
            // manages this node's contents directly via the DOM (not
            // through React), so switching between the two branches needs
            // an actual unmount/remount, not an in-place prop diff — React
            // has no way to know it should clear out D3's own children
            // otherwise, since it never tracked them as its own.
            chartContent = <div key="chart" className="venn-chart-container" ref={chartRef} />;
        }
    }

    // Non-blocking: buildRenderModel already rendered using just the first
    // 3 categories, this just tells the viewer that happened and which
    // ones got left out — shown regardless of the all-toggled-off state
    // above, since it's about the underlying data, not the toggle state.
    const showCategoryWarning = showLegend && excludedCategoryNames.length > 0;

    return (
        <div
            ref={vizRootRef}
            className={`venn-viz viz-container${isEmpty ? ' viz-container--empty' : ''}`}
            style={{
                background: backgroundColor,
                overflow: 'hidden',
            }}
        >
            <div className={`venn-wrap legend-${legendPos}`}>
                {chartContent}
                {showLegend && legendPos !== 'none' && (
                    <Legend
                        names={fullNames}
                        disabledCategoryNames={disabledCategoryNames}
                        onHoverSet={(key) => rendererRef.current?.setActiveSet(key)}
                        onToggle={handleLegendToggle}
                        textColor={legendTextColor}
                        hoverTargetRef={hoverTargetRef}
                    />
                )}
            </div>
            {showCategoryWarning && (
                <div className="venn-warning">
                    {`Found ${categoryNames.length} categories — showing the first ${REGION_KEYS.length} (${Object.values(fullNames).join(', ')}). Hidden: ${excludedCategoryNames.join(', ')}.`}
                </div>
            )}
        </div>
    );
}

const rootElement = document.getElementById('root') || document.body;
createRoot(rootElement).render(<VennVisualization />);
