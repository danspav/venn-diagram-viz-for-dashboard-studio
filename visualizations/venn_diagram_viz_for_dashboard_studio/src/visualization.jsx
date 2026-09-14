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

// Category NAMES are discovered from the data itself (see
// discoverCategoryNames) rather than configured — A/B/C are purely internal
// bookkeeping slots that layout hangs off of, reassigned alphabetically
// each render. Colors ARE user-configurable (categoryColorA/B/C options,
// see VennVisualization) — these are just the defaults, used whenever an
// option is unset. Since the slot assignment is positional (alphabetical),
// not tied to a specific category name, "category color 1" always means
// "whichever category is alphabetically first this render," same as the
// existing region-key assignment already behaves.
const DEFAULT_CATEGORY_COLORS = { A: '#5fb3d9', B: '#d9a441', C: '#d9564f' };

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

// "Show counts" mode (renderVenn): a region's hit-area/text is sized off
// its own Monte Carlo-estimated area (sqrt(area/pi) — the radius of a
// circle with that same area), clamped so a thin sliver still gets a
// comfortably hoverable target and a huge region's number doesn't grow
// unboundedly.
const COUNT_HIT_RADIUS_MIN = 14;
const COUNT_FONT_MIN = 10;
const COUNT_FONT_MAX = 24;

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
// Vertical margin is computed in renderVenn from the ACTUAL labelSize in
// effect (not a fixed worst-case) since it directly eats into chart height,
// almost always the binding dimension for a landscape panel — reserving
// room as if every label were "Large" regardless of the real setting was
// the main reason the diagram rendered much smaller than the panel actually
// allowed. LABEL_HORIZONTAL_MARGIN covers the rarer side-anchored case
// (only when a circle's direction from center is closer to horizontal than
// the "points down" threshold allows) — also decided dynamically in
// renderVenn (see measureDiagramLayout) rather than reserved unconditionally
// on every render, since most layouts never end up with a single
// side-anchored label at all. A side-anchored label's own max width is
// capped to LABEL_SIDE_MAX_WIDTH to match exactly what's reserved for it —
// it can never grow wider than the room actually set aside.
const LABEL_SIDE_MAX_WIDTH = 90;
const LABEL_HORIZONTAL_MARGIN = LABEL_OFFSET + LABEL_SIDE_MAX_WIDTH;
// Used instead of LABEL_HORIZONTAL_MARGIN when NO label ends up
// side-anchored — still needs to be non-zero, since a middle-anchored
// (top/bottom) label's wrapped width can extend past its own circle's edge
// by up to half of centerMaxLabelWidth, which could otherwise clip the
// panel edge for a circle sitting near the outer edge of the layout.
const LABEL_MIDDLE_HORIZONTAL_MARGIN = 40;

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

