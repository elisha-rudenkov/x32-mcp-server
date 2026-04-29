// X32 FX algorithm schema — per-type parameter tables.
//
// Each entry maps an FX algorithm (identified by its integer type code returned
// by /fx/N/type, plus a symbolic name) to the ordered list of parameters that
// algorithm exposes via /fx/N/par. The X32 always returns 64 fields from
// /node fx/N/par; only the first `params.length` are meaningful for the
// currently selected algorithm — the rest are inactive padding.
//
// Source: pmaillot "Unofficial X32 OSC Remote Protocol" — EFFECTS section
// (algorithm parameter tables) + Appendix "Effects enums, names and preset
// names table" (FX1..FX4 type code list, 0..60).
//
// Verified against live X32 firmware 4.13 on 2026-04-28 by cycling
// /fx/1/type 0..70 and reading /node fx/1/par. Codes ≥61 clamp to 60 on
// firmware 4.13 — there are 61 algorithms total (0..60).
//
// The X32 renders /fx/N/par values like any /node container: bare ints for
// "i" fields, decimals for "f" fields, "1k", "3k48", "20k0" for log freq,
// and symbolic strings for known enums (OFF/ON, LP/HP/BP/NO, FEM/MALE,
// 1/4, 3/8, 4/3, etc.). Booleans (Active enum [OFF,ON]) are modeled as
// "bool" so callers can pass true/false. Numeric-labeled enums (Factor A
// in 3TAP/4TAP/DLY, Range in SUB, etc.) are modeled as "enum" with the
// symbolic value list — encodeFieldValue accepts either symbol or index.
//
// Where pmaillot's documented enum values disagree with what the live mixer
// returns (e.g. P1A "Lo Freq" — pmaillot says enum [0, 30, 60, 100] but
// firmware 4.13 returned 20), the field is modeled as "int" or "freq" with
// a note rather than enum.

import { FieldDef } from "./node-schema.js";

export interface FxAlgorithmEntry {
    /** Integer code returned by /fx/N/type (0..60). */
    code: number;
    /** Symbolic name from pmaillot (HALL, PLAT, ROOM, ...). */
    name: string;
    /** Human description, e.g. "Hall reverb". */
    description: string;
    /** Whether this algo is available on slots 1..4 (stereo) and/or 5..8 (insert/mono). */
    slots: { stereo: boolean; insert: boolean };
    /** Ordered parameter list. Length is the algorithm's "active" param count;
     *  /node fx/N/par returns 64 fields — slots beyond `params.length` are inactive. */
    params: FieldDef[];
}

// ---------- Common enum value lists ----------
const FACTOR_ENUM = ["1/4", "3/8", "1/2", "2/3", "1", "4/3", "3/2", "2", "3"];
const PATTERN_ENUM = ["1/4", "1/3", "3/8", "1/2", "2/3", "3/4", "1", "1/4X", "1/3X", "3/8X", "1/2X", "2/3X", "3/4X", "1X"];
const RANGE_ENUM = ["LO", "MID", "HI"];
const VOICE_ENUM = ["FEM", "MALE"];
const STMS_ENUM = ["ST", "M/S"];
const DLY_MODE_ENUM = ["ST", "X", "M"];
const FILT_MODE_ENUM = ["LP", "HP", "BP", "NO"];
const FILT_WAVE_ENUM = ["TRI", "SIN", "SAW", "SAW-", "RMP", "SQU", "RND"];
const VREV_POS_ENUM = ["FRONT", "REAR"];
const MODD_SETUP_ENUM = ["PAR", "SER"];
const MODD_TYPE_ENUM = ["AMB", "CLUB", "HALL"];
const MODD_DELAY_ENUM = ["1", "1/2", "2/3", "3/2"];
const ULC_RATIO_ENUM = ["4", "8", "12", "20", "ALL"];
const LEC_MODE_ENUM = ["COMP", "LIM"];
const CMB_BAND_SOLO_ENUM = ["OFF", "Bd1", "Bd2", "Bd3", "Bd4", "Bd5"];
const CMB_XOVER_SLOPE_ENUM = ["12", "48"];
const CMB_RATIO_ENUM = ["1.1", "1.2", "1.3", "1.5", "1.7", "2", "2.5", "3", "3.5", "4", "5", "7", "10", "LIM"];
const CMB_METER_ENUM = ["GR", "SBC", "PEAK"];
const P1A_LOFREQ_ENUM = ["0", "30", "60", "100"];
const P1A_MIDFREQ_ENUM = ["3k", "4k", "5k", "8k", "10k", "12k", "16k"];
const P1A_HIFREQ_ENUM = ["5k", "10k", "20k"];
const PQ5_LOFREQ_ENUM = ["200", "300", "500", "700", "1000"];
const PQ5_MIDFREQ_ENUM = ["200", "300", "500", "700", "1k", "1k5", "2k", "3k", "4k", "5k", "7k"];
const PQ5_HIFREQ_ENUM = ["1k5", "2k", "3k", "4k", "5k"];

// ---------- Reusable param-list factories for symmetric algorithms ----------
function reverbCommon(): FieldDef[] {
    // Used as the *prefix* of HALL/PLAT/AMBI/RPLT/ROOM/CHAM (they share their
    // first 8 params before diverging).
    return [
        { name: "predly", type: "int", range: [0, 200], unit: "ms" },
        { name: "decay", type: "float", unit: "s", note: "logf scale" },
        { name: "size", type: "int", range: [2, 100] },
        { name: "damping", type: "freq", range: [1000, 20000], unit: "Hz" },
        { name: "diffuse", type: "int", range: [1, 30] },
        { name: "level", type: "db", range: [-12, 12], unit: "dB" },
        { name: "loCut", type: "freq", range: [10, 500], unit: "Hz" },
        { name: "hiCut", type: "freq", range: [200, 20000], unit: "Hz" },
    ];
}

const PARAM_PREDLY: FieldDef = { name: "predly", type: "int", range: [0, 200], unit: "ms" };
const PARAM_LEVEL_PM12: FieldDef = { name: "level", type: "db", range: [-12, 12], unit: "dB" };
const PARAM_LO_CUT: FieldDef = { name: "loCut", type: "freq", range: [10, 500], unit: "Hz" };
const PARAM_HI_CUT: FieldDef = { name: "hiCut", type: "freq", range: [200, 20000], unit: "Hz" };

// ---------- The schema ----------

