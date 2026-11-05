'use strict';
// Flex Fuel: the MHD ethanol protocol and the poller against in-memory DMEs (MHD on the known ROM, a stock
// DME, MHD on another ROM, a DME that forgets the identifier, a quiet one), the accept filters, the screen
// in every state (software canvas and GPU recorder) and main.js with the kit stubbed. No SDK or car needed:
//   node kit/tools/test_mhd_flex.js
const assert = require('assert');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..', '..');
const kit = path.join(ROOT, 'kit/runtime');
const app = path.join(ROOT, 'apps/mhd_flex');
// the app requires the kit as ./kit/<name>: map it to kit/runtime
const load = Module._load;
let mguApp = null;
Module._load = function (req, parent, isMain) {
    if (req === './kit/mgu' && parent && parent.filename.startsWith(app)) return { run: (a) => { mguApp = a; } };
    if (req.startsWith('./kit/') && parent && parent.filename.startsWith(app)) return load.call(this, path.join(kit, req.slice(6)), parent, isMain);
    return load.call(this, req, parent, isMain);
};
const P = require(path.join(app, 'protocol'));
const { Poller } = require(path.join(app, 'poller'));
const UI = require(path.join(app, 'ui'));
const LOGO = require(path.join(app, 'logo'));
const G = require(path.join(kit, 'gauges'));
const { Canvas } = require(path.join(kit, 'canvas'));
const { Recorder, play } = require(path.join(kit, 'record'));
const themes = require(path.join(kit, 'themes'));

const hex = (b) => b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const bytes = (s) => s.split(/\s+/).filter(Boolean).map((x) => parseInt(x, 16));
const quiet = { info() {}, warn() {}, error(e) { throw new Error('log.error: ' + e); } };

// the SVK replies as the user's DME gave them (ids at unaligned offsets on purpose in the second one)
const SVK_OWN_F101 = bytes('62 F1 01 01 01 00 06 26 11 04 8F 04 D2 01 00 00 00 10 00 00 01 00 00 3D DE 03 13 16 02 00 00 3D D1 FF FF FF 06 00 00 48 DB 01 23 05 08 00 00 5D 55 50 3C 05 0D 00 00 84 17 50 3C 1D 05 00 00 27 42 02 05 41');
const SVK_OWN_F102 = bytes('62 F1 02 01 01 00 05 22 02 18 8B 00 08 00 30 30 30 30 00 00 01 00 00 3D DE 03 1D 04 02 00 00 6E 45 FF FF FF 08 00 00 5D 55 50 3C 05 08 00 00 99 F6 14 46 06');
const SVK_OTHER_F101 = bytes('62 F1 01 01 01 00 06 26 10 16 8F 04 D2 01 00 00 00 10 00 00 06 00 00 48 DB 01 23 05 08 00 00 5C 64 14 6E 06 0D 00 00 8A 51 14 6E AD');
const MHD_MARKER = bytes('6F 04 4D 48 44 32 01 20 00 00 00 00 00 1C 06 00 00 42');

/**
 * An in-memory DME at 0x12. kind: 'mhd' (the owner's ROM), 'stock' (no MHD), 'other' (MHD, another ROM),
 * 'quiet' (never answers). Options: lose = reads that answer 7F 22 31 before a good one; short = reply with
 * one data byte; values = [active, can]; slots = the dynamic identifiers the DME has (F300..F303 like the
 * owner's: any other answers 7F 2C 31, as F304 did on the car). Every reply is checked against the request's accept().
 */
