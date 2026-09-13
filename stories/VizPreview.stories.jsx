import React, { useCallback, useEffect, useRef } from 'react';

// Long shape (see SPL.md): one row per (item, single category) — the same
// item spans multiple rows when it belongs to more than one category,
// exactly the shape `stats ... by host, category` naturally produces.
// Column NAMES don't matter, only order/count (item, category, value,
// tooltip here — the 4-column form).
const SAMPLE_DATA = {
    fields: [{ name: 'host' }, { name: 'category' }, { name: 'count' }, { name: 'description' }],
    columns: [
        [
            'web-01', 'web-02', 'web-03', 'web-04', 'web-05', 'web-06',
            'db-01', 'db-02', 'db-03', 'db-04',
            'edge-01', 'edge-02', 'edge-03',
            'app-01', 'app-01',
            'app-02', 'app-02',
            'app-03', 'app-03',
            'app-04', 'app-04', 'app-04',
        ],
        [
            'Failed logins', 'Failed logins', 'Failed logins', 'Failed logins', 'Failed logins', 'Failed logins',
            'Malware alerts', 'Malware alerts', 'Malware alerts', 'Malware alerts',
            'Firewall blocks', 'Firewall blocks', 'Firewall blocks',
            'Failed logins', 'Malware alerts',
            'Failed logins', 'Firewall blocks',
            'Malware alerts', 'Firewall blocks',
            'Failed logins', 'Malware alerts', 'Firewall blocks',
        ],
        ['4', '9', '3', '12', '6', '5', '7', '3', '11', '5', '17', '10', '6', '15', '9', '8', '6', '5', '7', '4', '3', '6'],
        [
            'SSH brute force', 'RDP brute force', 'VPN lockouts', 'Repeated auth failures', 'Password spray', 'Stale creds',
            'Trojan detected', 'Cryptominer', 'Rootkit signature', 'Adware',
            'Port scan blocked', 'Known bad IP', 'Geo-blocked range',
            'Brute force', 'Follow-on malware',
            'Auth failures', 'Egress blocked',
            'Malware', 'C2 callback blocked',
            'Auth failures', 'Malware', 'C2 callback blocked',
        ],
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