export const FX_ALGORITHM_SCHEMA: FxAlgorithmEntry[] = [
    // ===== Reverbs (codes 0..9) =====
    {
        code: 0, name: "HALL", description: "Hall reverb",
        slots: { stereo: true, insert: false },
        params: [
            ...reverbCommon(),
            { name: "bassMulti", type: "float", range: [0.5, 2] },
            { name: "spread", type: "int", range: [0, 50] },
            { name: "shape", type: "int", range: [0, 250] },
            { name: "modSpeed", type: "int", range: [0, 100] },
        ],
    },
    {
        code: 1, name: "AMBI", description: "Ambiance reverb",
        slots: { stereo: true, insert: false },
        params: [
            ...reverbCommon().slice(0, 8).map((f, i) => i === 1 ? { ...f, range: [0.2, 7.3] as [number, number] } : f),
            { name: "modulate", type: "int", range: [0, 100], unit: "%" },
            { name: "tailGain", type: "int", range: [0, 100] },
        ],
    },
    {
        code: 2, name: "RPLT", description: "Rich plate reverb",
        slots: { stereo: true, insert: false },
        params: [
            { name: "predly", type: "int", range: [0, 200], unit: "ms" },
            { name: "decay", type: "float", range: [0.3, 29], unit: "s" },
            { name: "size", type: "int", range: [4, 39] },
            { name: "damping", type: "freq", range: [1000, 20000], unit: "Hz" },
            { name: "diffuse", type: "int", range: [1, 30] },
            PARAM_LEVEL_PM12,
            PARAM_LO_CUT,
            PARAM_HI_CUT,
            { name: "bassMulti", type: "float", range: [0.25, 4] },
            { name: "spread", type: "int", range: [0, 50] },
            { name: "attack", type: "int", range: [0, 100] },
            { name: "spin", type: "int", range: [0, 100] },
            { name: "echoL", type: "int", range: [0, 1200], unit: "ms" },
            { name: "echoR", type: "int", range: [0, 1200], unit: "ms" },
            { name: "echoFeedL", type: "int", range: [-100, 100] },
            { name: "echoFeedR", type: "int", range: [-100, 100] },
        ],
    },
    {
        code: 3, name: "ROOM", description: "Room reverb",
        slots: { stereo: true, insert: false },
        params: [
            { name: "predly", type: "int", range: [0, 200], unit: "ms" },
            { name: "decay", type: "float", range: [0.3, 29], unit: "s" },
            { name: "size", type: "int", range: [4, 72] },
            { name: "damping", type: "freq", range: [1000, 20000], unit: "Hz" },
            { name: "diffuse", type: "int", range: [1, 30] },
            PARAM_LEVEL_PM12,
            PARAM_LO_CUT,
            PARAM_HI_CUT,
            { name: "bassMulti", type: "float", range: [0.25, 4] },
            { name: "spread", type: "int", range: [0, 50] },
            { name: "shape", type: "int", range: [0, 250] },
            { name: "spin", type: "int", range: [0, 100] },
            { name: "echoL", type: "int", range: [0, 1200], unit: "ms" },
            { name: "echoR", type: "int", range: [0, 1200], unit: "ms" },
        ],
    },
    {
        code: 4, name: "CHAM", description: "Chamber reverb",
        slots: { stereo: true, insert: false },
        params: [
            { name: "predly", type: "int", range: [0, 200], unit: "ms" },
            { name: "decay", type: "float", range: [0.3, 29], unit: "s" },
            { name: "size", type: "int", range: [4, 72] },
            { name: "damping", type: "freq", range: [1000, 20000], unit: "Hz" },
            { name: "diffuse", type: "int", range: [1, 30] },
            PARAM_LEVEL_PM12,
            PARAM_LO_CUT,
            PARAM_HI_CUT,
            { name: "bassMulti", type: "float", range: [0.25, 4] },
            { name: "spread", type: "int", range: [0, 50] },
            { name: "shape", type: "int", range: [0, 250] },
            { name: "spin", type: "int", range: [0, 100] },
            { name: "reflectionL", type: "int", range: [0, 500] },
            { name: "reflectionR", type: "int", range: [0, 500] },
            { name: "reflectionGainL", type: "int", range: [0, 100] },
            { name: "reflectionGainR", type: "int", range: [0, 100] },
        ],
    },
    {
        code: 5, name: "PLAT", description: "Plate reverb",
        slots: { stereo: true, insert: false },
        params: [
            { name: "predly", type: "int", range: [0, 200], unit: "ms" },
            { name: "decay", type: "float", range: [0.2, 10], unit: "s" },
            { name: "size", type: "int", range: [2, 100] },
            { name: "damping", type: "freq", range: [1000, 20000], unit: "Hz" },
            { name: "diffuse", type: "int", range: [1, 30] },
            PARAM_LEVEL_PM12,
            PARAM_LO_CUT,
            PARAM_HI_CUT,
            { name: "bassMulti", type: "float", range: [0.5, 2] },
            { name: "xover", type: "freq", range: [10, 500], unit: "Hz" },
            { name: "mod", type: "int", range: [0, 50] },
            { name: "modSpeed", type: "int", range: [0, 100] },
        ],
    },
    {
        code: 6, name: "VREV", description: "Vintage reverb",
        slots: { stereo: true, insert: false },
        params: [
            { name: "predly", type: "int", range: [0, 120], unit: "ms" },
            { name: "decay", type: "float", range: [0.3, 4.5], unit: "s" },
            { name: "modulate", type: "int", range: [0, 10] },
            { name: "vintage", type: "bool" },
            { name: "position", type: "enum", values: VREV_POS_ENUM },
            PARAM_LEVEL_PM12,
            PARAM_LO_CUT,
            PARAM_HI_CUT,
            { name: "loMultiply", type: "float", range: [0.5, 2] },
            { name: "hiMultiply", type: "float", range: [0.25, 1] },
        ],
    },
    {
        code: 7, name: "VRM", description: "Vintage room",
        slots: { stereo: true, insert: false },
        params: [
            { name: "reverbDelay", type: "int", range: [0, 20], unit: "ms" },
            { name: "decay", type: "float", range: [0.1, 20], unit: "s" },
            { name: "size", type: "int", range: [0, 10] },
            { name: "density", type: "int", range: [1, 30] },
            { name: "erLevel", type: "int", range: [0, 190] },
            PARAM_LEVEL_PM12,
            { name: "loMultiply", type: "float", range: [0.1, 10] },
            { name: "hiMultiply", type: "float", range: [0.1, 10] },
            PARAM_LO_CUT,
            PARAM_HI_CUT,
            { name: "erLeft", type: "int", range: [0, 10] },
            { name: "erRight", type: "int", range: [0, 10] },
            { name: "freeze", type: "bool" },
        ],
    },
    {
        code: 8, name: "GATE", description: "Gated reverb",
        slots: { stereo: true, insert: false },
        params: [
            { name: "predly", type: "int", range: [0, 200], unit: "ms" },
            { name: "decay", type: "int", range: [140, 1000], unit: "ms" },
            { name: "attack", type: "int", range: [0, 30] },
            { name: "density", type: "int", range: [1, 30] },
            { name: "spread", type: "int", range: [0, 100] },
            PARAM_LEVEL_PM12,
            PARAM_LO_CUT,
            PARAM_HI_CUT,
            { name: "hiShvGain", type: "db", range: [-30, 0], unit: "dB" },
            { name: "diffuse", type: "int", range: [1, 30] },
        ],
    },
    {
        code: 9, name: "RVRS", description: "Reverse reverb",
        slots: { stereo: true, insert: false },
        params: [
            { name: "predly", type: "int", range: [0, 200], unit: "ms" },
            { name: "decay", type: "int", range: [140, 1000], unit: "ms" },
            { name: "rise", type: "int", range: [0, 50] },
            { name: "diffuse", type: "int", range: [1, 30] },
            { name: "spread", type: "int", range: [1, 100] },
            PARAM_LEVEL_PM12,
            PARAM_LO_CUT,
            PARAM_HI_CUT,
            { name: "hiShvGain", type: "db", range: [-30, 0], unit: "dB" },
        ],
    },

    // ===== Delays (codes 10..12) =====
    {
        code: 10, name: "DLY", description: "Stereo delay",
        slots: { stereo: true, insert: false },
        params: [
            { name: "mix", type: "int", range: [0, 100], unit: "%" },
            { name: "time", type: "int", range: [0, 3000], unit: "ms" },
            { name: "mode", type: "enum", values: DLY_MODE_ENUM, note: "ST=stereo, X=cross, M=mono" },
            { name: "factorL", type: "enum", values: FACTOR_ENUM },
            { name: "factorR", type: "enum", values: FACTOR_ENUM },
            { name: "offsetLR", type: "int", range: [-100, 100] },
            PARAM_LO_CUT,
            PARAM_HI_CUT,
            { name: "feedLoCut", type: "freq", range: [10, 500], unit: "Hz" },
            { name: "feedLeft", type: "int", range: [1, 100] },
            { name: "feedRight", type: "int", range: [1, 100] },
            { name: "feedHiCut", type: "freq", range: [200, 20000], unit: "Hz" },
        ],
    },
    {
        code: 11, name: "3TAP", description: "3-tap delay",
        slots: { stereo: true, insert: false },
        params: [
            { name: "dry", type: "int", range: [0, 3000], unit: "ms" },
            { name: "gainBase", type: "int", range: [0, 100] },
            { name: "panBase", type: "int", range: [-100, 100] },
            { name: "feedback", type: "int", range: [0, 100], unit: "%" },
            PARAM_LO_CUT,
            PARAM_HI_CUT,
            { name: "factorA", type: "enum", values: FACTOR_ENUM },
            { name: "gainA", type: "int", range: [0, 100] },
            { name: "panA", type: "int", range: [-100, 100] },
            { name: "factorB", type: "enum", values: FACTOR_ENUM },
            { name: "gainB", type: "int", range: [0, 100] },
            { name: "panB", type: "int", range: [-100, 100] },
            { name: "crossFeed", type: "bool" },
            { name: "mono", type: "bool" },
            { name: "dryEnable", type: "bool", note: "enum [OFF,ON] — distinct from `dry` time" },
        ],
    },
    {
        code: 12, name: "4TAP", description: "4-tap delay",
        slots: { stereo: true, insert: false },
        params: [
            { name: "time", type: "int", range: [1, 3000], unit: "ms" },
            { name: "gainBase", type: "int", range: [0, 100] },
            { name: "feedback", type: "int", range: [0, 100], unit: "%" },
            PARAM_LO_CUT,
            PARAM_HI_CUT,
            { name: "spread", type: "int", range: [0, 6] },
            { name: "factorA", type: "enum", values: FACTOR_ENUM },
            { name: "gainA", type: "int", range: [0, 100] },
            { name: "factorB", type: "enum", values: FACTOR_ENUM },
            { name: "gainB", type: "int", range: [0, 100] },
            { name: "factorC", type: "enum", values: FACTOR_ENUM },
            { name: "gainC", type: "int", range: [0, 100] },
            { name: "crossFeed", type: "bool" },
            { name: "mono", type: "bool" },
            { name: "dry", type: "bool" },
        ],
    },

    // ===== Modulation (codes 13..19) =====
    {
        code: 13, name: "CRS", description: "Stereo chorus",
        slots: { stereo: true, insert: false },
        params: [
            { name: "speed", type: "float", range: [0.05, 5], unit: "Hz" },
            { name: "depthL", type: "int", range: [0, 100] },
            { name: "depthR", type: "int", range: [0, 100] },
            { name: "delayL", type: "float", range: [0.5, 20], unit: "ms" },
            { name: "delayR", type: "float", range: [0.5, 20], unit: "ms" },
            { name: "mix", type: "int", range: [0, 100], unit: "%" },
            PARAM_LO_CUT,
            PARAM_HI_CUT,
            { name: "phase", type: "int", range: [0, 180] },
            { name: "wave", type: "int", range: [0, 100] },
            { name: "spread", type: "int", range: [0, 100] },
        ],
    },
    {
        code: 14, name: "FLNG", description: "Stereo flanger",
        slots: { stereo: true, insert: false },
        params: [
            { name: "speed", type: "float", range: [0.05, 5], unit: "Hz" },
            { name: "depthL", type: "int", range: [0, 100] },
            { name: "depthR", type: "int", range: [0, 100] },
            { name: "delayL", type: "float", range: [0.5, 20], unit: "ms" },
            { name: "delayR", type: "float", range: [0.5, 20], unit: "ms" },
            { name: "mix", type: "int", range: [0, 100], unit: "%" },
            PARAM_LO_CUT,
            PARAM_HI_CUT,
            { name: "phase", type: "int", range: [0, 180] },
            { name: "feedLoCut", type: "freq", range: [10, 500], unit: "Hz" },
            { name: "feedHiCut", type: "freq", range: [200, 20000], unit: "Hz" },
            { name: "feed", type: "int", range: [-90, 90] },
        ],
    },
    {
        code: 15, name: "PHAS", description: "Stereo phaser",
        slots: { stereo: true, insert: true, /* slots 5-8 also list PHAS at code 30 */ },
        params: [
            { name: "speed", type: "float", range: [0.05, 5], unit: "Hz" },
            { name: "depth", type: "int", range: [0, 100] },
            { name: "resonance", type: "int", range: [0, 80] },
            { name: "base", type: "int", range: [0, 50] },
            { name: "stages", type: "int", range: [2, 12] },
            { name: "mix", type: "int", range: [0, 100], unit: "%" },
            { name: "wave", type: "int", range: [-50, 50] },
            { name: "phase", type: "int", range: [0, 180] },
            { name: "envMod", type: "int", range: [-100, 100] },
            { name: "attack", type: "float", range: [10, 1000], unit: "ms" },
            { name: "hold", type: "float", range: [1, 2000], unit: "ms" },
            { name: "release", type: "float", range: [10, 1000], unit: "ms" },
        ],
    },
    {
        code: 16, name: "DIMC", description: "Dimensional chorus",
        slots: { stereo: true, insert: false },
        params: [
            { name: "active", type: "bool" },
            { name: "mode", type: "enum", values: ["M", "ST"] },
            { name: "dry", type: "bool" },
            { name: "mode1", type: "bool" },
            { name: "mode2", type: "bool" },
            { name: "mode3", type: "bool" },
            { name: "mode4", type: "bool" },
        ],
    },
    {
        code: 17, name: "FILT", description: "Mood filter",
        slots: { stereo: true, insert: true },
        params: [
            { name: "speed", type: "float", range: [0.05, 20], unit: "Hz" },
            { name: "depth", type: "int", range: [0, 100] },
            { name: "resonance", type: "int", range: [0, 100] },
            { name: "base", type: "freq", range: [10, 15000], unit: "Hz" },
            { name: "mode", type: "enum", values: FILT_MODE_ENUM },
            { name: "mix", type: "int", range: [0, 100], unit: "%" },
            { name: "wave", type: "enum", values: FILT_WAVE_ENUM },
            { name: "phase", type: "int", range: [0, 180] },
            { name: "envMod", type: "int", range: [-100, 100] },
            { name: "attack", type: "float", range: [10, 250], unit: "ms" },
            { name: "release", type: "float", range: [10, 500], unit: "ms" },
            { name: "drive", type: "int", range: [0, 100] },
            { name: "fourPole", type: "enum", values: ["2POL", "4POL"], note: "filter slope; pmaillot lists OFF/ON but firmware renders 2POL/4POL" },
            { name: "sideChain", type: "bool" },
        ],
    },
    {
        code: 18, name: "ROTA", description: "Rotary speaker",
        slots: { stereo: true, insert: false },
        params: [
            { name: "loSpeed", type: "float", range: [0.1, 4], unit: "Hz" },
            { name: "hiSpeed", type: "float", range: [2, 10], unit: "Hz" },
            { name: "accelerate", type: "int", range: [0, 100] },
            { name: "distance", type: "int", range: [0, 100] },
            { name: "balance", type: "int", range: [-100, 100] },
            { name: "mix", type: "int", range: [0, 100], unit: "%" },
            { name: "stop", type: "enum", values: ["RUN", "STOP"], note: "pmaillot says OFF/ON; firmware renders RUN/STOP" },
            { name: "slow", type: "enum", values: ["SLOW", "FAST"], note: "pmaillot says OFF/ON; firmware renders SLOW/FAST" },
        ],
    },
    {
        code: 19, name: "PAN", description: "Tremolo / panner",
        slots: { stereo: true, insert: true },
        params: [
            { name: "speed", type: "float", range: [0.05, 4], unit: "Hz" },
            { name: "phase", type: "int", range: [0, 180] },
            { name: "wave", type: "int", range: [-50, 50] },
            { name: "depth", type: "int", range: [0, 100] },
            { name: "envSpeed", type: "int", range: [0, 100] },
            { name: "envDepth", type: "int", range: [0, 100] },
            { name: "attack", type: "float", range: [10, 1000], unit: "ms" },
            { name: "hold", type: "float", range: [1, 2000], unit: "ms" },
            { name: "release", type: "float", range: [10, 1000], unit: "ms" },
        ],
    },

    // ===== Suboctaver (code 20) — dual-mono shape (5 params × 2 channels) =====
    {
        code: 20, name: "SUB", description: "Sub octaver (dual mono)",
        slots: { stereo: true, insert: true },
        params: [
            { name: "activeA", type: "bool" },
            { name: "rangeA", type: "enum", values: RANGE_ENUM },
            { name: "dryA", type: "int", range: [0, 100] },
            { name: "octaveDownA", type: "int", range: [0, 100], note: "octave -1 mix" },
            { name: "octaveDown2A", type: "int", range: [0, 100], note: "octave -2 mix" },
            { name: "activeB", type: "bool" },
            { name: "rangeB", type: "enum", values: RANGE_ENUM },
            { name: "dryB", type: "int", range: [0, 100] },
            { name: "octaveDownB", type: "int", range: [0, 100] },
            { name: "octaveDown2B", type: "int", range: [0, 100] },
        ],
    },

    // ===== Combo effects (codes 21..26) — 12 params each =====
    // D/RV, CR/R, FL/R: param[0..5] = mod section, param[6..11] = chamber section.
    // D/CR, D/FL: time-based delay + modulation.
    // MODD: 13 params with mid-position enums.
    {
        code: 21, name: "D/RV", description: "Delay + chamber",
        slots: { stereo: true, insert: false },
        params: [
            { name: "time", type: "int", range: [1, 3000], unit: "ms" },
            { name: "pattern", type: "enum", values: PATTERN_ENUM },
            { name: "feedHiCut", type: "freq", range: [1000, 20000], unit: "Hz" },
            { name: "feedback", type: "int", range: [0, 100], unit: "%" },
            { name: "crossFeed", type: "int", range: [0, 100] },
            { name: "balance", type: "int", range: [-100, 100] },
            { name: "predly", type: "int", range: [0, 200], unit: "ms" },
            { name: "decay", type: "float", range: [0.1, 5], unit: "s" },
            { name: "size", type: "int", range: [2, 100] },
            { name: "damping", type: "freq", range: [1000, 20000], unit: "Hz" },
            PARAM_LO_CUT,
            { name: "mix", type: "int", range: [0, 100], unit: "%" },
        ],
    },
    {
        code: 22, name: "CR/R", description: "Chorus + chamber",
        slots: { stereo: true, insert: false },
        params: [
            { name: "speed", type: "float", range: [0.05, 4], unit: "Hz" },
            { name: "depth", type: "int", range: [0, 100] },
            { name: "delay", type: "float", range: [0.5, 50], unit: "ms" },
            { name: "phase", type: "int", range: [0, 180] },
            { name: "wave", type: "int", range: [0, 100] },
            { name: "balance", type: "int", range: [-100, 100] },
            { name: "predly", type: "int", range: [0, 200], unit: "ms" },
            { name: "decay", type: "float", range: [0.1, 5], unit: "s" },
            { name: "size", type: "int", range: [2, 100] },
            { name: "damping", type: "freq", range: [1000, 20000], unit: "Hz" },
            PARAM_LO_CUT,
            { name: "mix", type: "int", range: [0, 100], unit: "%" },
        ],
    },
    {
        code: 23, name: "FL/R", description: "Flanger + chamber",
        slots: { stereo: true, insert: false },
        params: [
            { name: "speed", type: "float", range: [0.05, 4], unit: "Hz" },
            { name: "depth", type: "int", range: [0, 100] },
            { name: "delay", type: "float", range: [0.5, 20], unit: "ms" },
            { name: "phase", type: "int", range: [0, 180] },
            { name: "feed", type: "int", range: [-90, 90] },
            { name: "balance", type: "int", range: [-100, 100] },
            { name: "predly", type: "int", range: [0, 200], unit: "ms" },
            { name: "decay", type: "float", range: [0.1, 5], unit: "s" },
            { name: "size", type: "int", range: [2, 100] },
            { name: "damping", type: "freq", range: [1000, 20000], unit: "Hz" },
            PARAM_LO_CUT,
            { name: "mix", type: "int", range: [0, 100], unit: "%" },
        ],
    },
    {
        code: 24, name: "D/CR", description: "Delay + chorus",
        slots: { stereo: true, insert: false },
        params: [
            { name: "time", type: "int", range: [1, 3000], unit: "ms" },
            { name: "pattern", type: "enum", values: PATTERN_ENUM },
            { name: "feedHiCut", type: "freq", range: [1000, 20000], unit: "Hz" },
            { name: "feedback", type: "int", range: [0, 100], unit: "%" },
            { name: "crossFeed", type: "int", range: [0, 100] },
            { name: "balance", type: "int", range: [-100, 100] },
            { name: "speed", type: "float", range: [0.05, 4], unit: "Hz" },
            { name: "depth", type: "int", range: [0, 100] },
            { name: "delay", type: "float", range: [0.5, 50], unit: "ms" },
            { name: "phase", type: "int", range: [0, 180] },
            { name: "wave", type: "int", range: [0, 100] },
            { name: "mix", type: "int", range: [0, 100], unit: "%" },
        ],
    },
    {
        code: 25, name: "D/FL", description: "Delay + flanger",
        slots: { stereo: true, insert: false },
        params: [
            { name: "time", type: "int", range: [1, 3000], unit: "ms" },
            { name: "pattern", type: "enum", values: PATTERN_ENUM },
            { name: "feedHiCut", type: "freq", range: [1000, 20000], unit: "Hz" },
            { name: "feedback", type: "int", range: [0, 100], unit: "%" },
            { name: "crossFeed", type: "int", range: [0, 100] },
            { name: "balance", type: "int", range: [-100, 100] },
            { name: "speed", type: "float", range: [0.05, 4], unit: "Hz" },
            { name: "depth", type: "int", range: [0, 100] },
            { name: "delay", type: "float", range: [0.5, 20], unit: "ms" },
            { name: "phase", type: "int", range: [0, 180] },
            { name: "feed", type: "int", range: [-90, 90] },
            { name: "mix", type: "int", range: [0, 100], unit: "%" },
        ],
    },
    {
        code: 26, name: "MODD", description: "Modulation delay",
        slots: { stereo: true, insert: false },
        params: [
            { name: "time", type: "int", range: [1, 3000], unit: "ms" },
            { name: "delay", type: "enum", values: MODD_DELAY_ENUM, note: "tempo subdivision" },
            { name: "feed", type: "int", range: [0, 100], unit: "%" },
            PARAM_LO_CUT,
            PARAM_HI_CUT,
            { name: "depthRate", type: "int", range: [0, 100] },
            { name: "rate", type: "float", range: [0.05, 10], unit: "Hz" },
            { name: "setup", type: "enum", values: MODD_SETUP_ENUM },
            { name: "type", type: "enum", values: MODD_TYPE_ENUM },
            { name: "decay", type: "int", range: [1, 10] },
            { name: "damping", type: "freq", range: [1000, 20000], unit: "Hz" },
            { name: "balance", type: "int", range: [-100, 100] },
            { name: "mix", type: "int", range: [0, 100], unit: "%" },
        ],
    },

    // ===== Graphic / True EQ (codes 27..30) — 32 or 64 sliders + master =====
    // GEQ2 / TEQ2 (dual): 31 sliders A + 1 master A + 31 sliders B + 1 master B = 64 fields.
    // GEQ / TEQ (stereo): 31 sliders L/R + 1 master L/R = 32 fields. Mixer pads remaining 32 with 0.
    {
        code: 27, name: "GEQ2", description: "Dual 31-band graphic EQ",
        slots: { stereo: true, insert: true },
        params: [
            ...geqBands("A"),
            { name: "masterA", type: "db", range: [-15, 15], unit: "dB" },
            ...geqBands("B"),
            { name: "masterB", type: "db", range: [-15, 15], unit: "dB" },
        ],
    },
    {
        code: 28, name: "GEQ", description: "Stereo 31-band graphic EQ",
        slots: { stereo: true, insert: true },
        params: [
            ...geqBands(""),
            { name: "master", type: "db", range: [-15, 15], unit: "dB" },
        ],
    },
    {
        code: 29, name: "TEQ2", description: "Dual TruEQ (no-ripple 31-band)",
        slots: { stereo: true, insert: true },
        params: [
            ...geqBands("A"),
            { name: "masterA", type: "db", range: [-15, 15], unit: "dB" },
            ...geqBands("B"),
            { name: "masterB", type: "db", range: [-15, 15], unit: "dB" },
        ],
    },
    {
        code: 30, name: "TEQ", description: "Stereo TruEQ (no-ripple 31-band)",
        slots: { stereo: true, insert: true },
        params: [
            ...geqBands(""),
            { name: "master", type: "db", range: [-15, 15], unit: "dB" },
        ],
    },

    // ===== De-Esser (codes 31..32) =====
    {
        code: 31, name: "DES2", description: "Dual de-esser",
        slots: { stereo: true, insert: true },
        params: [
            { name: "loBandA", type: "int", range: [0, 50] },
            { name: "hiBandA", type: "int", range: [0, 50] },
            { name: "loBandB", type: "int", range: [0, 50] },
            { name: "hiBandB", type: "int", range: [0, 50] },
            { name: "voiceA", type: "enum", values: VOICE_ENUM },
            { name: "voiceB", type: "enum", values: VOICE_ENUM },
        ],
    },
    {
        code: 32, name: "DES", description: "Stereo de-esser",
        slots: { stereo: true, insert: true },
        params: [
            { name: "loBandL", type: "int", range: [0, 50] },
            { name: "hiBandL", type: "int", range: [0, 50] },
            { name: "loBandR", type: "int", range: [0, 50] },
            { name: "hiBandR", type: "int", range: [0, 50] },
            { name: "voice", type: "enum", values: VOICE_ENUM },
            { name: "mode", type: "enum", values: STMS_ENUM },
        ],
    },

    // ===== Pultec/Xtec EQs (codes 33..36) =====
    // pmaillot lists Lo Freq / Mid Freq / Hi Freq as discrete enums but firmware
    // 4.13 returns continuous values that don't match (e.g. P1A Lo Freq read 20).
    // Modeling as "freq" preserves whatever the mixer returns.
    {
        code: 33, name: "P1A", description: "Stereo Pultec EQ1",
        slots: { stereo: true, insert: true },
        params: [
            { name: "active", type: "bool" },
            { name: "gain", type: "db", range: [-12, 12], unit: "dB" },
            { name: "loBoost", type: "int", range: [0, 10] },
            { name: "loFreq", type: "freq", note: "pmaillot enum [0,30,60,100]; firmware returns continuous" },
            { name: "midWidth", type: "float", range: [0, 10] },
            { name: "midBoost", type: "float", range: [0, 10] },
            { name: "midFreq", type: "freq", note: "pmaillot enum [3k..16k]" },
            { name: "hiAttenuation", type: "int", range: [0, 10] },
            { name: "hiFreq", type: "freq", note: "pmaillot enum [5k,10k,20k]" },
            { name: "transformer", type: "bool" },
            { name: "extra", type: "int", note: "11th param documented in pmaillot signature but not in name table" },
        ],
    },
    {
        code: 34, name: "P1A2", description: "Dual Pultec EQ1",
        slots: { stereo: true, insert: true },
        params: [
            ...pultecEq1Side("A"),
            ...pultecEq1Side("B"),
        ],
    },
    {
        code: 35, name: "PQ5", description: "Stereo Midrange EQ (Pultec EQP-5)",
        slots: { stereo: true, insert: true },
        params: [
            { name: "active", type: "bool" },
            { name: "gain", type: "db", range: [-12, 12], unit: "dB" },
            { name: "loFreq", type: "enum", values: PQ5_LOFREQ_ENUM, unit: "Hz" },
            { name: "loBoost", type: "float", range: [0, 10] },
            { name: "midFreq", type: "enum", values: PQ5_MIDFREQ_ENUM, unit: "Hz" },
            { name: "midBoost", type: "float", range: [0, 10] },
            { name: "hiFreq", type: "enum", values: PQ5_HIFREQ_ENUM, unit: "Hz" },
            { name: "hiBoost", type: "float", range: [0, 10] },
            { name: "transformer", type: "bool" },
        ],
    },
    {
        code: 36, name: "PQ5S", description: "Dual Midrange EQ (Pultec EQP-5)",
        slots: { stereo: true, insert: true },
        params: [
            ...pq5Side("A"),
            ...pq5Side("B"),
        ],
    },

    // ===== Wave Designer / Limiter (codes 37..38) =====
    {
        code: 37, name: "WAVD", description: "Wave designer (transient shaper)",
        slots: { stereo: true, insert: true },
        params: [
            { name: "attackA", type: "int", range: [-100, 100] },
            { name: "sustainA", type: "int", range: [-100, 100] },
            { name: "gainA", type: "db", range: [-24, 24], unit: "dB" },
            { name: "attackB", type: "int", range: [-100, 100] },
            { name: "sustainB", type: "int", range: [-100, 100] },
            { name: "gainB", type: "db", range: [-24, 24], unit: "dB" },
        ],
    },
    {
        code: 38, name: "LIM", description: "Precision limiter",
        slots: { stereo: true, insert: true },
        params: [
            { name: "inputGain", type: "db", range: [0, 18], unit: "dB" },
            { name: "outGain", type: "db", range: [-18, 18], unit: "dB" },
            { name: "squeeze", type: "int", range: [0, 100] },
            { name: "knee", type: "int", range: [0, 10] },
            { name: "attack", type: "float", range: [0.05, 1], unit: "ms" },
            { name: "release", type: "float", range: [20, 2000], unit: "ms" },
            { name: "stereoLink", type: "bool" },
            { name: "autoGain", type: "bool" },
        ],
    },

    // ===== Combinator (codes 39..40) — multiband dynamics =====
    // Param tables in pmaillot have severe column-misalignment; the schema
    // captures the field count from the signatures (16 mono / 32 dual) and
    // names per-band fields positionally. params 7..15 are best-effort.
    {
        code: 39, name: "CMB", description: "Stereo combinator (5-band dynamics)",
        slots: { stereo: true, insert: true },
        params: [
            { name: "active", type: "bool" },
            { name: "bandSolo", type: "enum", values: CMB_BAND_SOLO_ENUM },
            { name: "mix", type: "int", range: [0, 100], unit: "%" },
            { name: "attack", type: "int", range: [0, 19] },
            { name: "release", type: "float", range: [20, 3000], unit: "ms" },
            { name: "autorelease", type: "bool" },
            { name: "sbcSpeed", type: "int", range: [0, 10] },
            { name: "sbcOn", type: "bool" },
            { name: "xover", type: "int", range: [-50, 50] },
            { name: "xoverSlope", type: "enum", values: CMB_XOVER_SLOPE_ENUM, unit: "dB/oct" },
            { name: "ratio", type: "enum", values: CMB_RATIO_ENUM },
            { name: "threshold", type: "db", range: [-40, 0], unit: "dB" },
            { name: "gain", type: "db", range: [-10, 10], unit: "dB" },
            { name: "band1Threshold", type: "db", range: [-10, 10], unit: "dB" },
            { name: "band1Gain", type: "db", range: [-10, 10], unit: "dB" },
            { name: "band1Lock", type: "bool" },
            { name: "band2Threshold", type: "db", range: [-10, 10], unit: "dB" },
            { name: "band2Gain", type: "db", range: [-10, 10], unit: "dB" },
            { name: "band2Lock", type: "bool" },
            { name: "band3Threshold", type: "db", range: [-10, 10], unit: "dB" },
            { name: "band3Gain", type: "db", range: [-10, 10], unit: "dB" },
            { name: "band3Lock", type: "bool" },
            { name: "band4Threshold", type: "db", range: [-10, 10], unit: "dB" },
            { name: "band4Gain", type: "db", range: [-10, 10], unit: "dB" },
            { name: "band4Lock", type: "bool" },
            { name: "band5Threshold", type: "db", range: [-10, 10], unit: "dB" },
            { name: "band5Gain", type: "db", range: [-10, 10], unit: "dB" },
            { name: "band5Lock", type: "bool" },
            { name: "meterMode", type: "enum", values: CMB_METER_ENUM },
        ],
    },
    {
        code: 40, name: "CMB2", description: "Dual combinator",
        slots: { stereo: true, insert: true },
        // 28 params per channel × 2 = 56 — but signature shows 50ish; mark each side with prefix.
        params: [
            ...combinatorSide("A"),
            ...combinatorSide("B"),
        ],
    },

    // ===== Fairchild / Leisure / Ultimo / Edison (codes 41..47, 53..54) =====
    {
        code: 41, name: "FAC", description: "Fair Comp (Fairchild stereo)",
        slots: { stereo: true, insert: true },
        params: facStereoParams(),
    },
    {
        code: 42, name: "FAC1M", description: "Fair Comp M/S",
        slots: { stereo: true, insert: true },
        params: facDualParams("M", "S"),
    },
    {
        code: 43, name: "FAC2", description: "Dual Fair Comp",
        slots: { stereo: true, insert: true },
        params: facDualParams("A", "B"),
    },
    {
        code: 44, name: "LEC", description: "Leisure Comp (stereo)",
        slots: { stereo: true, insert: true },
        params: [
            { name: "active", type: "bool" },
            { name: "gain", type: "int", range: [0, 100] },
            { name: "peak", type: "int", range: [0, 100] },
            { name: "mode", type: "enum", values: LEC_MODE_ENUM },
            { name: "outGain", type: "db", range: [-18, 6], unit: "dB" },
        ],
    },
    {
        code: 45, name: "LEC2", description: "Dual Leisure Comp",
        slots: { stereo: true, insert: true },
        params: [
            { name: "activeA", type: "bool" },
            { name: "gainA", type: "int", range: [0, 100] },
            { name: "peakA", type: "int", range: [0, 100] },
            { name: "modeA", type: "enum", values: LEC_MODE_ENUM },
            { name: "outGainA", type: "db", range: [-18, 6], unit: "dB" },
            { name: "activeB", type: "bool" },
            { name: "gainB", type: "int", range: [0, 100] },
            { name: "peakB", type: "int", range: [0, 100] },
            { name: "modeB", type: "enum", values: LEC_MODE_ENUM },
            { name: "outGainB", type: "db", range: [-18, 6], unit: "dB" },
        ],
    },
    {
        code: 46, name: "ULC", description: "Ultimo Comp (stereo, 1176-style)",
        slots: { stereo: true, insert: true },
        params: [
            { name: "active", type: "bool" },
            { name: "inputGain", type: "db", range: [-48, 0], unit: "dB" },
            { name: "outGain", type: "db", range: [-48, 0], unit: "dB" },
            { name: "attack", type: "int", range: [1, 7] },
            { name: "release", type: "int", range: [1, 7] },
            { name: "ratio", type: "enum", values: ULC_RATIO_ENUM },
        ],
    },
    {
        code: 47, name: "ULC2", description: "Dual Ultimo Comp",
        slots: { stereo: true, insert: true },
        params: [
            { name: "activeA", type: "bool" },
            { name: "inputGainA", type: "db", range: [-48, 0], unit: "dB" },
            { name: "outGainA", type: "db", range: [-48, 0], unit: "dB" },
            { name: "attackA", type: "int", range: [1, 7] },
            { name: "releaseA", type: "int", range: [1, 7] },
            { name: "ratioA", type: "enum", values: ULC_RATIO_ENUM },
            { name: "activeB", type: "bool" },
            { name: "inputGainB", type: "db", range: [-48, 0], unit: "dB" },
            { name: "outGainB", type: "db", range: [-48, 0], unit: "dB" },
            { name: "attackB", type: "int", range: [1, 7] },
            { name: "releaseB", type: "int", range: [1, 7] },
            { name: "ratioB", type: "enum", values: ULC_RATIO_ENUM },
        ],
    },

    // ===== Enhancer / Exciter (codes 48..51) =====
    {
        code: 48, name: "ENH2", description: "Dual enhancer",
        slots: { stereo: true, insert: true },
        params: [
            ...enhancerSide("A"),
            ...enhancerSide("B"),
        ],
    },
    {
        code: 49, name: "ENH", description: "Stereo enhancer",
        slots: { stereo: true, insert: true },
        params: enhancerSide(""),
    },
    {
        code: 50, name: "EXC2", description: "Dual exciter",
        slots: { stereo: true, insert: true },
        params: [
            ...exciterSide("A"),
            ...exciterSide("B"),
        ],
    },
    {
        code: 51, name: "EXC", description: "Stereo exciter",
        slots: { stereo: true, insert: true },
        params: exciterSide(""),
    },

    // ===== Imager / Edison / Sound Maxer (codes 52..54) =====
    {
        code: 52, name: "IMG", description: "Stereo imager",
        slots: { stereo: true, insert: true },
        params: [
            { name: "balance", type: "int", range: [-100, 100] },
            { name: "monoPan", type: "int", range: [-100, 100] },
            { name: "stereoPan", type: "int", range: [-100, 100] },
            { name: "shvGain", type: "db", range: [0, 12], unit: "dB" },
            { name: "shvFreq", type: "freq", range: [100, 1000], unit: "Hz" },
            { name: "shvQ", type: "float", range: [1, 10] },
            { name: "outGain", type: "db", range: [-12, 12], unit: "dB" },
        ],
    },
    {
        code: 53, name: "EDI", description: "Edison EX1 (stereo widener)",
        slots: { stereo: true, insert: true },
        params: [
            { name: "active", type: "bool" },
            { name: "stereoInput", type: "enum", values: STMS_ENUM },
            { name: "stereoOutput", type: "enum", values: STMS_ENUM },
            { name: "stSpread", type: "int", range: [-50, 50] },
            { name: "lmfSpread", type: "int", range: [-50, 50] },
            { name: "balance", type: "int", range: [-50, 50] },
            { name: "centerDistance", type: "int", range: [-50, 50] },
            { name: "outGain", type: "db", range: [-12, 12], unit: "dB" },
        ],
    },
    {
        code: 54, name: "SON", description: "Sound maxer",
        slots: { stereo: true, insert: true },
        params: [
            { name: "activeA", type: "bool" },
            { name: "loContourA", type: "float", range: [0, 10] },
            { name: "processA", type: "float", range: [0, 10] },
            { name: "outGainA", type: "db", range: [-12, 12], unit: "dB" },
            { name: "activeB", type: "bool" },
            { name: "loContourB", type: "float", range: [0, 10] },
            { name: "processB", type: "float", range: [0, 10] },
            { name: "outGainB", type: "db", range: [-12, 12], unit: "dB" },
        ],
    },

    // ===== Guitar amps (codes 55..56) =====
    {
        code: 55, name: "AMP2", description: "Dual guitar amp",
        slots: { stereo: true, insert: true },
        params: [
            ...ampSide("A"),
            ...ampSide("B"),
        ],
    },
    {
        code: 56, name: "AMP", description: "Stereo guitar amp",
        slots: { stereo: true, insert: true },
        params: ampSide(""),
    },

    // ===== Tube stage (codes 57..58) =====
    {
        code: 57, name: "DRV2", description: "Dual tube stage",
        slots: { stereo: true, insert: true },
        params: [
            ...tubeStageSide("A"),
            ...tubeStageSide("B"),
        ],
    },
    {
        code: 58, name: "DRV", description: "Stereo tube stage",
        slots: { stereo: true, insert: true },
        params: tubeStageSide(""),
    },

    // ===== Pitch shifter (codes 59..60) =====
    {
        code: 59, name: "PIT2", description: "Dual pitch shifter",
        slots: { stereo: true, insert: false },
        params: [
            ...pitchSide("A"),
            ...pitchSide("B"),
        ],
    },
    {
        code: 60, name: "PIT", description: "Stereo pitch shifter",
        slots: { stereo: true, insert: false },
        params: pitchSide(""),
    },
];

