// ── DOM helpers ───────────────────────────────────────────────────────────────

export function applyTheme(theme) {
    document.documentElement.setAttribute('data-color-scheme', theme);
}

export function showError(text) {
    const el = document.getElementById('__err');
    if (el) {
        el.style.display = 'block';
        el.textContent = text;
    }
}

export function hideError() {
    const el = document.getElementById('__err');
    if (el) el.style.display = 'none';
}

export function notifyParent(type, message) {
    try {
        window.parent.postMessage(
            { __source: 'viz_tester_frame', type, message },
            window.location.origin
        );
    } catch (_) {}
}

// ── Listener helpers ──────────────────────────────────────────────────────────

export function invokeListeners(listeners, key, arg) {
    listeners[key].forEach(function (fn) {
        try {
            fn(arg);
        } catch (e) {
            console.error('[preview] listener error', e);
        }
    });
}

export function makeListener(listeners, key, getArg) {
    return function (cb, opts) {
        listeners[key].push(cb);
        if (opts && opts.invokeImmediately) cb(getArg());
        if (opts && opts.signal)
            opts.signal.addEventListener('abort', function () {
                listeners[key] = listeners[key].filter(function (f) {
                    return f !== cb;
                });
            });
        return function () {
            listeners[key] = listeners[key].filter(function (f) {
                return f !== cb;
            });
        };
    };
}

// ── State factories ───────────────────────────────────────────────────────────

export function createListeners() {
    return { data: [], options: [], dimensions: [], theme: [], mode: [], tokens: [], error: [] };
}

export function createState(overrides) {
    return Object.assign(
        {
            dataSources: { primary: { data: null, meta: { status: 'waiting' } } },
            options: {},
            width: 600,
            height: 400,
            theme: 'dark',
            mode: 'view',
            tokens: {},
            error: '',
        },
        overrides
    );
}

// ── DashboardExtensionAPI mock ────────────────────────────────────────────────

export function createDashboardExtensionAPI(listeners, state) {
    return {
        addDataSourcesListener: makeListener(listeners, 'data', function () {
            return { loading: false, dataSources: state.dataSources };
        }),
        getDataSources: function () {
            return { loading: false, dataSources: state.dataSources };
        },

        addOptionsListener: makeListener(listeners, 'options', function () {
            return { options: state.options };
        }),
        getOptions: function () {
            return { options: state.options };
        },
        setOptions: function () {},

        addDimensionsListener: makeListener(listeners, 'dimensions', function () {
            return { width: state.width, height: state.height };
        }),
        getDimensions: function () {
            return { width: state.width, height: state.height };
        },

        addThemeListener: makeListener(listeners, 'theme', function () {
            return { theme: state.theme };
        }),
        getTheme: function () {
            return { theme: state.theme };
        },

        // Mode — tester is always view mode
        addModeListener: makeListener(listeners, 'mode', function () {
            return { mode: state.mode };
        }),
        getMode: function () {
            return { mode: state.mode };
        },

        addTokensListener: makeListener(listeners, 'tokens', function () {
            return { tokens: state.tokens };
        }),
        getTokens: function () {
            return { tokens: state.tokens };
        },

        // Errors — viz can report errors back; setError shows the red overlay
        addErrorListener: makeListener(listeners, 'error', function () {
            return { error: state.error };
        }),
        getError: function () {
            return { error: state.error };
        },
        setError: function (message) {
            state.error = message || '';
            showError(state.error);
            invokeListeners(listeners, 'error', { error: state.error });
        },
        clearError: function () {
            state.error = '';
            hideError();
            invokeListeners(listeners, 'error', { error: '' });
        },

        // Drilldown — no drilldown target in the tester; stubs prevent runtime errors
        addDrilldownListener: function () {
            return function () {};
        },
        triggerDrilldown: function () {},
    };
}
