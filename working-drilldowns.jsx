import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './patch-window-three.js';
import Globe from 'react-globe.gl';
import { MeshLambertMaterial } from 'three';
import * as solar from 'solar-calculator';
import { VisualizationAPI } from '@splunk/dashboard-studio-extension';
import {
    VisualizationExtensionProvider,
    useDataSources,
    useDimensions,
    useOptions,
} from '@splunk/dashboard-studio-extension/react';
import './visualization.css';
import earthDayTexture from './assets/earth-day.jpg';
import earthNightTexture from './assets/earth-night.jpg';
import earthBlueMarbleTexture from './assets/earth-blue-marble.jpg';
import earthDarkTexture from './assets/earth-dark.jpg';
import earthHeightTexture from './assets/earth-height.jpg';
import starfieldTexture from './assets/starfield.jpg';
import nightSkyTexture from './assets/night-sky.png';

const GLOBE_TEXTURES = {
    day: earthDayTexture,
    night: earthNightTexture,
    blue_marble: earthBlueMarbleTexture,
    dark: earthDarkTexture,
};

const BACKGROUND_IMAGES = {
    stars: starfieldTexture,
    night_sky: nightSkyTexture,
};

/* *****
 *  Helper Functions
 *  ---------------------------------------------------------------------------
 */

// Convert Dashboard Studio's columnar data shape into row objects keyed by field name.
function toRows(data) {
    if (!data || !data.columns || !data.columns.length) return [];
    const { fields, columns } = data;
    const fieldNames = fields.map((f) => f.name);
    return columns[0].map((_, rowIndex) =>
        Object.fromEntries(fieldNames.map((name, colIndex) => [name, columns[colIndex][rowIndex]]))
    );
}

// Line-style presets map to react-globe.gl's dash props. There's no true glow/bloom
// shader available for arcs, so "tracer" is approximated as a short, bright dash
// flowing fast along the arc (a comet/missile trail). "gradient" is the odd one out —
// it's not a dash pattern at all, it's a static solid line whose arcColor fades from
// a source tone to a destination tone (see arcColor below); everything else is dashes.
const ARC_LINE_STYLES = {
    solid: { dashLength: 1, dashGap: 0, animateTime: 0 },
    small_dashes: { dashLength: 0.12, dashGap: 0.08, animateTime: 0 },
    tracer: { dashLength: 0.15, dashGap: 0.85, animateTime: 1200 },
    pulse: { dashLength: 0.5, dashGap: 0.5, animateTime: 4000 },
    marching_ants: { dashLength: 0.08, dashGap: 0.08, animateTime: 2200 },
    flow: { dashLength: 0.06, dashGap: 0.04, animateTime: 1500 },
    fine_dots: { dashLength: 0.02, dashGap: 0.02, animateTime: 0 },
    gradient: { dashLength: 1, dashGap: 0, animateTime: 0 },
};

// Gradient mode's end color follows the row's dest_color field, falling back to this
// default when absent (start color similarly follows color, falling back to opt.arcDefaultColor
// — see arcColor below).
const ARC_GRADIENT_END_COLOR = '#00e5ff';

// labelSize is in angular degrees (text height); labelDotRadius scales alongside it at the
// same ratio react-globe.gl's own example uses (see labelDotRadius prop below).
const LABEL_SIZES = {
    small: 0.5,
    medium: 1.0,
    large: 1.8,
    extra_large: 3.5,
};

const DEFAULT_BACKGROUND_COLOR = '#000011';
const DEFAULT_ARC_COLOR = '#ffa500';
// react-globe.gl's color props get parsed via the `polished` package, which only accepts
// hex/rgb/rgba/hsl/hsla syntax and throws (breaking the whole render loop on first mount)
// on anything else. The editor.color widget's "theme default" preset can write an
// unresolved token like "> themes.defaultBackgroundColor" instead of a real color — Splunk's
// native panels resolve that themselves, but a custom viz just gets the raw string. Rather
// than special-case each such token as we discover it, only pass through values that are
// actually parseable; fall back to our own default for anything else.
const VALID_COLOR_PATTERN = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i;
function resolveColor(raw, fallback) {
    const value = raw?.trim();
    if (!value) return fallback;
    if (value.toLowerCase() === 'transparent') return 'rgba(0,0,0,0)';
    return VALID_COLOR_PATTERN.test(value) ? value : fallback;
}

