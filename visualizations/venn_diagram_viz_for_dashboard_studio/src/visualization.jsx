import { useDataSources, useDimensions } from '@splunk/dashboard-studio-extension/react';
import * as d3 from 'd3';
import { useEffect, useMemo, useRef } from 'react';
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

// Field-mapping and category naming/coloring will move into the options
// panel; hardcoded here to match the SPL shape documented in CLAUDE.md until
// then: in_A/in_B/in_C membership flags, host id, optional alerts metric.
const DEFAULT_NAMES = { A: 'Set A', B: 'Set B', C: 'Set C' };
const CATEGORY_COLORS = { A: '#5fb3d9', B: '#d9a441', C: '#d9564f' };

const PACKING_EFFICIENCY = 0.82;
const DENSITY_SAMPLES = 40000;
const LEGEND_HEIGHT = 34;
const PANEL_PADDING = 16;

function isTruthy(value) {
    if (value == null) return false;
    const normalized = String(value).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function toRows(data) {
    if (!data || !data.fields || !data.columns || data.columns.length === 0) return [];
    const fieldNames = data.fields.map((f) => f.name || f);
    const numRows = data.columns[0]?.length ?? 0;
    return Array.from({ length: numRows }, (_, i) =>
        Object.fromEntries(fieldNames.map((name, j) => [name, data.columns[j][i]]))
    );
}

function buildHosts(rows) {
    const hosts = [];
    rows.forEach((row, i) => {
        const memberships = REGION_KEYS.filter((k) => isTruthy(row[`in_${k}`]));
        if (memberships.length === 0) return;
        const alertsRaw = row.alerts;
        const alerts = alertsRaw != null && alertsRaw !== '' ? parseFloat(alertsRaw) : 1;
        hosts.push({
            id: row.host != null && row.host !== '' ? String(row.host) : `row-${i}`,
            memberships,
            alerts: Number.isFinite(alerts) ? alerts : 1,
        });
    });
    return hosts;
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

// ---- The imperative D3/venn.js render, isolated from React's tree --------
function renderVenn(container, hosts, width, height, names) {
    container.innerHTML = '';

    const chartWidth = Math.max(80, width - PANEL_PADDING * 2);
    const chartHeight = Math.max(80, height - PANEL_PADDING * 2 - LEGEND_HEIGHT);

    const vennSets = buildVennSets(hosts, names);
    if (vennSets.length === 0) return () => {};

    const wrap = d3.select(container).append('div').attr('class', 'venn-chart-wrap');
    const chartDiv = wrap.append('div').attr('class', 'venn-chart');
    const chart = venn.VennDiagram().width(chartWidth).height(chartHeight);
    const div = chartDiv.datum(vennSets).call(chart);

    div.selectAll('.venn-circle path')
        .style('fill', 'none')
        .style('stroke', (d) => {
            const key = REGION_KEYS.find((k) => names[k] === d.sets[0]);
            return CATEGORY_COLORS[key];
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
    if (activeKeys.length === 0) return () => {};

    const alertsExtent = d3.extent(hosts, (h) => h.alerts);
    const rScale =
        alertsExtent[0] === alertsExtent[1]
            ? () => 3.5
            : d3.scaleSqrt().domain(alertsExtent).range([2.2, 5.5]);
    hosts.forEach((h) => {
        h.r = rScale(h.alerts);
        h.color = h.memberships.length === 3 ? blend(TRIPLE_COMBO) : blend(h.memberships);
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
    const dotLayer = svg.append('g').attr('class', 'dot-layer');
    const dotSel = dotLayer
        .selectAll('circle.host-dot')
        .data(hosts, (d) => d.id)
        .join('circle')
        .attr('class', 'host-dot')
        .attr('r', (d) => d.r)
        .attr('fill', (d) => d.color)
        .attr('opacity', 0.9);

    const tooltip = wrap.append('div').attr('class', 'venn-tooltip');

    dotSel
        .on('mouseover', (_event, d) => {
            tooltip.selectAll('*').remove();
            tooltip.append('div').attr('class', 'venn-tooltip-id').text(d.id);
            tooltip.append('div').text(d.memberships.map((k) => names[k]).join(' + '));
            tooltip.append('div').text(`${d.alerts} alerts`);
            tooltip.classed('venn-tooltip--visible', true);
        })
        .on('mousemove', (event) => {
            const [x, y] = d3.pointer(event, wrap.node());
            tooltip.style('left', `${x + 12}px`).style('top', `${y - 24}px`);
        })
        .on('mouseout', () => {
            tooltip.classed('venn-tooltip--visible', false);
        });

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

    const prefersReducedMotion =
        typeof window !== 'undefined' &&
        window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
        sim.stop();
        for (let i = 0; i < 300; i++) sim.tick();
    }

    return () => sim.stop();
}

function LoadingState() {
    return <div className="viz-container viz-container--empty" />;
}

function EmptyState({ message }) {
    return (
        <div className="viz-container viz-container--empty">
            <div className="viz-message">{message}</div>
        </div>
    );
}

function Legend({ names }) {
    return (
        <div className="venn-legend">
            {REGION_KEYS.map((k) => (
                <div className="venn-legend-item" key={k}>
                    <span className="venn-legend-swatch" style={{ background: CATEGORY_COLORS[k] }} />
                    {names[k]}
                </div>
            ))}
        </div>
    );
}

function VennVisualization() {
    const { dataSources, loading } = useDataSources();
    const { width, height } = useDimensions();
    const chartRef = useRef(null);

    const rows = useMemo(() => toRows(dataSources?.primary?.data), [dataSources]);
    const hosts = useMemo(() => buildHosts(rows), [rows]);
    const names = DEFAULT_NAMES;

    useEffect(() => {
        const container = chartRef.current;
        if (!container || hosts.length === 0 || width <= 0 || height <= 0) return undefined;
        return renderVenn(container, hosts, width, height, names);
    }, [hosts, width, height, names]);

    if (loading) return <LoadingState />;
    if (rows.length === 0) return <EmptyState message="No data available" />;
    if (hosts.length === 0) {
        return (
            <EmptyState message="No rows matched any set (expected in_A / in_B / in_C membership fields)" />
        );
    }

    return (
        <div className="venn-viz viz-container">
            <div className="venn-wrap legend-bottom">
                <div className="venn-chart-container" ref={chartRef} />
                <Legend names={names} />
            </div>
        </div>
    );
}

const rootElement = document.getElementById('root') || document.body;
createRoot(rootElement).render(<VennVisualization />);
