import OSC from "osc-js";
import dgram from "dgram";
import os from "os";
import {
    NODE_SCHEMA,
    NodeSchemaEntry,
    FieldDef,
    FieldType,
    findSchema,
    listSchemas as listSchemasImpl,
    decodeField,
    encodeFieldValue,
} from "./node-schema.js";
import {
    FX_ALGORITHM_COUNT,
    FxAlgorithmEntry,
    findFxByName,
    findFxBySlotAndCode,
    fxCodeForSlot,
    isInsertSlot,
    listFxAlgorithms as listFxAlgorithmsImpl,
    resolveFxType,
    GEQ_ALGORITHM_NAMES,
} from "./fx-schema.js";

// ========== X32node reply parsers ==========
// X32 /node replies come back on the non-OSC-compliant address "node" (no leading slash).
// Format: single OSC string arg like '/ch/01/config "Voc1" 1 MG 1\n'
// Values are space-delimited; names are quoted; bitmasks prefixed %, -∞ dB rendered as "-oo",
// frequencies rendered in "3k48" shorthand (=3480 Hz).

/** Tokenize a /node reply string. Respects "quoted" values (which may contain spaces). */
export function parseNodeLine(line: string): { path: string; values: string[] } {
    const trimmed = line.replace(/\n$/, "").replace(/\s+$/, "");
    const firstSpace = trimmed.indexOf(" ");
    const path = firstSpace === -1 ? trimmed : trimmed.substring(0, firstSpace);
    const rest = firstSpace === -1 ? "" : trimmed.substring(firstSpace + 1);
    const values: string[] = [];
    let i = 0;
    while (i < rest.length) {
        while (i < rest.length && rest[i] === " ") i++;
        if (i >= rest.length) break;
        if (rest[i] === '"') {
            i++;
            let out = "";
            while (i < rest.length && rest[i] !== '"') {
                if (rest[i] === "\\" && i + 1 < rest.length) {
                    out += rest[i + 1]; i += 2;
                } else {
                    out += rest[i]; i++;
                }
            }
            values.push(out);
            if (i < rest.length) i++;
        } else {
            const start = i;
            while (i < rest.length && rest[i] !== " ") i++;
            values.push(rest.substring(start, i));
        }
    }
    return { path, values };
}

/** X32 dB-string to number: "-oo" → -Infinity, "+3.3" → 3.3, "-44" → -44. */
export function parseX32Db(s: string): number {
    if (s === "-oo" || s === "-∞") return -Infinity;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
}

/** X32 frequency shorthand to Hz: "3k48" → 3480, "12k" → 12000, "500" → 500. */
export function parseX32Freq(s: string): number {
    const m = s.match(/^(\d+)k(\d*)$/);
    if (m) {
        const thousands = parseInt(m[1], 10) * 1000;
        if (m[2] === "") return thousands;
        const sub = parseInt(m[2], 10) * Math.pow(10, 3 - m[2].length);
        return thousands + sub;
    }
    return parseFloat(s);
}

/** X32 bitmask string "%01011010" to integer. */
export function parseX32Bitmask(s: string): number {
    if (s.startsWith("%")) return parseInt(s.substring(1), 2);
    return parseInt(s, 10);
}

/** X32 boolean: "ON"/"OFF" → true/false. */
export function parseX32Bool(s: string): boolean {
    return s === "ON" || s === "TRUE" || s === "1";
}

// ========== Meter blob helpers (Phase E) ==========

/** Read a NUL-terminated, 4-byte-padded OSC C-string from a buffer at offset. */
function readCStringFrom(buf: Buffer, off: number): { s: string; next: number } {
    let end = off;
    while (end < buf.length && buf[end] !== 0) end++;
    const s = buf.subarray(off, end).toString("utf8");
    const padded = Math.ceil((end - off + 1) / 4) * 4;
    return { s, next: off + padded };
}

/** Build an OSC `/meters ,s <bank-tag>` request packet by hand (osc-js doesn't expose
 *  the right shape for a single-string arg cleanly). */
function buildMetersRequest(bank: number): Buffer {
    const padNul = (s: string): Buffer => {
        const raw = Buffer.from(s + "\0");
        const padded = Math.ceil(raw.length / 4) * 4;
        return Buffer.concat([raw, Buffer.alloc(padded - raw.length)]);
    };
    return Buffer.concat([padNul("/meters"), padNul(",s"), padNul(`/meters/${bank}`)]);
}

/** Convert linear meter value to dBfs. 0 → -∞. */
function linToDbfs(v: number): number {
    if (!Number.isFinite(v) || v <= 0) return -Infinity;
    return 20 * Math.log10(v);
}

/** Convert linear gain-reduction value to dB. 1.0 → 0 dB (no reduction); 0.5 → -6 dB. */
function linToGrDb(v: number): number {
    if (!Number.isFinite(v) || v <= 0) return -Infinity;
    return 20 * Math.log10(v);
}

/**
 * Decode a meter blob into an LLM-friendly named dict per bank layout.
 *
 * Bank 0 (70 floats):  ch01..32, auxin1..8, fxrtn1L/1R..4L/4R, bus01..16, mtx01..06
 * Bank 1 (96 floats):  ch01..32 post-fader, ch01..32 gate-GR, ch01..32 dyn-GR
 * Bank 2 (49 floats):  bus01..16, mtx01..06, mainL, mainR, mainM, then GR for the same
 * Bank 3 (22 floats):  auxsnd01..06, auxin1..8, fxrtn1L..4R
 */
function decodeMeterBlob(
    bank: number,
    floats: number[],
    thresholdDb: number,
    elapsedMs: number,
): {
    bank: number;
    description: string;
    elapsedMs: number;
    floatCount: number;
    levels?: Record<string, number>;
    gateGainReduction?: Record<string, number>;
    dynGainReduction?: Record<string, number>;
} {
    const passLevel = (db: number) => Number.isFinite(db) && db >= thresholdDb;
    const passGr = (db: number) => Number.isFinite(db) && db < -0.05;  // only show GR when actively reducing

    const result: any = { bank, description: "", elapsedMs, floatCount: floats.length };

    if (bank === 0) {
        result.description = "Per-channel post-headamp meters + aux/fx/bus/matrix levels";
        const lv: Record<string, number> = {};
        for (let i = 0; i < 32; i++) {
            const db = linToDbfs(floats[i]);
            if (passLevel(db)) lv[`ch${String(i + 1).padStart(2, "0")}`] = +db.toFixed(1);
        }
        for (let i = 0; i < 8; i++) {
            const db = linToDbfs(floats[32 + i]);
            if (passLevel(db)) lv[`auxin${i + 1}`] = +db.toFixed(1);
        }
        const fxLabels = ["fxrtn1L", "fxrtn1R", "fxrtn2L", "fxrtn2R", "fxrtn3L", "fxrtn3R", "fxrtn4L", "fxrtn4R"];
        for (let i = 0; i < 8; i++) {
            const db = linToDbfs(floats[40 + i]);
            if (passLevel(db)) lv[fxLabels[i]] = +db.toFixed(1);
        }
        for (let i = 0; i < 16; i++) {
            const db = linToDbfs(floats[48 + i]);
            if (passLevel(db)) lv[`bus${String(i + 1).padStart(2, "0")}`] = +db.toFixed(1);
        }
        for (let i = 0; i < 6; i++) {
            const db = linToDbfs(floats[64 + i]);
            if (passLevel(db)) lv[`mtx${String(i + 1).padStart(2, "0")}`] = +db.toFixed(1);
        }
        result.levels = lv;
        return result;
    }

    if (bank === 1) {
        result.description = "Post-fader channel levels + gate GR + dyn GR (32 channels each)";
        const lv: Record<string, number> = {};
        const gateGr: Record<string, number> = {};
        const dynGr: Record<string, number> = {};
        for (let i = 0; i < 32; i++) {
            const db = linToDbfs(floats[i]);
            if (passLevel(db)) lv[`ch${String(i + 1).padStart(2, "0")}`] = +db.toFixed(1);
        }
        for (let i = 0; i < 32; i++) {
            const grDb = linToGrDb(floats[32 + i]);
            if (passGr(grDb)) gateGr[`ch${String(i + 1).padStart(2, "0")}`] = +grDb.toFixed(1);
        }
        for (let i = 0; i < 32; i++) {
            const grDb = linToGrDb(floats[64 + i]);
            if (passGr(grDb)) dynGr[`ch${String(i + 1).padStart(2, "0")}`] = +grDb.toFixed(1);
        }
        result.levels = lv;
        result.gateGainReduction = gateGr;
        result.dynGainReduction = dynGr;
        return result;
    }

    if (bank === 2) {
        result.description = "Bus + matrix + main levels with their dyn GR";
        const lv: Record<string, number> = {};
        const dynGr: Record<string, number> = {};
        for (let i = 0; i < 16; i++) {
            const db = linToDbfs(floats[i]);
            if (passLevel(db)) lv[`bus${String(i + 1).padStart(2, "0")}`] = +db.toFixed(1);
        }
        for (let i = 0; i < 6; i++) {
            const db = linToDbfs(floats[16 + i]);
            if (passLevel(db)) lv[`mtx${String(i + 1).padStart(2, "0")}`] = +db.toFixed(1);
        }
        const mainLeft = linToDbfs(floats[22]);
        if (passLevel(mainLeft)) lv.mainL = +mainLeft.toFixed(1);
        const mainRight = linToDbfs(floats[23]);
        if (passLevel(mainRight)) lv.mainR = +mainRight.toFixed(1);
        const mainMono = linToDbfs(floats[24]);
        if (passLevel(mainMono)) lv.mainM = +mainMono.toFixed(1);

        for (let i = 0; i < 16; i++) {
            const grDb = linToGrDb(floats[25 + i]);
            if (passGr(grDb)) dynGr[`bus${String(i + 1).padStart(2, "0")}`] = +grDb.toFixed(1);
        }
        for (let i = 0; i < 6; i++) {
            const grDb = linToGrDb(floats[41 + i]);
            if (passGr(grDb)) dynGr[`mtx${String(i + 1).padStart(2, "0")}`] = +grDb.toFixed(1);
        }
        const mainLrGr = linToGrDb(floats[47]);
        if (passGr(mainLrGr)) dynGr.mainLR = +mainLrGr.toFixed(1);
        const mainMonoGr = linToGrDb(floats[48]);
        if (passGr(mainMonoGr)) dynGr.mainM = +mainMonoGr.toFixed(1);

        result.levels = lv;
        result.dynGainReduction = dynGr;
        return result;
    }

    if (bank === 3) {
        result.description = "Aux sends + aux returns + FX returns";
        const lv: Record<string, number> = {};
        for (let i = 0; i < 6; i++) {
            const db = linToDbfs(floats[i]);
            if (passLevel(db)) lv[`auxsnd${i + 1}`] = +db.toFixed(1);
        }
        for (let i = 0; i < 8; i++) {
            const db = linToDbfs(floats[6 + i]);
            if (passLevel(db)) lv[`auxin${i + 1}`] = +db.toFixed(1);
        }
        const fxLabels = ["fxrtn1L", "fxrtn1R", "fxrtn2L", "fxrtn2R", "fxrtn3L", "fxrtn3R", "fxrtn4L", "fxrtn4R"];
        for (let i = 0; i < 8; i++) {
            const db = linToDbfs(floats[14 + i]);
            if (passLevel(db)) lv[fxLabels[i]] = +db.toFixed(1);
        }
        result.levels = lv;
        return result;
    }

    return result;
}

// ========== GEQ band-name helpers (Phase D″) ==========
// The fx-schema names GEQ band fields as `band_20Hz`, `band_31_5Hz`, ...,
// `band_1k`, `band_1k25`, ..., `band_20k`. Dual variants prefix the side
// (`bandA_20Hz`, `bandB_1k`, etc.) These helpers translate between user-
// friendly ISO frequency labels ("20Hz", "1kHz", "1.25k", "20kHz") and the
// canonical schema-suffix form.

const GEQ_BAND_FIELD_SUFFIXES = [
    "20Hz", "25Hz", "31_5Hz", "40Hz", "50Hz", "63Hz", "80Hz", "100Hz", "125Hz", "160Hz",
    "200Hz", "250Hz", "315Hz", "400Hz", "500Hz", "630Hz", "800Hz", "1kHz", "1k25Hz", "1k6Hz",
    "2kHz", "2k5Hz", "3k15Hz", "4kHz", "5kHz", "6k3Hz", "8kHz", "10kHz", "12k5Hz", "16kHz", "20kHz",
];

const GEQ_USER_LABELS = [
    "20Hz", "25Hz", "31.5Hz", "40Hz", "50Hz", "63Hz", "80Hz", "100Hz", "125Hz", "160Hz",
    "200Hz", "250Hz", "315Hz", "400Hz", "500Hz", "630Hz", "800Hz", "1kHz", "1.25kHz", "1.6kHz",
    "2kHz", "2.5kHz", "3.15kHz", "4kHz", "5kHz", "6.3kHz", "8kHz", "10kHz", "12.5kHz", "16kHz", "20kHz",
];

/** Resolve a user-typed band label to the schema field-suffix. */
function resolveBandLabel(label: string): string | null {
    // Normalize: strip whitespace, lowercase, accept both "1k" and "1kHz", "31.5" and "31_5".
    const norm = label.trim().toLowerCase().replace(/hz$/, "").replace(/[._]/g, "_");
    for (let i = 0; i < GEQ_USER_LABELS.length; i++) {
        const u = GEQ_USER_LABELS[i].toLowerCase().replace(/hz$/, "").replace(/[._]/g, "_");
        if (norm === u) return GEQ_BAND_FIELD_SUFFIXES[i];
    }
    // Also accept the schema-suffix form directly ("31_5Hz", "1k", "1k25Hz").
    for (const s of GEQ_BAND_FIELD_SUFFIXES) {
        const lower = s.toLowerCase().replace(/hz$/, "");
        if (norm === lower) return s;
    }
    return null;
}

/** Convert a schema field name (e.g. "band_31_5Hz", "bandA_1kHz") to the user label "31.5Hz" / "1kHz". */
function fieldToUserLabel(suffix: string): string {
    const idx = GEQ_BAND_FIELD_SUFFIXES.indexOf(suffix);
    return idx >= 0 ? GEQ_USER_LABELS[idx] : suffix;
}

/** Pluck the bands + master for one side ("" / "A" / "B") out of a fxGet params dict. */
function extractGeqSide(params: Record<string, any>, side: string): { bands: Record<string, number>; master: number } {
    const bands: Record<string, number> = {};
    for (const sfx of GEQ_BAND_FIELD_SUFFIXES) {
        const key = `band${side}_${sfx}`;
        if (key in params) bands[fieldToUserLabel(sfx)] = params[key];
    }
    const masterKey = side === "" ? "master" : `master${side}`;
    return { bands, master: params[masterKey] ?? 0 };
}

/** Translate user-supplied band map ({"1kHz": +3}) to schema-keyed map ({band_1kHz: +3} or {bandA_1kHz: +3}). */
function mapGeqBands(input: Record<string, number> | undefined, side: string): Record<string, number> {
    if (!input) return {};
    const out: Record<string, number> = {};
    for (const [label, value] of Object.entries(input)) {
        const sfx = resolveBandLabel(label);
        if (!sfx) {
            throw new Error(`Unknown GEQ band label: "${label}". Valid: ${GEQ_USER_LABELS.join(", ")}`);
        }
        out[`band${side}_${sfx}`] = value;
    }
    return out;
}

