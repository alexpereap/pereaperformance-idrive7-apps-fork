'use strict';
/**
 * Flex Fuel - the ethanol content an MHD-flashed DME runs on, read over the head unit's own
 * diagnostic link (InternalTasu, DME 0x12): "Ethanol Content (Active)", what the tune uses,
 * and "Ethanol Content (CAN)", what the flex fuel sensor reports, as two dials.
 *
 * Read-only: the app sends 2F 04 "MHD" (is MHD there), 22 F1 01 / F1 02 (which ROM), 2C 03 / 2C 02
 * F303 (its own dynamic identifier over the two bytes; F301 when F303 is refused) and 22 F3 03 (the
 * read). Nothing is written to
 * the car; the identifier is the DME's volatile table and goes with the ignition. Protocol: protocol.js,
 * loop and states: poller.js, screen: ui.js. With "Demo data" on (or Auto without a diagnostic
 * transport, as in the emulator) the dials show made-up values and nothing is sent.
 * The screen flags two disagreements between the sensor and the tune (ui.js): "Flex fuel disabled"
 * in amber when Active is 0 while CAN reads ethanol, and a MISMATCH badge when the two are 10 points
 * or more apart.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Recorder } = require('./kit/record');
const { Diag } = require('./kit/diag');
const UI = require('./ui');
const { Poller } = require('./poller');
const { DME, PROFILES } = require('./protocol');
const LOGO = require('./logo');

/**
 * Demo values: a slow wander around 50-80 %, CAN a touch off Active, and in every 25 s a spell of
 * 6 s with Active at 0 (the "disabled" note with the sensor still reading) and one of 6 s with CAN
 * 25 points above Active (the MISMATCH badge).
 */
function demoValues(t) {
    const base = Math.round(50 + 30 * Math.sin(t / 9000));
    const phase = t % 25000;
    const can = phase >= 12000 && phase < 18000 ? base + 25 : base + 2 * Math.sin(t / 2500);
    return { active: phase < 6000 ? 0 : base, can: Math.max(0, Math.min(100, Math.round(can))) };
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const diag = new Diag(ctx.signals, log);
        diag.quiet = true;
        await diag.init();                 // never throws: without a transport diag.p stays null
        const poller = new Poller({
            physical: (sid, data, ms, accept) => diag.physical(DME, sid, data, ms, accept),
            available: () => !!diag.available,
            hasLink: () => !!diag.p,
            log, config: ctx.spec.config, profiles: PROFILES,
        });
        // demo: Always, or Auto without a diagnostic transport (the emulator, a preview); never while the car answers
        const demo = () => settings.get('demo') === 'on' || (settings.get('demo') === 'auto' && !diag.p);

        const render = async () => {
            const v = poller.view();
            if (demo()) Object.assign(v, demoValues(Date.now()), { state: 'reading', demo: true, stale: false });
            const cv = ctx.canvas(UI.W, UI.H) || new Recorder(UI.W, UI.H);   // (the kit records every frame; software plays it back)
            UI.draw(cv, G, ctx.theme(), v, LOGO);
            await ui.image('MAIN_GFX', cv);
        };
        const loop = ctx.loop('MAIN', 4, render);

        diag.on('available', (on) => { poller.linkChanged(on); loop.kick(); });
        ui.onVisible((name, on) => { if (name === 'MAIN') poller.setVisible(on); });
        poller.setVisible(ui.isVisible('MAIN'));
        poller.setPaused(demo());
        settings.onChange(() => { poller.setPaused(demo()); loop.kick(); });
        poller.start();
        await render();
        log.info('mhd_flex ready (transport=' + (diag.p ? 'up' : 'none') + ', demo=' + demo() + ')');
    },
});
