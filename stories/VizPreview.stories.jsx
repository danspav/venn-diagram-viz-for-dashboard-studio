import React, { useCallback, useEffect, useRef } from 'react';

// Shape matches the SPL in CLAUDE.md: one row per host with in_A/in_B/in_C
// membership flags plus an optional secondary metric (alerts) for dot sizing.
const SAMPLE_DATA = {
    fields: [{ name: 'host' }, { name: 'in_A' }, { name: 'in_B' }, { name: 'in_C' }, { name: 'alerts' }],
    columns: [
        [
            'web-01', 'web-02', 'web-03', 'web-04', 'web-05', 'web-06', 'web-07', 'web-08',
            'db-01', 'db-02', 'db-03', 'db-04',
            'edge-01', 'edge-02', 'edge-03',
            'app-01', 'app-02', 'app-03', 'app-04',
        ],
        ['1', '1', '1', '1', '1', '1', '1', '1', '0', '0', '0', '0', '1', '1', '1', '1', '1', '0', '0'],
        ['0', '0', '0', '0', '0', '0', '1', '1', '1', '1', '1', '1', '1', '1', '0', '0', '0', '1', '1'],
        ['0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '1', '0', '0', '1', '1', '1', '0'],
        ['4', '9', '3', '12', '6', '5', '14', '8', '7', '3', '11', '5', '17', '10', '6', '15', '9', '4', '3'],
    ],
};

function VizPreviewStory({ theme, vizName, height, sampleData }) {
    const iframeRef = useRef(null);
    const loaded = useRef(false);
    const widthRef = useRef(600);

    const post = useCallback((msg) => {
        iframeRef.current?.contentWindow?.postMessage(
            { __source: 'viz_tester_host', ...msg },
            window.location.origin
        );
    }, []);

    // Load viz when iframe is ready — sends initial theme, dimensions, and sample data
    const onIframeLoad = useCallback(() => {
        const width = iframeRef.current?.offsetWidth ?? widthRef.current;
        widthRef.current = width;
        loaded.current = true;
        post({
            type: 'load_viz',
            vizUrl: `/dist/${vizName}/visualization.js`,
            sampleData,
            theme,
            width,
            height,
            options: {},
            ts: Date.now(),
        });
    }, [post, vizName, theme, sampleData, height]);

    // Push theme changes into the frame after initial load
    useEffect(() => {
        if (loaded.current) {
            post({ type: 'set_theme', theme });
        }
    }, [theme, post]);

    // Push height changes into the frame after initial load
    useEffect(() => {
        if (loaded.current) {
            post({ type: 'set_dimensions', width: widthRef.current, height });
        }
    }, [height, post]);

    // Push data source changes into the frame after initial load
    useEffect(() => {
        if (loaded.current) {
            post({ type: 'set_data', data: sampleData });
        }
    }, [sampleData, post]);

    // Track iframe width changes via ResizeObserver and forward to the frame
    useEffect(() => {
        const iframe = iframeRef.current;
        if (!iframe) return;
        const observer = new ResizeObserver(([entry]) => {
            const width = Math.round(entry.contentRect.width);
            widthRef.current = width;
            if (loaded.current) {
                post({ type: 'set_dimensions', width, height: iframe.offsetHeight });
            }
        });
        observer.observe(iframe);
        return () => observer.disconnect();
    }, [post]);

    return (
        <iframe
            ref={iframeRef}
            src="/preview-frame.html"
            sandbox="allow-scripts allow-same-origin"
            style={{ width: '100%', height: `${height}px`, border: 'none' }}
            title={`${vizName} preview`}
            onLoad={onIframeLoad}
        />
    );
}

export default {
    title: 'Viz Preview',
    component: VizPreviewStory,
    parameters: { layout: 'fullscreen' },
    argTypes: {
        theme: {
            control: { type: 'radio' },
            options: ['dark', 'light'],
        },
        height: {
            control: { type: 'number', min: 100, step: 50 },
            description: 'Height of the viz preview in pixels',
        },
        sampleData: {
            control: { type: 'object' },
            description: 'Primary data source sent to the viz (fields + columns)',
        },
        vizName: {
            table: { disable: true },
        },
    },
};

// Add one export per viz in your visualizations/ directory.
export const Preview = {
    args: { theme: 'dark', vizName: 'venn_diagram_viz_for_dashboard_studio', height: 400, sampleData: SAMPLE_DATA },
    name: 'venn_diagram_viz_for_dashboard_studio',
};