/** Encode a JS value for the /  (X32node write) command. Strings with whitespace get quoted. */
function encodeWriteValue(v: any): string {
    if (typeof v === "boolean") return v ? "ON" : "OFF";
    if (typeof v === "number") {
        if (v === -Infinity) return "-oo";
        return String(v);
    }
    const s = String(v);
    if (s === "" || /[\s"]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
    return s;
}

/** Numeric field types that support relative {adjust} arithmetic. Enums/strings/bools/bitmasks don't. */
function isNumericFieldType(t: FieldType): boolean {
    return t === "int" || t === "float" || t === "db" || t === "freq" || t === "ms" || t === "pct";
}

/** A relative-adjustment request: `{adjust: N}` in place of an absolute field value. */
export type AdjustRequest = { adjust: number };

/** Whether a supplied field value is a `{adjust: number}` relative request rather than an absolute. */
function isAdjustRequest(v: any): v is AdjustRequest {
    return (
        v !== null &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        typeof (v as any).adjust === "number" &&
        Number.isFinite((v as any).adjust)
    );
}

/**
 * Coerce a JS value to the correct JS type for osc-js's inference.
 * osc-js picks OSC type tag from JS type: integer number -> 'i', decimal -> 'f', string -> 's', bool -> 'T'/'F'.
 * If `osctype` is given, we force the conversion; otherwise we parse-through:
 *  - string "6" + osctype "int" => 6
 *  - string "0.5" + osctype "float" => 0.5
 *  - number 6 with no osctype => 6 (int)
 *  - number 0.5 with no osctype => 0.5 (float)
 *
 * Critical for X32: `/config/color`, `/config/icon`, `/config/chlink`, scene recall, etc. all require int type.
 * LLMs often pass ints as JSON strings when schemas are loose — this lets callers force the right tag.
 */
export function coerceOscArg(v: any, osctype?: "int" | "float" | "string" | "bool"): any {
    if (osctype === "int") {
        const n = typeof v === "number" ? Math.trunc(v) : parseInt(String(v), 10);
        if (Number.isNaN(n)) throw new Error(`Cannot coerce ${JSON.stringify(v)} to int`);
        // ensure integer for osc-js isInt() check (n % 1 === 0)
        return n;
    }
    if (osctype === "float") {
        const n = typeof v === "number" ? v : parseFloat(String(v));
        if (Number.isNaN(n)) throw new Error(`Cannot coerce ${JSON.stringify(v)} to float`);
        // osc-js isFloat requires n % 1 !== 0; force a fractional component if whole
        return Number.isInteger(n) ? n + 0.0000001 : n;
    }
    if (osctype === "string") return String(v);
    if (osctype === "bool") {
        if (typeof v === "boolean") return v;
        const s = String(v).toLowerCase();
        return s === "true" || s === "1" || s === "on";
    }
    // No explicit type — pass through; osc-js will infer from JS type.
    return v;
}

// ========== Routing source encoders/decoders ==========
// Confirmed against live X32 (firmware 2.07+) on 2026-04-14.
// Probe data: slot 27 source 129 => X32-Edit label "Card 01" => 129-160 = Card 1-32.

/**
 * Decode a User In slot source code to a human label.
 * Domain: /config/userrout/in/NN (0..168).
 */
export function decodeUserInSource(n: number): string {
    if (n === 0) return "OFF";
    if (n >= 1 && n <= 32) return `Local ${n}`;
    if (n >= 33 && n <= 80) return `AES50A ${n - 32}`;
    if (n >= 81 && n <= 128) return `AES50B ${n - 80}`;
    if (n >= 129 && n <= 160) return `Card ${n - 128}`;
    if (n >= 161 && n <= 168) return `AUX In ${n - 160}`;
    return `UNKNOWN(${n})`;
}

/**
 * Encode a human label back to a User In source code.
 * Accepts labels like "Card 1", "Local 27", "AES50A 5", "AES50B 12", "AUX In 3", "OFF".
 * Case-insensitive, tolerant of extra spaces.
 */
export function encodeUserInSource(label: string | number): number {
    if (typeof label === "number") return label;
    const s = label.trim().toUpperCase().replace(/\s+/g, " ");
    if (s === "OFF" || s === "0") return 0;
    const m = s.match(/^(LOCAL|AES50A|AES50B|CARD|AUX IN|AUX)\s*(\d+)$/);
    if (!m) throw new Error(`Cannot parse User In source label: "${label}". Expected e.g. "Card 1", "Local 27", "AES50A 5", "OFF".`);
    const kind = m[1];
    const n = parseInt(m[2], 10);
    if (kind === "LOCAL") {
        if (n < 1 || n > 32) throw new Error(`Local out of range: ${n}`);
        return n;
    }
    if (kind === "AES50A") {
        if (n < 1 || n > 48) throw new Error(`AES50A out of range: ${n}`);
        return 32 + n;
    }
    if (kind === "AES50B") {
        if (n < 1 || n > 48) throw new Error(`AES50B out of range: ${n}`);
        return 80 + n;
    }
    if (kind === "CARD") {
        if (n < 1 || n > 32) throw new Error(`Card out of range: ${n}`);
        return 128 + n;
    }
    // AUX IN / AUX
    if (n < 1 || n > 8) throw new Error(`AUX In out of range: ${n}`);
    return 160 + n;
}

/**
 * Decode a block-level routing selector (the 8-channel block value).
 * Used by /config/routing/IN/*, /config/routing/AES50A/*, /config/routing/AES50B/*, /config/routing/CARD/*.
 * Each block represents 8 channels; the value selects which source group feeds that block.
 * Confirmed on live hardware: IN 1-8=20..IN 25-32=23 => User In 1-8..25-32.
 */
export function decodeBlockInSource(n: number): string {
    if (n >= 0 && n <= 3) return `Local ${n * 8 + 1}-${n * 8 + 8}`;
    if (n >= 4 && n <= 9) return `AES50A ${(n - 4) * 8 + 1}-${(n - 4) * 8 + 8}`;
    if (n >= 10 && n <= 15) return `AES50B ${(n - 10) * 8 + 1}-${(n - 10) * 8 + 8}`;
    if (n >= 16 && n <= 19) return `Card ${(n - 16) * 8 + 1}-${(n - 16) * 8 + 8}`;
    if (n >= 20 && n <= 23) return `User In ${(n - 20) * 8 + 1}-${(n - 20) * 8 + 8}`;
    if (n === 24) return "AUX In 1-6 / TB / USB";
    return `UNKNOWN(${n})`;
}

/**
 * Decode a User Out slot source code (output tap selection).
 * Note: this enum is less fully verified than User In. Identity mapping (slot 1-32 = source 1-32)
 * was observed on the live mixer, which matches the pmaillot spec for Out 1-32 taps,
 * but ranges above 32 are best-effort and should be verified before relied upon.
 */
export function decodeUserOutSource(n: number): string {
    if (n === 0) return "OFF";
    if (n >= 1 && n <= 16) return `Out ${n} (Local)`;
    if (n >= 17 && n <= 32) return `Out ${n}`;
    if (n >= 33 && n <= 48) return `P16 ${n - 32}`;
    if (n >= 49 && n <= 50) return n === 49 ? "Monitor L" : "Monitor R";
    return `UNKNOWN(${n}) — see X32 OSC spec, not fully verified`;
}

/**
 * Decode the X32 output-tap source enum used by `outputs/{main,aux,p16,aes,rec}/NN.src`.
 * Verified by cross-referencing live mixer reads:
 *   outputs/main/14=1 (MainL), 15=2 (MainR), 16=3 (MainC)
 *   outputs/main/01=4 (MX1), 06=25 (MTX6)
 *   outputs/p16/01=26 (Ch01), 14=54 (Ch29), 16=12 (MX9)
 * Note: this enum is distinct from decodeUserOutSource (which decodes /config/userrout/out/NN).
 */
export function decodeOutputTapSource(n: number): string {
    if (n === 0) return "OFF";
    if (n === 1) return "Main L";
    if (n === 2) return "Main R";
    if (n === 3) return "Main C/Mono";
    if (n >= 4 && n <= 19) return `MX ${n - 3}`;
    if (n >= 20 && n <= 25) return `MTX ${n - 19}`;
    if (n >= 26 && n <= 57) return `Ch ${String(n - 25).padStart(2, "0")}`;
    if (n >= 58 && n <= 65) return `AuxIn ${n - 57}`;
    if (n >= 66 && n <= 73) return `FX ${Math.floor((n - 66) / 2) + 1}${n % 2 === 0 ? "L" : "R"}`;
    return `UNKNOWN(${n})`;
}

type RawReply = { address: string; args: any[]; raw: string };

/** One cached /node container read. Values are display-unit tokens as returned by the X32. */
type CacheEntry = { path: string; raw: string; values: string[]; ts: number };

/** One entry in the change feed ring buffer. */
type ChangeEvent = { ts: number; address: string; value: any; source: ChangeSource };
type ChangeSource = "console" | "server";

/** A deduped change row returned by getChanges() / the osc_changes tool. */
export type ChangeRow = {
    address: string;
    value: any;
    source: ChangeSource;
    count: number;
    firstSecondsAgo: number;
    lastSecondsAgo: number;
};

/** How to reverse one field-level write during undo. */
type JournalWriteKind = "node" | "fx" | "routeIn" | "routeOut";

/** One captured field-level write inside a journal entry. `prev`/`next` are DECODED values
 *  (same domain nodeGetField returns); `prev === null` marks a write whose prior state could
 *  not be captured, so it executed but is not individually revertible. */
export type JournalWrite = {
    kind: JournalWriteKind;
    path: string;      // container path ("ch/01/mix", "fx/3/par") or leaf ("config/userrout/in/27")
    field: string;     // field / FX-param name, or "source" for routing writes
    slot?: number;     // FX slot (kind "fx") or routing slot (kind "routeIn"/"routeOut")
    prev: any;         // decoded prior value, or null if uncapturable
    next: any;         // decoded new value (informational)
};

/** One tool call's worth of writes, grouped for single-step undo. */
export type JournalEntry = {
    ts: number;
    label: string;
    writes: JournalWrite[];
    revertible: boolean;  // at least one write captured a prior value
};

/** Compact journal row for the osc_journal tool. */
export type JournalRow = { ts: number; label: string; writeCount: number; revertible: boolean };

export type CacheStats = {
    entries: number;
    hits: number;
    misses: number;
    invalidations: number;
    ttlMs: number;
    serving: boolean;
};

export type DiscoveredMixer = {
    ip: string;
    name: string;
    model: string;
    firmware: string;
    respondedFrom: string;
};

/** Build a raw OSC message with optional string args. Used for discovery (no live client needed). */
function buildOscBytes(address: string, ...stringArgs: string[]): Buffer {
    const padNul = (s: string): Buffer => {
        const raw = Buffer.from(s + "\0");
        const padded = Math.ceil(raw.length / 4) * 4;
        return Buffer.concat([raw, Buffer.alloc(padded - raw.length)]);
    };
    const tag = "," + "s".repeat(stringArgs.length);
    return Buffer.concat([padNul(address), padNul(tag), ...stringArgs.map(padNul)]);
}

/** Parse an X32 /xinfo reply (address + 4 string args: ip, name, model, firmware). */
function parseXinfoReply(buf: Buffer): { ip: string; name: string; model: string; firmware: string } | null {
    try {
        const readCStr = (off: number) => {
            let end = off;
            while (end < buf.length && buf[end] !== 0) end++;
            const s = buf.subarray(off, end).toString("utf8");
            const padded = Math.ceil((end - off + 1) / 4) * 4;
            return { s, next: off + padded };
        };
        const a = readCStr(0);
        if (a.s !== "/xinfo") return null;
        const t = readCStr(a.next);
        if (!t.s.startsWith(",")) return null;
        let off = t.next;
        const strings: string[] = [];
        for (let i = 1; i < t.s.length && i <= 4; i++) {
            if (t.s[i] !== "s") return null;
            const v = readCStr(off);
            strings.push(v.s);
            off = v.next;
        }
        if (strings.length < 4) return null;
        return { ip: strings[0], name: strings[1], model: strings[2], firmware: strings[3] };
    } catch {
        return null;
    }
}

/** Compute the directed broadcast address for an IPv4 address + netmask, e.g. ("192.168.1.5", "255.255.255.0") → "192.168.1.255". */
function computeBroadcast(addr: string, mask: string): string | null {
    const toInt = (s: string): number | null => {
        const parts = s.split(".").map((p) => parseInt(p, 10));
        if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return null;
        return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    };
    const a = toInt(addr);
    const m = toInt(mask);
    if (a === null || m === null) return null;
    const b = ((a & m) | (~m >>> 0)) >>> 0;
    return [(b >>> 24) & 0xff, (b >>> 16) & 0xff, (b >>> 8) & 0xff, b & 0xff].join(".");
}

export class OSCClient {
    private osc: any;
    private host: string;
    private port: number;
    // Queue-per-address so two concurrent reads of the same address don't clobber
    // each other — replies are handed out FIFO to the waiters for that address.
    private responseCallbacks: Map<string, Array<{ resolve: (value: any) => void; timer: NodeJS.Timeout }>> = new Map();
    private isConnected: boolean = false;

    // Parallel UDP socket for X32node traffic.
    // Reasons we can't reuse the osc-js socket:
    //   1. X32 /node replies land on address "node" (no leading slash). osc-js's OSC parser
    //      validates addresses and silently drops these, so the "*" listener never fires.
    //   2. /xinfo replies carry 4 string args, but existing sendAndReceive only surfaces args[0].
    // This socket speaks raw OSC via a hand-rolled parser so we can see everything.
    private rawSock: dgram.Socket | null = null;
    // Bounded pool of in-flight raw queries (was a single slot). Incoming packets are
    // matched against these entries in FIFO order; the FIRST whose matcher accepts the
    // packet is resolved. The matcher sees BOTH the reply address and the payload's
    // path token so concurrent /node reads — which all reply on address "node" — are
    // told apart by the path embedded in the reply body.
    private rawInflight: Array<{
        match: (address: string, payloadPath: string | null) => boolean;
        resolve: (r: RawReply) => void;
        reject: (e: Error) => void;
        timer: NodeJS.Timeout;
    }> = [];
    // Pending fire() thunks queued when the in-flight pool is at capacity.
    private rawQueue: Array<() => void> = [];
    // Max concurrent raw queries before further sends queue behind the pool.
    private static readonly RAW_POOL_CAP = 8;
    // Node paths that timed out after retry, ONLY for absent-by-design patterns
    // (unassigned headamp slots, auxin automix containers). Fast-failed thereafter.
    // Never holds arbitrary paths — a transient UDP drop must not poison a real node.
    private negativeCache: Set<string> = new Set();
    private heartbeatTimer: NodeJS.Timeout | null = null;

    // ---------- Live state mirror: container read cache ----------
    // Caches nodeRead() container results keyed by normalized node path ("ch/01/mix").
    // Transparently accelerates every composite tool. Entries are invalidated — never
    // patched — on any write or pushed change, because pushes carry RAW normalized floats
    // while the cache holds display-unit tokens; converting between them is a footgun.
    private nodeCache: Map<string, CacheEntry> = new Map();
    private static readonly CACHE_TTL_MS = 60_000;
    private cacheStats = { hits: 0, misses: 0, invalidations: 0 };
    // OSC_NO_CACHE=1 disables *serving* from cache (still fills it and records changes).
    private readonly cacheServe: boolean = process.env.OSC_NO_CACHE !== "1";

    // ---------- Live state mirror: change feed ----------
    // Ring buffer of parameter changes. "console" = arrived unsolicited via the /xremote
    // push stream (physical console or another client); "server" = caused by our own write.
    private changeBuffer: ChangeEvent[] = [];
    private static readonly CHANGE_BUFFER_CAP = 500;

    // ---------- Undo journal ----------
    // Every field-level write captures its prior value BEFORE writing and appends a journal
    // entry. All writes of one tool call fold into ONE entry (grouped via a transaction so a
    // batch of 12 ops is a single undo step). osc_undo replays the prev values in reverse.
    private journal: JournalEntry[] = [];
    private static readonly JOURNAL_CAP = 200;
    // When non-null, field writes accumulate into this open transaction instead of each
    // committing its own entry. The method that OPENED the txn is the one that commits it;
    // nested writers (batch → nodeSetField, insertEqSet → fxSet) just contribute writes.
    private journalTxn: { label: string; writes: JournalWrite[] } | null = null;

    constructor(host: string, port: number) {
        this.host = host;
        this.port = port;
        this._rebuildOscInstance();
    }

    /** (Re)build the osc-js instance pointing at the current host/port. The plugin captures
     *  send target at construction, so changing host/port requires a fresh instance. */
    private _rebuildOscInstance(): void {
        const plugin = new (OSC as any).DatagramPlugin({
            open: { host: "0.0.0.0", port: 0 },
            send: { host: this.host, port: this.port },
        });
        this.osc = new (OSC as any)({ plugin });
        this.osc.on("*", (message: any) => {
            const address = message.address;
            const queue = this.responseCallbacks.get(address);
            if (queue && queue.length > 0 && message.args && message.args.length > 0) {
                const waiter = queue.shift()!;
                clearTimeout(waiter.timer);
                if (queue.length === 0) this.responseCallbacks.delete(address);
                waiter.resolve(message.args[0]);
                return;
            }
            // No pending read matched this address — it is an unsolicited push from the
            // /xremote stream (a change made at the console or by another client). Feed it
            // to the change log and invalidate the enclosing container's cache entry.
            this._handleUnsolicited(address, message.args);
        });
        this.osc.on("error", (err: Error) => {
            console.error("OSC Error:", err);
        });
    }

    async connect(): Promise<void> {
        this.osc.open({ host: "0.0.0.0", port: 0 });
        this.isConnected = true;
        console.error("OSC UDP Port ready");

        this.sendCommand("/xremote");
        this.heartbeatTimer = setInterval(() => this.sendCommand("/xremote"), 9000);

        this.rawSock = dgram.createSocket("udp4");
        this.rawSock.on("message", (buf) => this._handleRawReply(buf));
        this.rawSock.on("error", (e) => console.error("rawSock error:", e));
        await new Promise<void>((resolve) => {
            this.rawSock!.bind(0, "0.0.0.0", () => resolve());
        });
        console.error("Raw OSC socket bound on port", this.rawSock!.address().port);
    }

    /** Retarget the live client at a new mixer. rawSock stays bound (its dest is read at send time);
     *  osc-js plugin captures its send target at construction so we rebuild that instance. */
    async reconnect(host: string, port: number = 10023): Promise<void> {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        try {
            (this.osc as any)?.close?.();
        } catch {
            // osc-js close is best-effort
        }
        this.responseCallbacks.clear();
        // Negative cache is per-mixer — a slot absent on one console may exist on another.
        this.negativeCache.clear();
        // Read cache + change feed are per-mixer state; drop them on retarget.
        this._invalidateAll();
        this.changeBuffer.length = 0;
        // Journal is per-mixer state; its prev values reference the old console.
        this.journal.length = 0;
        this.journalTxn = null;
        this.isConnected = false;

        this.host = host;
        this.port = port;

        this._rebuildOscInstance();
        this.osc.open({ host: "0.0.0.0", port: 0 });
        this.isConnected = true;

        this.sendCommand("/xremote");
        this.heartbeatTimer = setInterval(() => this.sendCommand("/xremote"), 9000);

        console.error(`OSC client retargeted to ${this.host}:${this.port}`);
    }

    /** Current connection target plus live-mirror cache stats. Doesn't probe — pair with
     *  osc_identity to verify reachability. */
    getConnectionInfo(): { host: string; port: number; connected: boolean; cache: CacheStats } {
        return { host: this.host, port: this.port, connected: this.isConnected, cache: this.getCacheStats() };
    }

    // ========== Live state mirror: cache, change feed, invalidation ==========

    /** Snapshot of container-read cache counters for osc_get_connection. */
    getCacheStats(): CacheStats {
        return {
            entries: this.nodeCache.size,
            hits: this.cacheStats.hits,
            misses: this.cacheStats.misses,
            invalidations: this.cacheStats.invalidations,
            ttlMs: OSCClient.CACHE_TTL_MS,
            serving: this.cacheServe,
        };
    }

    /** Normalize an OSC path to a cache/lineage key: no leading or trailing slashes. */
    private _normPath(path: string): string {
        return path.replace(/^\/+/, "").replace(/\/+$/, "");
    }

    /** Whether a normalized node path may be cached. Excludes volatile / non-container
     *  reads (meters, xinfo, status, info) so live data is never served stale. */
    private _isCacheable(clean: string): boolean {
        return !/^(meters|xinfo|status|info)(\/|$)/.test(clean);
    }

    /** Invalidate every cache entry on the same path lineage as `path` — an ancestor
     *  container, the node itself, or a descendant. Used for both external leaf pushes
     *  (derive the enclosing container) and our own writes. Correctness-first: it
     *  over-invalidates along the lineage rather than risk serving a stale container. */
    private _invalidateLineage(path: string): void {
        const target = this._normPath(path);
        if (!target) return;
        for (const key of this.nodeCache.keys()) {
            if (key === target || target.startsWith(key + "/") || key.startsWith(target + "/")) {
                this.nodeCache.delete(key);
                this.cacheStats.invalidations++;
            }
        }
    }

    /** Drop the entire cache (scene recall / load rewrites the whole console). */
    private _invalidateAll(): void {
        this.cacheStats.invalidations += this.nodeCache.size;
        this.nodeCache.clear();
    }

    /** Append a change to the ring buffer, trimming to the cap. */
    private _recordChange(address: string, value: any, source: ChangeSource): void {
        this.changeBuffer.push({ ts: Date.now(), address, value, source });
        const overflow = this.changeBuffer.length - OSCClient.CHANGE_BUFFER_CAP;
        if (overflow > 0) this.changeBuffer.splice(0, overflow);
    }

    /** An OSC message that matched no pending read: an external parameter change delivered
     *  via the /xremote push stream. Log it as "console" and invalidate the container. */
    private _handleUnsolicited(address: string, args: any[] | undefined): void {
        if (!args || args.length === 0 || !this._isParameterPush(address)) return;
        this._recordChange(address, args[0], "console");
        // Pushed values are RAW normalized floats; the cache holds display units. Never
        // convert — invalidate the enclosing container so the next read fetches fresh.
        this._invalidateLineage(address);
    }

    /** Filter /xremote-stream noise: keep real parameter leaves, drop meter blobs, /node
     *  replies (no leading slash — already excluded), heartbeat echoes, and info replies. */
    private _isParameterPush(address: string): boolean {
        if (typeof address !== "string" || address[0] !== "/") return false;
        if (address === "/xremote") return false;
        if (/^\/meters(\/|$)/.test(address)) return false;
        if (/^\/(xinfo|status|info|node)(\/|$)/.test(address)) return false;
        return true;
    }

    /** Bookkeeping after one of our own OSC sends that carried a value (a write). Reads and
     *  the /xremote heartbeat send no args, so they never reach here. */
    private _afterOwnWrite(address: string, args: any[]): void {
        if (typeof address !== "string" || address[0] !== "/") return;
        this._recordChange(address, args[0], "server");
        if (/^\/-snap\/load(\/|$)/.test(address)) {
            // Scene recall rewrites the whole console — nuke the entire cache.
            this._invalidateAll();
        } else {
            this._invalidateLineage(address);
        }
    }

    /**
     * Deduped view of the change feed for the osc_changes tool. Groups by address so a
     * fader wiggle collapses to one row carrying the latest value, a hit count, and
     * first/last timestamps. Ordered newest-activity-last.
     *
     * @param sinceSeconds   only include changes within this window (default 300).
     * @param includeServer  include our own writes (source "server"); default false so
     *                       "what did the band change?" shows only console-side edits.
     */
    getChanges(opts?: { sinceSeconds?: number; includeServer?: boolean }): {
        sinceSeconds: number;
        includeServer: boolean;
        count: number;
        changes: ChangeRow[];
    } {
        const sinceSeconds = opts?.sinceSeconds ?? 300;
        const includeServer = opts?.includeServer ?? false;
        const now = Date.now();
        const cutoff = now - sinceSeconds * 1000;
        const grouped = new Map<string, { row: ChangeRow; firstTs: number; lastTs: number }>();
        for (const ev of this.changeBuffer) {
            if (ev.ts < cutoff) continue;
            if (!includeServer && ev.source === "server") continue;
            const g = grouped.get(ev.address);
            if (g) {
                g.row.value = ev.value;
                g.row.source = ev.source;
                g.row.count++;
                g.lastTs = ev.ts;
            } else {
                grouped.set(ev.address, {
                    row: { address: ev.address, value: ev.value, source: ev.source, count: 1, firstSecondsAgo: 0, lastSecondsAgo: 0 },
                    firstTs: ev.ts,
                    lastTs: ev.ts,
                });
            }
        }
        const changes = Array.from(grouped.values())
            .sort((a, b) => a.lastTs - b.lastTs)
            .map(({ row, firstTs, lastTs }) => {
                row.firstSecondsAgo = Math.round((now - firstTs) / 1000);
                row.lastSecondsAgo = Math.round((now - lastTs) / 1000);
                return row;
            });
        return { sinceSeconds, includeServer, count: changes.length, changes };
    }

    // ========== Undo journal ==========

    /** Open a journal transaction. Returns true iff THIS caller opened it (and must commit).
     *  If a txn is already open (nested writer), returns false and writes fold into the outer. */
    private _beginJournal(label: string): boolean {
        if (this.journalTxn) return false;
        this.journalTxn = { label, writes: [] };
        return true;
    }

    /** Contribute one captured field write to the open transaction (no-op if none is open). */
    private _journalWrite(w: JournalWrite): void {
        if (this.journalTxn) this.journalTxn.writes.push(w);
    }

    /** Commit the open transaction as a single entry (only the owner may commit). Returns the
     *  committed entry's index, or -1 if nothing was committed (no writes, or not the owner). */
    private _commitJournal(owns: boolean): number {
        if (!owns || !this.journalTxn) return -1;
        const txn = this.journalTxn;
        this.journalTxn = null;
        if (txn.writes.length === 0) return -1;
        const revertible = txn.writes.some((w) => w.prev !== null && w.prev !== undefined);
        this.journal.push({ ts: Date.now(), label: txn.label, writes: txn.writes, revertible });
        const overflow = this.journal.length - OSCClient.JOURNAL_CAP;
        if (overflow > 0) this.journal.splice(0, overflow);
        return this.journal.length - 1;
    }

    /** Push a standalone non-revertible marker entry (e.g. a scene recall boundary). */
    private _journalMarker(label: string): void {
        this.journal.push({ ts: Date.now(), label, writes: [], revertible: false });
        const overflow = this.journal.length - OSCClient.JOURNAL_CAP;
        if (overflow > 0) this.journal.splice(0, overflow);
    }

    /**
     * Resolve a relative {adjust} request against the current decoded value for a numeric field.
     * Reads the current value from `currentRaw` (the /node token), adds the delta, and clamps to
     * the field's schema range. A current value of -Infinity dB adjusts up from the range floor
     * (e.g. -90 dB for faders) rather than staying at -∞. Throws for non-numeric field types.
     */
    private _resolveAdjust(field: FieldDef, currentRaw: string | undefined, delta: number): number {
        if (!isNumericFieldType(field.type)) {
            throw new Error(
                `Cannot {adjust} field "${field.name}" (type ${field.type}) — relative adjust only supports numeric fields (int/float/db/freq/ms/pct).`,
            );
        }
        const decoded = currentRaw === undefined ? null : decodeField(field, currentRaw);
        let base: number;
        if (decoded === null || decoded === undefined || Number.isNaN(decoded)) {
            base = field.range ? field.range[0] : 0;
        } else if (decoded === -Infinity) {
            if (!field.range) {
                throw new Error(`Cannot {adjust} "${field.name}" from -∞ without a schema range to floor against.`);
            }
            base = field.range[0];
        } else {
            base = decoded;
        }
        let result = base + delta;
        if (field.range) {
            const [min, max] = field.range;
            if (result < min) result = min;
            if (result > max) result = max;
        }
        return result;
    }

    /** Compact list of recent journal entries, newest first, for the osc_journal tool. */
    listJournal(limit: number = 20): { count: number; entries: JournalRow[] } {
        const n = Math.max(0, Math.min(limit, this.journal.length));
        const entries: JournalRow[] = [];
        for (let i = this.journal.length - 1; i >= 0 && entries.length < n; i--) {
            const e = this.journal[i];
            entries.push({ ts: e.ts, label: e.label, writeCount: e.writes.length, revertible: e.revertible });
        }
        return { count: this.journal.length, entries };
    }

    /** Replay one journal entry's captured prev values in reverse write order. Assumes a journal
     *  transaction is already open (the undo entry) so the reverting writes fold into it. */
    private async _revertEntry(entry: JournalEntry): Promise<number> {
        let reverted = 0;
        for (let i = entry.writes.length - 1; i >= 0; i--) {
            const w = entry.writes[i];
            if (w.prev === null || w.prev === undefined) continue; // uncapturable — cannot revert
            switch (w.kind) {
                case "node":
                    await this.nodeSetField(w.path, { [w.field]: w.prev });
                    break;
                case "fx":
                    await this.fxSet(w.slot!, { [w.field]: w.prev });
                    break;
                case "routeIn":
                    await this.setUserRoutingIn(w.slot!, w.prev);
                    break;
                case "routeOut":
                    await this.setUserRoutingOut(w.slot!, w.prev);
                    break;
            }
            reverted++;
        }
        return reverted;
    }

    /**
     * Revert the last `steps` revertible journal entries, newest first, writing each entry's
     * captured prev values back in reverse order. Non-revertible entries (scene-recall markers,
     * or writes that couldn't capture prior state) are skipped and reported as warnings. Each
     * revert is itself journaled as a new entry labeled "undo: <original label>", so undoing an
     * undo performs a redo.
     */
    async undo(steps: number = 1): Promise<{
        requested: number;
        reverted: Array<{ label: string; writeCount: number; revertedWrites: number }>;
        warnings: string[];
    }> {
        const want = Math.max(1, Math.floor(steps));
        // Select targets by snapshotting BEFORE we append any undo entries, so the new entries
        // we create can't become targets of this same call (that would be a premature redo).
        const targets: JournalEntry[] = [];
        const warnings: string[] = [];
        for (let i = this.journal.length - 1; i >= 0 && targets.length < want; i--) {
            const e = this.journal[i];
            if (e.revertible) targets.push(e);
            else warnings.push(`skipped non-revertible entry "${e.label}"`);
        }
        if (targets.length === 0) {
            warnings.push("nothing revertible to undo");
            return { requested: want, reverted: [], warnings };
        }
        const reverted: Array<{ label: string; writeCount: number; revertedWrites: number }> = [];
        for (const entry of targets) {
            const owns = this._beginJournal(`undo: ${entry.label}`);
            let revertedWrites = 0;
            try {
                revertedWrites = await this._revertEntry(entry);
            } finally {
                this._commitJournal(owns);
            }
            reverted.push({ label: entry.label, writeCount: entry.writes.length, revertedWrites });
        }
        return { requested: want, reverted, warnings };
    }

    /**
     * Execute a sequence of read/write ops as ONE tool call. Ops run SEQUENTIALLY (so writes
     * then dependent reads behave predictably) but each op still rides the pooled rawQuery for
     * wire speed. All writes across the batch fold into a SINGLE undo journal entry.
     *
     * Op shapes:
     *   { get: { path, field? } }        — read a container or single field (decoded)
     *   { set: { path, fields } }        — absolute and/or {adjust} field writes (atomic per container)
     *   { fx:  { slot, params } }        — write FX-slot params (delegates to fxSet)
     *
     * @param stopOnError  default true: stop at the first failing op and mark the rest skipped.
     * Returns per-op results in order: { ok, result?, error?, skipped?, undoIndex? }.
     */
    async batch(
        ops: Array<any>,
        stopOnError: boolean = true,
    ): Promise<{ count: number; stopOnError: boolean; results: Array<any> }> {
        if (!Array.isArray(ops)) throw new Error("osc_batch: `ops` must be an array.");
        if (ops.length === 0) throw new Error("osc_batch: `ops` is empty — nothing to do.");
        if (ops.length > 50) throw new Error(`osc_batch: at most 50 ops per call (got ${ops.length}).`);

        const owns = this._beginJournal(`batch: ${ops.length} ops`);
        const results: Array<any> = [];
        const writeResultIdx: number[] = []; // result indices produced by write ops
        let stopped = false;
        try {
            for (let i = 0; i < ops.length; i++) {
                if (stopped) {
                    results.push({ ok: false, skipped: true, error: "skipped: a prior op failed (stopOnError)" });
                    continue;
                }
                const op = ops[i] ?? {};
                try {
                    if (op.get) {
                        const r = await this.nodeGetField(op.get.path, op.get.field);
                        results.push({ ok: true, result: r });
                    } else if (op.set) {
                        const r = await this.nodeSetField(op.set.path, op.set.fields);
                        results.push({ ok: true, result: { wrote: r.wrote, sent: r.sent } });
                        writeResultIdx.push(results.length - 1);
                    } else if (op.fx) {
                        const r = await this.fxSet(op.fx.slot, op.fx.params);
                        results.push({ ok: true, result: { wrote: r.wrote, type: r.type } });
                        writeResultIdx.push(results.length - 1);
                    } else {
                        throw new Error(`op ${i}: must contain exactly one of get / set / fx.`);
                    }
                } catch (e) {
                    results.push({ ok: false, error: e instanceof Error ? e.message : String(e) });
                    if (stopOnError) stopped = true;
                }
            }
        } finally {
            const undoIndex = this._commitJournal(owns);
            if (undoIndex >= 0) {
                for (const ri of writeResultIdx) results[ri].undoIndex = undoIndex;
            }
        }
        return { count: ops.length, stopOnError, results };
    }

    /**
     * Broadcast /xinfo on the local network and collect replies. Stateless — does not affect
     * the live client. Sends to 255.255.255.255 + each NIC's directed broadcast + 127.0.0.1
     * (covers emulator) and listens for `timeoutMs` ms before returning. Dedupes by reported IP.
     */
    static async discoverMixers(port: number = 10023, timeoutMs: number = 1500): Promise<DiscoveredMixer[]> {
        return new Promise((resolve, reject) => {
            const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
            const found = new Map<string, DiscoveredMixer>();
            let settled = false;
            const done = (err?: Error) => {
                if (settled) return;
                settled = true;
                try {
                    sock.close();
                } catch {
                    // ignore — socket may already be closed
                }
                if (err) reject(err);
                else resolve(Array.from(found.values()));
            };

            sock.on("error", (e) => done(e));
            sock.on("message", (buf, rinfo) => {
                const parsed = parseXinfoReply(buf);
                if (!parsed) return;
                const key = parsed.ip || rinfo.address;
                if (found.has(key)) return;
                found.set(key, { ...parsed, respondedFrom: rinfo.address });
            });

            sock.bind(0, "0.0.0.0", () => {
                try {
                    sock.setBroadcast(true);
                } catch (e) {
                    return done(e as Error);
                }
                const packet = buildOscBytes("/xinfo");
                const targets = new Set<string>(["255.255.255.255", "127.0.0.1"]);
                for (const ifaces of Object.values(os.networkInterfaces())) {
                    for (const iface of ifaces ?? []) {
                        if (iface.family !== "IPv4" || iface.internal) continue;
                        const bcast = computeBroadcast(iface.address, iface.netmask);
                        if (bcast) targets.add(bcast);
                    }
                }
                for (const target of targets) {
                    sock.send(packet, port, target, (err) => {
                        if (err) console.error(`xinfo broadcast to ${target}:${port} failed: ${err.message}`);
                    });
                }
                setTimeout(() => done(), timeoutMs);
            });
        });
    }

    private _handleRawReply(buf: Buffer): void {
        try {
            const readCString = (off: number) => {
                let end = off;
                while (end < buf.length && buf[end] !== 0) end++;
                const s = buf.subarray(off, end).toString("utf8");
                const padded = Math.ceil((end - off + 1) / 4) * 4;
                return { s, next: off + padded };
            };
            const a = readCString(0);
            const t = readCString(a.next);
            if (!t.s.startsWith(",")) return;
            let off = t.next;
            const args: any[] = [];
            let raw = "";
            for (let i = 1; i < t.s.length; i++) {
                const tag = t.s[i];
                if (tag === "s") {
                    const v = readCString(off);
                    args.push(v.s);
                    if (i === 1) raw = v.s;
                    off = v.next;
                } else if (tag === "i") {
                    args.push(buf.readInt32BE(off)); off += 4;
                } else if (tag === "f") {
                    args.push(buf.readFloatBE(off)); off += 4;
                } else if (tag === "T") { args.push(true); }
                else if (tag === "F") { args.push(false); }
                else { break; }
            }
            // Payload path token: X32 /node replies carry the queried path as the first
            // string arg (e.g. '/ch/01/config "Voc1" 1 MG 1'), which is how concurrent
            // /node reads — all addressed "node" — are matched back to their query.
            const payloadPath = raw ? parseNodeLine(raw).path : null;
            for (let i = 0; i < this.rawInflight.length; i++) {
                const entry = this.rawInflight[i];
                if (!entry.match(a.s, payloadPath)) continue;
                this.rawInflight.splice(i, 1);
                clearTimeout(entry.timer);
                entry.resolve({ address: a.s, args, raw });
                this._pumpRawQueue();
                return;
            }
            // No matching in-flight entry — stray, duplicate, or streaming packet; ignore.
        } catch {
            // ignore malformed packets
        }
    }

    /** Admit queued raw queries up to the pool cap. */
    private _pumpRawQueue(): void {
        while (this.rawInflight.length < OSCClient.RAW_POOL_CAP && this.rawQueue.length > 0) {
            const fire = this.rawQueue.shift()!;
            fire();
        }
    }

    private _buildOscMessage(address: string, ...args: any[]): Buffer {
        const m = args.length
            ? new (OSC as any).Message(address, ...args)
            : new (OSC as any).Message(address);
        return Buffer.from(m.pack());
    }

    /**
     * Send a raw OSC message and wait for a matching reply on this.rawSock.
     * Concurrent — up to RAW_POOL_CAP queries may be in flight at once; the rest queue.
     * Returns { address, args, raw }.
     *
     * @param match  predicate over (reply address, reply payload-path token). For /node
     *   reads this checks BOTH address === "node" AND the payload path matches the queried
     *   path, so concurrent /node reads (all addressed "node") never cross-match. For
     *   non-node reads (/xinfo, /status, ...) the payload-path arg is simply ignored.
     * @param timeoutMs per-attempt timeout (default 300ms). One automatic retry is made
     *   on timeout, so total worst case ≈ 2 × timeoutMs before rejection.
     */
    private rawQuery(
        sendAddress: string,
        sendArgs: any[],
        match: (address: string, payloadPath: string | null) => boolean,
        timeoutMs: number = 300,
    ): Promise<RawReply> {
        if (!this.rawSock) throw new Error("rawSock not initialized — call connect() first");
        return new Promise((resolve, reject) => {
            const buf = this._buildOscMessage(sendAddress, ...sendArgs);
            let attempt = 0;
            const admit = () => {
                if (this.rawInflight.length < OSCClient.RAW_POOL_CAP) fire();
                else this.rawQueue.push(fire);
            };
            const fire = () => {
                const entry = {
                    match,
                    resolve,
                    reject,
                    timer: setTimeout(() => onTimeout(entry), timeoutMs),
                };
                this.rawInflight.push(entry);
                this.rawSock!.send(buf, this.port, this.host);
            };
            const onTimeout = (entry: any) => {
                const idx = this.rawInflight.indexOf(entry);
                if (idx !== -1) this.rawInflight.splice(idx, 1);
                if (attempt < 1) {
                    // One automatic retry — on a LAN a real reply lands in single-digit ms,
                    // so a miss is almost always transient UDP loss, not an absent node.
                    attempt++;
                    admit();
                } else {
                    reject(new Error(`Timeout: ${sendAddress} ${JSON.stringify(sendArgs)}`));
                    this._pumpRawQueue();
                }
            };
            admit();
        });
    }

    // ========== X32node primitives ==========

    /**
     * Request an X32 "node" — a bundle of related parameters at a given path.
     * Valid paths are enumerated in the pmaillot spec (e.g. ch/NN/config, ch/NN/mix,
     * ch/NN/eq/B, ch/NN/mix/BB, headamp/NNN, bus/NN/mix, main/st/eq, etc.).
     * Not recursive: one call returns one node's values.
     *
     * Returns { path, raw, values } where `values` is the tokenized space-delimited list
     * (quoted strings unwrapped). Callers decode individual tokens using parseX32Db/
     * parseX32Freq/parseX32Bitmask/parseX32Bool as appropriate for the node's schema.
     */
    async nodeRead(path: string): Promise<{ path: string; raw: string; values: string[] }> {
        const clean = path.replace(/^\/+/, "");
        if (this._isNegativeCacheable(clean) && this.negativeCache.has(clean)) {
            throw new Error(`Node "${clean}" is negative-cached as absent (timed out after retry). Cleared on reconnect().`);
        }
        const cacheable = this._isCacheable(clean);
        if (cacheable && this.cacheServe) {
            const hit = this.nodeCache.get(clean);
            if (hit && Date.now() - hit.ts < OSCClient.CACHE_TTL_MS) {
                this.cacheStats.hits++;
                // Copy values so callers mutating the array can't corrupt the cache.
                return { path: hit.path, raw: hit.raw, values: [...hit.values] };
            }
        }
        try {
            // Match on address "node" AND the reply payload's path token, so concurrent
            // /node reads (all replying on "node") are disambiguated by their path.
            const reply = await this.rawQuery(
                "/node",
                [clean],
                (address, payloadPath) =>
                    address === "node" &&
                    payloadPath !== null &&
                    payloadPath.replace(/^\/+/, "") === clean,
            );
            const text = String(reply.args[0] ?? "");
            const parsed = parseNodeLine(text);
            if (cacheable) {
                this.cacheStats.misses++;
                this.nodeCache.set(clean, { path: parsed.path, raw: text, values: parsed.values, ts: Date.now() });
            }
            return { path: parsed.path, raw: text, values: [...parsed.values] };
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (this._isNegativeCacheable(clean) && /^Timeout:/.test(msg)) {
                this.negativeCache.add(clean);
            }
            throw e;
        }
    }

    /**
     * Whether a node path is eligible for negative caching. ONLY absent-by-design
     * patterns qualify: unassigned headamp slots (headamp/NNN) and the auxin automix
     * container (auxin/NN/automix) that times out on firmware 4.13. Every other path
     * is excluded so a transient UDP drop can never poison a genuinely present node.
     */
    private _isNegativeCacheable(clean: string): boolean {
        return /^headamp\/\d+$/.test(clean) || /^auxin\/\d+\/automix$/.test(clean);
    }

    /**
     * Write multiple fields of an X32 node atomically using the `/` (X32node) command.
     * The X32 parses the text, applies all listed values in one pass, and echoes the
     * command back for flow control.
     *
     * Values are provided as a positional array matching the node's field order from the
     * spec. The spec allows PREFIX-PARTIAL writes — you can send fewer values than the
     * node has, but the ones you send must be in order from the first field.
     *
     * Strings containing whitespace or empty strings are automatically quoted.
     * Booleans become ON/OFF. -Infinity becomes "-oo".
     *
     * Fires-and-forgets: the mixer will echo the command on address "/" but we do not
     * wait for it. Use nodeRead to verify after.
     */
    async nodeWrite(path: string, values: any[]): Promise<void> {
        if (!this.rawSock) throw new Error("rawSock not initialized");
        const clean = path.replace(/^\/+/, "");
        const encoded = values.map(encodeWriteValue).join(" ");
        const arg = `${clean} ${encoded}`;
        const buf = this._buildOscMessage("/", arg);
        this.rawSock.send(buf, this.port, this.host);
        // Our own container write — invalidate the whole subtree and log it as "server".
        this._invalidateLineage(clean);
        this._recordChange("/" + clean, encoded, "server");
    }

    // ========== Schema-driven node access (Phase D) ==========

    /**
     * Read a single field of a node by name, decoded per the node-schema entry.
     * Pass `field` undefined to get the whole node as a {name: value, ...} dict.
     * Throws if no schema entry matches the path or if the field name is unknown.
     */
    async nodeGetField(path: string, field?: string): Promise<any> {
        const schema = findSchema(path);
        if (!schema) {
            throw new Error(`No schema entry for path "${path}". Use osc_list_nodes to enumerate.`);
        }
        const node = await this.nodeRead(path);
        if (field === undefined || field === null || field === "") {
            const out: Record<string, any> = {};
            for (let i = 0; i < schema.fields.length; i++) {
                const f = schema.fields[i];
                const raw = node.values[i];
                out[f.name] = raw === undefined ? null : decodeField(f, raw);
            }
            return out;
        }
        const idx = schema.fields.findIndex((f) => f.name === field);
        if (idx === -1) {
            const valid = schema.fields.map((f) => f.name).join(", ");
            throw new Error(`Field "${field}" not in schema for "${path}". Valid: ${valid}`);
        }
        const raw = node.values[idx];
        if (raw === undefined) return null;
        return decodeField(schema.fields[idx], raw);
    }

    /**
     * Atomically write multiple named fields of a node.
     * Reads current values to fill in untouched positions, splices in the named
     * overrides preserving order, encodes per type, and sends one /(X32node) write.
     * Returns the list of fields that were written and the encoded values.
     *
     * A field value may be an absolute (e.g. `-6`, `"RD"`, `false`) OR a relative
     * `{adjust: N}` request: the current decoded value is read (cache-accelerated), the
     * delta added, and the result clamped to the field's schema range. Adjust is valid
     * only for numeric field types (int/float/db/freq/ms/pct); it throws for enums/
     * strings/bools/bitmasks. A -∞ dB current adjusts up from the schema's range floor.
     *
     * Every write is captured in the undo journal (grouped into the caller's transaction
     * if one is open, else its own "node_set <path>" entry).
     */
    async nodeSetField(
        path: string,
        fields: Record<string, any>,
    ): Promise<{ wrote: string[]; sent: any[] }> {
        const schema = findSchema(path);
        if (!schema) {
            throw new Error(`No schema entry for path "${path}". Use osc_list_nodes to enumerate.`);
        }
        if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
            throw new Error(`fields must be an object {fieldName: value, ...} — got ${typeof fields}`);
        }
        const fieldNames = Object.keys(fields);
        if (fieldNames.length === 0) return { wrote: [], sent: [] };
        const valid = schema.fields.map((f) => f.name);
        const unknown = fieldNames.filter((k) => !valid.includes(k));
        if (unknown.length > 0) {
            throw new Error(`Unknown fields for "${path}": ${unknown.join(", ")}. Valid: ${valid.join(", ")}`);
        }

        // We need positional values up through the highest-index field touched.
        // Untouched leading/middle slots are preserved by reading current state and
        // re-encoding through the schema (so e.g. db tokens like "-oo" round-trip).
        const current = await this.nodeRead(path);
        const clean = this._normPath(path);

        // Resolve any {adjust} requests to absolute decoded values against current state.
        // Build a parallel map of the DECODED value we are writing for each field, so the
        // journal records prev/next in the same domain nodeGetField returns.
        const resolved: Record<string, any> = {};
        for (const name of fieldNames) {
            const f = schema.fields[schema.fields.findIndex((x) => x.name === name)];
            const raw = fields[name];
            resolved[name] = isAdjustRequest(raw)
                ? this._resolveAdjust(f, current.values[schema.fields.indexOf(f)], raw.adjust)
                : raw;
        }

        let lastIdx = -1;
        for (let i = 0; i < schema.fields.length; i++) {
            if (schema.fields[i].name in fields) lastIdx = i;
        }
        const sent: any[] = [];
        for (let i = 0; i <= lastIdx; i++) {
            const f = schema.fields[i];
            if (f.name in fields) {
                sent.push(encodeFieldValue(f, resolved[f.name]));
            } else {
                const raw = current.values[i];
                // For untouched fields, decode then re-encode so the JS value goes
                // through the same path (no double-quoting, -oo handled, etc.).
                if (raw === undefined) {
                    // /node didn't return this slot — bail rather than guessing.
                    throw new Error(`Cannot fill untouched field "${f.name}" of "${path}": current /node response had no value at position ${i}`);
                }
                sent.push(encodeFieldValue(f, decodeField(f, raw)));
            }
        }

        // Capture prior state BEFORE writing so the journal can revert us.
        const owns = this._beginJournal(`node_set /${clean}`);
        for (const name of fieldNames) {
            const idx = schema.fields.findIndex((x) => x.name === name);
            const rawPrev = current.values[idx];
            const prev = rawPrev === undefined ? null : decodeField(schema.fields[idx], rawPrev);
            this._journalWrite({ kind: "node", path: clean, field: name, prev, next: resolved[name] });
        }
        try {
            await this.nodeWrite(path, sent);
        } finally {
            this._commitJournal(owns);
        }
        return { wrote: fieldNames, sent };
    }

    /** Return the schema, optionally filtered by glob pattern (e.g. "ch/*&zwj;/gate", "config/*"). */
    listNodeSchemas(filter?: string): NodeSchemaEntry[] {
        return listSchemasImpl(filter);
    }

    /** Total number of canonical node entries in the schema. */
    nodeSchemaCount(): number {
        return NODE_SCHEMA.length;
    }

    // ========== FX algorithm parameter surface (Phase D′) ==========

    /**
     * Read an FX slot's algorithm + decoded parameters.
     *
     * Steps:
     *   1. Read /fx/N/type (int) — gets the current algorithm code.
     *   2. Look up the algorithm in FX_ALGORITHM_SCHEMA → ordered param names + types.
     *   3. /node fx/N/par returns 64 positional values (most are inactive padding
     *      for algorithms that use < 64 params). Decode the active prefix per the
     *      algorithm's schema. Trailing inactive slots are dropped.
     *
     * Returns:
     *   {
     *     slot: 1..8,
     *     typeCode: int,
     *     type: "HALL",            // null if code is unknown
     *     description: "Hall reverb",
     *     params: { predly: 26, decay: 2.99, ... },  // named, decoded
     *     extraParams: ["0","0",...] // anything past the algorithm's named slots, raw
     *   }
     */
    async fxGet(slot: number): Promise<{
        slot: number;
        typeCode: number;
        type: string | null;
        description: string | null;
        params: Record<string, any>;
        extraParams: string[];
    }> {
        if (slot < 1 || slot > 8) throw new Error(`FX slot out of range: ${slot} (valid: 1..8)`);

        // /node fx/N/type returns the SYMBOLIC name (e.g. "HALL", "DES2", "GEQ")
        // regardless of slot class, sidestepping the FX1..4 vs FX5..8 dual integer
        // encoding. The leaf /fx/N/type returns slot-class-specific ints.
        const typeNode = await this.nodeRead(`fx/${slot}/type`);
        const symbolic = typeNode.values[0];
        const algo = symbolic ? findFxByName(symbolic) : null;

        // Read leaf int too — useful for callers that want the raw code.
        let leafCode = -1;
        try {
            const leaf = await this.sendAndReceive(`/fx/${slot}/type`);
            leafCode = typeof leaf === "number" ? leaf : Number(leaf);
        } catch {
            // leaf read failed; fall back to schema-derived code per slot class
            if (algo) {
                try { leafCode = fxCodeForSlot(algo, slot); } catch { leafCode = -1; }
            }
        }

        const node = await this.nodeRead(`fx/${slot}/par`);
        const params: Record<string, any> = {};
        const extra: string[] = [];
        if (algo) {
            for (let i = 0; i < algo.params.length; i++) {
                const f = algo.params[i];
                const raw = node.values[i];
                params[f.name] = raw === undefined ? null : decodeField(f, raw);
            }
            for (let i = algo.params.length; i < node.values.length; i++) {
                extra.push(node.values[i]);
            }
        } else {
            // Unknown type — surface raw values so callers aren't blind.
            for (let i = 0; i < node.values.length; i++) {
                params[`par${i + 1}`] = node.values[i];
            }
        }
        return {
            slot,
            typeCode: leafCode,
            type: algo?.name ?? symbolic ?? null,
            description: algo?.description ?? null,
            params,
            extraParams: extra,
        };
    }

    /**
     * Write one or more named parameters to an FX slot. Reads the slot's current
     * algorithm to resolve param names → positional indices via the schema.
     *
     * `params` is an object mapping parameter names (per the slot's current
     * algorithm) to values. Values are coerced through encodeFieldValue per the
     * field's type — bools accept true/false/ON/OFF, db accepts numbers, enum
     * accepts symbol or numeric index.
     *
     * Implementation note: the per-param leaf `/fx/N/par/PP` expects a
     * NORMALIZED 0..1 float, while /node fx/N/par returns native-unit text
     * (e.g. "26", "3k48", "ON"). To preserve native-unit round-trip, this
     * method writes via the /node container address (`fx/N/par`) using
     * X32node prefix-partial writes — same machinery as nodeSetField. Reads
     * current /node values, splices in the named overrides preserving order,
     * encodes all positions through the schema, and sends ONE atomic write.
     *
     * Returns the list of params written and the encoded payload.
     */
    async fxSet(slot: number, params: Record<string, any>): Promise<{
        wrote: string[];
        sent: any[];
        type: string;
    }> {
        if (slot < 1 || slot > 8) throw new Error(`FX slot out of range: ${slot} (valid: 1..8)`);
        if (!params || typeof params !== "object" || Array.isArray(params)) {
            throw new Error(`params must be an object {paramName: value, ...} — got ${typeof params}`);
        }
        const paramNames = Object.keys(params);
        if (paramNames.length === 0) return { wrote: [], sent: [], type: "<no-write>" };

        // Read symbolic name via /node (slot-class-independent), then look up by name.
        const typeNode = await this.nodeRead(`fx/${slot}/type`);
        const symbolic = typeNode.values[0];
        const algo = symbolic ? findFxByName(symbolic) : null;
        if (!algo) {
            throw new Error(`FX slot ${slot} reported type "${symbolic}" — no schema match. Use osc_fx_list_algorithms to enumerate.`);
        }

        // Validate all param names up front so a typo can't half-apply.
        const validNames = algo.params.map((f) => f.name);
        const unknown = paramNames.filter((n) => !validNames.includes(n));
        if (unknown.length > 0) {
            throw new Error(`Unknown FX params for ${algo.name}: ${unknown.join(", ")}. Valid: ${validNames.join(", ")}`);
        }

        // Read current /node fx/N/par to preserve untouched fields up to the
        // last index we're writing. The container has 64 fields; we only need
        // values up through the highest-index name we're touching.
        const current = await this.nodeRead(`fx/${slot}/par`);
        let lastIdx = -1;
        for (let i = 0; i < algo.params.length; i++) {
            if (algo.params[i].name in params) lastIdx = i;
        }
        const sent: any[] = [];
        for (let i = 0; i <= lastIdx; i++) {
            const f = algo.params[i];
            if (f.name in params) {
                sent.push(encodeFieldValue(f, params[f.name]));
            } else {
                const raw = current.values[i];
                if (raw === undefined) {
                    throw new Error(`Cannot fill untouched FX param "${f.name}" at index ${i} of slot ${slot}: /node response had no value at position ${i}`);
                }
                sent.push(encodeFieldValue(f, decodeField(f, raw)));
            }
        }

        // Journal prior param values BEFORE writing (grouped into the caller's txn if open,
        // e.g. an insert-EQ set or a batch, else its own "fx_set N (<algo>)" entry).
        const owns = this._beginJournal(`fx_set ${slot} (${algo.name})`);
        for (const name of paramNames) {
            const idx = algo.params.findIndex((p) => p.name === name);
            const rawPrev = current.values[idx];
            const prev = rawPrev === undefined ? null : decodeField(algo.params[idx], rawPrev);
            this._journalWrite({ kind: "fx", path: `fx/${slot}/par`, field: name, slot, prev, next: params[name] });
        }
        try {
            await this.nodeWrite(`fx/${slot}/par`, sent);
        } finally {
            this._commitJournal(owns);
        }
        return { wrote: paramNames, sent, type: algo.name };
    }

    /**
     * Set an FX slot's algorithm by symbolic name ("HALL") or integer code (0).
     * Writes /fx/N/type. The X32 may reset parameters to algorithm defaults on
     * type change; callers should re-fetch with fxGet() if they need the new
     * param state.
     */
    async fxSetType(slot: number, typeRef: string | number): Promise<{
        slot: number;
        typeCode: number;
        type: string;
        previousType: string | null;
        previousTypeCode: number;
    }> {
        if (slot < 1 || slot > 8) throw new Error(`FX slot out of range: ${slot} (valid: 1..8)`);

        // resolveFxType validates slot-class compatibility (e.g. rejects HALL on slot 5).
        const algo = resolveFxType(typeRef, slot);
        const slotCode = fxCodeForSlot(algo, slot);

        // Capture previous state via /node-symbolic (slot-class-independent).
        let previousType: string | null = null;
        let previousTypeCode = -1;
        try {
            const prevNode = await this.nodeRead(`fx/${slot}/type`);
            previousType = prevNode.values[0] ?? null;
        } catch {}
        try {
            const prevLeaf = await this.sendAndReceive(`/fx/${slot}/type`);
            previousTypeCode = typeof prevLeaf === "number" ? prevLeaf : Number(prevLeaf);
        } catch {}

        // Write the slot-class-correct integer to the leaf. (The X32 also accepts
        // /node-style writes with the symbolic name, but the leaf int is the
        // documented path for FX type writes.)
        this.sendCommand(`/fx/${slot}/type`, [slotCode]);
        // Changing the algorithm resets its parameters — invalidate the whole slot subtree
        // (the leaf write above only clears the /fx/N/type lineage, not fx/N/par).
        this._invalidateLineage(`fx/${slot}`);
        return {
            slot,
            typeCode: slotCode,
            type: algo.name,
            previousType,
            previousTypeCode,
        };
    }

    /** Return the FX algorithm schema, optionally filtered by name/description substring. */
    listFxAlgorithms(filter?: string): FxAlgorithmEntry[] {
        return listFxAlgorithmsImpl(filter);
    }

    /** Total number of FX algorithms in the schema. */
    fxAlgorithmCount(): number {
        return FX_ALGORITHM_COUNT;
    }

    // ========== Meter snapshot (Phase E) ==========

    /**
     * One-shot meter snapshot. Sends /meters with a bank tag, captures the FIRST
     * binary blob reply from the mixer, and decodes it into a named-channel dict
     * of dBfs values (or dB gain reduction for GR fields).
     *
     * The X32 actually treats /meters as a subscription — once requested, it
     * streams updates every ~50ms for 10 seconds. We use a temporary dgram socket
     * scoped to this snapshot so the streaming doesn't pollute the main rawSock
     * queue, and close it after the first reply.
     *
     * Implemented banks:
     *   - 0: per-channel post-headamp + auxes + FX returns + buses + matrices (70 floats)
     *   - 1: post-fader levels + gate GR + dyn GR (96 floats)
     *   - 2: bus + matrix + main + dyn GR for buses/matrices/mains (49 floats)
     *   - 3: aux sends + aux returns + FX returns (22 floats)
     *
     * Filters out floats below `thresholdDb` (default -90 dBfs) — most "silent"
     * channels noise-floor at ~-100 dBfs and pollute LLM context. Pass
     * thresholdDb = -Infinity to keep everything.
     */
    async meterSnapshot(bank: number = 0, thresholdDb: number = -90): Promise<{
        bank: number;
        description: string;
        elapsedMs: number;
        floatCount: number;
        levels?: Record<string, number>;
        gateGainReduction?: Record<string, number>;
        dynGainReduction?: Record<string, number>;
    }> {
        if (![0, 1, 2, 3].includes(bank)) {
            throw new Error(`Meter bank ${bank} not implemented (valid: 0, 1, 2, 3). Banks 4..15 are RTA/specialty/console-VU and intentionally skipped.`);
        }
        const t0 = Date.now();
        const floats = await this._readMeterBlob(bank, 1500);
        const elapsedMs = Date.now() - t0;
        return decodeMeterBlob(bank, floats, thresholdDb, elapsedMs);
    }

    /**
     * Send /meters with bank tag, listen on a temporary dgram socket for the first
     * /meters/N blob reply, return the decoded float array.
     */
    private _readMeterBlob(bank: number, timeoutMs: number): Promise<number[]> {
        return new Promise((resolve, reject) => {
            const sock = dgram.createSocket("udp4");
            let settled = false;
            const cleanup = () => {
                try { sock.close(); } catch {}
            };
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(`/meters/${bank} timeout after ${timeoutMs}ms — no blob reply`));
            }, timeoutMs);

            sock.on("message", (buf: Buffer) => {
                if (settled) return;
                try {
                    const a = readCStringFrom(buf, 0);
                    const t = readCStringFrom(buf, a.next);
                    if (a.s !== `/meters/${bank}` || t.s !== ",b") return;
                    const blobLen = buf.readInt32BE(t.next);
                    const dataStart = t.next + 4;
                    const numFloats = buf.readInt32LE(dataStart);
                    if (numFloats < 0 || numFloats > 4096) {
                        throw new Error(`Implausible numFloats ${numFloats} from /meters/${bank} (blobLen ${blobLen})`);
                    }
                    const out: number[] = [];
                    for (let i = 0; i < numFloats; i++) {
                        out.push(buf.readFloatLE(dataStart + 4 + i * 4));
                    }
                    settled = true;
                    clearTimeout(timer);
                    cleanup();
                    resolve(out);
                } catch (e) {
                    settled = true;
                    clearTimeout(timer);
                    cleanup();
                    reject(e);
                }
            });
            sock.on("error", (e) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                cleanup();
                reject(e);
            });

            sock.bind(0, "0.0.0.0", () => {
                try {
                    // OSC msg: /meters with args (string banktag) — single string is enough.
                    const msg = buildMetersRequest(bank);
                    sock.send(msg, this.port, this.host);
                } catch (e) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    cleanup();
                    reject(e);
                }
            });
        });
    }

    // ========== Insert-effect surface (Phase D″) ==========

    /**
     * Discover all FX slots whose currently-loaded algorithm is a 31-band graphic EQ
     * (GEQ, GEQ2, TEQ, or TEQ2). Slot-agnostic: the user can configure any of the
     * 8 racks to host any compatible algorithm; this scan reads /fx/N/type for each
     * and filters by name. Use as a probe before insert-EQ operations.
     */
    async findGeqSlots(): Promise<Array<{ slot: number; type: string }>> {
        const out: Array<{ slot: number; type: string }> = [];
        for (let n = 1; n <= 8; n++) {
            try {
                const node = await this.nodeRead(`fx/${n}/type`);
                const sym = node.values[0];
                if (sym && GEQ_ALGORITHM_NAMES.has(sym)) {
                    out.push({ slot: n, type: sym });
                }
            } catch {
                // skip — slot didn't respond
            }
        }
        return out;
    }

    /**
     * Resolve a high-level insert target (e.g. "bus 3", "main", "main mono",
     * "mtx 1", "ch 5") to the underlying /node container path.
     * Throws on ambiguous or out-of-range labels.
     */
    private resolveInsertTarget(target: string): { path: string; label: string } {
        const t = target.trim().toUpperCase();
        if (t === "MAIN" || t === "MAIN LR" || t === "MAIN ST" || t === "MAIN STEREO") {
            return { path: "main/st/insert", label: "Main LR" };
        }
        if (t === "MAIN M" || t === "MAIN MONO" || t === "MONO") {
            return { path: "main/m/insert", label: "Main Mono" };
        }
        const busM = t.match(/^BUS\s*(\d+)$/);
        if (busM) {
            const n = parseInt(busM[1], 10);
            if (n < 1 || n > 16) throw new Error(`Bus number out of range: ${n} (valid: 1..16)`);
            return { path: `bus/${String(n).padStart(2, "0")}/insert`, label: `Bus ${n}` };
        }
        const mtxM = t.match(/^(MTX|MATRIX)\s*(\d+)$/);
        if (mtxM) {
            const n = parseInt(mtxM[2], 10);
            if (n < 1 || n > 6) throw new Error(`Matrix number out of range: ${n} (valid: 1..6)`);
            return { path: `mtx/${String(n).padStart(2, "0")}/insert`, label: `Matrix ${n}` };
        }
        const chM = t.match(/^(CH|CHANNEL)\s*(\d+)$/);
        if (chM) {
            const n = parseInt(chM[2], 10);
            if (n < 1 || n > 32) throw new Error(`Channel number out of range: ${n} (valid: 1..32)`);
            return { path: `ch/${String(n).padStart(2, "0")}/insert`, label: `Ch ${n}` };
        }
        throw new Error(`Cannot parse insert target: "${target}". Expected e.g. "bus 3", "main", "main mono", "mtx 1", "ch 5".`);
    }

    /**
     * Parse an `insert.sel` enum value (e.g. "FX5L", "FX6", "FX7R", "OFF") to
     * the integer FX slot it points to (1..8), or null if disconnected.
     */
    private parseInsertSel(sel: string): { slot: number; side: "L" | "R" | null } | null {
        if (!sel || sel === "OFF") return null;
        const m = sel.match(/^FX([1-8])([LR])?$/);
        if (!m) return null;
        return { slot: parseInt(m[1], 10), side: (m[2] as "L" | "R") ?? null };
    }

    /**
     * Read the insert state of a target (bus / main / mtx / ch). Returns the
     * insert.on / pos / sel along with the resolved FX slot (if any) and
     * whether that slot currently hosts a GEQ-class algorithm.
     */
    async getInsertState(target: string): Promise<{
        target: string;
        path: string;
        on: boolean;
        pos: string;
        sel: string;
        fxSlot: number | null;
        fxSide: "L" | "R" | null;
        fxType: string | null;
        isGeqClass: boolean;
    }> {
        const { path, label } = this.resolveInsertTarget(target);
        const node = await this.nodeRead(path);
        const on = node.values[0] === "ON";
        const pos = node.values[1] ?? "PRE";
        const sel = node.values[2] ?? "OFF";
        const parsed = this.parseInsertSel(sel);
        let fxType: string | null = null;
        if (parsed) {
            try {
                const t = await this.nodeRead(`fx/${parsed.slot}/type`);
                fxType = t.values[0] ?? null;
            } catch {}
        }
        return {
            target: label,
            path,
            on,
            pos,
            sel,
            fxSlot: parsed?.slot ?? null,
            fxSide: parsed?.side ?? null,
            fxType,
            isGeqClass: fxType !== null && GEQ_ALGORITHM_NAMES.has(fxType),
        };
    }

    /**
     * Read the 31-band graphic EQ inserted on a target.
     *
     * Steps:
     *   1. Resolve target → /node insert.sel → FX slot (1..8).
     *   2. Verify the discovered slot's algorithm is GEQ/GEQ2/TEQ/TEQ2.
     *   3. Read /node fx/<slot>/par and decode the 31 bands + master per the algo's schema.
     *
     * For dual-mono GEQ2/TEQ2, returns separate `channelA` / `channelB` bands.
     * For stereo GEQ/TEQ, both channels share the same gains — returned as a single `bands` map.
     *
     * Slot-agnostic: never assumes which slot has the GEQ. If the target's
     * insert.sel doesn't point at a GEQ-class slot, returns the discovered
     * insert state with `isGeqClass: false` and no bands.
     */
    async insertEqGet(target: string): Promise<{
        target: string;
        path: string;
        slot: number | null;
        type: string | null;
        isGeqClass: boolean;
        on: boolean;
        pos: string;
        bands?: Record<string, number>;
        master?: number;
        channelA?: { bands: Record<string, number>; master: number };
        channelB?: { bands: Record<string, number>; master: number };
        message?: string;
    }> {
        const insertState = await this.getInsertState(target);
        if (!insertState.fxSlot) {
            return {
                target: insertState.target,
                path: insertState.path,
                slot: null,
                type: null,
                isGeqClass: false,
                on: insertState.on,
                pos: insertState.pos,
                message: `${insertState.target} has no FX insert routed (sel=${insertState.sel})`,
            };
        }
        if (!insertState.isGeqClass) {
            return {
                target: insertState.target,
                path: insertState.path,
                slot: insertState.fxSlot,
                type: insertState.fxType,
                isGeqClass: false,
                on: insertState.on,
                pos: insertState.pos,
                message: `${insertState.target} insert points at FX${insertState.fxSlot} which hosts ${insertState.fxType}, not a GEQ-class algorithm. Load GEQ/GEQ2/TEQ/TEQ2 into FX${insertState.fxSlot} via osc_fx_set_type to use this tool.`,
            };
        }
        const fx = await this.fxGet(insertState.fxSlot);
        const params = fx.params;
        const isDual = fx.type === "GEQ2" || fx.type === "TEQ2";
        const result: any = {
            target: insertState.target,
            path: insertState.path,
            slot: insertState.fxSlot,
            type: fx.type,
            isGeqClass: true,
            on: insertState.on,
            pos: insertState.pos,
        };
        if (isDual) {
            result.channelA = extractGeqSide(params, "A");
            result.channelB = extractGeqSide(params, "B");
        } else {
            result.bands = extractGeqSide(params, "").bands;
            result.master = extractGeqSide(params, "").master;
        }
        return result;
    }

    /**
     * Set bands on the GEQ inserted at a target. Accepts either:
     *   { bands: { "1kHz": +3, "20Hz": -2 }, master: -1 }            (stereo / TEQ / GEQ)
     *   { channelA: { bands: {...}, master: 0 }, channelB: { ... } } (dual / GEQ2 / TEQ2)
     *
     * Frequency keys can be ISO labels: "20Hz", "31.5Hz", "1k", "1kHz", "20kHz",
     * "1.25k", etc. — all map to the same canonical band. Partial writes preserve
     * untouched bands.
     */
    async insertEqSet(target: string, opts: {
        bands?: Record<string, number>;
        master?: number;
        channelA?: { bands?: Record<string, number>; master?: number };
        channelB?: { bands?: Record<string, number>; master?: number };
    }): Promise<{ target: string; slot: number; type: string; wrote: string[] }> {
        const insertState = await this.getInsertState(target);
        if (!insertState.fxSlot) {
            throw new Error(`${insertState.target} has no FX insert routed (sel=${insertState.sel}).`);
        }
        if (!insertState.isGeqClass) {
            throw new Error(`${insertState.target} insert points at FX${insertState.fxSlot} which hosts ${insertState.fxType}, not a GEQ-class algorithm.`);
        }
        const slot = insertState.fxSlot;
        const type = insertState.fxType!;
        const isDual = type === "GEQ2" || type === "TEQ2";

        const fxParams: Record<string, any> = {};
        if (isDual) {
            if (opts.bands || opts.master !== undefined) {
                throw new Error(`${type} is dual-mono — pass channelA / channelB instead of bands / master.`);
            }
            if (opts.channelA) {
                Object.assign(fxParams, mapGeqBands(opts.channelA.bands, "A"));
                if (opts.channelA.master !== undefined) fxParams[`masterA`] = opts.channelA.master;
            }
            if (opts.channelB) {
                Object.assign(fxParams, mapGeqBands(opts.channelB.bands, "B"));
                if (opts.channelB.master !== undefined) fxParams[`masterB`] = opts.channelB.master;
            }
        } else {
            if (opts.channelA || opts.channelB) {
                throw new Error(`${type} is stereo — pass bands / master directly, not channelA / channelB.`);
            }
            Object.assign(fxParams, mapGeqBands(opts.bands, ""));
            if (opts.master !== undefined) fxParams[`master`] = opts.master;
        }
        if (Object.keys(fxParams).length === 0) {
            throw new Error("No bands or master specified — nothing to write.");
        }
        // Own the journal txn so the underlying fxSet folds into a single, nicely-labeled entry.
        const owns = this._beginJournal(`insert_eq_set ${insertState.target}`);
        let result;
        try {
            result = await this.fxSet(slot, fxParams);
        } finally {
            this._commitJournal(owns);
        }
        return { target: insertState.target, slot, type, wrote: result.wrote };
    }

    /**
     * Reset all 31 bands and master(s) on the GEQ inserted at a target to 0 dB.
     */
    async insertEqReset(target: string): Promise<{ target: string; slot: number; type: string; wrote: string[] }> {
        const insertState = await this.getInsertState(target);
        if (!insertState.fxSlot) {
            throw new Error(`${insertState.target} has no FX insert routed (sel=${insertState.sel}).`);
        }
        if (!insertState.isGeqClass) {
            throw new Error(`${insertState.target} insert points at FX${insertState.fxSlot} which hosts ${insertState.fxType}, not a GEQ-class algorithm.`);
        }
        const slot = insertState.fxSlot;
        const type = insertState.fxType!;
        const isDual = type === "GEQ2" || type === "TEQ2";
        const fxParams: Record<string, any> = {};
        if (isDual) {
            for (const f of GEQ_BAND_FIELD_SUFFIXES) {
                fxParams[`bandA_${f}`] = 0;
                fxParams[`bandB_${f}`] = 0;
            }
            fxParams.masterA = 0;
            fxParams.masterB = 0;
        } else {
            for (const f of GEQ_BAND_FIELD_SUFFIXES) {
                fxParams[`band_${f}`] = 0;
            }
            fxParams.master = 0;
        }
        const result = await this.fxSet(slot, fxParams);
        return { target: insertState.target, slot, type, wrote: result.wrote };
    }

    // ========== Composite signal-flow diagnostics (Phase B) ==========

    /**
     * Walk the signal path for a single channel: physical input → headamp → channel
     * strip → DCA/mute group memberships → bus sends → main/mono → physical outputs
     * tapped from this channel. Defensive: a partial result is preferable to a throw.
     */
    async traceSignal(channel: number): Promise<any> {
        if (channel < 1 || channel > 32) throw new Error(`channel out of range: ${channel}`);
        const nn = String(channel).padStart(2, "0");
        const channelTapSrc = 25 + channel; // outputs.src code for "Ch NN" tap

        const tryNode = async (path: string) => {
            try { return await this.nodeRead(path); } catch { return null; }
        };

        // ----- Strip + headamp -----
        const config = await tryNode(`ch/${nn}/config`);
        const mix = await tryNode(`ch/${nn}/mix`);
        const grp = await tryNode(`ch/${nn}/grp`);
        const preamp = await tryNode(`ch/${nn}/preamp`);

        const sourceField = config && config.values[3] !== undefined ? parseInt(config.values[3], 10) : null;
        let headamp: any = null;
        if (sourceField !== null && Number.isFinite(sourceField) && sourceField >= 0 && sourceField < 64) {
            const ha = await tryNode(`headamp/${String(sourceField).padStart(3, "0")}`);
            if (ha) {
                headamp = {
                    slot: `headamp/${String(sourceField).padStart(3, "0")}`,
                    gain: ha.values[0] !== undefined ? parseX32Db(ha.values[0]) : null,
                    phantom: ha.values[1] !== undefined ? parseX32Bool(ha.values[1]) : null,
                };
            }
        }

        const stripOn = mix && mix.values[0] !== undefined ? parseX32Bool(mix.values[0]) : null;
        const fader = mix && mix.values[1] !== undefined ? parseX32Db(mix.values[1]) : null;
        const stSend = mix && mix.values[2] !== undefined ? parseX32Bool(mix.values[2]) : null;
        const monoSend = mix && mix.values[4] !== undefined ? parseX32Bool(mix.values[4]) : null;
        const mlevel = mix && mix.values[5] !== undefined ? parseX32Db(mix.values[5]) : null;

        const dcaMask = grp && grp.values[0] !== undefined ? parseX32Bitmask(grp.values[0]) : 0;
        const muteMask = grp && grp.values[1] !== undefined ? parseX32Bitmask(grp.values[1]) : 0;
        const dcaIndices: number[] = [];
        for (let i = 0; i < 8; i++) if ((dcaMask >> i) & 1) dcaIndices.push(i + 1);
        const muteGroupIndices: number[] = [];
        for (let i = 0; i < 6; i++) if ((muteMask >> i) & 1) muteGroupIndices.push(i + 1);

        // ----- DCA assignments (resolve names + state) -----
        const dcas: any[] = [];
        for (const i of dcaIndices) {
            const d = await tryNode(`dca/${i}`);
            const dc = await tryNode(`dca/${i}/config`);
            dcas.push({
                dca: i,
                name: dc?.values[0] ?? null,
                on: d?.values[0] !== undefined ? parseX32Bool(d.values[0]) : null,
                fader: d?.values[1] !== undefined ? parseX32Db(d.values[1]) : null,
            });
        }

        // ----- Mute groups (resolve master state) -----
        const muteGroups: any[] = [];
        if (muteGroupIndices.length > 0) {
            const mute = await tryNode("config/mute");
            for (const i of muteGroupIndices) {
                const v = mute?.values[i - 1];
                muteGroups.push({
                    group: i,
                    muted: v !== undefined ? parseX32Bool(v) : null,
                });
            }
        }

        // ----- Bus sends (16) — only those with level > -90 dB or on=true -----
        const busSends: any[] = [];
        for (let b = 1; b <= 16; b++) {
            const bb = String(b).padStart(2, "0");
            const send = await tryNode(`ch/${nn}/mix/${bb}`);
            if (!send) continue;
            const sendOn = send.values[0] !== undefined ? parseX32Bool(send.values[0]) : null;
            const level = send.values[1] !== undefined ? parseX32Db(send.values[1]) : null;
            const tapType = send.values[3] ?? null;
            const isHot = sendOn === true && level !== null && level > -90;
            if (!isHot && level !== null && level <= -90 && sendOn !== true) continue;
            const busConfig = await tryNode(`bus/${bb}/config`);
            const busMix = await tryNode(`bus/${bb}/mix`);
            busSends.push({
                bus: b,
                name: busConfig?.values[0] ?? null,
                sendOn,
                level,
                tapType,
                hot: isHot,
                busOn: busMix?.values[0] !== undefined ? parseX32Bool(busMix.values[0]) : null,
                busFader: busMix?.values[1] !== undefined ? parseX32Db(busMix.values[1]) : null,
            });
        }

        // ----- Main / mono sends -----
        const mainStMix = await tryNode("main/st/mix");
        const mainMMix = await tryNode("main/m/mix");
        const mainSends = {
            st: stSend === null ? null : {
                send: stSend,
                mainOn: mainStMix?.values[0] !== undefined ? parseX32Bool(mainStMix.values[0]) : null,
                mainFader: mainStMix?.values[1] !== undefined ? parseX32Db(mainStMix.values[1]) : null,
            },
            mono: monoSend === null ? null : {
                send: monoSend,
                level: mlevel,
                mainOn: mainMMix?.values[0] !== undefined ? parseX32Bool(mainMMix.values[0]) : null,
                mainFader: mainMMix?.values[1] !== undefined ? parseX32Db(mainMMix.values[1]) : null,
            },
        };

        // ----- Physical outputs tapped directly from this channel -----
        const outputs: any[] = [];
        const containers: Array<{ kind: string; count: number; hasInvert: boolean }> = [
            { kind: "main", count: 16, hasInvert: true },
            { kind: "aux", count: 6, hasInvert: true },
            { kind: "p16", count: 16, hasInvert: true },
            { kind: "aes", count: 2, hasInvert: true },
            { kind: "rec", count: 2, hasInvert: false },
        ];
        for (const c of containers) {
            for (let i = 1; i <= c.count; i++) {
                const ii = String(i).padStart(2, "0");
                const out = await tryNode(`outputs/${c.kind}/${ii}`);
                if (!out) continue;
                const src = out.values[0] !== undefined ? parseInt(out.values[0], 10) : null;
                if (src !== channelTapSrc) continue;
                outputs.push({
                    container: `outputs/${c.kind}/${ii}`,
                    src,
                    srcLabel: decodeOutputTapSource(src),
                    pos: out.values[1] ?? null,
                    invert: c.hasInvert && out.values[2] !== undefined ? parseX32Bool(out.values[2]) : null,
                });
            }
        }

        // ----- Heuristic diagnostics -----
        const warnings: string[] = [];
        if (stripOn === false) warnings.push("channel mute is ON (signal blocked)");
        if (fader !== null && fader <= -90) warnings.push("channel fader at -∞ (no level)");
        if (headamp && headamp.gain !== null && headamp.gain <= -12 && stripOn === true) {
            warnings.push(`headamp gain ${headamp.gain} dB is very low — check input level`);
        }
        for (const m of muteGroups) {
            if (m.muted === true) warnings.push(`mute group ${m.group} is active`);
        }
        for (const d of dcas) {
            if (d.on === false) warnings.push(`DCA ${d.dca} (${d.name}) muted`);
            if (d.fader !== null && d.fader <= -90) warnings.push(`DCA ${d.dca} (${d.name}) at -∞`);
        }
        const hotBuses = busSends.filter((s) => s.hot);
        const reachesAnything = (mainSends.st && mainSends.st.send) || (mainSends.mono && mainSends.mono.send) || hotBuses.length > 0 || outputs.length > 0;
        if (!reachesAnything && stripOn === true) warnings.push("channel unmuted but routed nowhere (no main, no bus sends, no direct outputs)");

        return {
            channel,
            name: config?.values[0] ?? null,
            color: config?.values[2] ?? null,
            input: {
                sourceField,
                headamp,
            },
            strip: {
                on: stripOn,
                fader,
                preamp: preamp ? {
                    trim: preamp.values[0] !== undefined ? parseX32Db(preamp.values[0]) : null,
                    polarityInvert: preamp.values[1] !== undefined ? parseX32Bool(preamp.values[1]) : null,
                    hpOn: preamp.values[2] !== undefined ? parseX32Bool(preamp.values[2]) : null,
                    hpSlope: preamp.values[3] ?? null,
                    hpf: preamp.values[4] !== undefined ? parseX32Freq(preamp.values[4]) : null,
                } : null,
                dcaMembers: dcaIndices,
                muteGroups: muteGroupIndices,
            },
            dcas,
            muteGroups,
            busSends,
            mainSends,
            outputs,
            warnings,
        };
    }

    /**
     * Reverse-lookup: which strips/buses currently feed `dest`?
     * Accepts: "MIX 1" / "BUS 7" / "MTX 2" / "MAIN" / "MAIN LR" / "MONO" / "OUT 5"
     *          "P16 3" / "AES 1" / "REC 1" / "FX 2" / "DCA 1".
     * Returns a list of contributors with the relevant level/state.
     */
    async findRouting(dest: string): Promise<any> {
        const norm = dest.trim().toUpperCase().replace(/\s+/g, " ");

        const tryNode = async (path: string) => {
            try { return await this.nodeRead(path); } catch { return null; }
        };

        // Helper to scan a strip type for a given mix/BB send -> bus N.
        // "Currently feeding" = sendOn=true AND level>-90 dB (per Phase B spec).
        const scanSendsToBus = async (busIdx: number) => {
            const bb = String(busIdx).padStart(2, "0");
            const contributors: any[] = [];
            const stripKinds: Array<{ prefix: string; count: number; pad: number }> = [
                { prefix: "ch", count: 32, pad: 2 },
                { prefix: "auxin", count: 8, pad: 2 },
                { prefix: "fxrtn", count: 8, pad: 2 },
            ];
            for (const k of stripKinds) {
                for (let i = 1; i <= k.count; i++) {
                    const ii = String(i).padStart(k.pad, "0");
                    const send = await tryNode(`${k.prefix}/${ii}/mix/${bb}`);
                    if (!send) continue;
                    const sendOn = send.values[0] !== undefined ? parseX32Bool(send.values[0]) : null;
                    const level = send.values[1] !== undefined ? parseX32Db(send.values[1]) : null;
                    if (sendOn !== true) continue;
                    if (level === null || level <= -90) continue;
                    const cfg = await tryNode(`${k.prefix}/${ii}/config`);
                    contributors.push({
                        strip: `${k.prefix}/${ii}`,
                        name: cfg?.values[0] ?? null,
                        sendOn,
                        level,
                        tapType: send.values[3] ?? null,
                    });
                }
            }
            return contributors;
        };

        // Helper to scan strips for main LR or main mono via the mix node.
        const scanMain = async (which: "st" | "mono") => {
            const contributors: any[] = [];
            const stripKinds: Array<{ prefix: string; count: number; pad: number }> = [
                { prefix: "ch", count: 32, pad: 2 },
                { prefix: "auxin", count: 8, pad: 2 },
                { prefix: "fxrtn", count: 8, pad: 2 },
                { prefix: "bus", count: 16, pad: 2 },
            ];
            for (const k of stripKinds) {
                for (let i = 1; i <= k.count; i++) {
                    const ii = String(i).padStart(k.pad, "0");
                    const m = await tryNode(`${k.prefix}/${ii}/mix`);
                    if (!m) continue;
                    const stripOn = m.values[0] !== undefined ? parseX32Bool(m.values[0]) : null;
                    const fader = m.values[1] !== undefined ? parseX32Db(m.values[1]) : null;
                    const enable = which === "st"
                        ? (m.values[2] !== undefined ? parseX32Bool(m.values[2]) : null)
                        : (m.values[4] !== undefined ? parseX32Bool(m.values[4]) : null);
                    if (enable !== true) continue;
                    if (stripOn !== true) continue;
                    if (fader !== null && fader <= -90) continue;
                    const cfg = await tryNode(`${k.prefix}/${ii}/config`);
                    contributors.push({
                        strip: `${k.prefix}/${ii}`,
                        name: cfg?.values[0] ?? null,
                        stripOn,
                        fader,
                        sendEnabled: enable,
                    });
                }
            }
            return contributors;
        };

        // ----- Dispatch -----
        let m: RegExpMatchArray | null;

        m = norm.match(/^(?:MIX|BUS)\s*(\d+)$/);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n < 1 || n > 16) throw new Error(`bus out of range: ${n}`);
            const contributors = await scanSendsToBus(n);
            return { dest: `MIX ${n}`, kind: "bus", contributors };
        }

        m = norm.match(/^(?:MTX|MATRIX)\s*(\d+)$/);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n < 1 || n > 6) throw new Error(`matrix out of range: ${n}`);
            const nn = String(n).padStart(2, "0");
            const contributors: any[] = [];
            for (let b = 1; b <= 16; b++) {
                const bb = String(b).padStart(2, "0");
                const send = await tryNode(`bus/${bb}/mix/${nn}`);
                if (!send) continue;
                const sendOn = send.values[0] !== undefined ? parseX32Bool(send.values[0]) : null;
                const level = send.values[1] !== undefined ? parseX32Db(send.values[1]) : null;
                if (sendOn !== true) continue;
                if (level === null || level <= -90) continue;
                const cfg = await tryNode(`bus/${bb}/config`);
                contributors.push({ strip: `bus/${bb}`, name: cfg?.values[0] ?? null, sendOn, level, tapType: send.values[3] ?? null });
            }
            // main/st can also send to matrix
            const stMain = await tryNode(`main/st/mix/${nn}`);
            if (stMain) {
                const sendOn = stMain.values[0] !== undefined ? parseX32Bool(stMain.values[0]) : null;
                const level = stMain.values[1] !== undefined ? parseX32Db(stMain.values[1]) : null;
                if (sendOn === true && level !== null && level > -90) {
                    contributors.push({ strip: "main/st", name: "Main LR", sendOn, level, tapType: stMain.values[3] ?? null });
                }
            }
            return { dest: `MTX ${n}`, kind: "matrix", contributors };
        }

        if (norm === "MAIN" || norm === "MAIN LR" || norm === "LR") {
            const contributors = await scanMain("st");
            return { dest: "MAIN LR", kind: "main", contributors };
        }
        if (norm === "MONO" || norm === "MAIN M" || norm === "MAIN MONO" || norm === "M/C" || norm === "C") {
            const contributors = await scanMain("mono");
            return { dest: "MAIN MONO", kind: "main", contributors };
        }

        m = norm.match(/^(OUT|OUTPUT|P16|AUX OUT|AUX|AES|REC)\s*(\d+)$/);
        if (m) {
            const kindWord = m[1];
            const n = parseInt(m[2], 10);
            const map: Record<string, string> = {
                OUT: "main", OUTPUT: "main", P16: "p16", "AUX OUT": "aux", AUX: "aux", AES: "aes", REC: "rec",
            };
            const kind = map[kindWord];
            const ii = String(n).padStart(2, "0");
            const out = await tryNode(`outputs/${kind}/${ii}`);
            if (!out) return { dest: norm, kind: "output", contributors: [], note: "node read failed" };
            const src = out.values[0] !== undefined ? parseInt(out.values[0], 10) : null;
            return {
                dest: norm,
                kind: "output",
                container: `outputs/${kind}/${ii}`,
                src,
                srcLabel: src === null ? null : decodeOutputTapSource(src),
                pos: out.values[1] ?? null,
                invert: out.values[2] !== undefined ? parseX32Bool(out.values[2]) : null,
            };
        }

        m = norm.match(/^FX\s*(\d+)$/);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n < 1 || n > 8) throw new Error(`fx slot out of range: ${n}`);
            const src = await tryNode(`fx/${n}/source`);
            return {
                dest: `FX ${n}`,
                kind: "fx",
                sourceL: src?.values[0] ?? null,
                sourceR: src?.values[1] ?? null,
                contributors: src ? [
                    { name: `sourceL=${src.values[0]}` },
                    { name: `sourceR=${src.values[1]}` },
                ] : [],
            };
        }

        m = norm.match(/^DCA\s*(\d+)$/);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n < 1 || n > 8) throw new Error(`dca out of range: ${n}`);
            const bit = 1 << (n - 1);
            const contributors: any[] = [];
            const stripKinds: Array<{ prefix: string; count: number }> = [
                { prefix: "ch", count: 32 },
                { prefix: "auxin", count: 8 },
                { prefix: "fxrtn", count: 8 },
                { prefix: "bus", count: 16 },
            ];
            for (const k of stripKinds) {
                for (let i = 1; i <= k.count; i++) {
                    const ii = String(i).padStart(2, "0");
                    const grp = await tryNode(`${k.prefix}/${ii}/grp`);
                    if (!grp) continue;
                    const mask = grp.values[0] !== undefined ? parseX32Bitmask(grp.values[0]) : 0;
                    if ((mask & bit) === 0) continue;
                    const cfg = await tryNode(`${k.prefix}/${ii}/config`);
                    contributors.push({ strip: `${k.prefix}/${ii}`, name: cfg?.values[0] ?? null });
                }
            }
            return { dest: `DCA ${n}`, kind: "dca", contributors };
        }

        throw new Error(`Unknown destination "${dest}". Try MIX N, MTX N, MAIN, MONO, OUT N, P16 N, AUX N, AES N, REC N, FX N, DCA N.`);
    }

    /**
     * Identity block: combined /xinfo + /status read in compact form.
     * /xinfo returns [ip, name, model, firmware]; /status returns [state, ip, name].
     */
    async getIdentity(): Promise<{ model: string; firmware: string; ip: string; name: string; state: string }> {
        const xinfo = await this.rawQuery("/xinfo", [], (a) => a === "/xinfo");
        const status = await this.rawQuery("/status", [], (a) => a === "/status");
        return {
            ip: String(xinfo.args[0] ?? ""),
            name: String(xinfo.args[1] ?? ""),
            model: String(xinfo.args[2] ?? ""),
            firmware: String(xinfo.args[3] ?? ""),
            state: String(status.args[0] ?? ""),
        };
    }

    private sendCommand(address: string, args?: any[]): void {
        if (!this.isConnected) {
            console.error("OSC not connected");
            return;
        }

        const message = new (OSC as any).Message(address, ...(args || []));
        this.osc.send(message);
        // A send carrying args is a parameter write; reads and the /xremote heartbeat send
        // none. Record it and invalidate the affected cache entries. The X32 does not echo
        // our own writes back, so this is the only place they enter the change feed.
        if (args && args.length > 0) this._afterOwnWrite(address, args);
    }

    private async sendAndReceive(address: string, args?: any[], timeoutMs: number = 300): Promise<any> {
        // One send attempt: register a FIFO waiter for this address, fire, await reply.
        const attemptOnce = (): Promise<any> => new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const q = this.responseCallbacks.get(address);
                if (q) {
                    const idx = q.findIndex((w) => w.timer === timer);
                    if (idx !== -1) q.splice(idx, 1);
                    if (q.length === 0) this.responseCallbacks.delete(address);
                }
                reject(new Error(`Timeout waiting for response from ${address}`));
            }, timeoutMs);
            const waiter = { resolve, timer };
            const q = this.responseCallbacks.get(address);
            if (q) q.push(waiter);
            else this.responseCallbacks.set(address, [waiter]);
            this.sendCommand(address, args);
        });
        try {
            return await attemptOnce();
        } catch {
            // One automatic retry — a single dropped UDP datagram shouldn't fail the read.
            return await attemptOnce();
        }
    }

    private getChannelPath(channel: number): string {
        return `/ch/${channel.toString().padStart(2, "0")}`;
    }

    private getBusPath(bus: number): string {
        return `/bus/${bus.toString().padStart(2, "0")}`;
    }

    // ========== Channel Controls ==========

    async muteChannel(channel: number, mute: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/on`;
        // Mixer uses 1 for ON (unmuted) and 0 for OFF (muted)
        this.sendCommand(path, [mute ? 0 : 1]);
    }

    async getMute(channel: number): Promise<boolean> {
        const path = `${this.getChannelPath(channel)}/mix/on`;
        const value = await this.sendAndReceive(path);
        return value === 0;
    }

    async setPan(channel: number, pan: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/pan`;
        // Convert -1 to 1 range to 0 to 1 range (0 = left, 0.5 = center, 1 = right)
        const mixerPan = (pan + 1) / 2;
        this.sendCommand(path, [mixerPan]);
    }

    async getPan(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/mix/pan`;
        const value = await this.sendAndReceive(path);
        // Convert 0-1 range to -1 to 1 range
        return value * 2 - 1;
    }

    async setChannelName(channel: number, name: string): Promise<void> {
        const path = `${this.getChannelPath(channel)}/config/name`;
        this.sendCommand(path, [name]);
    }

    async getChannelName(channel: number): Promise<string> {
        const path = `${this.getChannelPath(channel)}/config/name`;
        return await this.sendAndReceive(path);
    }

    async setChannelColor(channel: number, color: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/config/color`;
        this.sendCommand(path, [color]);
    }

    async getChannelColor(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/config/color`;
        return await this.sendAndReceive(path);
    }

    async setChannelIcon(channel: number, icon: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/config/icon`;
        this.sendCommand(path, [icon]);
    }

    async getChannelIcon(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/config/icon`;
        return await this.sendAndReceive(path);
    }

    // Channel linking is per-pair. Addresses: /config/chlink/1-2, 3-4, ... 31-32.
    // Each returns int 0 (unlinked) or 1 (linked).
    async getChannelLinks(): Promise<Array<{ pair: string; linked: boolean }>> {
        const result: Array<{ pair: string; linked: boolean }> = [];
        for (let i = 1; i <= 31; i += 2) {
            const pair = `${i}-${i + 1}`;
            const v = await this.safeRead(`/config/chlink/${pair}`);
            result.push({ pair, linked: v === 1 });
        }
        return result;
    }

    async setChannelLink(pair: string, linked: boolean): Promise<void> {
        this.sendCommand(`/config/chlink/${pair}`, [linked ? 1 : 0]);
    }

    async getBusLinks(): Promise<Array<{ pair: string; linked: boolean }>> {
        const result: Array<{ pair: string; linked: boolean }> = [];
        for (let i = 1; i <= 15; i += 2) {
            const pair = `${i}-${i + 1}`;
            const v = await this.safeRead(`/config/buslink/${pair}`);
            result.push({ pair, linked: v === 1 });
        }
        return result;
    }

    async setBusLink(pair: string, linked: boolean): Promise<void> {
        this.sendCommand(`/config/buslink/${pair}`, [linked ? 1 : 0]);
    }

    // Read a block-level input routing assignment (8-ch group).
    async getRoutingBlockIn(block: string): Promise<{ raw: number; label: string } | null> {
        const raw = await this.safeRead(`/config/routing/IN/${block}`);
        if (raw === null) return null;
        return { raw, label: decodeBlockInSource(raw) };
    }

    // ========== EQ Controls ==========

    async setEQ(channel: number, band: number, gain: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/g`;
        // Convert dB to mixer range (0.0 to 1.0, where 0.5 is 0dB)
        const mixerGain = (gain + 15) / 30; // -15dB to +15dB mapped to 0-1
        this.sendCommand(path, [mixerGain]);
    }

    async getEQ(channel: number, band: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/g`;
        const value = await this.sendAndReceive(path);
        // Convert mixer range to dB
        return value * 30 - 15;
    }

    async getEQFrequency(channel: number, band: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/f`;
        return await this.sendAndReceive(path);
    }

    async setEQFrequency(channel: number, band: number, frequency: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/f`;
        this.sendCommand(path, [frequency]);
    }

    async getEQQ(channel: number, band: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/q`;
        return await this.sendAndReceive(path);
    }

    async setEQQ(channel: number, band: number, q: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/q`;
        this.sendCommand(path, [q]);
    }

    async getEQType(channel: number, band: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/type`;
        return await this.sendAndReceive(path);
    }

    async setEQType(channel: number, band: number, type: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/type`;
        this.sendCommand(path, [type]);
    }

    async getEQOn(channel: number): Promise<boolean> {
        const path = `${this.getChannelPath(channel)}/eq/on`;
        const value = await this.sendAndReceive(path);
        return value === 1;
    }

    async setEQOn(channel: number, on: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/on`;
        this.sendCommand(path, [on ? 1 : 0]);
    }

    // ========== Dynamics Controls ==========

    async setGate(channel: number, threshold: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/thr`;
        // Convert dB to mixer range
        const mixerThreshold = (threshold + 80) / 80; // -80dB to 0dB mapped to 0-1
        this.sendCommand(path, [mixerThreshold]);
    }

    async getGate(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/gate/thr`;
        const value = await this.sendAndReceive(path);
        return value * 80 - 80;
    }

    async setGateRange(channel: number, range: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/range`;
        this.sendCommand(path, [range]);
    }

    async setGateAttack(channel: number, attack: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/attack`;
        this.sendCommand(path, [attack]);
    }

    async setGateHold(channel: number, hold: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/hold`;
        this.sendCommand(path, [hold]);
    }

    async setGateRelease(channel: number, release: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/release`;
        this.sendCommand(path, [release]);
    }

    async setGateOn(channel: number, on: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/on`;
        this.sendCommand(path, [on ? 1 : 0]);
    }

    async setCompressor(
        channel: number,
        threshold: number,
        ratio: number
    ): Promise<void> {
        const thrPath = `${this.getChannelPath(channel)}/dyn/thr`;
        const ratioPath = `${this.getChannelPath(channel)}/dyn/ratio`;

        // Convert threshold dB to mixer range
        const mixerThreshold = (threshold + 60) / 60; // -60dB to 0dB mapped to 0-1
        this.sendCommand(thrPath, [mixerThreshold]);

        // Convert ratio to mixer range
        const mixerRatio = (ratio - 1) / 19; // 1:1 to 20:1 mapped to 0-1
        this.sendCommand(ratioPath, [mixerRatio]);
    }

    async setCompressorAttack(channel: number, attack: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/attack`;
        this.sendCommand(path, [attack]);
    }

    async setCompressorRelease(channel: number, release: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/release`;
        this.sendCommand(path, [release]);
    }

    async setCompressorKnee(channel: number, knee: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/knee`;
        this.sendCommand(path, [knee]);
    }

    async setCompressorGain(channel: number, gain: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/gain`;
        this.sendCommand(path, [gain]);
    }

    async setCompressorOn(channel: number, on: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/on`;
        this.sendCommand(path, [on ? 1 : 0]);
    }

    // ========== Sends ==========

    async sendToBus(channel: number, bus: number, level: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/${bus.toString().padStart(2, "0")}/level`;
        this.sendCommand(path, [level]);
    }

    async getSendToBus(channel: number, bus: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/mix/${bus.toString().padStart(2, "0")}/level`;
        return await this.sendAndReceive(path);
    }

    async sendToAux(channel: number, aux: number, level: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/${(aux + 15).toString().padStart(2, "0")}/level`;
        this.sendCommand(path, [level]);
    }

    async setSendPrePost(channel: number, bus: number, pre: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/${bus.toString().padStart(2, "0")}/preamp`;
        this.sendCommand(path, [pre ? 1 : 0]);
    }

    // ========== Routing ==========

    async setChannelSource(channel: number, source: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/config/source`;
        this.sendCommand(path, [source]);
    }

    async getChannelSource(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/config/source`;
        return await this.sendAndReceive(path);
    }

    // ========== Scenes ==========

    async recallScene(scene: number): Promise<void> {
        const path = `/-snap/load`;
        this.sendCommand(path, [scene - 1]); // Mixer scenes are 0-indexed
        // A recall rewrites the whole console; prior journal entries reference values that no
        // longer hold, so reverting across a recall would be wrong. Clear them and drop a
        // non-revertible boundary marker.
        this.journal.length = 0;
        this._journalMarker("scene recall — journal cleared");
    }

    async saveScene(scene: number, name?: string): Promise<void> {
        const path = `/-snap/store`;
        this.sendCommand(path, [scene - 1]);
        if (name) {
            const namePath = `/-snap/${(scene - 1).toString().padStart(3, "0")}/name`;
            this.sendCommand(namePath, [name]);
        }
    }

    async getSceneName(scene: number): Promise<string> {
        const path = `/-snap/${(scene - 1).toString().padStart(3, "0")}/name`;
        return await this.sendAndReceive(path);
    }

    // ========== Meters ==========

    async getChannelMeter(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/mix/fader`;
        // Note: Meters are typically sent automatically by the mixer
        // This is a placeholder - actual meter data comes via /meters
        return await this.sendAndReceive(path);
    }

    // ========== Bulk Reads ==========

    private async safeRead(address: string): Promise<any> {
        try { return await this.sendAndReceive(address); } catch { return null; }
    }

    private async readEQBands(path: string, bands: number = 4): Promise<any> {
        // Fire the on-flag and every band's four leaves concurrently through the pool.
        const [eqOn, eq] = await Promise.all([
            this.safeRead(`${path}/eq/on`),
            Promise.all(Array.from({ length: bands }, async (_, i) => {
                const b = i + 1;
                const [gain, freq, q, type] = await Promise.all([
                    this.safeRead(`${path}/eq/${b}/g`),
                    this.safeRead(`${path}/eq/${b}/f`),
                    this.safeRead(`${path}/eq/${b}/q`),
                    this.safeRead(`${path}/eq/${b}/type`),
                ]);
                return { band: b, gain, freq, q, type };
            })),
        ]);
        return { eqOn: eqOn === 1, eq };
    }

    /**
     * Read a full channel strip via /node. Replaces ~87 serial leaf reads with 26 /node calls.
     * Values are in NATIVE UNITS from the /node text format (dB, Hz, enum strings, booleans),
     * which is a deliberate change from the pre-rewrite normalized-0..1 floats — native units
     * are what the scene audit heuristics and LLM prose reason about directly.
     *
     * Field names match the old shape so downstream consumers key by the same names.
     *
     * Node shapes (pmaillot spec, verified against firmware 4.13):
     *  - ch/NN/config: [name, icon, color, source]
     *  - ch/NN/mix:    [on, fader, st, pan, mono, mlevel]
     *  - ch/NN/eq:     [on]
     *  - ch/NN/eq/B:   [type, f, g, q]        B ∈ 1..4
     *  - ch/NN/gate:   [on, mode, thr, range, attack, hold, release, keysrc]
     *  - ch/NN/dyn:    [on, mode, det, env, thr, ratio, knee, mgain, attack, hold, release, pos, keysrc, mix, auto]
     *  - ch/NN/mix/BB: [on, level, pan, type, panFollow] for odd BB (stereo)
     *                  [on, level]                      for even BB
     *  - headamp/NNN:  [gain, phantom]
     */
    async getChannelStrip(channel: number): Promise<any> {
        const nn = channel.toString().padStart(2, "0");
        const result: any = { channel };

        const readOrNull = async (path: string): Promise<{ values: string[] } | null> => {
            try { return await this.nodeRead(path); } catch { return null; }
        };

        // All of these reads are independent — fire them concurrently through the
        // pooled rawQuery instead of one strict round trip at a time.
        const [config, mix, eqNode, gate, dyn, eqBands, sends] = await Promise.all([
            readOrNull(`ch/${nn}/config`),
            readOrNull(`ch/${nn}/mix`),
            readOrNull(`ch/${nn}/eq`),
            readOrNull(`ch/${nn}/gate`),
            readOrNull(`ch/${nn}/dyn`),
            Promise.all(Array.from({ length: 4 }, (_, i) => readOrNull(`ch/${nn}/eq/${i + 1}`))),
            Promise.all(Array.from({ length: 16 }, (_, i) =>
                readOrNull(`ch/${nn}/mix/${String(i + 1).padStart(2, "0")}`))),
        ]);

        // config: [name, icon, color, source]
        result.name = config?.values[0] ?? null;
        result.fader = mix ? parseX32Db(mix.values[1]) : null;
        result.on = mix ? parseX32Bool(mix.values[0]) : null;
        result.pan = mix?.values[3] !== undefined ? parseFloat(mix.values[3]) : null;
        result.color = config?.values[2] ?? null;
        result.source = config?.values[3] !== undefined ? parseInt(config.values[3], 10) : null;

        // Headamp (only for local/aes50a source codes 0..63, matching prior behavior).
        // NOTE: /node on an unassigned headamp slot times out, hence readOrNull.
        const src = result.source;
        if (src !== null && Number.isFinite(src) && src >= 0 && src < 64) {
            const ha = await readOrNull(`headamp/${src.toString().padStart(3, "0")}`);
            result.headampGain = ha ? parseX32Db(ha.values[0]) : null;
            result.headampPhantom = ha ? parseX32Bool(ha.values[1]) : null;
        }

        // EQ
        result.eqOn = eqNode ? parseX32Bool(eqNode.values[0]) : null;
        result.eq = eqBands.map((band, i) => ({
            band: i + 1,
            gain: band?.values[2] !== undefined ? parseX32Db(band.values[2]) : null,
            freq: band?.values[1] !== undefined ? parseX32Freq(band.values[1]) : null,
            q: band?.values[3] !== undefined ? parseFloat(band.values[3]) : null,
            type: band?.values[0] ?? null,
        }));

        // Gate: [on, mode, thr, range, attack, hold, release, keysrc]
        result.gateOn = gate ? parseX32Bool(gate.values[0]) : null;
        result.gateThr = gate ? parseX32Db(gate.values[2]) : null;
        result.gateRange = gate?.values[3] !== undefined ? parseFloat(gate.values[3]) : null;
        result.gateAttack = gate?.values[4] !== undefined ? parseFloat(gate.values[4]) : null;
        result.gateHold = gate?.values[5] !== undefined ? parseFloat(gate.values[5]) : null;
        result.gateRelease = gate?.values[6] !== undefined ? parseFloat(gate.values[6]) : null;

        // Dyn: [on, mode, det, env, thr, ratio, knee, mgain, attack, hold, release, pos, keysrc, mix, auto]
        result.dynOn = dyn ? parseX32Bool(dyn.values[0]) : null;
        result.dynThr = dyn ? parseX32Db(dyn.values[4]) : null;
        result.dynRatio = dyn?.values[5] !== undefined ? parseFloat(dyn.values[5]) : null;
        result.dynKnee = dyn?.values[6] !== undefined ? parseFloat(dyn.values[6]) : null;
        result.dynGain = dyn?.values[7] !== undefined ? parseX32Db(dyn.values[7]) : null;
        result.dynAttack = dyn?.values[8] !== undefined ? parseFloat(dyn.values[8]) : null;
        result.dynRelease = dyn?.values[10] !== undefined ? parseFloat(dyn.values[10]) : null;

        // Sends: odd buses (stereo-linked) have [on, level, pan, type, panFollow]; even have [on, level].
        result.sends = sends.map((send, i) => {
            const bus = i + 1;
            if (!send) return { bus, level: null, pan: null, type: null };
            return {
                bus,
                level: send.values[1] !== undefined ? parseX32Db(send.values[1]) : null,
                pan: send.values[2] !== undefined ? parseFloat(send.values[2]) : null,
                type: send.values[3] ?? null,
            };
        });

        return result;
    }

    async getBusStrip(bus: number): Promise<any> {
        const path = this.getBusPath(bus);
        const result: any = { bus };

        const [name, fader, on, pan, color, eqData, dynOn, dynThr, dynRatio] = await Promise.all([
            this.safeRead(`${path}/config/name`),
            this.safeRead(`${path}/mix/fader`),
            this.safeRead(`${path}/mix/on`),
            this.safeRead(`${path}/mix/pan`),
            this.safeRead(`${path}/config/color`),
            this.readEQBands(path, 4),
            this.safeRead(`${path}/dyn/on`),
            this.safeRead(`${path}/dyn/thr`),
            this.safeRead(`${path}/dyn/ratio`),
        ]);
        result.name = name;
        result.fader = fader;
        result.on = on === 1;
        result.pan = pan;
        result.color = color;
        result.eqOn = eqData.eqOn;
        result.eq = eqData.eq;
        result.dynOn = dynOn === 1;
        result.dynThr = dynThr;
        result.dynRatio = dynRatio;

        return result;
    }

    async getAuxStrip(aux: number): Promise<any> {
        const path = `/auxin/${aux.toString().padStart(2, "0")}`;
        const result: any = { aux };

        const [name, fader, on, pan, color, source] = await Promise.all([
            this.safeRead(`${path}/config/name`),
            this.safeRead(`${path}/mix/fader`),
            this.safeRead(`${path}/mix/on`),
            this.safeRead(`${path}/mix/pan`),
            this.safeRead(`${path}/config/color`),
            this.safeRead(`${path}/config/source`),
        ]);
        result.name = name;
        result.fader = fader;
        result.on = on === 1;
        result.pan = pan;
        result.color = color;
        result.source = source;

        return result;
    }

    async getFxReturnStrip(fxr: number): Promise<any> {
        const path = `/fxrtn/${fxr.toString().padStart(2, "0")}`;
        const result: any = { fxReturn: fxr };

        const [name, fader, on, pan, color] = await Promise.all([
            this.safeRead(`${path}/config/name`),
            this.safeRead(`${path}/mix/fader`),
            this.safeRead(`${path}/mix/on`),
            this.safeRead(`${path}/mix/pan`),
            this.safeRead(`${path}/config/color`),
        ]);
        result.name = name;
        result.fader = fader;
        result.on = on === 1;
        result.pan = pan;
        result.color = color;

        return result;
    }

    async getMatrixStrip(mtx: number): Promise<any> {
        const path = `/mtx/${mtx.toString().padStart(2, "0")}`;
        const result: any = { matrix: mtx };

        const [name, fader, on, pan, eqData] = await Promise.all([
            this.safeRead(`${path}/config/name`),
            this.safeRead(`${path}/mix/fader`),
            this.safeRead(`${path}/mix/on`),
            this.safeRead(`${path}/mix/pan`),
            this.readEQBands(path, 4),
        ]);
        result.name = name;
        result.fader = fader;
        result.on = on === 1;
        result.pan = pan;
        result.eqOn = eqData.eqOn;
        result.eq = eqData.eq;

        return result;
    }

    async getDCA(dca: number): Promise<any> {
        const path = `/dca/${dca}`;
        const result: any = { dca };

        const [name, fader, on, color] = await Promise.all([
            this.safeRead(`${path}/config/name`),
            this.safeRead(`${path}/fader`),
            this.safeRead(`${path}/on`),
            this.safeRead(`${path}/config/color`),
        ]);
        result.name = name;
        result.fader = fader;
        result.on = on === 1;
        result.color = color;

        return result;
    }

    async getMainStrip(): Promise<any> {
        const result: any = { type: "main_stereo" };

        const [fader, on, pan, eqData, dynOn, dynThr, dynRatio, monoFader, monoOn] = await Promise.all([
            this.safeRead("/main/st/mix/fader"),
            this.safeRead("/main/st/mix/on"),
            this.safeRead("/main/st/mix/pan"),
            this.readEQBands("/main/st", 6),
            this.safeRead("/main/st/dyn/on"),
            this.safeRead("/main/st/dyn/thr"),
            this.safeRead("/main/st/dyn/ratio"),
            this.safeRead("/main/m/mix/fader"),
            this.safeRead("/main/m/mix/on"),
        ]);
        result.fader = fader;
        result.on = on === 1;
        result.pan = pan;
        result.eqOn = eqData.eqOn;
        result.eq = eqData.eq;
        result.dynOn = dynOn === 1;
        result.dynThr = dynThr;
        result.dynRatio = dynRatio;
        result.mono = {
            fader: monoFader,
            on: monoOn === 1,
        };

        return result;
    }

    async getHeadamp(index: number): Promise<any> {
        const path = `/headamp/${index.toString().padStart(3, "0")}`;
        return {
            index,
            gain: await this.safeRead(`${path}/gain`),
            phantom: (await this.safeRead(`${path}/phantom`)) === 1,
        };
    }

    /**
     * High-level console overview. Rewritten to read each strip's name + on/fader from
     * two /node container reads (config → name; mix → on + fader) instead of three
     * single-leaf reads per strip, and to issue every read concurrently through the
     * pooled rawQuery. ~62 strips × 3 serial leaf reads (~190 round trips) collapse to
     * ~124 concurrent /node reads.
     *
     * SEMANTIC CHANGE — fader units: the old single-leaf `/…/mix/fader` reads returned a
     * 0..1 LINEAR float. The /node `mix` container reports fader as a dB string, decoded
     * here via parseX32Db. dB cannot be converted back to the old linear scale cleanly,
     * so the key is renamed `fader` → `faderDb` (and `monoFader` → `monoFaderDb`) to make
     * the unit change explicit and prevent any consumer from silently misreading it.
     * index.ts only JSON-stringifies this object, so no caller edits are required.
     */
    async getConsoleOverview(): Promise<any> {
        const readOrNull = async (p: string): Promise<{ values: string[] } | null> => {
            try { return await this.nodeRead(p); } catch { return null; }
        };
        const name = (n: { values: string[] } | null): string | null => n?.values[0] ?? null;
        // mix / dca containers: values[0]=on (ON/OFF), values[1]=fader (dB).
        const faderDb = (n: { values: string[] } | null): number | null =>
            n && n.values[1] !== undefined ? parseX32Db(n.values[1]) : null;
        const on = (n: { values: string[] } | null): boolean | null =>
            n ? parseX32Bool(n.values[0]) : null;

        // A per-strip pair reader: [config, mix] concurrently.
        const stripPair = (cfgPath: string, mixPath: string) =>
            Promise.all([readOrNull(cfgPath), readOrNull(mixPath)]);

        // Fire EVERY read across all strip groups concurrently; the pool caps at
        // RAW_POOL_CAP in flight and queues the rest.
        const [
            chPairs, busPairs, dcaPairs, mtxPairs, auxPairs, fxrPairs,
            fxTypes, mainStMix, mainMMix,
        ] = await Promise.all([
            Promise.all(Array.from({ length: 32 }, (_, i) => {
                const nn = String(i + 1).padStart(2, "0");
                return stripPair(`ch/${nn}/config`, `ch/${nn}/mix`);
            })),
            Promise.all(Array.from({ length: 16 }, (_, i) => {
                const nn = String(i + 1).padStart(2, "0");
                return stripPair(`bus/${nn}/config`, `bus/${nn}/mix`);
            })),
            // DCA master state lives at dca/N (on, fader); its name at dca/N/config.
            Promise.all(Array.from({ length: 8 }, (_, i) =>
                stripPair(`dca/${i + 1}/config`, `dca/${i + 1}`))),
            Promise.all(Array.from({ length: 6 }, (_, i) => {
                const nn = String(i + 1).padStart(2, "0");
                return stripPair(`mtx/${nn}/config`, `mtx/${nn}/mix`);
            })),
            Promise.all(Array.from({ length: 8 }, (_, i) => {
                const nn = String(i + 1).padStart(2, "0");
                return stripPair(`auxin/${nn}/config`, `auxin/${nn}/mix`);
            })),
            Promise.all(Array.from({ length: 8 }, (_, i) => {
                const nn = String(i + 1).padStart(2, "0");
                return stripPair(`fxrtn/${nn}/config`, `fxrtn/${nn}/mix`);
            })),
            // FX slot type unchanged: leaf read returns the raw int type code.
            Promise.all(Array.from({ length: 8 }, (_, i) => this.safeRead(`/fx/${i + 1}/type`))),
            readOrNull("main/st/mix"),
            readOrNull("main/m/mix"),
        ]);

        const overview: any = {};
        overview.channels = chPairs.map(([cfg, mix], i) => ({
            ch: i + 1, name: name(cfg), faderDb: faderDb(mix), on: on(mix),
        }));
        overview.buses = busPairs.map(([cfg, mix], i) => ({
            bus: i + 1, name: name(cfg), faderDb: faderDb(mix), on: on(mix),
        }));
        overview.dcas = dcaPairs.map(([cfg, dca], i) => ({
            dca: i + 1, name: name(cfg), faderDb: faderDb(dca), on: on(dca),
        }));
        overview.matrices = mtxPairs.map(([cfg, mix], i) => ({
            matrix: i + 1, name: name(cfg), faderDb: faderDb(mix), on: on(mix),
        }));
        overview.auxInputs = auxPairs.map(([cfg, mix], i) => ({
            aux: i + 1, name: name(cfg), faderDb: faderDb(mix), on: on(mix),
        }));
        overview.fxReturns = fxrPairs.map(([cfg, mix], i) => ({
            fxReturn: i + 1, name: name(cfg), faderDb: faderDb(mix), on: on(mix),
        }));
        overview.fxSlots = fxTypes.map((type, i) => ({ slot: i + 1, type }));
        overview.main = {
            faderDb: faderDb(mainStMix),
            on: on(mainStMix),
            monoFaderDb: faderDb(mainMMix),
            monoOn: on(mainMMix),
        };

        return overview;
    }

    async getRouting(): Promise<any> {
        const routing: any = {};

        // FX source assignments (FX 1-4 are stereo insert, 5-8 are dual mono)
        routing.fxSources = [];
        for (let fx = 1; fx <= 4; fx++) {
            routing.fxSources.push({
                slot: fx,
                sourceL: await this.safeRead(`/fx/${fx}/source/l`),
                sourceR: await this.safeRead(`/fx/${fx}/source/r`),
            });
        }
        // FX 5-8 are inserted on channels, different structure
        for (let fx = 5; fx <= 8; fx++) {
            routing.fxSources.push({
                slot: fx,
                source: await this.safeRead(`/fx/${fx}/source`),
            });
        }

        // Output routing blocks
        routing.outputs = {};
        for (const block of ["1-4", "5-8", "9-12", "13-16"]) {
            routing.outputs[`OUT_${block}`] = await this.safeRead(`/config/routing/OUT/${block}`);
        }

        // Input routing blocks (decoded)
        routing.inputs = {};
        for (const block of ["1-8", "9-16", "17-24", "25-32"]) {
            const raw = await this.safeRead(`/config/routing/IN/${block}`);
            routing.inputs[`IN_${block}`] = { raw, label: raw === null ? null : decodeBlockInSource(raw) };
        }

        // AES50 routing (decoded using same block-in enum)
        routing.aes50a = {};
        for (const block of ["1-8", "9-16", "17-24", "25-32", "33-40", "41-48"]) {
            const raw = await this.safeRead(`/config/routing/AES50A/${block}`);
            routing.aes50a[`AES50A_${block}`] = { raw, label: raw === null ? null : decodeBlockInSource(raw) };
        }
        routing.aes50b = {};
        for (const block of ["1-8", "9-16", "17-24", "25-32", "33-40", "41-48"]) {
            const raw = await this.safeRead(`/config/routing/AES50B/${block}`);
            routing.aes50b[`AES50B_${block}`] = { raw, label: raw === null ? null : decodeBlockInSource(raw) };
        }

        // Card routing (decoded)
        routing.card = {};
        for (const block of ["1-8", "9-16", "17-24", "25-32"]) {
            const raw = await this.safeRead(`/config/routing/CARD/${block}`);
            routing.card[`CARD_${block}`] = { raw, label: raw === null ? null : decodeBlockInSource(raw) };
        }

        return routing;
    }

    // User-defined routing (firmware 4.0+): per-slot patches for the "User In"
    // and "User Out" blocks. When a routing block is set to source type
    // "USER IN" / "USER OUT", these tables determine the actual per-channel source.
    /**
     * Single-call summary of ALL routing layers, decoded. Returns:
     *  - inputBlocks: 4 block assignments (which source group feeds each 8-ch range)
     *  - outputBlocks, aes50a, aes50b, card: same structure for other directions
     *  - userIn: 32 per-slot patches (firmware 4.0+ 1:1 routing)
     *  - userOut: 48 per-slot patches
     *
     * Use this FIRST when planning routing changes — it shows the full topology so you can tell
     * whether a channel is patched via block routing (legacy 8-ch groups) or per-slot User In (firmware 4.0+).
     * If an input block shows "User In 25-32", per-channel patches live in userIn[24..31].
     */
    async getRoutingOverview(): Promise<any> {
        const routing = await this.getRouting();
        const userRouting = await this.getUserRouting();
        return {
            summary: "X32 routing topology. Input blocks select which 8-ch source group feeds each channel range. When a block is set to 'User In N-M', the userIn per-slot table determines the actual physical source for each channel in that range.",
            inputBlocks: routing.inputs,
            outputBlocks: routing.outputs,
            aes50a: routing.aes50a,
            aes50b: routing.aes50b,
            card: routing.card,
            userIn: userRouting.userIn,
            userOut: userRouting.userOut,
        };
    }

    async getUserRouting(): Promise<any> {
        // All 32 + 48 slot reads are independent — issue them concurrently through the
        // pool. map() preserves slot order in the result arrays.
        const [userIn, userOut] = await Promise.all([
            Promise.all(Array.from({ length: 32 }, async (_, i) => {
                const slot = i + 1;
                const source = await this.safeRead(`/config/userrout/in/${slot.toString().padStart(2, "0")}`);
                return { slot, source, sourceLabel: source === null ? null : decodeUserInSource(source) };
            })),
            Promise.all(Array.from({ length: 48 }, async (_, i) => {
                const slot = i + 1;
                const source = await this.safeRead(`/config/userrout/out/${slot.toString().padStart(2, "0")}`);
                return { slot, source, sourceLabel: source === null ? null : decodeUserOutSource(source) };
            })),
        ]);

        return { userIn, userOut };
    }

    /**
     * Set a User In slot's source. Accepts either a raw int (0..168) or a label like "Card 1", "Local 27", "AES50A 5", "OFF".
     */
    async setUserRoutingIn(slot: number, source: number | string): Promise<void> {
        const code = encodeUserInSource(source);
        const path = `/config/userrout/in/${slot.toString().padStart(2, "0")}`;
        // Capture prior source code so undo can restore it (null on read failure — write proceeds).
        const prevRaw = await this.safeRead(path);
        const prev = typeof prevRaw === "number" ? prevRaw : null;
        const owns = this._beginJournal(`set_user_routing_in ${slot}`);
        this._journalWrite({ kind: "routeIn", path: this._normPath(path), field: "source", slot, prev, next: code });
        this.sendCommand(path, [code]);
        this._commitJournal(owns);
    }

    async setUserRoutingOut(slot: number, source: number): Promise<void> {
        const path = `/config/userrout/out/${slot.toString().padStart(2, "0")}`;
        const prevRaw = await this.safeRead(path);
        const prev = typeof prevRaw === "number" ? prevRaw : null;
        const owns = this._beginJournal(`set_user_routing_out ${slot}`);
        this._journalWrite({ kind: "routeOut", path: this._normPath(path), field: "source", slot, prev, next: source });
        this.sendCommand(path, [source]);
        this._commitJournal(owns);
    }

    // ========== Custom Commands ==========

    /**
     * Send a raw OSC command. Supports two modes:
     *  - Write:  pass `value` (and optionally `osctype` = 'int'|'float'|'string'|'bool').
     *            If `osctype` is omitted, type is inferred from the JS value
     *            (integer numbers → int, decimals → float, strings → string, booleans → T/F).
     *            Pass an array of { type, value } to send multiple typed args.
     *  - Read:   omit `value` entirely — sends a query and returns the mixer's reply value (or null on timeout).
     *
     * X32 is strict about OSC type tags: `/config/color` requires int (',i') — sending string '6' is silently dropped.
     * Use `osctype: 'int'` when LLMs may pass values as strings.
     */
    async sendCustomCommand(
        address: string,
        value?: any,
        osctype?: "int" | "float" | "string" | "bool",
    ): Promise<any> {
        // Read mode
        if (value === undefined) {
            try {
                return await this.sendAndReceive(address);
            } catch {
                return null;
            }
        }

        // Typed multi-arg: value is an array of { type, value } entries
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && value[0] !== null && "type" in value[0]) {
            const packed = value.map((entry: any) => coerceOscArg(entry.value, entry.type));
            this.sendCommand(address, packed);
            return;
        }

        // Single value, optional explicit type
        const args = Array.isArray(value) ? value : [value];
        const packed = args.map((v: any) => coerceOscArg(v, osctype));
        this.sendCommand(address, packed);
    }

    // ========== Scene snapshot + audit (Phase C) ==========

    /**
     * Walk every top-level /node container the schema covers and return one
     * structured object the LLM can reason about. Schema-driven decoding so
     * values arrive as native types (db numbers, freq Hz, enum strings, bools).
     *
     * Defensive: every read is wrapped in try/catch — a partial dump survives
     * even if some nodes timeout or are unassigned (e.g., headamp slots on
     * channels routed via User In rather than local headamps).
     *
     * Skips meters, scene/show files, talkback, monitor, prefs (Phase G skip
     * list). FX params are omitted — Phase D′ surfaces those by algorithm.
     */
    async sceneSnapshot(): Promise<any> {
        const t0 = Date.now();

        const tryGet = async (p: string): Promise<any> => {
            try { return await this.nodeGetField(p); } catch { return null; }
        };
        const trySafeRead = async (addr: string): Promise<any> => {
            try { return await this.sendAndReceive(addr); } catch { return null; }
        };

        // ----- META -----
        let identity: any = null;
        try { identity = await this.getIdentity(); } catch { /* keep going */ }

        // ----- CHANNELS (32) -----
        const channels = await Promise.all(Array.from({ length: 32 }, async (_, i) => {
            const n = i + 1;
            const nn = String(n).padStart(2, "0");
            const config = await tryGet(`ch/${nn}/config`);
            const mix = await tryGet(`ch/${nn}/mix`);
            const eq = await tryGet(`ch/${nn}/eq`);
            const eqBands: any[] = [];
            for (let b = 1; b <= 4; b++) eqBands.push(await tryGet(`ch/${nn}/eq/${b}`));
            const gate = await tryGet(`ch/${nn}/gate`);
            const dyn = await tryGet(`ch/${nn}/dyn`);
            const preamp = await tryGet(`ch/${nn}/preamp`);
            const grp = await tryGet(`ch/${nn}/grp`);
            const sends: any[] = [];
            for (let b = 1; b <= 16; b++) {
                const bb = String(b).padStart(2, "0");
                const s = await tryGet(`ch/${nn}/mix/${bb}`);
                sends.push(s ? { bus: b, ...s } : { bus: b, on: null, level: null });
            }
            let headamp: any = null;
            const src = config?.source;
            if (typeof src === "number" && src >= 0 && src < 64) {
                headamp = await tryGet(`headamp/${String(src).padStart(3, "0")}`);
            }
            return { n, config, mix, eq, eqBands, gate, dyn, preamp, grp, headamp, sends };
        }));

        // ----- AUX INPUTS (8) -----
        // auxin/N/automix is NOT a valid /node container on firmware 4.13 (verified
        // via probe: it times out). Skip it — schema entry kept only for write paths
        // that may resolve via leaves. The audit rules don't reference automix.
        const auxins = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
            const n = i + 1;
            const nn = String(n).padStart(2, "0");
            const config = await tryGet(`auxin/${nn}/config`);
            const mix = await tryGet(`auxin/${nn}/mix`);
            const preamp = await tryGet(`auxin/${nn}/preamp`);
            const grp = await tryGet(`auxin/${nn}/grp`);
            const sends: any[] = [];
            for (let b = 1; b <= 16; b++) {
                const bb = String(b).padStart(2, "0");
                const s = await tryGet(`auxin/${nn}/mix/${bb}`);
                sends.push(s ? { bus: b, ...s } : { bus: b, on: null, level: null });
            }
            return { n, config, mix, preamp, grp, sends };
        }));

        // ----- FX RETURNS (8) -----
        const fxrtns = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
            const n = i + 1;
            const nn = String(n).padStart(2, "0");
            const config = await tryGet(`fxrtn/${nn}/config`);
            const mix = await tryGet(`fxrtn/${nn}/mix`);
            const grp = await tryGet(`fxrtn/${nn}/grp`);
            const sends: any[] = [];
            for (let b = 1; b <= 16; b++) {
                const bb = String(b).padStart(2, "0");
                const s = await tryGet(`fxrtn/${nn}/mix/${bb}`);
                sends.push(s ? { bus: b, ...s } : { bus: b, on: null, level: null });
            }
            return { n, config, mix, grp, sends };
        }));

        // ----- BUSES (16) — sends are to matrices (1..6) -----
        const buses = await Promise.all(Array.from({ length: 16 }, async (_, i) => {
            const n = i + 1;
            const nn = String(n).padStart(2, "0");
            const config = await tryGet(`bus/${nn}/config`);
            const mix = await tryGet(`bus/${nn}/mix`);
            const grp = await tryGet(`bus/${nn}/grp`);
            const sends: any[] = [];
            for (let m = 1; m <= 6; m++) {
                const mm = String(m).padStart(2, "0");
                const s = await tryGet(`bus/${nn}/mix/${mm}`);
                sends.push(s ? { mtx: m, ...s } : { mtx: m, on: null, level: null });
            }
            return { n, config, mix, grp, sends };
        }));

        // ----- MATRICES (6) -----
        const matrices = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
            const n = i + 1;
            const nn = String(n).padStart(2, "0");
            const config = await tryGet(`mtx/${nn}/config`);
            const mix = await tryGet(`mtx/${nn}/mix`);
            const grp = await tryGet(`mtx/${nn}/grp`);
            return { n, config, mix, grp };
        }));

        // ----- MAIN (st + m) -----
        const stConfig = await tryGet("main/st/config");
        const stMix = await tryGet("main/st/mix");
        const stGrp = await tryGet("main/st/grp");
        const stSends: any[] = [];
        for (let m = 1; m <= 6; m++) {
            const mm = String(m).padStart(2, "0");
            const s = await tryGet(`main/st/mix/${mm}`);
            stSends.push(s ? { mtx: m, ...s } : { mtx: m, on: null, level: null });
        }
        const mConfig = await tryGet("main/m/config");
        const mMix = await tryGet("main/m/mix");
        const mGrp = await tryGet("main/m/grp");
        const main = {
            st: { config: stConfig, mix: stMix, grp: stGrp, sends: stSends },
            m: { config: mConfig, mix: mMix, grp: mGrp },
        };

        // ----- DCAs (8) -----
        const dcas = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
            const n = i + 1;
            const dca = await tryGet(`dca/${n}`);
            const config = await tryGet(`dca/${n}/config`);
            return { n, config, ...(dca || { on: null, fader: null }) };
        }));

        // ----- FX (8) — type leaf + source node for slots 1..4 -----
        const fx = await Promise.all(Array.from({ length: 8 }, async (_, i) => {
            const n = i + 1;
            const type = await trySafeRead(`/fx/${n}/type`);
            const slot: any = { slot: n, type };
            if (n <= 4) slot.source = await tryGet(`fx/${n}/source`);
            return slot;
        }));

        // ----- OUTPUTS -----
        const readOutputs = async (kind: string, count: number) => {
            const list: any[] = [];
            for (let i = 1; i <= count; i++) {
                const ii = String(i).padStart(2, "0");
                const o = await tryGet(`outputs/${kind}/${ii}`);
                let srcLabel: string | null = null;
                if (o && typeof o.src === "number") srcLabel = decodeOutputTapSource(o.src);
                list.push({ n: i, ...(o || { src: null, pos: null, invert: null }), srcLabel });
            }
            return list;
        };
        const outputs = {
            main: await readOutputs("main", 16),
            aux: await readOutputs("aux", 6),
            p16: await readOutputs("p16", 16),
            aes: await readOutputs("aes", 2),
            rec: await readOutputs("rec", 2),
        };

        // ----- ROUTING -----
        // Avoid getRouting() — its /fx/5..8/source reads time out (1s each, no such
        // address on this firmware) and waste ~4s. Read block routing directly with
        // parallel safeReads (different addresses → osc-js can dispatch concurrently).
        const readBlock = async (kind: string, blocks: string[]) => {
            const out: Record<string, any> = {};
            const vals = await Promise.all(blocks.map((b) =>
                this.safeRead(`/config/routing/${kind}/${b}`)));
            blocks.forEach((b, i) => {
                const raw = vals[i];
                out[`${kind}_${b}`] = raw === null
                    ? { raw: null, label: null }
                    : { raw, label: decodeBlockInSource(raw) };
            });
            return out;
        };
        const block_in = readBlock("IN", ["1-8", "9-16", "17-24", "25-32"]);
        const block_aes50a = readBlock("AES50A", ["1-8", "9-16", "17-24", "25-32", "33-40", "41-48"]);
        const block_aes50b = readBlock("AES50B", ["1-8", "9-16", "17-24", "25-32", "33-40", "41-48"]);
        const block_card = readBlock("CARD", ["1-8", "9-16", "17-24", "25-32"]);

        const userIn = Promise.all(Array.from({ length: 32 }, async (_, i) => {
            const slot = i + 1;
            const source = await this.safeRead(`/config/userrout/in/${String(slot).padStart(2, "0")}`);
            return { slot, source, sourceLabel: source === null ? null : decodeUserInSource(source) };
        }));
        const userOut = Promise.all(Array.from({ length: 48 }, async (_, i) => {
            const slot = i + 1;
            const source = await this.safeRead(`/config/userrout/out/${String(slot).padStart(2, "0")}`);
            return { slot, source, sourceLabel: source === null ? null : decodeUserOutSource(source) };
        }));

        const [
            blockInResolved, blockAes50aResolved, blockAes50bResolved, blockCardResolved,
            user_in, user_out,
        ] = await Promise.all([block_in, block_aes50a, block_aes50b, block_card, userIn, userOut]);

        const routing = {
            block_in: blockInResolved,
            block_aes50a: blockAes50aResolved,
            block_aes50b: blockAes50bResolved,
            block_card: blockCardResolved,
            user_in, user_out,
        };

        // ----- CONFIG -----
        const config = {
            mute: await tryGet("config/mute"),
            chlink: await tryGet("config/chlink"),
            buslink: await tryGet("config/buslink"),
            auxlink: await tryGet("config/auxlink"),
            mtxlink: await tryGet("config/mtxlink"),
            linkcfg: await tryGet("config/linkcfg"),
        };

        const wall_ms = Date.now() - t0;
        return {
            meta: {
                model: identity?.model ?? null,
                firmware: identity?.firmware ?? null,
                ip: identity?.ip ?? null,
                name: identity?.name ?? null,
                state: identity?.state ?? null,
                captured_at: new Date().toISOString(),
                wall_ms,
            },
            channels, auxins, fxrtns, buses, matrices, main, dcas, fx, outputs, routing, config,
        };
    }

    /**
     * Run deterministic heuristics over a scene snapshot. If `snap` is omitted
     * the snapshot is fetched first. Returns a list of findings sorted by
     * severity (error > warn > info) then by path.
     *
     * Findings are structured, not pretty-printed — the LLM wraps them into
     * prose for the volunteer.
     */
    async sceneAudit(snap?: any): Promise<{ findings: any[]; snapshotMeta: any }> {
        const s = snap ?? await this.sceneSnapshot();
        const findings: any[] = [];
        const add = (severity: "info" | "warn" | "error", path: string, rule: string, message: string) => {
            findings.push({ severity, path, rule, message });
        };

        const isVocalName = (name?: string | null): boolean => {
            if (!name) return false;
            return /^vo[cx]/i.test(name.trim());
        };

        // ----- per-channel checks -----
        for (const c of (s.channels || [])) {
            const tag = `ch/${String(c.n).padStart(2, "0")}`;
            const name = c.config?.name ?? null;
            const onMix = c.mix?.on === true;
            const fader: number = typeof c.mix?.fader === "number" ? c.mix.fader : -Infinity;
            const haGain: number | null = typeof c.headamp?.gain === "number" ? c.headamp.gain : null;
            const phantom: boolean | null = typeof c.headamp?.phantom === "boolean" ? c.headamp.phantom : null;

            // SIGNAL-PATH: unmuted + fader > -90 + headamp gain <= -12 dB
            if (onMix && fader > -90 && haGain !== null && haGain <= -12) {
                add("warn", tag, "low-headamp-gain",
                    `${name || tag} unmuted with fader ${fader.toFixed(1)}dB but headamp gain is ${haGain.toFixed(1)}dB — likely no signal at the input.`);
            }

            // SIGNAL-PATH: phantom power off on a vocal-named channel
            if (isVocalName(name) && phantom === false) {
                add("info", tag, "vocal-phantom-off",
                    `${name} (likely vocal) has phantom power OFF — most condenser mics need +48V.`);
            }

            // SIGNAL-PATH: unreachable — unmuted, fader up, but no DCA, no main, no bus sends
            const dcaMask = typeof c.grp?.dca === "number" ? c.grp.dca : 0;
            const muteMask = typeof c.grp?.mute === "number" ? c.grp.mute : 0;
            const stSend = c.mix?.st === true;
            const monoSend = c.mix?.mono === true;
            const hotBusSends = (c.sends || []).filter((x: any) =>
                x.on === true && typeof x.level === "number" && x.level > -90);
            if (onMix && fader > -90 && dcaMask === 0 && !stSend && !monoSend && hotBusSends.length === 0) {
                add("warn", tag, "unreachable",
                    `${name || tag} is unmuted with fader up but routed nowhere — no main send, no bus sends, no DCA.`);
            }

            // SIGNAL-PATH: send-to-muted-bus / send-to-silent-bus is consolidated
            // below at the per-bus level — one finding per silent bus, listing
            // the hot-feeding strips. Issuing one per send produced 80+ findings
            // on a typical scene with several inactive monitor buses.

            // EQ: feedback risk
            const eqOn = c.eq?.on === true;
            if (eqOn) {
                for (let b = 0; b < (c.eqBands || []).length; b++) {
                    const band = c.eqBands[b];
                    if (!band) continue;
                    const g: number | null = typeof band.g === "number" ? band.g : null;
                    const f: number | null = typeof band.f === "number" ? band.f : null;
                    if (g === null || f === null) continue;
                    if (g > 9 && f < 80) {
                        add("warn", `${tag}/eq/${b + 1}`, "subwoofer-feedback-risk",
                            `${name || tag} EQ band ${b + 1}: +${g.toFixed(1)}dB at ${f.toFixed(0)}Hz — likely subwoofer feedback or rumble boost.`);
                    } else if (g > 9 && f < 200) {
                        add("warn", `${tag}/eq/${b + 1}`, "low-mid-feedback-risk",
                            `${name || tag} EQ band ${b + 1}: +${g.toFixed(1)}dB at ${f.toFixed(0)}Hz — feedback / boominess risk.`);
                    }
                }
            }

            // GATE: high threshold on vocal
            const gateOn = c.gate?.on === true;
            const gateThr: number | null = typeof c.gate?.thr === "number" ? c.gate.thr : null;
            const gateRange: number | null = typeof c.gate?.range === "number" ? c.gate.range : null;
            if (gateOn && gateThr !== null && gateThr > -20 && isVocalName(name)) {
                add("info", `${tag}/gate`, "vocal-gate-high",
                    `${name} gate threshold is ${gateThr.toFixed(1)}dB — soft phrases may get cut. Try -30dB or lower for spoken/sung vocals.`);
            }
            if (gateOn && gateRange !== null && gateRange < 10) {
                add("info", `${tag}/gate`, "gate-range-narrow",
                    `${name || tag} gate range is only ${gateRange.toFixed(1)}dB — gate is barely doing anything.`);
            }

            // DYN: very aggressive compression
            const dynOn = c.dyn?.on === true;
            const dynThr: number | null = typeof c.dyn?.thr === "number" ? c.dyn.thr : null;
            const dynRatio: number | null = typeof c.dyn?.ratio === "number" ? c.dyn.ratio : null;
            if (dynOn && dynRatio !== null && dynThr !== null && dynRatio > 8 && dynThr > -20) {
                add("info", `${tag}/dyn`, "aggressive-compression",
                    `${name || tag} compressor is aggressive: ${dynRatio.toFixed(1)}:1 ratio at ${dynThr.toFixed(1)}dB threshold — sounds heavily limited.`);
            }
        }

        // ----- LINKED CHANNEL DIVERGENCE -----
        // chlink has 16 booleans; index i=0 means pair (1,2), i=1 means pair (3,4), etc.
        const chlink = s.config?.chlink || {};
        const linkArr = Object.values(chlink) as boolean[];
        for (let i = 0; i < linkArr.length; i++) {
            if (linkArr[i] !== true) continue;
            const a = (s.channels || [])[i * 2];
            const b = (s.channels || [])[i * 2 + 1];
            if (!a || !b) continue;
            const tag = `ch/${String(a.n).padStart(2, "0")}+${String(b.n).padStart(2, "0")}`;
            const diffs: string[] = [];
            const af = a.mix?.fader, bf = b.mix?.fader;
            if (typeof af === "number" && typeof bf === "number" && Math.abs(af - bf) > 0.5) {
                diffs.push(`fader ${af.toFixed(1)} vs ${bf.toFixed(1)} dB`);
            }
            const aGate = a.gate, bGate = b.gate;
            if (aGate && bGate && (aGate.on !== bGate.on || aGate.thr !== bGate.thr)) {
                diffs.push(`gate on=${aGate.on}/${bGate.on} thr=${aGate.thr}/${bGate.thr}`);
            }
            const aDyn = a.dyn, bDyn = b.dyn;
            if (aDyn && bDyn && (aDyn.on !== bDyn.on || aDyn.thr !== bDyn.thr || aDyn.ratio !== bDyn.ratio)) {
                diffs.push(`dyn on=${aDyn.on}/${bDyn.on}`);
            }
            for (let bi = 0; bi < 4; bi++) {
                const ab = (a.eqBands || [])[bi], bb = (b.eqBands || [])[bi];
                if (ab && bb && (ab.g !== bb.g || ab.f !== bb.f || ab.q !== bb.q || ab.type !== bb.type)) {
                    diffs.push(`eq band ${bi + 1} differs`);
                }
            }
            if (diffs.length > 0) {
                add("warn", tag, "linked-pair-diverged",
                    `Linked pair ch${a.n}/${b.n} has differing settings: ${diffs.join("; ")}.`);
            }
        }

        // ----- FX RETURN MUTED BUT SOURCE ASSIGNED -----
        for (const slot of (s.fx || [])) {
            if (slot.slot > 4) continue;  // 5-8 are inserts, no source/return pair
            const fxr = (s.fxrtns || [])[slot.slot - 1];
            if (!fxr) continue;
            const sourceL = slot.source?.sourceL ?? null;
            const sourceR = slot.source?.sourceR ?? null;
            const assigned = (sourceL && sourceL !== "OFF") || (sourceR && sourceR !== "OFF");
            const fxrOn = fxr.mix?.on === true;
            if (assigned && !fxrOn) {
                add("warn", `fxrtn/${String(slot.slot).padStart(2, "0")}`, "fx-muted-but-sourced",
                    `FX slot ${slot.slot} is sourced (${sourceL}/${sourceR}) but FX return ${slot.slot} is muted — no FX in the mix.`);
            }
        }

        // ----- OUTPUT TAPS A MUTED BUS -----
        // Output src enum: 4..19 = MX1..MX16 (bus = src - 3)
        const checkOutputs = (kind: string, list: any[]) => {
            for (const o of (list || [])) {
                if (typeof o.src !== "number") continue;
                if (o.src >= 4 && o.src <= 19) {
                    const busN = o.src - 3;
                    const bus = (s.buses || [])[busN - 1];
                    if (!bus) continue;
                    const busOn = bus.mix?.on === true;
                    if (!busOn) {
                        add("error", `outputs/${kind}/${String(o.n).padStart(2, "0")}`, "output-from-muted-bus",
                            `${kind.toUpperCase()} ${o.n} is sourced from MIX${busN} (${bus.config?.name || "?"}) but that bus is MUTED — output carries silence.`);
                    }
                }
            }
        };
        checkOutputs("main", s.outputs?.main || []);
        checkOutputs("aux", s.outputs?.aux || []);
        checkOutputs("p16", s.outputs?.p16 || []);
        checkOutputs("aes", s.outputs?.aes || []);
        checkOutputs("rec", s.outputs?.rec || []);

        // ----- TWO OUTPUTS TAPPING SAME CHANNEL AT DIFFERENT POSITIONS -----
        const channelTaps = new Map<number, Array<{ container: string; pos: any }>>();
        const collectChTap = (kind: string, list: any[]) => {
            for (const o of (list || [])) {
                if (typeof o.src !== "number") continue;
                // src 26..57 = Ch01..Ch32
                if (o.src >= 26 && o.src <= 57) {
                    const ch = o.src - 25;
                    if (!channelTaps.has(ch)) channelTaps.set(ch, []);
                    channelTaps.get(ch)!.push({
                        container: `outputs/${kind}/${String(o.n).padStart(2, "0")}`,
                        pos: o.pos ?? null,
                    });
                }
            }
        };
        collectChTap("main", s.outputs?.main || []);
        collectChTap("aux", s.outputs?.aux || []);
        collectChTap("p16", s.outputs?.p16 || []);
        collectChTap("aes", s.outputs?.aes || []);
        collectChTap("rec", s.outputs?.rec || []);
        for (const [ch, taps] of channelTaps) {
            if (taps.length < 2) continue;
            const positions = new Set(taps.map((t) => t.pos));
            if (positions.size > 1) {
                add("warn", `ch/${String(ch).padStart(2, "0")}`, "duplicate-output-tap-positions",
                    `Channel ${ch} is tapped by ${taps.length} outputs with different tap positions: ${taps.map((t) => `${t.container}@${t.pos}`).join(", ")} — likely a mistake.`);
            }
        }

        // ----- MUTE GROUP ACTIVE -----
        const muteCfg = s.config?.mute || {};
        const muteFlags = Object.values(muteCfg) as boolean[];
        for (let g = 0; g < muteFlags.length; g++) {
            if (muteFlags[g] !== true) continue;
            const groupBit = 1 << g;
            const muted: string[] = [];
            for (const c of (s.channels || [])) {
                const m = typeof c.grp?.mute === "number" ? c.grp.mute : 0;
                if ((m & groupBit) !== 0) muted.push(`ch${c.n}${c.config?.name ? `(${c.config.name})` : ""}`);
            }
            for (const a of (s.auxins || [])) {
                const m = typeof a.grp?.mute === "number" ? a.grp.mute : 0;
                if ((m & groupBit) !== 0) muted.push(`auxin${a.n}${a.config?.name ? `(${a.config.name})` : ""}`);
            }
            for (const fr of (s.fxrtns || [])) {
                const m = typeof fr.grp?.mute === "number" ? fr.grp.mute : 0;
                if ((m & groupBit) !== 0) muted.push(`fxrtn${fr.n}${fr.config?.name ? `(${fr.config.name})` : ""}`);
            }
            for (const b of (s.buses || [])) {
                const m = typeof b.grp?.mute === "number" ? b.grp.mute : 0;
                if ((m & groupBit) !== 0) muted.push(`bus${b.n}${b.config?.name ? `(${b.config.name})` : ""}`);
            }
            add("info", `config/mute`, "mute-group-active",
                `Mute group ${g + 1} is ACTIVE — strips muted by it: ${muted.length > 0 ? muted.join(", ") : "(none assigned)"}.`);
        }

        // ----- BUS HAS HOT INPUTS BUT IS MUTED OR FADER-DOWN -----
        for (const bus of (s.buses || [])) {
            const busOn = bus.mix?.on === true;
            const busFader: number = typeof bus.mix?.fader === "number" ? bus.mix.fader : -Infinity;
            const isSilent = busOn === false || busFader <= -90;
            if (!isSilent) continue;

            const feeders: string[] = [];
            const collectFeeders = (strips: any[], prefix: string) => {
                for (const strip of (strips || [])) {
                    const send = (strip.sends || []).find((sd: any) => sd.bus === bus.n);
                    if (!send) continue;
                    if (send.on === true && typeof send.level === "number" && send.level > -90) {
                        feeders.push(`${prefix}${strip.n}${strip.config?.name ? `(${strip.config.name})` : ""}`);
                    }
                }
            };
            collectFeeders(s.channels, "ch");
            collectFeeders(s.auxins, "auxin");
            collectFeeders(s.fxrtns, "fxrtn");
            if (feeders.length === 0) continue;

            const tag = `bus/${String(bus.n).padStart(2, "0")}`;
            const busName = bus.config?.name || "?";
            if (busOn === false) {
                add("info", tag, "muted-bus-with-inputs",
                    `MIX${bus.n} (${busName}) is MUTED but fed by ${feeders.length} hot send${feeders.length === 1 ? "" : "s"}: ${feeders.join(", ")}.`);
            } else {
                add("info", tag, "silent-bus-with-inputs",
                    `MIX${bus.n} (${busName}) fader is at -∞ but fed by ${feeders.length} hot send${feeders.length === 1 ? "" : "s"}: ${feeders.join(", ")}.`);
            }
        }

        // ----- ORPHAN BUS: hot input sends, but no output sources from it -----
        const usedBuses = new Set<number>();
        const collectUsedBus = (list: any[]) => {
            for (const o of (list || [])) {
                if (typeof o.src !== "number") continue;
                if (o.src >= 4 && o.src <= 19) usedBuses.add(o.src - 3);
            }
        };
        collectUsedBus(s.outputs?.main || []);
        collectUsedBus(s.outputs?.aux || []);
        collectUsedBus(s.outputs?.p16 || []);
        collectUsedBus(s.outputs?.aes || []);
        collectUsedBus(s.outputs?.rec || []);
        // also: if a bus sends to a matrix, treat as used (matrix is its consumer)
        for (const b of (s.buses || [])) {
            const hotMtxSends = (b.sends || []).filter((sd: any) =>
                sd.on === true && typeof sd.level === "number" && sd.level > -90);
            if (hotMtxSends.length > 0) usedBuses.add(b.n);
        }
        // also: any bus that feeds an FX slot (slot.source like "MIX13") is used
        const fxSourceRe = /^MIX(\d+)$/i;
        for (const slot of (s.fx || [])) {
            for (const k of ["sourceL", "sourceR"]) {
                const v = slot.source?.[k];
                if (typeof v !== "string") continue;
                const m = v.match(fxSourceRe);
                if (m) usedBuses.add(parseInt(m[1], 10));
            }
        }
        for (const b of (s.buses || [])) {
            // Does this bus have hot input sends from any strip?
            let hasHotInput = false;
            const checkSends = (strip: any) => {
                const send = (strip.sends || []).find((sd: any) => sd.bus === b.n);
                if (!send) return;
                if (send.on === true && typeof send.level === "number" && send.level > -90) hasHotInput = true;
            };
            for (const c of (s.channels || [])) checkSends(c);
            for (const a of (s.auxins || [])) checkSends(a);
            for (const fr of (s.fxrtns || [])) checkSends(fr);
            const busOn = b.mix?.on === true;
            if (hasHotInput && !usedBuses.has(b.n) && busOn) {
                add("info", `bus/${String(b.n).padStart(2, "0")}`, "orphan-bus",
                    `MIX${b.n} (${b.config?.name || "?"}) has hot input sends but isn't routed to any output or matrix — orphan bus.`);
            }
        }

        // ----- SORT findings: severity (error > warn > info), then path -----
        const sevRank: Record<string, number> = { error: 0, warn: 1, info: 2 };
        findings.sort((a, b) => {
            const sa = sevRank[a.severity] ?? 3, sb = sevRank[b.severity] ?? 3;
            if (sa !== sb) return sa - sb;
            return a.path.localeCompare(b.path);
        });

        return { findings, snapshotMeta: s.meta };
    }

    // ========== Convenience verbs & comparisons (Phase F) ==========

    /**
     * Diff two channel strips and return only the fields that differ.
     *
     * Reads both channels via getChannelStrip (~26 /node calls each, ~80ms total),
     * walks the result recursively, and emits one entry per leaf where the values
     * disagree. Useful for "why does vocal 2 sound different from vocal 1" —
     * the LLM gets a small, structured list instead of two full strips to diff.
     *
     * Path notation: dot-separated for objects, bracket for arrays.
     * Example outputs: "mix.fader", "eqBands[2].g", "sends[5].on".
     */
    async compareChannelStrips(channelA: number, channelB: number): Promise<{
        a: number;
        b: number;
        differences: Array<{ path: string; a: any; b: any }>;
        identical: boolean;
        elapsedMs: number;
    }> {
        if (channelA < 1 || channelA > 32) throw new Error(`channelA out of range: ${channelA}`);
        if (channelB < 1 || channelB > 32) throw new Error(`channelB out of range: ${channelB}`);
        const t0 = Date.now();
        const [stripA, stripB] = await Promise.all([
            this.getChannelStrip(channelA),
            this.getChannelStrip(channelB),
        ]);
        const elapsedMs = Date.now() - t0;
        const differences = diffDeep(stripA, stripB, "");
        return {
            a: channelA,
            b: channelB,
            differences,
            identical: differences.length === 0,
            elapsedMs,
        };
    }

    /**
     * Diff two scene snapshots (as returned by sceneSnapshot). Pure data — no
     * mixer reads, so callers can compare an old saved snapshot against a fresh
     * one to find drift. Output structure mirrors compareChannelStrips but with
     * per-section grouping (channels[], buses[], main, dcas[], etc.).
     *
     * Excludes the meta section by default (captured_at / wall_ms always differ).
     */
    compareScenes(snapA: any, snapB: any): {
        differences: Array<{ path: string; a: any; b: any }>;
        identical: boolean;
        sectionCounts: Record<string, number>;
    } {
        const a = { ...(snapA ?? {}) };
        const b = { ...(snapB ?? {}) };
        delete a.meta;
        delete b.meta;
        const diffs = diffDeep(a, b, "");
        const sectionCounts: Record<string, number> = {};
        for (const d of diffs) {
            const root = d.path.split(/[.\[]/, 1)[0] || "(root)";
            sectionCounts[root] = (sectionCounts[root] || 0) + 1;
        }
        return {
            differences: diffs,
            identical: diffs.length === 0,
            sectionCounts,
        };
    }

    /**
     * Schema-driven channel copy. Reads source channel's /node containers and
     * writes them to the destination — slot-agnostic and faithful to whatever
     * the source actually has (vs. relying on a hypothetical /-action/copychannel
     * which doesn't exist on firmware 4.13).
     *
     * Containers copied by default (the "sound" of the channel):
     *   mix, eq, eq/1..4, gate, gate/filter, dyn, dyn/filter,
     *   insert, preamp, delay, automix, mix/01..16 (sends to buses)
     *
     * Containers preserved on the destination by default:
     *   config (name, icon, color, source) — identity stays with the channel
     *   grp (DCA + mute group memberships) — routing stays with the channel
     *
     * Pass `includeConfig: true` to also copy identity (name/icon/color/source).
     * Pass `includeGroups: true` to also copy DCA / mute group memberships.
     *
     * Returns the list of containers actually written + any that failed (failures
     * are non-fatal so a partial copy is preferable to a throw mid-way).
     *
     * Known firmware 4.13 quirk: log-scale time params on the dyn container
     * (release, hold, attack) may not propagate exactly via /node prefix-partial
     * writes — the destination may keep its prior value or snap to a different
     * bucket. Run osc_compare_channels post-copy and explicitly osc_node_set
     * any time fields that didn't take.
     */
    async copyChannel(from: number, to: number, options: {
        includeConfig?: boolean;
        includeGroups?: boolean;
    } = {}): Promise<{
        from: number;
        to: number;
        copied: string[];
        skipped: string[];
        failed: Array<{ container: string; error: string }>;
        elapsedMs: number;
    }> {
        if (from < 1 || from > 32) throw new Error(`from out of range: ${from}`);
        if (to < 1 || to > 32) throw new Error(`to out of range: ${to}`);
        if (from === to) throw new Error(`from === to (${from}); copy is a no-op`);
        const t0 = Date.now();
        const fromNN = String(from).padStart(2, "0");
        const toNN = String(to).padStart(2, "0");

        const containers: string[] = [
            "mix", "eq", "eq/1", "eq/2", "eq/3", "eq/4",
            "gate", "gate/filter", "dyn", "dyn/filter",
            "insert", "preamp", "delay", "automix",
        ];
        // Sends mix/01..16 (both odd full-stereo and even reduced shapes)
        for (let b = 1; b <= 16; b++) containers.push(`mix/${String(b).padStart(2, "0")}`);

        if (options.includeConfig) containers.unshift("config");
        if (options.includeGroups) containers.push("grp");

        const copied: string[] = [];
        const skipped: string[] = [];
        const failed: Array<{ container: string; error: string }> = [];

        for (const container of containers) {
            const srcPath = `ch/${fromNN}/${container}`;
            const dstPath = `ch/${toNN}/${container}`;
            try {
                const srcFields = await this.nodeGetField(srcPath);
                if (!srcFields || typeof srcFields !== "object") {
                    skipped.push(container);
                    continue;
                }
                await this.nodeSetField(dstPath, srcFields);
                copied.push(container);
            } catch (e) {
                failed.push({ container, error: e instanceof Error ? e.message : String(e) });
            }
        }

        return {
            from,
            to,
            copied,
            skipped,
            failed,
            elapsedMs: Date.now() - t0,
        };
    }

    close(): void {
        this.isConnected = false;
        this.osc.close();
        if (this.rawSock) {
            try { this.rawSock.close(); } catch { /* socket already closed */ }
            this.rawSock = null;
        }
    }
}