function dme(kind, o) {
    o = o || {};
    const d = { calls: [], inflight: 0, maxInflight: 0, defined: null, lose: o.lose || 0, values: o.values || [85, 83],
        slots: o.slots || ['F300', 'F301', 'F302', 'F303'] };
    const didOf = (data) => hex(data.slice(1, 3)).replace(' ', '');
    d.physical = async (target, sid, data, timeoutMs, accept) => {
        assert.strictEqual(target, 0x12);
        assert.ok(typeof accept === 'function', 'every request filters its reply');
        d.inflight++; d.maxInflight = Math.max(d.maxInflight, d.inflight);
        await new Promise(setImmediate);
        d.inflight--;
        d.calls.push(hex([sid].concat(data)));
        const reply = (() => {
            if (kind === 'quiet') return null;
            if (sid === 0x2F) return kind === 'stock' ? [0x7F, 0x2F, 0x11] : MHD_MARKER.slice();
            if (sid === 0x22 && data[0] === 0xF1) {
                if (data[1] === 0x01) return kind === 'other' ? SVK_OTHER_F101.slice() : SVK_OWN_F101.slice();
                if (data[1] === 0x02) return kind === 'other' ? [0x7F, 0x22, 0x31] : SVK_OWN_F102.slice();
            }
            if (sid === 0x2C) {
                assert.strictEqual(kind, 'mhd', 'only the known ROM may be defined');
                const did = didOf(data);
                if (d.slots.indexOf(did) < 0) return [0x7F, 0x2C, 0x31];
                if (data[0] === 0x03) { const was = d.defined === did; if (was) d.defined = null; return was ? [0x6C, 0x03, data[1], data[2]] : [0x7F, 0x2C, 0x31]; }
                if (data[0] === 0x02) {
                    assert.strictEqual(hex(data.slice(3)), '14 B0 00 60 C2 01 B0 00 60 D2 01');
                    d.defined = did; return [0x6C, 0x02, data[1], data[2]];
                }
            }
            if (sid === 0x22 && data[0] === 0xF3) {
                const did = hex(data).replace(' ', '');
                if (d.lose > 0) { d.lose--; d.defined = null; }
                if (d.defined !== did) return [0x7F, 0x22, 0x31];
                if (o.short) return [0x62, data[0], data[1], d.values[0]];
                return [0x62, data[0], data[1], d.values[0], d.values[1]];
            }
            return [0x7F, sid, 0x11];
        })();
        if (reply) assert.ok(accept(reply), 'the reply must pass the request\'s filter: ' + hex(reply));
        return reply;
    };
    return d;
}

/** A poller on a fake clock with instant sleeps, driven by step(). */
function poller(d, o) {
    const clock = { t: 1000000 };
    const p = new Poller(Object.assign({
        physical: (sid, data, ms, accept) => d.physical(0x12, sid, data, ms, accept), available: () => true, hasLink: () => true, log: quiet,
        sleep: async () => { await new Promise(setImmediate); }, now: () => clock.t,
    }, o || {}));
    p.clock = clock;
    return p;
}
async function steps(p, n) { for (let i = 0; i < n; i++) await p.step(); return p.state; }

