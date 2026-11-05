'use strict';
/**
 * poller.js - reads the two ethanol bytes from an MHD-flashed DME, one request at a time, and
 * keeps a state the screen can show:
 *
 *   no-link          no diagnostic transport at all (the emulator; the proxy not up yet)
 *   link-down        the transport is there but not available (car asleep)
 *   probing          2F 04 "MHD" is out
 *   no-mhd           the DME refused the probe: no MHD on it (probed again every 30 s)
 *   identifying      22 F1 01 / F1 02 are out
 *   unsupported-rom  MHD is there but no profile has this ROM's addresses (checked again every 60 s)
 *   defining         2C 03 / 2C 02 <did> are out: the first identifier of `dynamicDids` the DME takes
 *                    (F303, then F301: this DME has F300..F303 only and answered 7F 2C 31 to F304)
 *   reading          22 <did> every pollMs; the values are live
 *   error            something refused or went quiet: backoff 5 s, 10 s, 20 s, 30 s, then probe again
 *
 * Everything the loop sends comes from protocol.js; `physical(sid, data, timeoutMs, accept)` is the
 * transport (kit/diag.js Diag.physical bound to the DME), `available()` says whether it is up and
 * `hasLink()` whether it exists at all. `sleep` and `now` are injectable so tests run on a fake
 * clock, driving step() by hand instead of start().
 */
const P = require('./protocol');

const DEFAULTS = { dynamicDids: ['F303', 'F301'], pollMs: 500, readTimeoutMs: 1500, probeTimeoutMs: 3000, redefineLimit: 3 };
const RETRY_NO_MHD_MS = 30000, RETRY_ROM_MS = 60000, PROBE_RETRY_MS = 2000, PROBE_FAILS = 5;
const STALE_MISSES = 3, GIVE_UP_MISSES = 10, SLOW_POLL_MS = 1000, REDEFINE_GAP_MS = 1000;
const BACKOFF_MS = 5000, BACKOFF_MAX_MS = 30000;

class Poller {
    constructor(o) {
        this.physical = o.physical;
        this.available = o.available || (() => true);
        this.hasLink = o.hasLink || (() => true);
        this.log = o.log || { info() {}, warn() {}, error() {} };
        this.cfg = Object.assign({}, DEFAULTS, o.config || {});
        this.profiles = o.profiles || P.PROFILES;
        this.sleep = o.sleep || ((ms) => new Promise((r) => { this._wake = r; setTimeout(r, ms); }));
        this.now = o.now || (() => Date.now());
        // the identifiers to try, in order (config `dynamicDids`; a single `dynamicDid` is honoured too)
        const given = o.config || {};
        const list = [].concat(given.dynamicDids || [], given.dynamicDid || []).map((d) => String(d).toUpperCase());
        this.dids = list.length ? list : DEFAULTS.dynamicDids.slice();
        this.didIndex = 0;
        this.visible = true;
        this.paused = false;        // demo data on: nothing is sent
        this.running = false;
        this.busy = false;
        this.state = 'no-link';
        this.reason = '';           // why the state is what it is (log / screen)
        this.active = null; this.can = null;
        this.lastGood = 0;
        this.mhd = null;            // { version, marker } once detected
        this.profile = null;
        this.seen = [];             // SVK ids found on an unsupported ROM
        this.nextAt = 0;            // the earliest time the next request may go
        this.misses = 0;            // reads in a row without an answer
        this.probeFails = 0;
        this.errors = 0;            // backoff steps
        this.redefines = 0;         // definitions since the last good read
        this.definedAt = 0;
        this.lastReply = '';        // the last reply's bytes (hex), for the screen while values are not readable
        this._wake = null;
    }

    /** The loop: one step after another until stop(). Never throws. */
    start() {
        if (this.running) return;
        this.running = true;
        const run = async () => {
            while (this.running) {
                try { await this.step(); } catch (e) { this.log.error('mhd_flex: ' + String(e && e.stack || e)); await this.sleep(1000); }
            }
        };
        run();
    }
    stop() { this.running = false; this.wake(); }
    wake() { const w = this._wake; this._wake = null; if (w) w(); }
    linkChanged(on) { if (on && this.state === 'link-down') this.nextAt = 0; this.wake(); }
    setVisible(on) { this.visible = !!on; this.wake(); }
    setPaused(on) { this.paused = !!on; this.wake(); }

    get did() { return this.dids[this.didIndex]; }

    _set(state, reason) {
        if (state !== this.state) this.log.info('mhd_flex: ' + this.state + ' -> ' + state + (reason ? ' (' + reason + ')' : ''));
        this.state = state;
        this.reason = reason || '';
        if (state !== 'reading') { this.active = null; this.can = null; }
    }

    /** One request (or one wait). Returns the state afterwards. */
    async step() {
        if (this.busy) return this.state;
        if (!this.hasLink()) { this._set('no-link', 'no diagnostic transport'); await this.sleep(500); return this.state; }
        if (!this.available()) { this._set('link-down', 'transport not available'); await this.sleep(250); return this.state; }
        if (this.paused || !this.visible) { await this.sleep(250); return this.state; }
        const now = this.now();
        if (now < this.nextAt) { await this.sleep(Math.min(250, this.nextAt - now)); return this.state; }
        this.busy = true;
        try {
            switch (this.state) {
                case 'no-link': case 'link-down': case 'error': case 'no-mhd':
                    this._set('probing'); await this._probe(); break;
                case 'probing': await this._probe(); break;
                case 'unsupported-rom': this._set('identifying'); await this._identify(); break;
                case 'identifying': await this._identify(); break;
                case 'defining': await this._define(); break;
                case 'reading': await this._read(); break;
                default: this._set('probing');
            }
        } finally { this.busy = false; }
        return this.state;
    }