// ========== Deep-diff helper (Phase F) ==========

/**
 * Recursive structural diff. Walks two values in parallel; emits one entry
 * per leaf where they disagree. Uses === for primitives, recurses into objects
 * and arrays. Treats `undefined` and `null` as equivalent so optional fields
 * don't generate noise.
 */
function diffDeep(a: any, b: any, path: string): Array<{ path: string; a: any; b: any }> {
    if (a === b) return [];
    if (a == null && b == null) return [];

    const aIsArr = Array.isArray(a), bIsArr = Array.isArray(b);
    const aIsObj = a !== null && typeof a === "object" && !aIsArr;
    const bIsObj = b !== null && typeof b === "object" && !bIsArr;

    // Primitive mismatch (or shape mismatch where one side is object/array)
    if (aIsArr !== bIsArr || aIsObj !== bIsObj) {
        return [{ path: path || "(root)", a, b }];
    }

    if (aIsArr) {
        const len = Math.max(a.length, b.length);
        const out: Array<{ path: string; a: any; b: any }> = [];
        for (let i = 0; i < len; i++) {
            out.push(...diffDeep(a[i], b[i], `${path}[${i}]`));
        }
        return out;
    }

    if (aIsObj) {
        const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
        const out: Array<{ path: string; a: any; b: any }> = [];
        for (const k of keys) {
            const next = path ? `${path}.${k}` : k;
            out.push(...diffDeep(a[k], b[k], next));
        }
        return out;
    }

    // Both primitive, not equal
    // Floats sometimes wobble by a tiny epsilon on round-trip — tolerate ≤0.01
    if (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 0.01) {
        return [];
    }
    return [{ path: path || "(root)", a, b }];
}