// ---------- helper factories ----------

function geqBands(suffix: string): FieldDef[] {
    // Standard ISO 31-band frequencies — pmaillot doesn't list per-band names,
    // so band labels follow the standard ISO third-octave centers. Order matches
    // /node fx/N/par positional read.
    const ISO_31 = [
        "20", "25", "31_5", "40", "50", "63", "80", "100", "125", "160",
        "200", "250", "315", "400", "500", "630", "800", "1k", "1k25", "1k6",
        "2k", "2k5", "3k15", "4k", "5k", "6k3", "8k", "10k", "12k5", "16k", "20k",
    ];
    return ISO_31.map((freq) => ({
        name: `band${suffix}_${freq}Hz`,
        type: "db" as const,
        range: [-15, 15] as [number, number],
        unit: "dB",
        note: `ISO 1/3-octave center ${freq.replace("_", ".")} Hz`,
    }));
}

function pultecEq1Side(suffix: string): FieldDef[] {
    return [
        { name: `active${suffix}`, type: "bool" },
        { name: `gain${suffix}`, type: "db", range: [-12, 12], unit: "dB" },
        { name: `loBoost${suffix}`, type: "int", range: [0, 10] },
        { name: `loFreq${suffix}`, type: "freq", note: "pmaillot enum [0,30,60,100]" },
        { name: `midWidth${suffix}`, type: "float", range: [0, 10] },
        { name: `midBoost${suffix}`, type: "float", range: [0, 10] },
        { name: `midFreq${suffix}`, type: "freq", note: "pmaillot enum [3k..16k]" },
        { name: `hiAttenuation${suffix}`, type: "int", range: [0, 10] },
        { name: `hiFreq${suffix}`, type: "freq", note: "pmaillot enum [5k,10k,20k]" },
        { name: `transformer${suffix}`, type: "bool" },
        { name: `extra${suffix}`, type: "int", note: "11th positional field" },
    ];
}