// Shared point-radius scale: value=1 (the default when absent) gives a small dot,
// larger values grow it gently, clamped so no single point can dominate the globe.
function computePointRadius(rawValue) {
    const value = Number.isNaN(rawValue) ? 1 : rawValue;
    return Math.max(0.3, Math.min(1.2, 0.3 + value * 0.05));
}

// Map-pin marker, matching react-globe.gl's own html-markers example verbatim
// (https://github.com/vasturiano/react-globe.gl/blob/master/example/html-markers/index.html).
const MARKER_SVG = `<svg viewBox="-4 0 36 36">
    <path fill="currentColor" d="M14,0 C21.732,0 28,5.641 28,12.6 C28,23.963 14,36 14,36 C14,36 0,24.064 0,12.6 C0,5.641 6.268,0 14,0 Z"></path>
    <circle fill="black" cx="14" cy="14" r="7"></circle>
</svg>`;
const DEFAULT_MARKER_COLOR = '#00e5ff';
const HOVER_MOVE_THRESHOLD_PX = 6;

// "large" matches the marker's original fixed 24px size; small/medium scale down from there.
const MARKER_SIZES_PX = {
    small: 14,
    medium: 19,
    large: 24,
};

function buildMarkerElement(d, sizePx, tooltip) {
    const el = document.createElement('div');
    el.innerHTML = MARKER_SVG;
    el.style.color = d.color || DEFAULT_MARKER_COLOR;
    el.style.width = `${sizePx}px`;
    el.style.transition = 'opacity 250ms';
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'pointer';
    if (d.label && tooltip) {
        el.addEventListener('mouseenter', (e) => tooltip.show(d, e.clientX, e.clientY));
        el.addEventListener('mousemove', (e) => tooltip.move(e.clientX, e.clientY));
        el.addEventListener('mouseleave', () => tooltip.hide());
    }
    return el;
}

function escapeHtml(value) {
    return String(value).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
}

// Shared visual style for every hover tooltip (points, arcs, and pin markers) — a compact
// card with a color swatch matching the hovered item, so the look is consistent everywhere
// regardless of which of the three hover paths triggered it.
function buildTooltipHtml(label, color, detail) {
    const hasDetail = detail !== undefined && detail !== null && detail !== '';
    return `
        <div class="globe-viz-tooltip-title">
            <span class="globe-viz-tooltip-dot" style="background:${escapeHtml(color)}"></span>
            <span>${escapeHtml(label)}</span>
        </div>
        ${hasDetail ? `<div class="globe-viz-tooltip-detail">${escapeHtml(detail)}</div>` : ''}
    `;
}

// Day/night overlay, adapted from react-globe.gl's own solar-terminator example
// (https://github.com/vasturiano/react-globe.gl/blob/master/example/solar-terminator/index.html):
// a translucent dark tile centered on the antipodal point of the sun's current sub-solar
// point covers the *night* hemisphere instead of highlighting the lit one.
const NIGHT_TILE_MATERIAL = new MeshLambertMaterial({ color: '#000000', opacity: 0.5, transparent: true });
function sunPosAt(dt) {
    const day = new Date(+dt).setUTCHours(0, 0, 0, 0);
    const t = solar.century(dt);
    const longitude = ((day - dt) / 864e5) * 360 - 180;
    return [longitude - solar.equationOfTime(t) / 4, solar.declination(t)];
}

// The point on the globe directly opposite the sun — center of the night hemisphere.
function nightPosAt(dt) {
    const [sunLng, sunLat] = sunPosAt(dt);
    return [sunLng + 180, -sunLat];
}

function formatCoords(lat, lng) {
    return `${lat.toFixed(2)}°, ${lng.toFixed(2)}°`;
}

