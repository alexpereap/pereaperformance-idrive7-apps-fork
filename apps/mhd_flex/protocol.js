'use strict';
/**
 * protocol.js - how an MHD-flashed DME hands out its ethanol content, as captured from MHD's own
 * app logging on a G-series MG1 (DME 0x12, SGBD index 0F26B4, MHD 5.41), pure functions only.
 *
 *   detect MHD : 2F 04 4D 48 44 ("MHD")       -> 6F 04 4D 48 44 32 ..  ("MHD2" + version); an untuned DME refuses
 *   identify   : 22 F1 01 (and 22 F1 02)      -> SVK entries, 8 bytes each: <type> 00 00 <id 2 bytes> <version 3 bytes>;
 *                MHD keys its addresses by the program (type 08, "PRGID") and calibration (type 0D, "CALID") entries
 *   define     : 2C 03 F3 04                  -> 6C 03 ..          clear our dynamic identifier
 *                2C 02 F3 04 14 <addr 4 bytes> 01 <addr 4 bytes> 01 -> 6C 02 F3 04      both bytes, one identifier
 *   read       : 22 F3 04                     -> 62 F3 04 <active> <can>   % ethanol, one byte each
 *
 * 0x23 ReadMemoryByAddress is refused on this DME (7F 23 10), so the dynamic identifier is the way.
 * MHD's app uses F300..F303 and clears them when it connects: this app uses F304. The DME forgets
 * the definition at an ignition cycle (then 22 F3 04 answers 7F 22 31): define it again.
 * The addresses are ROM dependent: PROFILES holds the ROMs they were verified on, keyed by PRGID + CALID.
 */
const { replyTo, NRC, hex } = require('./kit/diag');

const DME = 0x12;

/** The ROMs the addresses are known for. prgid / calid as MHD's log header prints them (7 bytes). */
const PROFILES = [
    {
        name: 'MHD on MG1 (PRGID 00005D55503C05)',
        prgid: '00005D55503C05', calid: '00008417503C1D', sgbd: '0F26B4',
        active: 'B00060C2',     // "Ethanol Content (Active)", 1 byte, %
        can: 'B00060D2',        // "Ethanol Content (CAN)", 1 byte, %
    },
];

const PROBE = [0x04, 0x4D, 0x48, 0x44];      // 2F 04 "MHD"
const SVK_TYPES = [0x08, 0x0D];             // the SVK entry types MHD keys on (program, calibration)

function hexBytes(s) {
    if (typeof s !== 'string' || !/^([0-9A-Fa-f]{2})+$/.test(s)) throw new Error('bad hex ' + s);
    return s.match(/../g).map((b) => parseInt(b, 16));
}
function addressBytes(s) {
    const b = hexBytes(s);
    if (b.length !== 4) throw new Error('an address is 4 bytes: ' + s);
    return b;
}
function didBytes(s) {
    const b = hexBytes(s);
    if (b.length !== 2) throw new Error('an identifier is 2 bytes: ' + s);
    return b;
}
const bytesHex = (b) => (b || []).map((x) => hex(x)).join('');

/** 2F 04 "MHD": the DME answers with MHD's marker when the tune is flashed. */
function probeRequest() { return { sid: 0x2F, data: PROBE.slice(), accept: replyTo(0x2F, PROBE) }; }

/** The probe's answer: { mhd: true, version } on 6F 04 4D 48 44 32 .., { mhd: false, nrc } on a refusal, else reason. */
function parseProbe(reply) {
    if (!reply || !reply.length) return { mhd: false, reason: 'timeout' };
    if (reply[0] === 0x7F) return { mhd: false, nrc: reply[2], reason: nrcText(reply[2]) };
    const ok = reply[0] === 0x6F && reply[1] === 0x04 && reply[2] === 0x4D && reply[3] === 0x48 && reply[4] === 0x44 && reply[5] === 0x32;
    if (!ok) return { mhd: false, reason: 'unexpected ' + bytesHex(reply.slice(0, 8)) };
    return { mhd: true, version: bytesHex(reply.slice(6, 8)), marker: bytesHex(reply.slice(2)) };
}

/** 22 F1 01 / 22 F1 02: the DME's software version keys (SVK). */
function svkRequest(n) { const d = [0xF1, n]; return { sid: 0x22, data: d, accept: replyTo(0x22, d) }; }

/** The data after 62 F1 0n, or null (refused / no answer). */
function svkData(reply, n) {
    if (!reply || reply[0] !== 0x62 || reply[1] !== 0xF1 || reply[2] !== n) return null;
    return reply.slice(3);
}