function pq5Side(suffix: string): FieldDef[] {
    return [
        { name: `active${suffix}`, type: "bool" },
        { name: `gain${suffix}`, type: "db", range: [-12, 12], unit: "dB" },
        { name: `loFreq${suffix}`, type: "enum", values: PQ5_LOFREQ_ENUM, unit: "Hz" },
        { name: `loBoost${suffix}`, type: "float", range: [0, 10] },
        { name: `midFreq${suffix}`, type: "enum", values: PQ5_MIDFREQ_ENUM, unit: "Hz" },
        { name: `midBoost${suffix}`, type: "float", range: [0, 10] },
        { name: `hiFreq${suffix}`, type: "enum", values: PQ5_HIFREQ_ENUM, unit: "Hz" },
        { name: `hiBoost${suffix}`, type: "float", range: [0, 10] },
        { name: `transformer${suffix}`, type: "bool" },
    ];
}

function combinatorSide(suffix: string): FieldDef[] {
    return [
        { name: `active${suffix}`, type: "bool" },
        { name: `bandSolo${suffix}`, type: "enum", values: CMB_BAND_SOLO_ENUM },
        { name: `mix${suffix}`, type: "int", range: [0, 100], unit: "%" },
        { name: `attack${suffix}`, type: "int", range: [0, 19] },
        { name: `release${suffix}`, type: "float", range: [20, 3000], unit: "ms" },
        { name: `autorelease${suffix}`, type: "bool" },
        { name: `sbcSpeed${suffix}`, type: "int", range: [0, 10] },
        { name: `sbcOn${suffix}`, type: "bool" },
        { name: `xover${suffix}`, type: "int", range: [-50, 50] },
        { name: `xoverSlope${suffix}`, type: "enum", values: CMB_XOVER_SLOPE_ENUM, unit: "dB/oct" },
        { name: `ratio${suffix}`, type: "enum", values: CMB_RATIO_ENUM },
        { name: `threshold${suffix}`, type: "db", range: [-40, 0], unit: "dB" },
        { name: `gain${suffix}`, type: "db", range: [-10, 10], unit: "dB" },
        { name: `band1Threshold${suffix}`, type: "db", range: [-10, 10], unit: "dB" },
        { name: `band1Gain${suffix}`, type: "db", range: [-10, 10], unit: "dB" },
        { name: `band1Lock${suffix}`, type: "bool" },
        { name: `band2Threshold${suffix}`, type: "db", range: [-10, 10], unit: "dB" },
        { name: `band2Gain${suffix}`, type: "db", range: [-10, 10], unit: "dB" },
        { name: `band2Lock${suffix}`, type: "bool" },
        { name: `band3Threshold${suffix}`, type: "db", range: [-10, 10], unit: "dB" },
        { name: `band3Gain${suffix}`, type: "db", range: [-10, 10], unit: "dB" },
        { name: `band3Lock${suffix}`, type: "bool" },
        { name: `band4Threshold${suffix}`, type: "db", range: [-10, 10], unit: "dB" },
        { name: `band4Gain${suffix}`, type: "db", range: [-10, 10], unit: "dB" },
        { name: `band4Lock${suffix}`, type: "bool" },
        { name: `band5Threshold${suffix}`, type: "db", range: [-10, 10], unit: "dB" },
        { name: `band5Gain${suffix}`, type: "db", range: [-10, 10], unit: "dB" },
        { name: `band5Lock${suffix}`, type: "bool" },
        { name: `meterMode${suffix}`, type: "enum", values: CMB_METER_ENUM },
    ];
}

