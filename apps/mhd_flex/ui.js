'use strict';
/**
 * ui.js - the Flex Fuel screen: two dials in the middle (ethanol Active and CAN, the number with its
 * % in the middle of each), a note under them (green "Flex fuel active" while the tune uses the
 * ethanol, "Flex fuel disabled" when Active is 0, in amber when the sensor still reads ethanol;
 * the link's state otherwise), a detail line, and a small logo at the bottom. When Active and CAN
 * are GAP points or more apart (the tune still blending after a fill-up, or a sensor the map does
 * not follow) the header says MISMATCH.
 *
 * GPU-safe: arc / circle / line / text / roundRect / fillRect only (the car's Recorder has no polygons).
 * v = Poller.view() + { demo }; LOGO = logo.js (runs of a palette; `ink` entries take the theme's text colour).
 */
const { withAlpha, rgba } = require('./kit/canvas');

const W = 1600, H = 520;
const GO = '#2fd27a';
const GAP = 10;                 // percentage points between Active and CAN that count as a mismatch
const DIAL_R = 150, DIAL_Y = 212, DIAL_X = [500, 1100];

const live = (v) => v.state === 'reading' && v.active != null && v.can != null;

/** Active and CAN both readable, the tune using ethanol, and the two GAP points or more apart. */
function mismatch(v) { return live(v) && v.active > 0 && Math.abs(v.active - v.can) >= GAP; }

/** Active at 0 while the sensor reads ethanol: a map without flex fuel, or one that ignores the sensor. */
function sensorOnly(v) { return live(v) && v.active === 0 && v.can > 0; }

/** The note under the dials for a state: [text, colour]. */
function note(v, t) {
    switch (v.state) {
        case 'reading':
            if (v.active == null) return ['Waiting for the DME', t.dim];
            if (v.active > 0) return ['Flex fuel active', t.go || GO];
            return ['Flex fuel disabled', sensorOnly(v) ? t.warn : t.dim];
        case 'no-link': return ['No diagnostic link', t.dim];
        case 'link-down': return ['Diagnostic link down', t.dim];
        case 'probing': return ['Looking for MHD on the DME', t.dim];
        case 'no-mhd': return ['MHD not found on the DME', t.warn];
        case 'identifying': return ['Identifying the DME', t.dim];
        case 'unsupported-rom': return ['ROM not supported', t.warn];
        case 'defining': return ['Defining data identifier', t.dim];
        case 'error': return ['Waiting for the DME', t.warn];
        default: return ['', t.dim];
    }
}

/** The header badge for a state (none while live and consistent); draw() adds DEMO beside it. */
function badge(v, t) {
    switch (v.state) {
        case 'no-link': case 'link-down': return { text: 'NO LINK' };
        case 'no-mhd': return { text: 'NO MHD', color: t.warn };
        case 'unsupported-rom': return { text: 'OTHER ROM', color: t.warn };
        case 'error': return { text: 'DME ERROR', color: t.warn };
        case 'reading':
            if (v.stale) return { text: 'LINK STALE', color: t.warn };
            return mismatch(v) ? { text: 'MISMATCH', color: t.warn } : null;
        default: return null;
    }
}

/**
 * The line under the note: the ids seen on an unknown ROM; why the loop is waiting and the last
 * exchange in `error`; the last exchange's bytes while a value is not readable (what the DME really
 * answered); the mismatch or the sensor's reading while the tune disagrees with it; else the
 * profile and identifier in use. { text, colour, literal } (literal: not translated).
 */
function detail(v, t) {
    const lit = (text) => ({ text, colour: t.dim, literal: true });
    if (v.state === 'unsupported-rom') return lit(v.seen && v.seen.length ? v.seen.join('  ') : '');
    if (v.state === 'error') return lit([v.reason, v.lastReply].filter(Boolean).join('  ·  '));
    if (v.state !== 'reading') return lit('');
    if ((v.active == null || v.can == null) && !v.demo) return lit(v.lastReply || '');
    if (mismatch(v)) return { text: 'Active and CAN differ', colour: t.warn, literal: false };
    if (sensorOnly(v)) return { text: 'Sensor reads ' + v.can + ' %', colour: t.warn, literal: false };
    if (v.mhd && v.profile) return lit(v.profile + (v.did ? '  ·  ' + v.did : ''));
    return lit('');
}

/** The logo as a cached layer: one fillRect per run; ink runs in the theme's text colour at the baked alpha. */
function logoLayer(G, t, LOGO, textScale) {
    return G.layer('mhd_flex_logo|' + t.name, LOGO.w, LOGO.h, (c) => {
        const colours = LOGO.palette.map((p, i) => (LOGO.ink.indexOf(i) >= 0 ? withAlpha(t.text, rgba(p)[3] / 255) : p));
        LOGO.runs.forEach((r) => c.fillRect(r[1], r[0], r[2], 1, colours[r[3]]));
    }, textScale);
}

function draw(cv, G, t, v, LOGO) {
    cv.clear(t.bg);
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);
    // the label is drawn here, not by the dial: the dial's cached layer is only as wide as the dial and cuts a long one
    const dial = (cx, value, label, color) => {
        G.radial(cv, t, cx, DIAL_Y, DIAL_R, { value, min: 0, max: 100, unit: '%', decimals: 0, ticks: 10, majorEvery: 2, hot: false, color });
        cv.text(label.toUpperCase(), cx, DIAL_Y + DIAL_R * 0.82, 26, t.text, { align: 'center', font: 'bold', spacing: 1.5 });
    };
    dial(DIAL_X[0], v.active, 'Ethanol Content (Active)', 'accent');
    dial(DIAL_X[1], v.can, 'Ethanol Content (CAN)', 'accent2');

    const [text, colour] = note(v, t);
    cv.text(text, W / 2, 392, 26, colour, { align: 'center', font: 'bold', spacing: 1.5 });
    const d = detail(v, t);
    if (d.text) cv.text(d.text, W / 2, 418, 16, d.colour, { align: 'center', font: 'label', literal: d.literal });

    if (LOGO && LOGO.runs && LOGO.runs.length) {
        const y = G.pageBottom(cv) - G.MARGIN - LOGO.h;
        cv.blit(logoLayer(G, t, LOGO, cv.textScale), Math.round((W - LOGO.w) / 2), y);
    }
    G.frame(cv, t, ['Flex Fuel'], 0, [v.demo ? { text: 'DEMO' } : null, badge(v, t)]);
}

module.exports = { draw, note, badge, detail, mismatch, sensorOnly, W, H, GO, GAP };