function blend(keys, categoryColors) {
    const rgbs = keys.map((k) => d3.rgb(categoryColors[k]));
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

// Formats a set of category keys as a double-quoted, comma-separated list
// ready to drop straight into SPL's IN() clause, e.g. `category
// IN($token$)` — so clicking/hovering ANY category-related element gives a
// token for "every event tagged with ANY of these categories" (IN() is a
// union over its listed values). For a single circle/legend/dot this is
// just one quoted name; for a multi-category region (e.g. the A∩B overlap)
// it's genuinely useful — the region itself represents just the exact
// overlap, but the IN() list built from its categories pulls the broader
// union (A-only + B-only + A∩B together), which is what "find everything
// related to this pair of signals" usually actually means. Quotes inside a
// category name are escaped so an unusual name can't break the SPL syntax
// a dashboard author pastes this into.
function buildCategoryListToken(keys, names) {
    return keys.map((k) => `"${String(names[k]).replace(/"/g, '\\"')}"`).join(', ');
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
function buildDotDrilldownPayload(d, names) {
    const payload = { name: d.id, value: d.value };
    Object.entries(d.rawFields || {}).forEach(([field, value]) => {
        payload[`row.${field}.value`] = value ?? '';
    });
    payload['row.tooltip.value'] = buildDotTooltipText(d);
    payload['row.color.value'] = d.color;
    payload['row.categoryList.value'] = buildCategoryListToken(d.memberships, names);
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

// Pure geometry pipeline (no DOM) — venn.js's own VennDiagram() chart never
// exposes final scaled circle geometry on the datum, so this has to be
// recomputed manually with the exact same width/height/padding used for the
// real chart() render (see renderVenn). Also run BEFORE that render, with a
// provisional width, purely to measure a solution's natural footprint —
// cheap pure math, so doing it twice per render is fine.
function computeVennGeometry(vennSets, names, w, h) {
    let solution = venn.venn(vennSets);
    solution = venn.normalizeSolution(solution, Math.PI / 2, null);
    const scaled = venn.scaleSolution(solution, w, h, 15);
    const circles = {};
    REGION_KEYS.forEach((k) => {
        if (scaled[names[k]]) circles[k] = scaled[names[k]];
    });
    const activeKeys = REGION_KEYS.filter((k) => circles[k]);
    return { circles, activeKeys };
}

// Each label sits just outside its own circle, along the direction from the
// diagram's overall center out through that circle's own center — this is
// data-driven rather than hardcoded per letter, so whichever circle ends up
// top/bottom/side for a given dataset (venn.js's layout solver decides
// that, not us) gets a label placed sensibly outside it. Extracted as a
// standalone function (rather than inlined in the label-rendering loop) so
// the chart-sizing pre-check in renderVenn (measureDiagramLayout, below)
// and the real label placement use IDENTICAL direction logic — duplicating
// it would risk the two silently drifting apart.
function computeLabelDirections(circles, activeKeys) {
    const centroid = {
        x: d3.mean(activeKeys, (k) => circles[k].x),
        y: d3.mean(activeKeys, (k) => circles[k].y),
    };
    // With exactly 2 circles, they sit side by side at roughly the same
    // height — the general "radially away from center" rule would put both
    // labels off to the side, each cramped toward whichever edge is nearer.
    // Top/bottom instead gives each one the full, symmetric width to wrap
    // into: left circle's label on top, right circle's on the bottom.
    const isTwoCircleLayout = activeKeys.length === 2;
    const leftKey = isTwoCircleLayout
        ? activeKeys.reduce((a, b) => (circles[a].x <= circles[b].x ? a : b))
        : null;
    const directions = {};
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
        const anchor = ux < -0.15 ? 'end' : ux > 0.15 ? 'start' : 'middle';
        directions[key] = { ux, effectiveUy, anchor };
    });
    return directions;
}

// Used by renderVenn's chart-sizing pre-check: does this layout need full
// side-label room on both edges, or will every label end up top/bottom
// (middle-anchored)? Also measures the solution's actual bounding width, so
// the final chartWidth can be sized to what the diagram really needs
// instead of the full leftover panel width — venn.js centers its solution
// within whatever box it's given, so a needlessly wide box just shows up as
// empty gutters on both sides once the (usually height-bound) diagram is
// centered inside it.
function measureDiagramLayout(circles, activeKeys) {
    const directions = computeLabelDirections(circles, activeKeys);
    const anySideAnchored = activeKeys.some((k) => directions[k].anchor !== 'middle');
    const naturalWidth =
        d3.max(activeKeys, (k) => circles[k].x + circles[k].radius) -
        d3.min(activeKeys, (k) => circles[k].x - circles[k].radius);
    return { anySideAnchored, naturalWidth };
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
    hoverTargetRef,
    categoryColors,
    showCounts
) {
    container.innerHTML = '';

    const prefersReducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const isSideLegend = legendPos === 'left' || legendPos === 'right';
    const reserve = LEGEND_RESERVE[legendPos] ?? 0;

    const noop = { stop: () => {}, setActiveSet: () => {}, animateOutCategory: (_name, onComplete) => onComplete() };

    const vennSets = buildVennSets(hosts, names);
    if (vennSets.length === 0) return noop;

    // Vertical margin matches the label size actually in effect, not a
    // fixed worst-case — see the comment above LABEL_HORIZONTAL_MARGIN.
    const labelFontSize = LABEL_FONT_SIZES[labelSize] || LABEL_FONT_SIZES[DEFAULT_LABEL_SIZE];
    const verticalMargin = LABEL_OFFSET + LABEL_MAX_LINES * labelFontSize * LABEL_LINE_HEIGHT_MULTIPLIER;
    // chartHeight doesn't depend on chartWidth, so it's final immediately.
    // availableHeight (pre-margin) is kept around too — used later to
    // compute exactly how much further the whole rendered diagram can be
    // scaled up once its ACTUAL measured extent is known (see fillScale
    // near the end of this function), since chartHeight itself already has
    // the conservative worst-case margin baked in.
    const availableHeight = Math.max(80, height - PANEL_PADDING * 2 - (isSideLegend ? 0 : reserve));
    const chartHeight = Math.max(80, availableHeight - verticalMargin * 2);

    // chartWidth is trickier: how much horizontal room to reserve depends
    // on which direction labels end up pointing, which depends on the
    // circles' layout, which depends on chartWidth itself. Resolved with a
    // provisional (deliberately generous) geometry pass purely to measure
    // the solution's natural footprint and label directions — pure math, no
    // DOM touched, so running it twice per render (here and again once
    // chartWidth is final) is cheap. This replaces always reserving full
    // side-label room on both edges regardless of whether any label ends up
    // side-anchored (most layouts never do — see computeLabelDirections),
    // which on a wide landscape panel meant venn.js centered an
    // already-height-bound diagram inside a needlessly wide box: exactly
    // the "lot of white space around the diagram" Daniel reported.
    const availableWidth = Math.max(80, width - PANEL_PADDING * 2 - (isSideLegend ? reserve : 0));
    const provisional = computeVennGeometry(vennSets, names, availableWidth, chartHeight);
    if (provisional.activeKeys.length === 0) return noop;
    const { anySideAnchored, naturalWidth } = measureDiagramLayout(
        provisional.circles,
        provisional.activeKeys
    );
    const horizontalMargin = anySideAnchored ? LABEL_HORIZONTAL_MARGIN : LABEL_MIDDLE_HORIZONTAL_MARGIN;
    // Two ceilings, take whichever is tighter:
    //  - never below availableWidth minus the full margin — this is a hard
    //    floor on how much room stays OUTSIDE the svg (same guarantee the
    //    old fixed-subtraction formula always gave), so a narrow panel
    //    can't eat into it the way `min(availableWidth, natural+margin)`
    //    alone did: when natural+margin exceeded availableWidth, that
    //    version picked availableWidth outright with ZERO margin left,
    //    since venn.js then re-fits circles snugly to whatever width it's
    //    given — exactly reproducing the label-clipping bug the "scale to
    //    fit" work fixed previously. Verified via headless regression.
    //  - never above what the diagram naturally needs (+ margin) — this is
    //    the actual space-filling improvement: no point making the svg
    //    wider than its own content, since venn.js would just center that
    //    content inside the extra width, showing as dead space.
    const maxChartWidth = Math.max(80, availableWidth - horizontalMargin * 2);
    const chartWidth = Math.max(80, Math.min(maxChartWidth, naturalWidth + horizontalMargin * 2));

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
        const base = categoryColors[key];
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
            .style('fill', fillCircles ? blend(keys, categoryColors) : backgroundColor)
            .style('fill-opacity', fillCircles ? CIRCLE_FILL_OPACITY : 1)
            .style('pointer-events', 'none');
    });

    // venn.js's VennDiagram() never exposes final scaled circle geometry on
    // the datum — it must be recomputed with the exact same pipeline and
    // matching width/height/padding, or containment math won't match what's
    // drawn. chartWidth changed since the provisional pass above (it's now
    // final), so circle positions shift — this is the FINAL geometry, used
    // for containment, dot seeding, outlines, and label placement below.
    const { circles, activeKeys } = computeVennGeometry(vennSets, names, chartWidth, chartHeight);
    if (activeKeys.length === 0) return noop;

    const valueExtent = d3.extent(hosts, (h) => h.value);
    const rScale =
        valueExtent[0] === valueExtent[1]
            ? () => 3.5
            : d3.scaleSqrt().domain(valueExtent).range([2.2, 5.5]);
    hosts.forEach((h) => {
        h.r = rScale(h.value);
        h.color = blend(h.memberships, categoryColors);
    });

    // Region density (Monte Carlo area estimation) serves two different
    // purposes depending on mode: in dot mode, capping how many dots a thin
    // crescent region can actually hold without spilling outside it; in
    // "show counts" mode, placing each region's number at a point
    // genuinely inside that region (the average of the samples that landed
    // in it) and sizing its text/hit-area off the region's real area. The
    // samples' own average position is a much better label point than, say,
    // the geometric centroid of the region's bounding circles, which for a
    // crescent-shaped exclusive region can land outside the region itself.
    const areaCounts = {};
    const regionSumX = {};
    const regionSumY = {};
    for (let i = 0; i < DENSITY_SAMPLES; i++) {
        const x = Math.random() * chartWidth;
        const y = Math.random() * chartHeight;
        const key = classify(circles, activeKeys, x, y);
        if (key) {
            areaCounts[key] = (areaCounts[key] || 0) + 1;
            regionSumX[key] = (regionSumX[key] || 0) + x;
            regionSumY[key] = (regionSumY[key] || 0) + y;
        }
    }
    const boxArea = chartWidth * chartHeight;
    const regionArea = {};
    const regionCentroid = {};
    Object.keys(areaCounts).forEach((key) => {
        regionArea[key] = (areaCounts[key] / DENSITY_SAMPLES) * boxArea;
        regionCentroid[key] = { x: regionSumX[key] / areaCounts[key], y: regionSumY[key] / areaCounts[key] };
    });

    const hostsByRegion = d3.group(hosts, (h) => regionKeyOf(h.memberships));

    if (!showCounts) {
        hostsByRegion.forEach((regionHosts, key) => {
            const area = regionArea[key] || 0;
            const capacity = area * PACKING_EFFICIENCY;
            const requestedArea = d3.sum(regionHosts, (h) => Math.PI * h.r * h.r);
            if (requestedArea > capacity && requestedArea > 0) {
                const scale = Math.sqrt(capacity / requestedArea);
                regionHosts.forEach((h) => {
                    h.r = Math.max(1.3, h.r * scale);
                });
            }
        });

        // Seed each host via rejection sampling inside the bounding box of
        // its included circles, so the simulation only has to resolve
        // collisions rather than migrate nodes across boundaries from a
        // guessed start. Skipped entirely in "show counts" mode — no dots
        // get rendered there, so there's nothing to seed a position for.
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
    }

    const svg = div.select('svg');
    svg.style('overflow', 'visible');

    // Every rendered element (venn.js's own circle/intersection groups,
    // already children of svg at this point, plus our outline/label/dot
    // layers appended below) moves into this one wrapper group instead of
    // sitting directly on svg — so the whole diagram can be scaled up as a
    // single unit once its ACTUAL rendered extent is known (see fillScale
    // near the end of this function). chartWidth/chartHeight above are
    // deliberately sized against a conservative worst-case label-wrapping
    // budget, not the real (usually shorter) text, so there's normally
    // genuine leftover room — rather than guess a fixed percentage,
    // fillScale measures it directly and uses exactly what's actually free.
    const existingSvgChildren = Array.from(svg.node().childNodes);
    const contentGroup = svg.append('g').attr('class', 'venn-scale-wrapper');
    existingSvgChildren.forEach((node) => contentGroup.node().appendChild(node));

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
    const outlineLayer = contentGroup.append('g').attr('class', 'circle-outline-layer');
    activeKeys.forEach((key) => {
        const c = circles[key];
        outlineLayer
            .append('circle')
            .attr('class', 'circle-outline')
            .attr('data-set-key', key)
            .attr('cx', c.x)
            .attr('cy', c.y)
            .attr('r', c.radius)
            .style('--circle-stroke', categoryColors[key]);
    });

    // Each label sits just outside its own circle, along the direction from
    // the diagram's overall center out through that circle's own center —
    // this is data-driven rather than hardcoded per letter, so whichever
    // circle actually ends up top/bottom-left/bottom-right for a given
    // dataset (venn.js's layout solver decides that, not us) gets a label
    // placed sensibly outside it rather than a label baked to a fixed
    // on-screen position that could end up wrong (or overlapping another
    // circle) for a different size mix. (labelFontSize is computed earlier,
    // alongside chartHeight's vertical-margin calculation — reused here.)
    const labelLayer = contentGroup.append('g').attr('class', 'circle-label-layer');
    // Top/bottom (anchor 'middle') labels get the general, chartWidth-scaled
    // budget; side-anchored ones are capped to LABEL_SIDE_MAX_WIDTH instead,
    // matching exactly the horizontal margin actually reserved for them
    // above — computed per-label below, once `anchor` is known.
    const centerMaxLabelWidth = Math.min(
        LABEL_MAX_WIDTH,
        Math.max(LABEL_MIN_WIDTH, chartWidth * LABEL_WIDTH_FRACTION)
    );
    // Same direction logic used by the chart-sizing pre-check above
    // (measureDiagramLayout), so the two can never disagree about which
    // labels end up side-anchored.
    const labelDirections = computeLabelDirections(circles, activeKeys);
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
        const { ux, effectiveUy } = labelDirections[key];
        const labelX = c.x + ux * (c.radius + LABEL_OFFSET);
        const labelY = c.y + effectiveUy * (c.radius + LABEL_OFFSET);
        const { anchor } = labelDirections[key];
        const maxLabelWidth = anchor === 'middle' ? centerMaxLabelWidth : LABEL_SIDE_MAX_WIDTH;

        const label = labelLayer
            .append('text')
            .attr('class', 'circle-label')
            .attr('data-set-key', key)
            .attr('text-anchor', anchor)
            .style('fill', categoryColors[key])
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

    // Shared by both modes — the region-count tooltip (below) reuses this
    // same node/pattern rather than a second implementation.
    const tooltip = wrap.append('div').attr('class', 'venn-tooltip');
    // Assigned inside whichever branch below actually runs; referenced
    // later by setActiveSet/animateOutCategory/the returned handle, which
    // need to work correctly regardless of which mode rendered.
    let dotSel = null;
    let sim = null;
    let countGroupSel = null;
    let countRegions = null;

    if (!showCounts) {
    const dotLayer = contentGroup.append('g').attr('class', 'dot-layer');
    dotSel = dotLayer
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
            if (hoverTargetRef) hoverTargetRef.current = buildDotDrilldownPayload(d, names);
        })
        .on('mousemove', (event) => {
            const [x, y] = d3.pointer(event, wrap.node());
            tooltip.style('left', `${x + 12}px`).style('top', `${y - 24}px`);
        })
        .on('mouseout', () => {
            tooltip.classed('venn-tooltip--visible', false);
            if (hoverTargetRef) hoverTargetRef.current = null;
        });
    } else {
        // "Show counts" mode: one number per region (all 7 possible A/B/C
        // combinations, whichever actually have items) instead of packed
        // dots — for when there are too many items to read individually.
        // Legibility of the tiniest region (almost always the 3-way
        // center) comes from a hover tooltip with the exact figures,
        // rather than literal on-hover magnification of part of the SVG —
        // simpler to get right and consistent with how dots already work.
        const countsLayer = contentGroup.append('g').attr('class', 'count-layer');
        const regions = [...hostsByRegion.entries()]
            .map(([key, regionHosts]) => {
                const memberKeys = key.split(',').filter(Boolean);
                const fallbackCenter = () => {
                    const bb = bboxForIncluded(circles, memberKeys);
                    return { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
                };
                return {
                    key,
                    memberKeys,
                    count: regionHosts.length,
                    totalValue: d3.sum(regionHosts, (h) => h.value),
                    area: regionArea[key] || 0,
                    // Falls back to the bounding-circles' center on the rare
                    // chance a region is real (has items) but too thin for
                    // any of the 40k density samples to have landed in it.
                    centroid: regionCentroid[key] || fallbackCenter(),
                };
            })
            // Render biggest-area first (painted on the bottom) and
            // smallest last (on top) — their circular hit-areas are only
            // an approximation of the true (often crescent-shaped) region,
            // so they can overlap slightly; this ordering makes sure the
            // most specific region always wins that overlap, which matters
            // most for the tiny A∩B∩C center sitting inside 3 much larger
            // regions' approximate hit-areas.
            .sort((a, b) => b.area - a.area);

        const regionGroups = countsLayer
            .selectAll('g.count-region')
            .data(regions, (r) => r.key)
            .join('g')
            .attr('class', 'count-region')
            .attr('data-member-keys', (r) => r.key);
        countGroupSel = regionGroups;
        countRegions = regions;

        regionGroups.each(function (r) {
            const g = d3.select(this);
            const hitRadius = Math.max(COUNT_HIT_RADIUS_MIN, Math.sqrt(r.area / Math.PI));
            const fontSize = Math.max(COUNT_FONT_MIN, Math.min(COUNT_FONT_MAX, hitRadius * 0.9));

            g.append('circle')
                .attr('class', 'region-hit-area')
                .attr('cx', r.centroid.x)
                .attr('cy', r.centroid.y)
                .attr('r', hitRadius);

            g.append('text')
                .attr('class', 'region-count')
                .attr('x', r.centroid.x)
                .attr('y', r.centroid.y)
                .style('font-size', `${fontSize}px`)
                .text(r.count);
        });

        function regionDisplayName(r) {
            return r.memberKeys.map((k) => names[k]).join(' + ');
        }
        function buildRegionDrilldownPayload(r) {
            return {
                name: regionDisplayName(r),
                value: r.count,
                'row.totalValue.value': r.totalValue,
                'row.color.value': blend(r.memberKeys, categoryColors),
                'row.categoryList.value': buildCategoryListToken(r.memberKeys, names),
            };
        }

        regionGroups
            .on('mouseenter', (_event, r) => {
                // No visible fill on the hit-area circle itself (see the
                // CSS comment on .region-hit-area) — hover feedback is just
                // the parent circle(s) highlighting plus this tooltip.
                setActiveSet(r.memberKeys);
                tooltip.selectAll('*').remove();
                tooltip.append('div').attr('class', 'venn-tooltip-id').text(regionDisplayName(r));
                tooltip.append('div').text(`${r.count} item${r.count === 1 ? '' : 's'}`);
                tooltip.append('div').text(`Total value: ${r.totalValue}`);
                tooltip.classed('venn-tooltip--visible', true);
                if (hoverTargetRef) hoverTargetRef.current = buildRegionDrilldownPayload(r);
            })
            .on('mousemove', (event) => {
                const [x, y] = d3.pointer(event, wrap.node());
                tooltip.style('left', `${x + 12}px`).style('top', `${y - 24}px`);
            })
            .on('mouseleave', () => {
                setActiveSet(null);
                tooltip.classed('venn-tooltip--visible', false);
                if (hoverTargetRef) hoverTargetRef.current = null;
            });

        if (!prefersReducedMotion) {
            regionGroups
                .style('opacity', 0)
                .transition()
                .duration(ENTRANCE_DURATION_MS)
                .delay(() => Math.random() * ENTRANCE_STAGGER_MAX_MS)
                .style('opacity', 1);
        }
    }

    // Activating a set (by hovering its circle, an intersection region's
    // count in "show counts" mode, OR the matching legend item —
    // setActiveSet is exposed on the returned handle for the legend case,
    // since a legend item lives in a separate React-rendered DOM tree with
    // no CSS relationship to the SVG, so this can't be a plain :hover rule)
    // darkens the active circle(s)' own fill/border, dims every OTHER
    // circle's fill (only meaningful when fillCircles is on — otherwise
    // every fill-opacity here is already 0), and pauses the idle pulse on
    // every dot that ISN'T a member of the active set(s). Accepts either a
    // single key (the existing single-circle-hover callers) or an array of
    // keys (an intersection region belongs to more than one circle at
    // once, e.g. hovering the A∩B count should highlight BOTH A and B,
    // neither one dimmed relative to the other).
    function setActiveSet(keyOrKeys) {
        const activeList = keyOrKeys == null ? [] : Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        const hasActive = activeList.length > 0;
        div.selectAll('.venn-circle path').each(function (d) {
            const k = REGION_KEYS.find((rk) => names[rk] === d.sets[0]);
            d3.select(this)
                .classed('venn-circle--active', activeList.includes(k))
                .classed('venn-circle--dimmed', fillCircles && hasActive && !activeList.includes(k));
        });
        outlineLayer.selectAll('.circle-outline').each(function () {
            const k = this.getAttribute('data-set-key');
            // The outline dims only when Fill is off — when it's on, the
            // fill paths above already dim for focus, so dimming the
            // outline too would be redundant. With Fill off, the outline
            // (plus the label) is the only thing there is to dim.
            d3.select(this)
                .classed('venn-circle--active', activeList.includes(k))
                .classed('venn-circle--dimmed', !fillCircles && hasActive && !activeList.includes(k));
        });
        if (dotSel && animateItems && !prefersReducedMotion) {
            dotSel.classed(
                'host-dot--pulse-paused',
                (h) => hasActive && !h.memberships.some((m) => activeList.includes(m))
            );
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
                hoverTargetRef.current = {
                    name: names[key],
                    'row.color.value': categoryColors[key],
                    'row.categoryList.value': buildCategoryListToken([key], names),
                };
            }
        })
        .on('mouseleave', () => {
            setActiveSet(null);
            if (hoverTargetRef) hoverTargetRef.current = null;
        })
        .on('click', function () {
            // Both this circle's own group and outlineLayer are children of
            // contentGroup now (see the scale-wrapper re-parenting above),
            // not of svg directly — insertBefore's reference node must
            // share the same parent it's called on.
            contentGroup.node().insertBefore(this.parentNode, outlineLayer.node());
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
        if (dotSel) {
            const exclusiveDots = dotSel.filter((h) => h.memberships.length === 1 && h.memberships[0] === key);
            if (!exclusiveDots.empty()) {
                transitions.push(
                    exclusiveDots.transition().duration(duration).attr('r', 0).style('opacity', 0).end()
                );
            }
        }
        if (countGroupSel) {
            // Only the region EXCLUSIVE to this category (data-member-keys
            // is exactly this one key, e.g. "A" not "A,B") — a region that
            // also belongs to another still-visible category isn't
            // disappearing, same rule exclusiveDots above follows for dots.
            const exclusiveRegions = countGroupSel.filter(function () {
                return this.getAttribute('data-member-keys') === key;
            });
            if (!exclusiveRegions.empty()) {
                transitions.push(exclusiveRegions.transition().duration(duration).style('opacity', 0).end());
            }
        }

        // .end() rejects if a transition gets interrupted (e.g. the
        // container is torn down mid-fade) — proceed to onComplete either
        // way rather than leaving the toggle stuck.
        Promise.all(transitions).then(onComplete, onComplete);
    }

    // Force simulation only exists in dot mode — "show counts" has no
    // per-item positions to resolve collisions between.
    if (!showCounts) {
        // Checking A, then B, then C once each per tick lets fixing one
        // boundary re-break another (Gauss-Seidel problem) — run the clamp
        // to convergence (~6 passes) per node per tick instead.
        const clampToRegion = (node) => {
            let p = { x: node.x, y: node.y };
            for (let i = 0; i < 6; i++) p = clampOnce(circles, activeKeys, p, node);
            node.x = p.x;
            node.y = p.y;
        };

        sim = d3
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
    }

    // Everything above was sized against a conservative, worst-case label
    // budget (see verticalMargin/horizontalMargin) rather than each
    // label's actual (usually shorter) wrapped text — so there's normally
    // real room left over. Rather than guess a fixed "grow by X%", measure
    // the diagram's true rendered extent (circle bounds + each label's
    // final, post-collision-avoidance box from labelBBox) and scale
    // contentGroup up by exactly whatever fraction of that leftover room
    // is actually there. Dots aren't measured separately — containment
    // guarantees every dot sits within its circle, so circle bounds already
    // cover them.
    const contentBounds = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    const extendBounds = (x0, x1, y0, y1) => {
        contentBounds.x0 = Math.min(contentBounds.x0, x0);
        contentBounds.x1 = Math.max(contentBounds.x1, x1);
        contentBounds.y0 = Math.min(contentBounds.y0, y0);
        contentBounds.y1 = Math.max(contentBounds.y1, y1);
    };
    activeKeys.forEach((key) => {
        const c = circles[key];
        extendBounds(c.x - c.radius, c.x + c.radius, c.y - c.radius, c.y + c.radius);
    });
    labelEntries.forEach((entry) => {
        const box = labelBBox(entry);
        extendBounds(box.x0, box.x1, box.y0, box.y1);
    });
    // "Show counts" mode's region hit-areas are usually already covered by
    // the circle bounds above, but not guaranteed — a very lopsided region
    // (small area, far from its circles' own centers) could have a
    // characteristic radius that pokes outside them. Cheap to just measure
    // directly rather than assume.
    if (countRegions) {
        countRegions.forEach((r) => {
            const hitRadius = Math.max(COUNT_HIT_RADIUS_MIN, Math.sqrt(r.area / Math.PI));
            extendBounds(
                r.centroid.x - hitRadius,
                r.centroid.x + hitRadius,
                r.centroid.y - hitRadius,
                r.centroid.y + hitRadius
            );
        });
    }

    // Scaling happens around the SVG's own nominal center — the same point
    // the outer flexbox already centers the whole svg on — rather than the
    // content's own (possibly off-center, e.g. one label sticking out
    // further than another) bounding-box center, so the result stays
    // visually centered in the panel instead of drifting toward whichever
    // side has more content.
    const scaleOriginX = chartWidth / 2;
    const scaleOriginY = chartHeight / 2;
    const leftDist = scaleOriginX - contentBounds.x0;
    const rightDist = contentBounds.x1 - scaleOriginX;
    const topDist = scaleOriginY - contentBounds.y0;
    const bottomDist = contentBounds.y1 - scaleOriginY;
    const scaleX =
        leftDist > 0 && rightDist > 0 ? availableWidth / 2 / Math.max(leftDist, rightDist) : 1;
    const scaleY =
        topDist > 0 && bottomDist > 0 ? availableHeight / 2 / Math.max(topDist, bottomDist) : 1;
    // Never shrink at runtime — if measurement ever came out below 1 that
    // would mean the sizing above already has a real overflow bug to fix
    // properly (and be caught by the headless regression checks), not
    // something to silently paper over by shrinking after the fact.
    const fillScale = Math.max(1, Math.min(scaleX, scaleY));
    if (fillScale > 1.001) {
        contentGroup.attr(
            'transform',
            `translate(${scaleOriginX},${scaleOriginY}) scale(${fillScale}) translate(${-scaleOriginX},${-scaleOriginY})`
        );
    }

    return { stop: () => sim?.stop(), setActiveSet, animateOutCategory };
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
function Legend({ names, onHoverSet, onToggle, disabledCategoryNames, textColor, hoverTargetRef, categoryColors }) {
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
                                hoverTargetRef.current = {
                                    name: names[k],
                                    'row.color.value': categoryColors[k],
                                    'row.categoryList.value': buildCategoryListToken([k], names),
                                };
                            }
                        }}
                        onMouseLeave={() => {
                            onHoverSet(null);
                            if (hoverTargetRef) hoverTargetRef.current = null;
                        }}
                        onClick={() => onToggle(names[k])}
                        title={isDisabled ? `Click to show ${names[k]}` : `Click to hide ${names[k]}`}
                    >
                        <span className="venn-legend-swatch" style={{ background: categoryColors[k] }} />
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
    const showCounts = options?.showCounts === true;
    const labelSize = LABEL_FONT_SIZES[options?.labelSize] ? options.labelSize : DEFAULT_LABEL_SIZE;
    const legendTextColor = theme === 'light' ? LEGEND_TEXT_COLOR.light : LEGEND_TEXT_COLOR.dark;
    // Positional, not name-based — "category color 1" always means
    // whichever category is alphabetically first this render (region key
    // A), same as the pre-existing region-key assignment already works.
    // Kept as individual primitive values (not one object built once) so
    // the renderVenn effect's dependency array below can list them directly
    // — a fresh `{A,B,C}` object literal every render would otherwise
    // never be dependency-equal to itself and re-trigger the effect
    // constantly.
    const categoryColorA = options?.categoryColorA || DEFAULT_CATEGORY_COLORS.A;
    const categoryColorB = options?.categoryColorB || DEFAULT_CATEGORY_COLORS.B;
    const categoryColorC = options?.categoryColorC || DEFAULT_CATEGORY_COLORS.C;
    const categoryColors = { A: categoryColorA, B: categoryColorB, C: categoryColorC };

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
            hoverTargetRef,
            categoryColors,
            showCounts
        );
        rendererRef.current = handle;
        return () => {
            rendererRef.current = null;
            handle.stop();
        };
        // categoryColors itself is a fresh object every render (see above)
        // — depend on its primitive fields instead so this doesn't refire
        // needlessly.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        hosts,
        width,
        height,
        names,
        legendPos,
        fillCircles,
        animateItems,
        showCounts,
        backgroundColor,
        labelSize,
        categoryColorA,
        categoryColorB,
        categoryColorC,
    ]);

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
                        categoryColors={categoryColors}
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