function facStereoParams(): FieldDef[] {
    return [
        { name: "active", type: "bool" },
        { name: "inputGain", type: "db", range: [-20, 20], unit: "dB" },
        { name: "threshold", type: "float", range: [0, 10] },
        { name: "time", type: "float", range: [0, 6] },
        { name: "bias", type: "int", range: [0, 100] },
        { name: "gain", type: "db", range: [-18, 6], unit: "dB" },
        { name: "balance", type: "int", range: [-100, 100] },
    ];
}

function facDualParams(a: string, b: string): FieldDef[] {
    const side = (suffix: string): FieldDef[] => [
        { name: `active${suffix}`, type: "bool" },
        { name: `inputGain${suffix}`, type: "db", range: [-20, 20], unit: "dB" },
        { name: `threshold${suffix}`, type: "float", range: [0, 10] },
        { name: `time${suffix}`, type: "float", range: [0, 6] },
        { name: `bias${suffix}`, type: "int", range: [0, 100] },
        { name: `gain${suffix}`, type: "db", range: [-18, 6], unit: "dB" },
        { name: `balance${suffix}`, type: "int", range: [-100, 100] },
    ];
    return [...side(a), ...side(b)];
}

function enhancerSide(suffix: string): FieldDef[] {
    return [
        { name: `outGain${suffix}`, type: "db", range: [-12, 12], unit: "dB" },
        { name: `speed${suffix}`, type: "int", range: [0, 100] },
        { name: `bassGain${suffix}`, type: "int", range: [0, 100] },
        { name: `bassFreq${suffix}`, type: "int", range: [1, 50] },
        { name: `midGain${suffix}`, type: "int", range: [0, 100] },
        { name: `midFreq${suffix}`, type: "int", range: [1, 50] },
        { name: `hiGain${suffix}`, type: "int", range: [0, 100] },
        { name: `hiFreq${suffix}`, type: "int", range: [1, 50] },
        { name: `solo${suffix}`, type: "bool" },
    ];
}

