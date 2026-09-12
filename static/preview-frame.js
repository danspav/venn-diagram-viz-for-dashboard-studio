import {
    applyTheme,
    showError,
    hideError,
    notifyParent,
    invokeListeners,
    createDashboardExtensionAPI,
    createListeners,
    createState,
} from './preview-utils.js';

// ── Error handlers ────────────────────────────────────────────────────────────

window.onerror = function (msg, _src, _line, _col, err) {
    showError((err && err.stack) || msg);
    notifyParent('error', (err && err.stack) || msg);
};
window.addEventListener('unhandledrejection', function (e) {
    const text = (e.reason && e.reason.stack) || String(e.reason);
    showError(text);
    notifyParent('error', text);
});

// ── State ─────────────────────────────────────────────────────────────────────

let _listeners = createListeners();
let _state = createState();
globalThis.DashboardExtensionAPI = createDashboardExtensionAPI(_listeners, _state);

// ── Message handler ───────────────────────────────────────────────────────────

window.addEventListener('message', async function (e) {
    if (e.origin !== window.location.origin) return;
    const msg = e.data;
    if (!msg || msg.__source !== 'viz_tester_host') return;

    switch (msg.type) {
        case 'load_viz': {
            let resolvedVizUrl;
            try {
                resolvedVizUrl = new URL(msg.vizUrl, window.location.origin);
            } catch (_) {
                showError('Invalid vizUrl');
                return;
            }
            if (
                resolvedVizUrl.origin !== window.location.origin ||
                !resolvedVizUrl.pathname.startsWith('/dist/')
            ) {
                showError('vizUrl must be under /dist/');
                return;
            }
            hideError();
            _listeners = createListeners();
            _state = createState({
                dataSources: {
                    primary: {
                        data: msg.sampleData || null,
                        meta: { status: msg.sampleData ? 'done' : 'waiting' },
                    },
                },
                options: msg.options || {},
                width: msg.width || 600,
                height: msg.height || 400,
                theme: msg.theme || 'dark',
                tokens: msg.tokens || {},
            });
            // Recreate API so its closures reference the fresh listeners/state
            globalThis.DashboardExtensionAPI = createDashboardExtensionAPI(_listeners, _state);
            const root = document.getElementById('root');
            root.innerHTML = '';
            root.style.cssText = '';
            // Remove style tags injected by prior viz loads so CSS changes take effect
            document.querySelectorAll('style[data-viz]').forEach((el) => el.remove());
            applyTheme(_state.theme);
            try {
                // Cache-bust on each reload so file changes are picked up
                await import(resolvedVizUrl.href + '?t=' + msg.ts);
                notifyParent('ready', null);
            } catch (err) {
                showError(err.stack || err.message);
                notifyParent('error', err.stack || err.message);
            }
            break;
        }
        case 'set_data':
            _state.dataSources = msg.data
                ? Object.assign({}, _state.dataSources, {
                      primary: { data: msg.data, meta: { status: 'done' } },
                  })
                : { primary: { data: null, meta: { status: 'waiting' } } };
            invokeListeners(_listeners, 'data', {
                loading: false,
                dataSources: _state.dataSources,
            });
            // Re-invoke options so vizzes that apply option-driven styles on render don't lose them
            invokeListeners(_listeners, 'options', { options: _state.options });
            break;
        case 'set_options':
            _state.options = msg.options || {};
            invokeListeners(_listeners, 'options', { options: _state.options });
            break;
        case 'set_dimensions':
            _state.width = msg.width;
            _state.height = msg.height;
            invokeListeners(_listeners, 'dimensions', { width: msg.width, height: msg.height });
            break;
        case 'set_theme':
            _state.theme = msg.theme;
            applyTheme(msg.theme);
            invokeListeners(_listeners, 'theme', { theme: msg.theme });
            break;
        case 'set_tokens':
            _state.tokens = msg.tokens || {};
            invokeListeners(_listeners, 'tokens', { tokens: _state.tokens });
            break;
        case 'clear':
            _listeners = createListeners();
            _state = createState();
            globalThis.DashboardExtensionAPI = createDashboardExtensionAPI(_listeners, _state);
            const root2 = document.getElementById('root');
            if (root2) {
                root2.innerHTML = '';
                root2.style.cssText = '';
            }
            hideError();
            break;
    }
});