(async () => {
    /* ---------- pure protocol ---------- */
    assert.deepStrictEqual(P.probeRequest().data, [0x04, 0x4D, 0x48, 0x44]);
    assert.ok(P.probeRequest().accept(MHD_MARKER) && P.probeRequest().accept([0x7F, 0x2F, 0x11]));
    assert.ok(!P.probeRequest().accept([0x6F, 0x01, 0x02]), 'another 2F job\'s echo is not the probe\'s answer');
    assert.deepStrictEqual(P.parseProbe(MHD_MARKER), { mhd: true, version: '0120', marker: '4D484432012000000000001C06000042' });
    assert.deepStrictEqual(P.parseProbe([0x7F, 0x2F, 0x11]), { mhd: false, nrc: 0x11, reason: 'service not supported' });
    assert.strictEqual(P.parseProbe(bytes('6F 04 4D 48 44 31')).mhd, false, 'only MHD2 markers count');
    assert.strictEqual(P.parseProbe(null).reason, 'timeout');

    assert.strictEqual(P.findHex(SVK_OWN_F101.slice(3), '00005D55503C05'), 42);
    assert.strictEqual(P.findHex([1, 2, 3], '0203'), 1);
    assert.strictEqual(P.findHex([1, 2, 3], '0204'), -1);
    assert.deepStrictEqual(P.svkIds(SVK_OWN_F101.slice(3)), ['00005D55503C05', '00008417503C1D']);
    const own = P.matchProfile([SVK_OWN_F101.slice(3), SVK_OWN_F102.slice(3)]);
    assert.strictEqual(own.profile.active, 'B00060C2');
    assert.deepStrictEqual(own.seen, ['00005D55503C05', '00008417503C1D', '000099F6144606']);
    assert.strictEqual(P.matchProfile([SVK_OWN_F101.slice(3)]).profile.can, 'B00060D2', 'F1 01 alone carries both ids');
    const other = P.matchProfile([SVK_OTHER_F101.slice(3), null]);
    assert.strictEqual(other.profile, null);
    assert.deepStrictEqual(other.seen, ['00005C64146E06', '00008A51146EAD']);
    assert.strictEqual(P.matchProfile([SVK_OWN_F101.slice(3)], [{ prgid: '00005D55503C05', calid: '0000000000000A', active: 'B00060C2', can: 'B00060D2' }]).profile, null, 'both ids must match');

    assert.strictEqual(hex(P.clearRequest('F304').data), '03 F3 04');
    assert.strictEqual(hex(P.defineRequest('F304', P.PROFILES[0]).data), '02 F3 04 14 B0 00 60 C2 01 B0 00 60 D2 01');
    const accD = P.acceptDefine(0x02, 'F304');
    assert.ok(accD([0x6C, 0x02, 0xF3, 0x04]) && accD([0x7F, 0x2C, 0x31]) && accD([0x6C, 0x02]));
    assert.ok(!accD([0x6C, 0x02, 0xF3, 0x00]), 'MHD\'s own definition is not ours');
    assert.ok(!accD([0x6C, 0x03, 0xF3, 0x04]), 'a clear is not a define');
    assert.deepStrictEqual(P.parseDefine([0x6C, 0x02, 0xF3, 0x04], 0x02), { ok: true });
    assert.strictEqual(P.parseDefine([0x7F, 0x2C, 0x31], 0x03).nrc, 0x31);
    const accR = P.readRequest('F304').accept;
    assert.ok(accR([0x62, 0xF3, 0x04, 12, 12]) && accR([0x7F, 0x22, 0x31]));
    assert.ok(!accR([0x62, 0xF3, 0x00, 1, 2]), 'MHD\'s F300 answer is not ours');
    assert.deepStrictEqual(P.parseRead([0x62, 0xF3, 0x04, 12, 12], 'F304'), { ok: true, active: 12, can: 12 });
    assert.deepStrictEqual(P.parseRead([0x62, 0xF3, 0x04, 255, 0], 'F304'), { ok: true, active: null, can: 0 });
    assert.strictEqual(P.parseRead([0x62, 0xF3, 0x04, 12], 'F304').reason, 'length');
    assert.strictEqual(P.parseRead([0x7F, 0x22, 0x31], 'F304').nrc, 0x31);
    assert.throws(() => P.addressBytes('B00060'), /4 bytes/);

    /* ---------- happy path: MHD on the known ROM ---------- */
    {
        const d = dme('mhd'), p = poller(d);
        assert.strictEqual(await steps(p, 1), 'identifying');
        assert.strictEqual(await steps(p, 1), 'defining');
        assert.strictEqual(await steps(p, 1), 'reading');
        assert.strictEqual(await steps(p, 1), 'reading');
        assert.deepStrictEqual(d.calls, ['2F 04 4D 48 44', '22 F1 01', '22 F1 02', '2C 03 F3 03', '2C 02 F3 03 14 B0 00 60 C2 01 B0 00 60 D2 01', '22 F3 03']);
        let v = p.view();
        assert.strictEqual(v.state, 'reading'); assert.strictEqual(v.active, 85); assert.strictEqual(v.can, 83);
        assert.strictEqual(v.profile, P.PROFILES[0].name);
        assert.strictEqual(v.did, 'F303');
        assert.strictEqual(v.mhd.version, '0120');
        const t = themes.theme('m_tricolour');
        assert.deepStrictEqual(UI.note(v, t), ['Flex fuel active', UI.GO]);
        d.values = [0, 12];
        p.clock.t += 500;                         // the poll interval: nothing goes out before it
        assert.strictEqual((await steps(p, 1), d.calls.length), 7);
        v = p.view();
        assert.deepStrictEqual([v.active, v.can], [0, 12]);
        assert.deepStrictEqual(UI.note(v, t), ['Flex fuel disabled', t.dim]);
        assert.strictEqual(UI.badge(v, t), null, 'no badge while live');
        await steps(p, 3);
        assert.strictEqual(d.calls.length, 7, 'reads are paced by pollMs');
        assert.strictEqual(d.maxInflight, 1);
    }

    /* ---------- a stock DME: refused, nothing else is sent, probed again after 30 s ---------- */
    {
        const d = dme('stock'), p = poller(d);
        assert.strictEqual(await steps(p, 3), 'no-mhd');
        assert.deepStrictEqual(d.calls, ['2F 04 4D 48 44']);
        assert.ok(UI.note(p.view(), themes.theme('ice'))[0].indexOf('MHD not found') === 0);
        assert.strictEqual(UI.badge(p.view(), themes.theme('ice')).text, 'NO MHD');
        p.clock.t += 29000; await steps(p, 2);
        assert.strictEqual(d.calls.length, 1);
        p.clock.t += 2000; await steps(p, 1);
        assert.deepStrictEqual(d.calls, ['2F 04 4D 48 44', '2F 04 4D 48 44']);
    }

    /* ---------- MHD on another ROM: identified, never defined ---------- */
    {
        const d = dme('other'), p = poller(d);
        assert.strictEqual(await steps(p, 4), 'unsupported-rom');
        assert.deepStrictEqual(d.calls, ['2F 04 4D 48 44', '22 F1 01', '22 F1 02']);
        const v = p.view();
        assert.deepStrictEqual(v.seen, ['00005C64146E06', '00008A51146EAD']);
        assert.strictEqual(UI.badge(v, themes.theme('amber')).text, 'OTHER ROM');
        p.clock.t += 61000; await steps(p, 2);
        assert.strictEqual(d.calls.length, 5, 'identified again after a minute, still no 2C');
    }

    /* ---------- the DME forgets the identifier: defined again, then capped ---------- */
    {
        const d = dme('mhd', { lose: 1 }), p = poller(d);
        await steps(p, 3);                        // probing, identifying, defining -> reading
        assert.strictEqual(await steps(p, 1), 'defining', '7F 22 31 means the identifier is gone');
        p.clock.t += 1000;                        // a second between definitions
        assert.strictEqual(await steps(p, 1), 'reading');
        p.clock.t += 500;
        await steps(p, 1);
        assert.deepStrictEqual(p.view().active, 85);
        assert.strictEqual(d.calls.filter((c) => c.startsWith('2C 02')).length, 2);
    }
    {
        const d = dme('mhd', { lose: 99 }), p = poller(d);
        for (let i = 0; i < 30 && p.state !== 'error'; i++) { await p.step(); p.clock.t += 1000; }
        assert.strictEqual(p.state, 'error', 'a definition that never holds stops in error');
        assert.strictEqual(d.calls.filter((c) => c.startsWith('2C 02')).length, 3, 'redefineLimit');
        assert.strictEqual(UI.badge(p.view(), themes.theme('m_red')).text, 'DME ERROR');
        const probes = d.calls.filter((c) => c.startsWith('2F')).length;
        p.clock.t += 5000; await steps(p, 1);
        assert.strictEqual(p.state, 'identifying', 'after the backoff it starts over with the probe');
        assert.strictEqual(d.calls.filter((c) => c.startsWith('2F')).length, probes + 1);
    }

    /* ---------- the identifiers: F303 refused -> F301; all refused -> error; the car's F304 refusal ---------- */
    {
        const d = dme('mhd', { slots: ['F300', 'F301', 'F302'] }), p = poller(d);
        await steps(p, 2);
        assert.strictEqual(await steps(p, 1), 'defining', 'F303 refused: still defining, with the next identifier');
        assert.strictEqual(p.did, 'F301');
        assert.strictEqual(await steps(p, 1), 'reading');
        assert.deepStrictEqual(d.calls.slice(3), ['2C 03 F3 03', '2C 02 F3 03 14 B0 00 60 C2 01 B0 00 60 D2 01', '2C 03 F3 01', '2C 02 F3 01 14 B0 00 60 C2 01 B0 00 60 D2 01']);
        await steps(p, 1);
        assert.deepStrictEqual([p.view().active, p.view().can, p.view().did], [85, 83, 'F301']);
        assert.strictEqual(d.calls[d.calls.length - 1], '22 F3 01');
    }
    {
        const d = dme('mhd', { slots: ['F300'] }), p = poller(d);
        assert.strictEqual(await steps(p, 4), 'error', 'no identifier taken: error with backoff');
        assert.ok(/out of range \(identifiers F303, F301\)/.test(p.reason), p.reason);
        assert.strictEqual(d.calls.filter((c) => c.startsWith('2C 02')).length, 2);
        p.clock.t += 5000; await steps(p, 2);     // probe, identify: the next definition starts the list over
        assert.strictEqual(p.did, 'F303', 'after the backoff the list starts over');
        assert.strictEqual(d.calls.filter((c) => c.startsWith('2C 02')).length, 2);
    }
    {
        const d = dme('mhd'), p = poller(d, { config: { dynamicDid: 'F304' } });   // the first build on the car
        assert.strictEqual(await steps(p, 3), 'error');
        assert.ok(/definition refused: out of range/.test(p.reason), p.reason);
        assert.ok(/2C02F30414B00060C201B00060D201 -> 7F2C31$/.test(p.view().lastReply), p.view().lastReply);
    }
    {
        const p = poller(dme('mhd'), { config: { dynamicDids: ['f302'], dynamicDid: 'F300' } });
        assert.deepStrictEqual(p.dids, ['F302', 'F300'], 'config: the list first, then the single one, upper case');
    }

    /* ---------- a reply of the wrong length: someone else defined our identifier ---------- */
    {
        const d = dme('mhd', { short: true }), p = poller(d);
        await steps(p, 3);
        assert.strictEqual(await steps(p, 1), 'defining');
        assert.strictEqual(p.view().active, null);
    }

    /* ---------- a quiet DME: probe retries, then error with backoff ---------- */
    {
        const d = dme('quiet'), p = poller(d);
        for (let i = 0; i < 5; i++) { await steps(p, 1); p.clock.t += 2000; }
        assert.strictEqual(p.state, 'error');
        assert.strictEqual(d.calls.length, 5);
        assert.deepStrictEqual(UI.note(p.view(), themes.theme('ice')), ['Waiting for the DME', themes.theme('ice').warn]);
    }

    /* ---------- link states, visibility and demo pause ---------- */
    {
        const d = dme('mhd');
        let link = false, avail = false;
        const p = poller(d, { hasLink: () => link, available: () => avail });
        assert.strictEqual(await steps(p, 2), 'no-link');
        link = true;
        assert.strictEqual(await steps(p, 2), 'link-down');
        avail = true; p.linkChanged(true);
        assert.strictEqual(await steps(p, 3), 'reading');
        p.setVisible(false); p.clock.t += 5000;
        const n = d.calls.length; await steps(p, 3);
        assert.strictEqual(d.calls.length, n, 'hidden: nothing is sent');
        p.setVisible(true); p.setPaused(true); await steps(p, 3);
        assert.strictEqual(d.calls.length, n, 'demo on: nothing is sent');
        p.setPaused(false); await steps(p, 1);
        assert.strictEqual(d.calls.length, n + 1);
        avail = false;
        assert.strictEqual(await steps(p, 1), 'link-down');
        assert.strictEqual(p.view().active, null);
        assert.strictEqual(d.maxInflight, 1);
    }

    /* ---------- the screen in every state, software and GPU ---------- */
    const states = ['no-link', 'link-down', 'probing', 'no-mhd', 'identifying', 'unsupported-rom', 'defining', 'reading', 'error'];
    for (const name of Object.keys(themes.themes || { m_tricolour: 1, m_red: 1, ice: 1, amber: 1 })) {
        const t = themes.theme(name);
        for (const state of states) {
            const v = { state, active: state === 'reading' ? 12 : null, can: state === 'reading' ? 12 : null, stale: false,
                seen: ['00005C64146E06'], mhd: { version: '0120' }, profile: P.PROFILES[0].name, demo: false };
            const r = new Recorder(UI.W, UI.H);
            UI.draw(r, G, t, v, LOGO);
            play(r.words(), new Canvas(UI.W, UI.H));      // the software path: the recording played into a canvas
        }
        UI.draw(new Recorder(UI.W, UI.H), G, t, { state: 'reading', active: 70, can: 72, demo: true }, LOGO);
    }
    assert.ok(LOGO.w === 180 && LOGO.h > 40 && LOGO.runs.length > 100 && LOGO.palette.every((c) => /^#[0-9a-f]{8}$/.test(c)));

    /* ---------- main.js with the kit stubbed: no transport -> demo, one frame drawn ---------- */
    require(path.join(app, 'main'));
    assert.ok(mguApp && typeof mguApp.start === 'function');
    const vals = { theme: 'm_tricolour', layout: 'full', renderer: 'auto', demo: 'auto' };
    let frames = 0, loopFn = null;
    const ctx = {
        ui: { image: async () => { frames++; }, onVisible() {}, isVisible: () => true, onClick() {}, text() {} },
        settings: { get: (k) => vals[k], onChange() {} },
        log: quiet,
        spec: { config: { dynamicDids: ['F303', 'F301'], pollMs: 500 } },
        signals: { proxy: async () => { throw new Error('preview'); } },
        theme: () => themes.theme(vals.theme),
        canvas: (w, h) => new Recorder(w, h),
        loop: (name, fps, fn) => { loopFn = fn; return { stop() {}, kick() {} }; },
        onTab() {}, hideButton() {},
    };
    await mguApp.start(ctx);
    assert.strictEqual(frames, 1);
    await loopFn();
    assert.strictEqual(frames, 2);
    await new Promise((r) => setTimeout(r, 30));     // the poller's loop idles in no-link without throwing
    console.log('Flex Fuel checks passed (protocol, poller states, filters, screen, main).');
    process.exit(0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