function exciterSide(suffix: string): FieldDef[] {
    return [
        { name: `tune${suffix}`, type: "freq", range: [1000, 10000], unit: "Hz" },
        { name: `peak${suffix}`, type: "int", range: [0, 100] },
        { name: `zeroFill${suffix}`, type: "int", range: [0, 100] },
        { name: `timbre${suffix}`, type: "int", range: [-50, 50] },
        { name: `harmonics${suffix}`, type: "int", range: [0, 100] },
        { name: `mix${suffix}`, type: "int", range: [0, 100], unit: "%" },
        { name: `solo${suffix}`, type: "bool" },
    ];
}

function ampSide(suffix: string): FieldDef[] {
    return [
        { name: `preamp${suffix}`, type: "float", range: [0, 10] },
        { name: `buzz${suffix}`, type: "float", range: [0, 10] },
        { name: `punch${suffix}`, type: "float", range: [0, 10] },
        { name: `crunch${suffix}`, type: "float", range: [0, 10] },
        { name: `drive${suffix}`, type: "float", range: [0, 10] },
        { name: `low${suffix}`, type: "float", range: [0, 10] },
        { name: `high${suffix}`, type: "float", range: [0, 10] },
        { name: `level${suffix}`, type: "float", range: [0, 10] },
        { name: `cabinet${suffix}`, type: "bool" },
    ];
}