// A row is a point unless it also has a valid dest_lat/dest_lon, in which case
// it's an arc from (src_lat/src_lon, falling back to lat/lon) to (dest_lat/dest_lon)
// — plus a point marker at each end, so both locations stay visible on their own.
// `color` (if present) overrides the default color for either. `value` sizes point
// radius, or — for arcs — line thickness, falling back to opt.arcDefaultThickness.
function buildPointsAndArcs(rows, opt) {
    const points = [];
    const arcs = [];
    rows.forEach((row, idx) => {
        // `||` not `??` — Splunk's columnar rows represent an unset field as an empty
        // string, not null/undefined, so `??` alone wouldn't fall through to lat/lon
        // for a shared point+arc schema where src_lat/src_lon exist but are blank.
        const srcLat = parseFloat(row.src_lat || row.lat);
        const srcLon = parseFloat(row.src_lon || row.lon);
        if (Number.isNaN(srcLat) || Number.isNaN(srcLon)) return;

        const destLat = parseFloat(row.dest_lat);
        const destLon = parseFloat(row.dest_lon);
        const color = row.color || undefined;
        const destColor = row.dest_color || undefined;

        if (!Number.isNaN(destLat) && !Number.isNaN(destLon)) {
            const rawThickness = row.value ? parseFloat(row.value) : NaN;
            const thickness =
                Number.isNaN(rawThickness) || rawThickness <= 0
                    ? opt.arcDefaultThickness
                    : Math.min(rawThickness, 10);
            arcs.push({
                id: `arc-${idx}`,
                startLat: srcLat,
                startLng: srcLon,
                endLat: destLat,
                endLng: destLon,
                color,
                destColor,
                thickness,
                label: row.label || '',
                // Mirror the same src_label/label and dest_label fallback the endpoint
                // points use, so the arc's own tooltip can read "from -> to" consistently
                // with what's labeled at each end.
                fromLabel: row.src_label || row.label || '',
                toLabel: row.dest_label || '',
                sourceRow: row,
            });
            const endpointRadius = computePointRadius(row.value ? parseFloat(row.value) : NaN);
            points.push({
                id: `arc-src-${idx}`,
                lat: srcLat,
                lng: srcLon,
                label: row.src_label || row.label || '',
                color,
                radius: endpointRadius,
                sourceRow: row,
                pointType: 'arc_source',
            });
            points.push({
                id: `arc-dest-${idx}`,
                lat: destLat,
                lng: destLon,
                label: row.dest_label || '',
                color: destColor || color,
                radius: endpointRadius,
                sourceRow: row,
                pointType: 'arc_destination',
            });
        } else {
            points.push({
                id: `point-${idx}`,
                lat: srcLat,
                lng: srcLon,
                label: row.label || '',
                color,
                radius: computePointRadius(row.value ? parseFloat(row.value) : NaN),
                sourceRow: row,
                pointType: 'point',
            });
        }
    });
    return { points, arcs };
}

// Exposes every field the SPL search actually supplied for a row as row.<field>.value —
// not just the ones we parse out ourselves (lat/lon/label/etc.) — so any extra columns
// the user's search adds show up as bindable tokens too, same as the Calendar viz does.
function rowToDrilldownFields(row) {
    const fields = {};
    if (row) {
        Object.entries(row).forEach(([key, value]) => {
            fields[`row.${key}.value`] = value ?? '';
        });
    }
    return fields;
}

