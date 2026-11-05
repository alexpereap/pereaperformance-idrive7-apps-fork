'use strict';
/**
 * ui.js - the Flex Fuel screen: two dials in the middle (ethanol Active and CAN, the number with its
 * % in the middle of each), a note under them (green "Flex fuel active" while the tune uses the
 * ethanol, else "Flex fuel disabled"; the link's state otherwise), and a small logo at the bottom.
 *
 * GPU-safe: arc / circle / line / text / roundRect / fillRect only (the car's Recorder has no polygons).
 * v = Poller.view() + { demo }; LOGO = logo.js (runs of a palette; `ink` entries take the theme's text colour).
 */
const { withAlpha, rgba } = require('./kit/canvas');

const W = 1600, H = 520;
const GO = '#2fd27a';
const DIAL_R = 150, DIAL_Y = 212, DIAL_X = [500, 1100];

/** The note under the dials for a state: [text, colour key]. */
function note(v, t) {
    switch (v.state) {
        case 'reading':
            if (v.active == null && v.can == null) return ['Waiting for the DME', t.dim];
            return v.active > 0 ? ['Flex fuel active', t.go || GO] : ['Flex fuel disabled', t.dim];
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

/** The header badge for a state (none while live). */
function badge(v, t) {
    if (v.demo) return { text: 'DEMO' };
    switch (v.state) {
        case 'no-link': case 'link-down': return { text: 'NO LINK' };
        case 'no-mhd': return { text: 'NO MHD', color: t.warn };
        case 'unsupported-rom': return { text: 'OTHER ROM', color: t.warn };
        case 'error': return { text: 'DME ERROR', color: t.warn };
        case 'reading': return v.stale ? { text: 'LINK STALE', color: t.warn } : null;
        default: return null;
    }
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
    if (v.state === 'unsupported-rom' && v.seen && v.seen.length) {
        cv.text(v.seen.join('  '), W / 2, 418, 16, t.dim, { align: 'center', font: 'label', literal: true });
    } else if (v.state === 'reading' && v.mhd && v.profile) {
        cv.text(v.profile, W / 2, 418, 16, t.dim, { align: 'center', font: 'label', literal: true });
    }

    if (LOGO && LOGO.runs && LOGO.runs.length) {
        const y = G.pageBottom(cv) - G.MARGIN - LOGO.h;
        cv.blit(logoLayer(G, t, LOGO, cv.textScale), Math.round((W - LOGO.w) / 2), y);
    }
    G.frame(cv, t, ['Flex Fuel'], 0, [badge(v, t)]);
}

module.exports = { draw, note, badge, W, H, GO };