function tubeStageSide(suffix: string): FieldDef[] {
    return [
        { name: `drive${suffix}`, type: "int", range: [0, 100] },
        { name: `evenEar${suffix}`, type: "int", range: [0, 50] },
        { name: `oddEar${suffix}`, type: "int", range: [0, 50] },
        { name: `gain${suffix}`, type: "db", range: [-12, 12], unit: "dB" },
        { name: `loCut${suffix}`, type: "freq", range: [20, 200], unit: "Hz" },
        { name: `hiCut${suffix}`, type: "freq", range: [4000, 20000], unit: "Hz" },
        { name: `loGain${suffix}`, type: "db", range: [-12, 12], unit: "dB" },
        { name: `loFreq${suffix}`, type: "freq", range: [50, 400], unit: "Hz" },
        { name: `hiGain${suffix}`, type: "db", range: [-12, 12], unit: "dB" },
        { name: `hiFreq${suffix}`, type: "freq", range: [1000, 10000], unit: "Hz" },
    ];
}

function pitchSide(suffix: string): FieldDef[] {
    return [
        { name: `semitone${suffix}`, type: "int", range: [-12, 12], unit: "semitone" },
        { name: `cent${suffix}`, type: "int", range: [-50, 50], unit: "cent" },
        { name: `delay${suffix}`, type: "float", range: [1, 100], unit: "ms" },
        { name: `loCut${suffix}`, type: "freq", range: [10, 500], unit: "Hz" },
        { name: `hiCut${suffix}`, type: "freq", range: [2000, 20000], unit: "Hz" },
        { name: `mix${suffix}`, type: "int", range: [0, 100], unit: "%" },
    ];
}