// Builds the drilldown payload for whatever's currently hovered: a flat name/value/title
// (so a plain "value" drilldown works with no extra configuration), fixed row.lat/row.lon
// (etc.) using the coordinates we already resolved for rendering — guaranteed present under
// a consistent name regardless of whether the row's own field was `lat`/`lon` or `src_lat`/
// `src_lon` — plus row.<field>.value for every raw SPL-supplied field via rowToDrilldownFields.
// Raw fields are spread last so a row's own `lat`/`lon` (if it has one) can still override.
function buildDrilldownPayload({ hoveredPoint, hoveredArc, hoveredCoords }) {
    if (hoveredPoint) {
        return {
            name: hoveredPoint.label,
            value: hoveredPoint.label,
            title: hoveredPoint.label,
            'row.type.value': hoveredPoint.pointType || 'point',
            'row.lat.value': String(hoveredPoint.lat),
            'row.lon.value': String(hoveredPoint.lng),
            ...rowToDrilldownFields(hoveredPoint.sourceRow),
        };
    }
    if (hoveredArc) {
        return {
            name: hoveredArc.label,
            value: hoveredArc.label,
            title: hoveredArc.label,
            'row.type.value': 'arc',
            'row.src_lat.value': String(hoveredArc.startLat),
            'row.src_lon.value': String(hoveredArc.startLng),
            'row.dest_lat.value': String(hoveredArc.endLat),
            'row.dest_lon.value': String(hoveredArc.endLng),
            ...rowToDrilldownFields(hoveredArc.sourceRow),
        };
    }
    if (hoveredCoords) {
        const label = formatCoords(hoveredCoords.lat, hoveredCoords.lng);
        return {
            name: label,
            value: label,
            title: label,
            'row.type.value': 'globe',
            'row.lat.value': String(hoveredCoords.lat),
            'row.lon.value': String(hoveredCoords.lng),
        };
    }
    return { name: '', value: '', title: '' };
}

function buildHeatmapPoints(rows) {
    const points = [];
    rows.forEach((row) => {
        const lat = parseFloat(row.src_lat || row.lat);
        const lng = parseFloat(row.src_lon || row.lon);
        if (Number.isNaN(lat) || Number.isNaN(lng)) return;
        const weight = row.value ? parseFloat(row.value) : 1;
        points.push({ lat, lng, weight: Number.isNaN(weight) ? 1 : weight });
    });
    return points;
}