    async _send(req, timeoutMs) {
        const reply = await this.physical(req.sid, req.data, timeoutMs, req.accept);
        this.lastReply = P.bytesHex([req.sid].concat(req.data)) + ' -> ' + (reply && reply.length ? P.bytesHex(reply) : 'no answer');
        return reply;
    }

    _fail(reason) {
        this.errors++;
        const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * Math.pow(2, this.errors - 1));
        this.nextAt = this.now() + wait;
        this._set('error', reason);
        this.log.warn('mhd_flex: ' + reason + ', next try in ' + Math.round(wait / 1000) + ' s');
    }

    async _probe() {
        const r = P.parseProbe(await this._send(P.probeRequest(), this.cfg.probeTimeoutMs));
        if (r.mhd) {
            this.mhd = { version: r.version, marker: r.marker };
            this.probeFails = 0;
            this._set('identifying', 'MHD marker ' + r.marker);
            return;
        }
        if (r.nrc != null) {
            this.nextAt = this.now() + RETRY_NO_MHD_MS;
            this._set('no-mhd', 'DME refused the MHD probe (' + r.reason + ')');
            return;
        }
        this.probeFails++;
        if (this.probeFails >= PROBE_FAILS) { this.probeFails = 0; this._fail('no answer to the MHD probe'); return; }
        this.nextAt = this.now() + PROBE_RETRY_MS;
        this.reason = r.reason;
    }

    async _identify() {
        const a = P.svkData(await this._send(P.svkRequest(0x01), this.cfg.readTimeoutMs), 0x01);
        const b = P.svkData(await this._send(P.svkRequest(0x02), this.cfg.readTimeoutMs), 0x02);
        if (!a && !b) { this._fail('no answer to the identification'); return; }
        const m = P.matchProfile([a, b], this.profiles);
        this.seen = m.seen;
        if (!m.profile) {
            this.nextAt = this.now() + RETRY_ROM_MS;
            this._set('unsupported-rom', 'ids ' + m.seen.join(', '));
            return;
        }
        this.profile = m.profile;
        this._set('defining', m.profile.name);
    }

    async _define() {
        if (this.redefines >= this.cfg.redefineLimit) { this.redefines = 0; this._fail('the definition keeps getting lost'); return; }
        const clear = P.parseDefine(await this._send(P.clearRequest(this.did), this.cfg.readTimeoutMs), 0x03);
        if (!clear.ok && clear.nrc == null) { this._fail('no answer to the clear'); return; }    // a refusal (nothing defined) is fine
        const def = P.parseDefine(await this._send(P.defineRequest(this.did, this.profile), this.cfg.readTimeoutMs), 0x02);
        if (!def.ok && def.nrc === 0x31 && this.didIndex + 1 < this.dids.length) {
            // this DME has no such identifier: the next candidate, right away
            this.log.info('mhd_flex: identifier ' + this.did + ' refused (out of range), trying ' + this.dids[this.didIndex + 1]);
            this.didIndex++;
            this.reason = 'identifier ' + this.dids[this.didIndex - 1] + ' refused, trying ' + this.did;
            return;
        }
        if (!def.ok) {
            const tried = this.dids.slice(0, this.didIndex + 1).join(', ');
            this.didIndex = 0;
            this._fail('definition refused: ' + def.reason + (def.nrc === 0x31 ? ' (identifiers ' + tried + ')' : ''));
            return;
        }
        this.redefines++;
        this.definedAt = this.now();
        this.misses = 0;
        this._set('reading', 'identifier ' + this.did + ' defined');
    }

    async _read() {
        const r = P.parseRead(await this._send(P.readRequest(this.did), this.cfg.readTimeoutMs), this.did);
        const now = this.now();
        if (r.ok) {
            this.active = r.active; this.can = r.can;
            this.lastGood = now; this.misses = 0; this.redefines = 0; this.errors = 0;
            this.nextAt = now + this.cfg.pollMs;
            return;
        }
        if (r.reason === 'timeout') {
            this.misses++;
            if (this.misses >= GIVE_UP_MISSES) { this.misses = 0; this._set('probing', 'the DME went quiet'); return; }
            this.nextAt = now + (this.misses >= STALE_MISSES ? SLOW_POLL_MS : this.cfg.pollMs);
            return;
        }
        if (r.nrc === 0x31 || r.reason === 'length') {
            // the DME forgot our identifier (ignition cycle, MHD's own session), or someone else defined it
            this.nextAt = Math.max(now, this.definedAt + REDEFINE_GAP_MS);
            this._set('defining', 'identifier lost (' + r.reason + ')');
            return;
        }
        this._fail('read refused: ' + r.reason);
    }

    /** What the screen shows. */
    view() {
        const now = this.now();
        return {
            state: this.state, reason: this.reason,
            active: this.state === 'reading' ? this.active : null,
            can: this.state === 'reading' ? this.can : null,
            stale: this.state === 'reading' && this.misses >= STALE_MISSES,
            age: this.lastGood ? now - this.lastGood : null,
            mhd: this.mhd, profile: this.profile ? this.profile.name : null, seen: this.seen.slice(),
            did: this.did, lastReply: this.lastReply,
        };
    }
}

module.exports = { Poller, DEFAULTS };