// ---------- FX5..8 type code mapping ----------
// Slots 5..8 are insert-only and use a DIFFERENT integer encoding than slots 1..4.
// Same algorithm, different code (e.g. GEQ is code 28 in FX1..4 but code 1 in FX5..8).
// Source: pmaillot Effects appendix "FX5...FX8" table (X32_OSC.pdf, 2021-06).
//
// Verified against firmware 4.13 on 2026-04-28: live console reported leaf
// /fx/5/type=4 with /node fx/5/type="DES2" — matches FX5..8 row "4 DES2".
//
// Note: /node fx/N/type returns the SYMBOLIC name on any slot (slot-class-
// independent). Prefer /node-symbolic reads to dodge this dual encoding.
const FX5_TO_8_BY_CODE: Array<string> = [
    "GEQ2", "GEQ", "TEQ2", "TEQ",      // 0..3 graphic + true graphic EQ
    "DES2", "DES",                       // 4..5 de-essers
    "P1A", "P1A2", "PQ5", "PQ5S",       // 6..9 Pultec/Xtec EQs
    "WAVD", "LIM",                       // 10..11 dynamics
    "FAC", "FAC1M", "FAC2",             // 12..14 Fairchild
    "LEC", "LEC2",                       // 15..16 Leisure
    "ULC", "ULC2",                       // 17..18 Ultimo
    "ENH2", "ENH",                       // 19..20 enhancer
    "EXC2", "EXC",                       // 21..22 exciter
    "IMG", "EDI", "SON",                // 23..25 imager/Edison/SoundMaxer
    "AMP2", "AMP",                       // 26..27 guitar amps
    "DRV2", "DRV",                       // 28..29 tube stage
    "PHAS", "FILT", "PAN", "SUB",       // 30..33 mod/util (also valid in FX1..4 with different codes)
];

const FX5_TO_8_BY_NAME = new Map<string, number>(
    FX5_TO_8_BY_CODE.map((name, code) => [name, code]),
);

/** Returns true if the slot is an insert-class FX slot (5..8). */
export function isInsertSlot(slot: number): boolean {
    return slot >= 5 && slot <= 8;
}

/** Returns true if the slot is a stereo FX slot (1..4). */
export function isStereoSlot(slot: number): boolean {
    return slot >= 1 && slot <= 4;
}

// ---------- lookup helpers ----------

const BY_FX1_4_CODE = new Map<number, FxAlgorithmEntry>(FX_ALGORITHM_SCHEMA.map((e) => [e.code, e]));
const BY_NAME = new Map<string, FxAlgorithmEntry>(FX_ALGORITHM_SCHEMA.map((e) => [e.name.toUpperCase(), e]));

/**
 * Look up an FX algorithm by its integer type code in the FX1..4 numbering
 * (the original Phase D' map). Returns null if unknown.
 *
 * NOTE: this is the FX1..4 mapping. For slot 5..8 reads, the leaf int code
 * uses a different table — use findFxBySlotAndCode(slot, code) instead.
 */
export function findFxByCode(code: number): FxAlgorithmEntry | null {
    return BY_FX1_4_CODE.get(code) ?? null;
}

/** Look up an FX algorithm by symbolic name (case-insensitive). Returns null if unknown. */
export function findFxByName(name: string): FxAlgorithmEntry | null {
    return BY_NAME.get(name.toUpperCase()) ?? null;
}

/**
 * Slot-class-aware lookup. For slot 1..4 the integer is the FX1..4 code (0..60);
 * for slot 5..8 the integer is the FX5..8 code (0..33) and resolves to the
 * insert-suitable algorithm subset.
 */
export function findFxBySlotAndCode(slot: number, code: number): FxAlgorithmEntry | null {
    if (isInsertSlot(slot)) {
        const name = FX5_TO_8_BY_CODE[code];
        if (!name) return null;
        return findFxByName(name);
    }
    return findFxByCode(code);
}

/**
 * Returns the slot-class-correct integer type code to write to /fx/N/type
 * when setting `algo` on `slot`. Throws if `algo` isn't valid for the slot's
 * class (e.g. trying to load a reverb into an insert slot).
 */
export function fxCodeForSlot(algo: FxAlgorithmEntry, slot: number): number {
    if (isInsertSlot(slot)) {
        if (!algo.slots.insert) {
            throw new Error(`Algorithm "${algo.name}" is not insert-class — cannot load on slot ${slot}. Insert-suitable algos: ${FX5_TO_8_BY_CODE.join(", ")}`);
        }
        const code = FX5_TO_8_BY_NAME.get(algo.name);
        if (code === undefined) {
            throw new Error(`Internal: algorithm "${algo.name}" missing from FX5..8 code table`);
        }
        return code;
    }
    if (isStereoSlot(slot)) {
        if (!algo.slots.stereo) {
            throw new Error(`Algorithm "${algo.name}" is not stereo-class — cannot load on slot ${slot}.`);
        }
        return algo.code;
    }
    throw new Error(`Slot out of range: ${slot} (valid: 1..8)`);
}

/**
 * Resolve an FX type identifier (symbolic name or integer code) for a given slot.
 * Slot context disambiguates the integer encoding (FX1..4 vs FX5..8 use different ints
 * for the same algorithm). Symbolic names are slot-independent.
 *
 * Throws if the type doesn't exist OR if the type isn't valid for the slot's class.
 */
export function resolveFxType(typeRef: string | number, slot?: number): FxAlgorithmEntry {
    let entry: FxAlgorithmEntry | null = null;
    if (typeof typeRef === "number") {
        if (slot !== undefined) {
            entry = findFxBySlotAndCode(slot, typeRef);
        } else {
            entry = findFxByCode(typeRef);
        }
        if (!entry) {
            const where = slot !== undefined ? ` for slot ${slot}` : "";
            throw new Error(`Unknown FX type code: ${typeRef}${where}. Use osc_fx_list_algorithms to enumerate.`);
        }
        return entry;
    }
    // String input — try symbolic name first.
    entry = findFxByName(String(typeRef));
    if (entry) {
        // If a slot was supplied, verify class compatibility.
        if (slot !== undefined && isInsertSlot(slot) && !entry.slots.insert) {
            throw new Error(`Algorithm "${entry.name}" is not valid for insert slot ${slot} (FX5..8). Insert-class algos: ${FX5_TO_8_BY_CODE.join(", ")}`);
        }
        return entry;
    }
    // Try parse-as-number fallback ("0", "12").
    const asNum = Number(typeRef);
    if (Number.isFinite(asNum) && Number.isInteger(asNum)) {
        return resolveFxType(asNum, slot);
    }
    throw new Error(`Unknown FX type: "${typeRef}". Use osc_fx_list_algorithms to enumerate.`);
}

/** Filter the schema by a substring of name or description (case-insensitive). */
export function listFxAlgorithms(filter?: string): FxAlgorithmEntry[] {
    if (!filter) return FX_ALGORITHM_SCHEMA;
    const f = filter.toLowerCase();
    return FX_ALGORITHM_SCHEMA.filter((e) =>
        e.name.toLowerCase().includes(f) || e.description.toLowerCase().includes(f),
    );
}

/** Names of algorithms suitable for insert slots (5..8). */
export const FX_INSERT_ALGORITHM_NAMES: string[] = [...FX5_TO_8_BY_CODE];

/** Names of algorithm groups that implement a 31-band graphic EQ (used by insert-EQ helpers). */
export const GEQ_ALGORITHM_NAMES = new Set(["GEQ", "GEQ2", "TEQ", "TEQ2"]);

/** Total number of FX algorithms in the schema. */
export const FX_ALGORITHM_COUNT = FX_ALGORITHM_SCHEMA.length;