const GlobeViz = () => {
    const globeRef = useRef(null);
    const containerRef = useRef(null);
    // Hover state is tracked continuously (not click state) because addDrilldownListener's
    // payloadCallback fires synchronously *before* any click event — reading state set by a
    // click handler would always be one click stale. See references/drilldown-and-tokens.md.
    const hoveredPointRef = useRef(null);
    const hoveredArcRef = useRef(null);
    const hoveredCoordsRef = useRef(null);

    // The tooltip is a single plain DOM node mutated imperatively (not React state) so that
    // hovering — which fires continuously on every pointer move — never re-renders GlobeViz
    // and its (uncached) pointsData/arcsData arrays. It's clamped to containerRef's own
    // bounding rect rather than the viewport: a Dashboard Studio panel can be tiny and the
    // custom-viz DOM has no way to paint outside its own box anyway, so "nice tooltip that
    // never gets cut off" means "always measured and kept inside this box," not "escape it."
    const tooltipRef = useRef(null);
    const lastPointerRef = useRef({ x: 0, y: 0 });
    // Points/arcs are hover-tested every animation frame against the *current* pointer
    // position, not just when the pointer actually moves — so with autoRotate on, a
    // stationary cursor loses the arc within a frame or two as it rotates out from under
    // it, and onArcHover promptly reports null. Pin markers don't have this problem (their
    // hover comes from real DOM mouseenter/mouseleave, which browsers only fire on actual
    // pointer motion), so this flag lets the point/arc tooltip borrow that same behavior:
    // stay put through hover loss caused by rotation, and only actually hide once the
    // pointer itself moves and still finds nothing there.
    //
    // "Moves" is deliberately a few pixels of slack (HOVER_MOVE_THRESHOLD_PX), not any
    // mousemove event at all — a hand resting on a mouse/trackpad still fires a steady
    // trickle of 1px-ish jitter events, which without a dead zone re-arms the hide almost
    // immediately and made the tooltip vanish just as fast as before this fix.
    const pointerMovedSinceHoverRef = useRef(true);
    const hoverAnchorRef = useRef({ x: 0, y: 0 });

    const positionTooltip = (clientX, clientY) => {
        const tipEl = tooltipRef.current;
        const containerEl = containerRef.current;
        if (!tipEl || !containerEl) return;
        const containerRect = containerEl.getBoundingClientRect();
        const OFFSET = 14;
        const tipWidth = tipEl.offsetWidth;
        const tipHeight = tipEl.offsetHeight;
        let x = clientX - containerRect.left + OFFSET;
        let y = clientY - containerRect.top + OFFSET;
        if (x + tipWidth > containerRect.width) x = clientX - containerRect.left - tipWidth - OFFSET;
        if (y + tipHeight > containerRect.height) y = clientY - containerRect.top - tipHeight - OFFSET;
        x = Math.max(4, Math.min(x, containerRect.width - tipWidth - 4));
        y = Math.max(4, Math.min(y, containerRect.height - tipHeight - 4));
        tipEl.style.transform = `translate(${x}px, ${y}px)`;
    };

    const showTooltip = (html, clientX, clientY) => {
        const tipEl = tooltipRef.current;
        if (!tipEl) return;
        tipEl.innerHTML = html;
        tipEl.classList.add('globe-viz-tooltip--visible');
        positionTooltip(clientX, clientY);
    };

    const hideTooltip = () => {
        tooltipRef.current?.classList.remove('globe-viz-tooltip--visible');
    };

    const markerTooltip = {
        show: (d, x, y) => showTooltip(buildTooltipHtml(d.label, d.color || DEFAULT_MARKER_COLOR, d.sourceRow?.tooltip), x, y),
        move: positionTooltip,
        hide: hideTooltip,
    };

    const ds = useDataSources() ?? {};
    const dim = useDimensions() ?? {};
    const optCtx = useOptions() ?? {};

    const { dataSources, loading } = ds;
    const { width, height } = dim;
    const { options } = optCtx;

    const [dayNightTime, setDayNightTime] = useState(() => Date.now());

    const opt = {
        mode: options?.mode || 'map',
        autoRotate: options?.autoRotate ?? true,
        showMarkers: options?.showMarkers ?? false,
        markerSize: MARKER_SIZES_PX[options?.markerSize] ? options.markerSize : 'small',
        showLabels: options?.showLabels ?? false,
        showDayNight: options?.showDayNight ?? false,
        labelSize: LABEL_SIZES[options?.labelSize] ? options.labelSize : 'medium',
        globeStyle: GLOBE_TEXTURES[options?.globeStyle] ? options.globeStyle : 'day',
        backgroundType:
            options?.backgroundType === 'color' || BACKGROUND_IMAGES[options?.backgroundType]
                ? options.backgroundType
                : 'stars',
        backgroundColor: resolveColor(options?.backgroundColor, DEFAULT_BACKGROUND_COLOR),
        heatmapBandwidth: options?.heatmapBandwidth ?? 8,
        arcLineStyle: ARC_LINE_STYLES[options?.arcLineStyle] ? options.arcLineStyle : 'solid',
        arcDefaultThickness: options?.arcDefaultThickness ?? 0.5,
        arcDefaultColor: resolveColor(options?.arcDefaultColor, DEFAULT_ARC_COLOR),
        borderRadius: Math.max(0, Number(options?.borderRadius) || 0),
        initialZoom: options?.initialZoom ?? 2.5,
        initialLat: options?.initialLat ?? 0,
        initialLng: options?.initialLng ?? 0,
    };
    const arcStyle = ARC_LINE_STYLES[opt.arcLineStyle];

    // Keep the sun position roughly current while the day/night overlay is on. It doesn't
    // need per-frame accuracy — a slow refresh is enough to stay correct on a long-open
    // dashboard without re-rendering constantly for no visible benefit.
    useEffect(() => {
        if (!opt.showDayNight) return;
        const id = setInterval(() => setDayNightTime(Date.now()), 5 * 60 * 1000);
        return () => clearInterval(id);
    }, [opt.showDayNight]);

    // Sync auto-rotate onto the underlying OrbitControls whenever the option changes.
    useEffect(() => {
        const controls = globeRef.current?.controls?.();
        if (!controls) return;
        controls.autoRotate = opt.autoRotate;
        controls.autoRotateSpeed = 0.5;
    }, [opt.autoRotate, loading]);

    // Point the camera at the configured starting coordinates and distance (0,0 / 2.5
    // globe radii are react-globe.gl's own defaults). Re-applies whenever any of these
    // options change, so editing them in the panel updates live.
    useEffect(() => {
        if (!globeRef.current) return;
        globeRef.current.pointOfView({ lat: opt.initialLat, lng: opt.initialLng, altitude: opt.initialZoom }, 0);
    }, [opt.initialLat, opt.initialLng, opt.initialZoom, loading]);

    // Register drilldown once the globe (and its canvas) actually exist — depends on `loading`
    // since the container isn't rendered at all during the loading branch below.
    useEffect(() => {
        if (loading || !globeRef.current || !containerRef.current) return;

        const canvas = globeRef.current.renderer?.().domElement;
        const handleMouseMove = (event) => {
            if (!canvas) return;
            lastPointerRef.current = { x: event.clientX, y: event.clientY };
            if (!pointerMovedSinceHoverRef.current) {
                const dx = event.clientX - hoverAnchorRef.current.x;
                const dy = event.clientY - hoverAnchorRef.current.y;
                if (dx * dx + dy * dy > HOVER_MOVE_THRESHOLD_PX * HOVER_MOVE_THRESHOLD_PX) {
                    pointerMovedSinceHoverRef.current = true;
                    // onPointHover/onArcHover only fire when the raycaster's hover target
                    // actually *changes* — so if rotation already carried the point/arc away
                    // (hover already null) before this real move happened, no such callback
                    // is coming to hide the frozen tooltip. Do it here instead, the moment
                    // real movement is confirmed, same as a click would dismiss it. If the
                    // cursor landed on something new, the next hover callback re-shows it.
                    if (!hoveredPointRef.current && !hoveredArcRef.current) hideTooltip();
                }
            }
            const rect = canvas.getBoundingClientRect();
            const coords = globeRef.current.toGlobeCoords(event.clientX - rect.left, event.clientY - rect.top);
            hoveredCoordsRef.current = coords || null;
            // Keep the tooltip tracking the cursor while a point/arc stays hovered (marker
            // pins reposition it themselves via their own mousemove listener instead).
            if (hoveredPointRef.current || hoveredArcRef.current) positionTooltip(event.clientX, event.clientY);
        };
        canvas?.addEventListener('mousemove', handleMouseMove);

        const cleanupDrilldown = VisualizationAPI.addDrilldownListener({
            node: containerRef.current,
            action: 'value',
            payloadCallback: () =>
                buildDrilldownPayload({
                    hoveredPoint: hoveredPointRef.current,
                    hoveredArc: hoveredArcRef.current,
                    hoveredCoords: hoveredCoordsRef.current,
                }),
        });

        return () => {
            canvas?.removeEventListener('mousemove', handleMouseMove);
            cleanupDrilldown?.();
        };
    }, [loading]);

    if (loading) {
        return <div className="globe-viz-status">Loading...</div>;
    }

    const data = dataSources?.primary?.data;
    const rows = toRows(data);

    // Always computed (not just in "Points & Arcs" mode) since markers can overlay either mode.
    const { points, arcs } = buildPointsAndArcs(rows, opt);
    const heatmapPoints = opt.mode === 'heatmap' ? buildHeatmapPoints(rows) : [];
    const nightTiles = opt.showDayNight ? [{ pos: nightPosAt(dayNightTime) }] : [];

    return (
        <VisualizationExtensionProvider>
            <div
                ref={containerRef}
                className="globe-viz-container"
                style={{ '--globe-border-radius': `${opt.borderRadius}px` }}
            >
                <Globe
                    ref={globeRef}
                    width={width || undefined}
                    height={height || undefined}
                    globeImageUrl={GLOBE_TEXTURES[opt.globeStyle]}
                    bumpImageUrl={earthHeightTexture}
                    backgroundImageUrl={BACKGROUND_IMAGES[opt.backgroundType] || null}
                    backgroundColor={opt.backgroundColor}
                    pointsData={opt.mode === 'map' ? points : []}
                    pointLat="lat"
                    pointLng="lng"
                    pointColor={(d) => d.color || '#00e5ff'}
                    pointAltitude={0.01}
                    pointRadius="radius"
                    onPointHover={(point) => {
                        hoveredPointRef.current = point;
                        if (point) {
                            pointerMovedSinceHoverRef.current = false;
                            hoverAnchorRef.current = lastPointerRef.current;
                            showTooltip(
                                buildTooltipHtml(point.label, point.color || DEFAULT_MARKER_COLOR, point.sourceRow?.tooltip),
                                lastPointerRef.current.x,
                                lastPointerRef.current.y
                            );
                        } else if (!hoveredArcRef.current && pointerMovedSinceHoverRef.current) {
                            hideTooltip();
                        }
                    }}
                    htmlElementsData={opt.showMarkers ? points : []}
                    htmlLat="lat"
                    htmlLng="lng"
                    htmlElement={(d) => buildMarkerElement(d, MARKER_SIZES_PX[opt.markerSize], markerTooltip)}
                    htmlElementVisibilityModifier={(el, isVisible) => {
                        // A marker on the far side of the globe still projects to a valid
                        // on-screen position — it's only hidden here by fading its opacity —
                        // so without this it keeps capturing hover/tooltip events at that
                        // screen spot even though nothing is visibly there.
                        el.style.opacity = isVisible ? 1 : 0;
                        el.style.pointerEvents = isVisible ? 'auto' : 'none';
                    }}
                    labelsData={opt.showLabels ? points : []}
                    labelLat="lat"
                    labelLng="lng"
                    labelText="label"
                    labelColor={(d) => d.color || DEFAULT_MARKER_COLOR}
                    labelSize={LABEL_SIZES[opt.labelSize]}
                    labelDotRadius={LABEL_SIZES[opt.labelSize] * 0.375}
                    labelResolution={2}
                    arcsData={opt.mode === 'map' ? arcs : []}
                    onArcHover={(arc) => {
                        hoveredArcRef.current = arc;
                        if (arc) {
                            pointerMovedSinceHoverRef.current = false;
                            hoverAnchorRef.current = lastPointerRef.current;
                            const title = arc.toLabel ? `${arc.fromLabel || arc.label} → ${arc.toLabel}` : arc.fromLabel || arc.label;
                            showTooltip(
                                buildTooltipHtml(title, arc.color || opt.arcDefaultColor, arc.sourceRow?.tooltip),
                                lastPointerRef.current.x,
                                lastPointerRef.current.y
                            );
                        } else if (!hoveredPointRef.current && pointerMovedSinceHoverRef.current) {
                            hideTooltip();
                        }
                    }}
                    arcColor={(d) =>
                        opt.arcLineStyle === 'gradient'
                            ? [d.color || opt.arcDefaultColor, d.destColor || ARC_GRADIENT_END_COLOR]
                            : d.color || opt.arcDefaultColor
                    }
                    arcStroke={(d) => d.thickness}
                    arcDashLength={arcStyle.dashLength}
                    arcDashGap={arcStyle.dashGap}
                    arcDashAnimateTime={arcStyle.animateTime}
                    heatmapsData={heatmapPoints.length ? [heatmapPoints] : []}
                    heatmapPointLat="lat"
                    heatmapPointLng="lng"
                    heatmapPointWeight="weight"
                    heatmapBandwidth={opt.heatmapBandwidth}
                    heatmapBaseAltitude={0.01}
                    tilesData={nightTiles}
                    tileLng={(d) => d.pos[0]}
                    tileLat={(d) => d.pos[1]}
                    tileAltitude={0.005}
                    tileWidth={180}
                    tileHeight={180}
                    tileUseGlobeProjection={false}
                    tileMaterial={() => NIGHT_TILE_MATERIAL}
                    tilesTransitionDuration={0}
                    atmosphereColor="#4e9cf5"
                    atmosphereAltitude={0.15}
                />
                <div ref={tooltipRef} className="globe-viz-tooltip" />
            </div>
        </VisualizationExtensionProvider>
    );
};

createRoot(document.getElementById('root')).render(<GlobeViz />);