/** Index of the byte string (hex) in data, at any offset; -1 when absent. */
function findHex(data, s) {
    const want = hexBytes(s);
    for (let i = 0; i + want.length <= data.length; i++) {
        let j = 0;
        while (j < want.length && data[i + j] === want[j]) j++;
        if (j === want.length) return i;
    }
    return -1;
}

/** The program / calibration ids in an SVK reply (7 bytes each as hex), to say which ROM this is. */
function svkIds(data) {
    const out = [];
    for (let i = 0; i + 8 <= data.length; i++) {
        if (SVK_TYPES.indexOf(data[i]) >= 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] !== 0) {
            const id = bytesHex(data.slice(i + 1, i + 8));
            if (out.indexOf(id) < 0) out.push(id);
            i += 7;
        }
    }
    return out;
}

/** The profile whose PRGID and CALID both appear in the SVK replies (data arrays), with every id seen. */
function matchProfile(replies, profiles) {
    const datas = (replies || []).filter((d) => d && d.length);
    const seen = [];
    datas.forEach((d) => svkIds(d).forEach((id) => { if (seen.indexOf(id) < 0) seen.push(id); }));
    const has = (s) => datas.some((d) => findHex(d, s) >= 0);
    const profile = (profiles || PROFILES).find((p) => has(p.prgid) && has(p.calid)) || null;
    return { profile, seen };
}

/** accept() for a 2C request: its positive reply echoes the sub-function (and the identifier), or 7F 2C. */
function acceptDefine(sub, did) {
    const [hi, lo] = didBytes(did);
    return (u) => (u[0] === 0x6C && u[1] === sub && (u.length < 4 || (u[2] === hi && u[3] === lo)))
        || (u[0] === 0x7F && u[1] === 0x2C);
}

/** 2C 03 <did>: forget the identifier (a DME that has none answers 7F 2C 31, which is fine). */
function clearRequest(did) {
    const d = [0x03].concat(didBytes(did));
    return { sid: 0x2C, data: d, accept: acceptDefine(0x03, did) };
}

/** 2C 02 <did> 14 <addr> 01 <addr> 01: the identifier = active byte, then CAN byte (format 14 = 1-byte size, 4-byte address). */
function defineRequest(did, profile) {
    const d = [0x02].concat(didBytes(did), [0x14], addressBytes(profile.active), [0x01], addressBytes(profile.can), [0x01]);
    return { sid: 0x2C, data: d, accept: acceptDefine(0x02, did) };
}

/** { ok: true } when the DME took the definition, else { ok: false, nrc?, reason }. */
function parseDefine(reply, sub) {
    if (!reply || !reply.length) return { ok: false, reason: 'timeout' };
    if (reply[0] === 0x7F) return { ok: false, nrc: reply[2], reason: nrcText(reply[2]) };
    if (reply[0] === 0x6C && reply[1] === sub) return { ok: true };
    return { ok: false, reason: 'unexpected ' + bytesHex(reply.slice(0, 4)) };
}

/** 22 <did>: both ethanol bytes in one answer. */
function readRequest(did) { const d = didBytes(did); return { sid: 0x22, data: d, accept: replyTo(0x22, d) }; }

/**
 * The read's answer: { ok: true, active, can } (a byte over 100 is null: not a percentage), { ok: false, nrc },
 * or { ok: false, reason: 'length' } when the identifier does not hold exactly our two bytes (someone else
 * defined it: define it again).
 */
function parseRead(reply, did) {
    if (!reply || !reply.length) return { ok: false, reason: 'timeout' };
    if (reply[0] === 0x7F) return { ok: false, nrc: reply[2], reason: nrcText(reply[2]) };
    const [hi, lo] = didBytes(did);
    if (reply[0] !== 0x62 || reply[1] !== hi || reply[2] !== lo) return { ok: false, reason: 'unexpected ' + bytesHex(reply.slice(0, 4)) };
    if (reply.length !== 5) return { ok: false, reason: 'length' };
    const pct = (b) => (b <= 100 ? b : null);
    return { ok: true, active: pct(reply[3]), can: pct(reply[4]) };
}

function nrcText(nrc) { return NRC[nrc] || ('NRC ' + hex(nrc)); }

module.exports = {
    DME, PROFILES, PROBE, hexBytes, addressBytes, didBytes, bytesHex,
    probeRequest, parseProbe, svkRequest, svkData, findHex, svkIds, matchProfile,
    acceptDefine, clearRequest, defineRequest, parseDefine, readRequest, parseRead, nrcText,
};
