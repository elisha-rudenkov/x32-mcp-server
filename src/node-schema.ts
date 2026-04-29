// X32 /node schema — positional field tables for the canonical container nodes.
//
// Each entry maps a /node container path (or path pattern with [a..b] ranges) to
// the ordered list of fields that /node returns for that container. Values from
// /node text are decoded per field type; writes via /(X32node) are encoded back
// through the same table.
//
// Path patterns:
//   "[01..32]" — zero-padded 2-digit decimal (01..32)
//   "[000..127]" — zero-padded 3-digit decimal
//   "[1..4]" — bare decimal
// Patterns are expanded at lookup time when matching a concrete path.
//
// The /node field order does NOT always match the leaf-address spelling. Notably
// /ch/NN/preamp returns [trim, invert, hpon, hpslope, hpf] in /node text but the
// individual leaf addresses are /trim, /invert, /hpon, /hpf, /hpslope. The schema
// reflects the /node order — that's what's on the wire.
//
// Verified against live X32 firmware 4.13 on 2026-04-28.

export type FieldType =
    | "bool"      // ON/OFF, encoded ON/OFF on write
    | "int"       // bare integer, e.g. icon, source
    | "float"     // bare decimal, e.g. q, ratio
    | "db"        // dB rendered as +/-N.N or "-oo" for -Infinity
    | "freq"      // Hz, may be rendered as "3k48" shorthand on /node text
    | "ms"        // milliseconds
    | "pct"       // percent (0..100)
    | "enum"      // symbolic value from values[]; on write accepts symbolic or numeric index
    | "string"    // quoted on write if contains whitespace
    | "bitmask";  // %01011010 on /node text; int on write

export interface FieldDef {
    name: string;
    type: FieldType;
    range?: [number, number];   // numeric range (informational, not enforced strictly)
    values?: string[];           // enum symbols, in numeric-code order
    unit?: string;               // human-readable unit, e.g. "Hz", "ms", "dB"
    note?: string;
}

export interface NodeSchemaEntry {
    /** Path pattern with [a..b] ranges. Concrete paths are matched by expansion. */
    path: string;
    /** Human description of the container. */
    description: string;
    /** Positional field list — the order /node returns and / writes expects. */
    fields: FieldDef[];
}

// ========== Common enum value lists ==========

const COLORS = ["OFF", "RD", "GN", "YE", "BL", "MG", "CY", "WH", "OFFi", "RDi", "GNi", "YEi", "BLi", "MGi", "CYi", "WHi"];
const TAP_TYPES = ["PRE", "EQ->", "<-EQ", "DYN->", "<-DYN", "POST"];
const INSERT_POS = ["PRE", "POST"];
const HPSLOPE = ["12", "18", "24"];
const GATE_MODES = ["EXP2", "EXP3", "EXP4", "GATE", "DUCK"];
const DYN_MODES = ["COMP", "EXP"];
const DYN_DET = ["PEAK", "RMS"];
const DYN_ENV = ["LIN", "LOG"];
const DYN_POS = ["PRE", "POST"];
const EQ_TYPES = ["LCut", "LShv", "PEQ", "VEQ", "HShv", "HCut"];

// Insert "sel" enum is large; we capture the symbolic values we've seen and accept any string at write time.
const INSERT_SEL: string[] = [
    "OFF",
    "FX1L", "FX1R", "FX2L", "FX2R", "FX3L", "FX3R", "FX4L", "FX4R",
    "FX5", "FX6", "FX7", "FX8",
    "FX5L", "FX5R", "FX6L", "FX6R", "FX7L", "FX7R", "FX8L", "FX8R",
];

// Automix group enum — auxin uses same shape as ch/NN/automix
const AUTOMIX = ["OFF", "X", "Y"];

export const NODE_SCHEMA: NodeSchemaEntry[] = [
    // ========== Channel containers ==========
    {
        path: "ch/[01..32]/config",
        description: "Channel name, icon, color, source select",
        fields: [
            { name: "name", type: "string", note: "up to 12 chars; longer is silently truncated" },
            { name: "icon", type: "int", range: [1, 74] },
            { name: "color", type: "enum", values: COLORS },
            { name: "source", type: "int", range: [0, 64], note: "physical input slot; 0..63 = local/AES50; consult routing for indirection" },
        ],
    },
    {
        path: "ch/[01..32]/mix",
        description: "Main mix on/fader/stereo/pan/mono/mono-level",
        fields: [
            { name: "on", type: "bool" },
            { name: "fader", type: "db", range: [-90, 10], unit: "dB" },
            { name: "st", type: "bool", note: "to-LR send enable" },
            { name: "pan", type: "int", range: [-100, 100], note: "L..R; 0 = center" },
            { name: "mono", type: "bool", note: "to-mono send enable" },
            { name: "mlevel", type: "db", range: [-90, 10], unit: "dB", note: "mono send level" },
        ],
    },
    {
        path: "ch/[01..32]/eq",
        description: "Channel EQ master on/off",
        fields: [{ name: "on", type: "bool" }],
    },
    {
        path: "ch/[01..32]/eq/[1..4]",
        description: "Channel EQ band (4 bands per channel)",
        fields: [
            { name: "type", type: "enum", values: EQ_TYPES },
            { name: "f", type: "freq", range: [20, 20000], unit: "Hz" },
            { name: "g", type: "db", range: [-15, 15], unit: "dB" },
            { name: "q", type: "float", range: [0.3, 10] },
        ],
    },
    {
        path: "ch/[01..32]/gate",
        description: "Noise gate / expander / ducker",
        fields: [
            { name: "on", type: "bool" },
            { name: "mode", type: "enum", values: GATE_MODES },
            { name: "thr", type: "db", range: [-80, 0], unit: "dB" },
            { name: "range", type: "float", range: [3, 60], unit: "dB" },
            { name: "attack", type: "ms", range: [0, 120], unit: "ms" },
            { name: "hold", type: "ms", range: [0.02, 2000], unit: "ms" },
            { name: "release", type: "ms", range: [5, 4000], unit: "ms" },
            { name: "keysrc", type: "int", range: [0, 64], note: "0 = self; 1..32 = ch; etc." },
        ],
    },
    {
        path: "ch/[01..32]/gate/filter",
        description: "Gate sidechain filter",
        fields: [
            { name: "on", type: "bool" },
            { name: "type", type: "float", note: "filter Q/type code" },
            { name: "f", type: "freq", unit: "Hz" },
        ],
    },
    {
        path: "ch/[01..32]/dyn",
        description: "Dynamics (compressor / expander)",
        fields: [
            { name: "on", type: "bool" },
            { name: "mode", type: "enum", values: DYN_MODES },
            { name: "det", type: "enum", values: DYN_DET },
            { name: "env", type: "enum", values: DYN_ENV },
            { name: "thr", type: "db", range: [-60, 0], unit: "dB" },
            { name: "ratio", type: "float", range: [1, 100] },
            { name: "knee", type: "int", range: [0, 5] },
            { name: "mgain", type: "db", range: [0, 24], unit: "dB", note: "make-up gain" },
            { name: "attack", type: "ms", range: [0, 120], unit: "ms" },
            { name: "hold", type: "ms", range: [0.02, 2000], unit: "ms" },
            { name: "release", type: "ms", range: [5, 4000], unit: "ms" },
            { name: "pos", type: "enum", values: DYN_POS },
            { name: "keysrc", type: "int", range: [0, 64] },
            { name: "mix", type: "pct", range: [0, 100], unit: "%" },
            { name: "auto", type: "bool" },
        ],
    },
    {
        path: "ch/[01..32]/dyn/filter",
        description: "Dynamics sidechain filter",
        fields: [
            { name: "on", type: "bool" },
            { name: "type", type: "float", note: "filter Q/type code" },
            { name: "f", type: "freq", unit: "Hz" },
        ],
    },
    {
        path: "ch/[01..32]/insert",
        description: "Channel insert (FX patch point)",
        fields: [
            { name: "on", type: "bool" },
            { name: "pos", type: "enum", values: INSERT_POS },
            { name: "sel", type: "enum", values: INSERT_SEL, note: "OFF or FX slot side; many enum values" },
        ],
    },
    {
        path: "ch/[01..32]/preamp",
        description: "Preamp trim, polarity, high-pass filter",
        fields: [
            { name: "trim", type: "db", range: [-18, 18], unit: "dB" },
            { name: "invert", type: "bool", note: "polarity invert" },
            { name: "hpon", type: "bool" },
            { name: "hpslope", type: "enum", values: HPSLOPE, unit: "dB/oct", note: "12 / 18 / 24 dB/oct" },
            { name: "hpf", type: "freq", range: [20, 400], unit: "Hz" },
        ],
    },
    {
        path: "ch/[01..32]/delay",
        description: "Channel delay",
        fields: [
            { name: "on", type: "bool" },
            { name: "time", type: "float", range: [0.3, 500], unit: "ms" },
        ],
    },
    {
        path: "ch/[01..32]/grp",
        description: "DCA and mute group memberships (8-bit and 6-bit bitmasks)",
        fields: [
            { name: "dca", type: "bitmask", note: "bit 0 = DCA1 .. bit 7 = DCA8" },
            { name: "mute", type: "bitmask", note: "bit 0 = MuteGrp1 .. bit 5 = MuteGrp6" },
        ],
    },
    {
        path: "ch/[01..32]/automix",
        description: "Automix group assignment",
        fields: [
            { name: "group", type: "enum", values: ["OFF", "X", "Y"] },
            { name: "weight", type: "db", range: [-12, 12], unit: "dB" },
        ],
    },
    // Sends — odd BB has full stereo struct, even BB has reduced. The spec calls
    // the odd BB the "head" of the bus pair and even the "tail". This is independent
    // of whether the bus pair is currently link-toggled in /config/buslink.
    {
        path: "ch/[01..32]/mix/[01..15:odd]",
        description: "Channel send to bus (odd BB — head of bus pair)",
        fields: [
            { name: "on", type: "bool" },
            { name: "level", type: "db", range: [-90, 10], unit: "dB" },
            { name: "pan", type: "int", range: [-100, 100] },
            { name: "type", type: "enum", values: TAP_TYPES },
            { name: "panFollow", type: "int", range: [0, 1], note: "follow channel pan" },
        ],
    },
    {
        path: "ch/[01..32]/mix/[02..16:even]",
        description: "Channel send to bus (even BB — tail of bus pair)",
        fields: [
            { name: "on", type: "bool" },
            { name: "level", type: "db", range: [-90, 10], unit: "dB" },
        ],
    },

    // ========== Headamp ==========
    {
        path: "headamp/[000..127]",
        description: "Local/AES50 head amplifier — analog input gain and phantom power",
        fields: [
            { name: "gain", type: "db", range: [-12, 60], unit: "dB" },
            { name: "phantom", type: "bool", note: "+48 V" },
        ],
    },

    // ========== Bus containers ==========
    {
        path: "bus/[01..16]/config",
        description: "Mix bus name, icon, color (no source field — buses are internal)",
        fields: [
            { name: "name", type: "string" },
            { name: "icon", type: "int", range: [1, 74] },
            { name: "color", type: "enum", values: COLORS },
        ],
    },
    {
        path: "bus/[01..16]/mix",
        description: "Mix bus master mix — on, fader, st-send, pan, mono-send, mono-level",
        fields: [
            { name: "on", type: "bool" },
            { name: "fader", type: "db", range: [-90, 10], unit: "dB" },
            { name: "st", type: "bool", note: "to-LR send enable" },
            { name: "pan", type: "int", range: [-100, 100] },
            { name: "mono", type: "bool" },
            { name: "mlevel", type: "db", range: [-90, 10], unit: "dB" },
        ],
    },
    {
        path: "bus/[01..16]/grp",
        description: "Bus DCA / mute group memberships",
        fields: [
            { name: "dca", type: "bitmask" },
            { name: "mute", type: "bitmask" },
        ],
    },
    // Bus sends to matrix (BB 01..06): odd has full 5 fields, even has 2.
    {
        path: "bus/[01..16]/mix/[01..05:odd]",
        description: "Bus send to matrix (odd BB — head of matrix pair)",
        fields: [
            { name: "on", type: "bool" },
            { name: "level", type: "db", range: [-90, 10], unit: "dB" },
            { name: "pan", type: "int", range: [-100, 100] },
            { name: "type", type: "enum", values: TAP_TYPES },
            { name: "panFollow", type: "int", range: [0, 1] },
        ],
    },
    {
        path: "bus/[01..16]/mix/[02..06:even]",
        description: "Bus send to matrix (even BB — tail of matrix pair)",
        fields: [
            { name: "on", type: "bool" },
            { name: "level", type: "db", range: [-90, 10], unit: "dB" },
        ],
    },

    // ========== Aux input containers ==========
    {
        path: "auxin/[01..08]/config",
        description: "Aux input name, icon, color, source (4 fields — auxin has source like channels)",
        fields: [
            { name: "name", type: "string" },
            { name: "icon", type: "int", range: [1, 74] },
            { name: "color", type: "enum", values: COLORS },
            { name: "source", type: "int", range: [0, 168], note: "physical input slot" },
        ],
    },
    {
        path: "auxin/[01..08]/preamp",
        description: "Aux input preamp — trim and polarity invert (no HPF on auxin)",
        fields: [
            { name: "trim", type: "db", range: [-18, 18], unit: "dB" },
            { name: "invert", type: "bool" },
        ],
    },
    {
        path: "auxin/[01..08]/mix",
        description: "Aux input main mix — same shape as channel mix",
        fields: [
            { name: "on", type: "bool" },
            { name: "fader", type: "db", range: [-90, 10], unit: "dB" },
            { name: "st", type: "bool" },
            { name: "pan", type: "int", range: [-100, 100] },
            { name: "mono", type: "bool" },
            { name: "mlevel", type: "db", range: [-90, 10], unit: "dB" },
        ],
    },
    {
        path: "auxin/[01..08]/grp",
        description: "Aux input DCA / mute group memberships",
        fields: [
            { name: "dca", type: "bitmask" },
            { name: "mute", type: "bitmask" },
        ],
    },
    {
        path: "auxin/[01..08]/automix",
        description: "Aux input automix group assignment",
        fields: [
            { name: "group", type: "enum", values: AUTOMIX },
            { name: "weight", type: "db", range: [-12, 12], unit: "dB" },
        ],
    },
    {
        path: "auxin/[01..08]/mix/[01..15:odd]",
        description: "Aux input send to bus (odd BB — head of bus pair)",
        fields: [
            { name: "on", type: "bool" },
            { name: "level", type: "db", range: [-90, 10], unit: "dB" },
            { name: "pan", type: "int", range: [-100, 100] },
            { name: "type", type: "enum", values: TAP_TYPES },
            { name: "panFollow", type: "int", range: [0, 1] },
        ],
    },
    {
        path: "auxin/[01..08]/mix/[02..16:even]",
        description: "Aux input send to bus (even BB — tail of bus pair)",
        fields: [
            { name: "on", type: "bool" },
            { name: "level", type: "db", range: [-90, 10], unit: "dB" },
        ],
    },

    // ========== FX return containers ==========
    {
        path: "fxrtn/[01..08]/config",
        description: "FX return name, icon, color (3 fields — no source; tied to FX slot output)",
        fields: [
            { name: "name", type: "string" },
            { name: "icon", type: "int", range: [1, 74] },
            { name: "color", type: "enum", values: COLORS },
        ],
    },
    {
        path: "fxrtn/[01..08]/mix",
        description: "FX return main mix — same shape as channel mix",
        fields: [
            { name: "on", type: "bool" },
            { name: "fader", type: "db", range: [-90, 10], unit: "dB" },
            { name: "st", type: "bool" },
            { name: "pan", type: "int", range: [-100, 100] },
            { name: "mono", type: "bool" },
            { name: "mlevel", type: "db", range: [-90, 10], unit: "dB" },
        ],
    },
    {
        path: "fxrtn/[01..08]/grp",
        description: "FX return DCA / mute group memberships",
        fields: [
            { name: "dca", type: "bitmask" },
            { name: "mute", type: "bitmask" },
        ],
    },
    {
        path: "fxrtn/[01..08]/mix/[01..15:odd]",
        description: "FX return send to bus (odd BB — head of bus pair)",
        fields: [
            { name: "on", type: "bool" },
            { name: "level", type: "db", range: [-90, 10], unit: "dB" },
            { name: "pan", type: "int", range: [-100, 100] },
            { name: "type", type: "enum", values: TAP_TYPES },
            { name: "panFollow", type: "int", range: [0, 1] },
        ],
    },
    {
        path: "fxrtn/[01..08]/mix/[02..16:even]",
        description: "FX return send to bus (even BB — tail of bus pair)",
        fields: [
            { name: "on", type: "bool" },
            { name: "level", type: "db", range: [-90, 10], unit: "dB" },
        ],
    },

    // ========== Matrix containers ==========
    {
        path: "mtx/[01..06]/config",
        description: "Matrix name, icon, color",
        fields: [
            { name: "name", type: "string" },
            { name: "icon", type: "int", range: [1, 74] },
            { name: "color", type: "enum", values: COLORS },
        ],
    },
    {
        path: "mtx/[01..06]/mix",
        description: "Matrix master — on and fader only (no panning at matrix output)",
        fields: [
            { name: "on", type: "bool" },
            { name: "fader", type: "db", range: [-90, 10], unit: "dB" },
        ],
    },
    {
        path: "mtx/[01..06]/grp",
        description: "Matrix DCA / mute group memberships",
        fields: [
            { name: "dca", type: "bitmask" },
            { name: "mute", type: "bitmask" },
        ],
    },

    // ========== Main containers ==========
    {
        path: "main/st/config",
        description: "Main stereo (LR) name, icon, color",
        fields: [
            { name: "name", type: "string" },
            { name: "icon", type: "int", range: [1, 74] },
            { name: "color", type: "enum", values: COLORS },
        ],
    },
    {
        path: "main/m/config",
        description: "Main mono (Center/Sub) name, icon, color",
        fields: [
            { name: "name", type: "string" },
            { name: "icon", type: "int", range: [1, 74] },
            { name: "color", type: "enum", values: COLORS },
        ],
    },
    {
        path: "main/st/mix",
        description: "Main LR — on, fader, pan (3 fields; no st/mono/mlevel since main IS the destination)",
        fields: [
            { name: "on", type: "bool" },
            { name: "fader", type: "db", range: [-90, 10], unit: "dB" },
            { name: "pan", type: "int", range: [-100, 100] },
        ],
    },
    {
        path: "main/m/mix",
        description: "Main Mono — on and fader only",
        fields: [
            { name: "on", type: "bool" },
            { name: "fader", type: "db", range: [-90, 10], unit: "dB" },
        ],
    },
    {
        path: "main/st/grp",
        description: "Main LR DCA / mute group memberships",
        fields: [
            { name: "dca", type: "bitmask" },
            { name: "mute", type: "bitmask" },
        ],
    },
    {
        path: "main/m/grp",
        description: "Main Mono DCA / mute group memberships",
        fields: [
            { name: "dca", type: "bitmask" },
            { name: "mute", type: "bitmask" },
        ],
    },
    {
        path: "main/st/mix/[01..05:odd]",
        description: "Main LR send to matrix (odd BB — head of matrix pair)",
        fields: [
            { name: "on", type: "bool" },
            { name: "level", type: "db", range: [-90, 10], unit: "dB" },
            { name: "pan", type: "int", range: [-100, 100] },
            { name: "type", type: "enum", values: TAP_TYPES },
            { name: "panFollow", type: "int", range: [0, 1] },
        ],
    },
    {
        path: "main/st/mix/[02..06:even]",
        description: "Main LR send to matrix (even BB — tail of matrix pair)",
        fields: [
            { name: "on", type: "bool" },
            { name: "level", type: "db", range: [-90, 10], unit: "dB" },
        ],
    },

    // ========== DCA containers ==========
    {
        path: "dca/[1..8]",
        description: "DCA master state — on/off and fader",
        fields: [
            { name: "on", type: "bool" },
            { name: "fader", type: "db", range: [-90, 10], unit: "dB" },
        ],
    },
    {
        path: "dca/[1..8]/config",
        description: "DCA name, icon, color",
        fields: [
            { name: "name", type: "string" },
            { name: "icon", type: "int", range: [1, 74] },
            { name: "color", type: "enum", values: COLORS },
        ],
    },

    // ========== FX source (slots 1..4 only — slots 5..8 are channel inserts) ==========
    {
        path: "fx/[1..4]/source",
        description: "FX slot 1..4 stereo source — sourceL / sourceR. Values are bus name strings like 'MIX13' or 'OFF'.",
        fields: [
            { name: "sourceL", type: "string" },
            { name: "sourceR", type: "string" },
        ],
    },

    // ========== Physical output containers ==========
    // src field is the X32 output-tap source enum (different from User Out enum):
    //   0=OFF; 1=MainL; 2=MainR; 3=MainC; 4..19=MX1..16; 20..25=MTX1..6;
    //   26..57=Ch01..32; higher values are AuxIn/FX/USB (best-effort).
    // pos values verified on live console: POST and <-EQ; spec also allows PRE, EQ->, DYN->, <-DYN.
    {
        path: "outputs/main/[01..16]",
        description: "Physical OUT 1-16 — source tap, tap position, polarity invert",
        fields: [
            { name: "src", type: "int", range: [0, 96], note: "output tap source enum; see decodeOutputTapSource" },
            { name: "pos", type: "enum", values: TAP_TYPES },
            { name: "invert", type: "bool", note: "polarity invert" },
        ],
    },
    {
        path: "outputs/aux/[01..06]",
        description: "Physical AUX OUT 1-6 — source tap, tap position, polarity invert",
        fields: [
            { name: "src", type: "int", range: [0, 96] },
            { name: "pos", type: "enum", values: TAP_TYPES },
            { name: "invert", type: "bool" },
        ],
    },
    {
        path: "outputs/p16/[01..16]",
        description: "P16 personal-monitor outputs 1-16 — source tap, tap position, polarity invert",
        fields: [
            { name: "src", type: "int", range: [0, 96] },
            { name: "pos", type: "enum", values: TAP_TYPES },
            { name: "invert", type: "bool" },
        ],
    },
    {
        path: "outputs/aes/[01..02]",
        description: "AES50 / AES out — source tap, tap position, polarity invert",
        fields: [
            { name: "src", type: "int", range: [0, 96] },
            { name: "pos", type: "enum", values: TAP_TYPES },
            { name: "invert", type: "bool" },
        ],
    },
    {
        path: "outputs/rec/[01..02]",
        description: "Recording outputs — source tap and tap position only (no invert)",
        fields: [
            { name: "src", type: "int", range: [0, 96] },
            { name: "pos", type: "enum", values: TAP_TYPES },
        ],
    },

    // ========== Config containers ==========
    {
        path: "config/mute",
        description: "Mute groups 1..6 master state",
        fields: Array.from({ length: 6 }, (_, i) => ({ name: `mute${i + 1}`, type: "bool" as FieldType })),
    },
    {
        path: "config/chlink",
        description: "Channel link toggles for 16 pairs (1-2, 3-4, ... 31-32)",
        fields: Array.from({ length: 16 }, (_, i) => ({
            name: `link${i * 2 + 1}_${i * 2 + 2}`,
            type: "bool" as FieldType,
        })),
    },
    {
        path: "config/buslink",
        description: "Mix bus link toggles for 8 pairs (1-2 ... 15-16)",
        fields: Array.from({ length: 8 }, (_, i) => ({
            name: `link${i * 2 + 1}_${i * 2 + 2}`,
            type: "bool" as FieldType,
        })),
    },
    {
        path: "config/auxlink",
        description: "Aux input link toggles for 4 pairs (1-2 ... 7-8)",
        fields: Array.from({ length: 4 }, (_, i) => ({
            name: `link${i * 2 + 1}_${i * 2 + 2}`,
            type: "bool" as FieldType,
        })),
    },
    {
        path: "config/mtxlink",
        description: "Matrix link toggles for 3 pairs (1-2, 3-4, 5-6)",
        fields: Array.from({ length: 3 }, (_, i) => ({
            name: `link${i * 2 + 1}_${i * 2 + 2}`,
            type: "bool" as FieldType,
        })),
    },
    {
        path: "config/linkcfg",
        description: "Link behavior flags — which strip sections follow the channel/bus link toggle",
        fields: [
            { name: "eq", type: "bool", note: "EQ tracks across linked pair" },
            { name: "dyn", type: "bool", note: "dynamics tracks" },
            { name: "fdrmute", type: "bool", note: "fader/mute tracks" },
            { name: "group", type: "bool", note: "DCA / mute group membership tracks" },
        ],
    },
];

// ========== Path matching & expansion ==========

interface RangeSpec {
    pad: number;             // zero-pad width (0 = no padding)
    start: number;
    end: number;
    parity?: "odd" | "even";
}

function parseRange(raw: string): RangeSpec {
    // Forms: "01..32", "1..4", "000..127", "01..15:odd", "02..16:even"
    let parity: "odd" | "even" | undefined;
    let body = raw;
    const m = raw.match(/^(.+?):(odd|even)$/);
    if (m) {
        body = m[1];
        parity = m[2] as "odd" | "even";
    }
    const [a, b] = body.split("..");
    const pad = a.startsWith("0") && a.length > 1 ? a.length : 0;
    return { pad, start: parseInt(a, 10), end: parseInt(b, 10), parity };
}

function rangeMatches(rs: RangeSpec, token: string): number | null {
    // token must be either bare digits or zero-padded; check pad width matches.
    if (rs.pad > 0) {
        if (token.length !== rs.pad) return null;
    }
    if (!/^\d+$/.test(token)) return null;
    const n = parseInt(token, 10);
    if (n < rs.start || n > rs.end) return null;
    if (rs.parity === "odd" && n % 2 === 0) return null;
    if (rs.parity === "even" && n % 2 !== 0) return null;
    return n;
}

/** Split a path pattern into segments of {literal} or {range}. */
function tokenizePattern(pattern: string): Array<{ kind: "lit"; value: string } | { kind: "range"; spec: RangeSpec }> {
    const segs = pattern.split("/").filter((s) => s.length > 0);
    return segs.map((s) => {
        const m = s.match(/^\[(.+)\]$/);
        if (m) return { kind: "range", spec: parseRange(m[1]) };
        return { kind: "lit", value: s };
    });
}

/**
 * Try to match a concrete path (e.g. "ch/01/gate") against a schema entry's pattern
 * (e.g. "ch/[01..32]/gate"). Returns the captured numeric values from each range
 * segment, or null if no match.
 */
export function matchSchemaPath(pattern: string, concrete: string): number[] | null {
    const pTokens = tokenizePattern(pattern);
    const cSegs = concrete.replace(/^\/+/, "").split("/").filter((s) => s.length > 0);
    if (pTokens.length !== cSegs.length) return null;
    const captures: number[] = [];
    for (let i = 0; i < pTokens.length; i++) {
        const t = pTokens[i];
        if (t.kind === "lit") {
            if (t.value !== cSegs[i]) return null;
        } else {
            const n = rangeMatches(t.spec, cSegs[i]);
            if (n === null) return null;
            captures.push(n);
        }
    }
    return captures;
}

/** Find the schema entry for a concrete path. Returns null if no entry matches. */
export function findSchema(concrete: string): NodeSchemaEntry | null {
    const clean = concrete.replace(/^\/+/, "");
    for (const entry of NODE_SCHEMA) {
        if (matchSchemaPath(entry.path, clean) !== null) return entry;
    }
    return null;
}

/** Filter the schema by a glob-like pattern (e.g. "ch/*&zwj;/gate", "config/*"). */
export function listSchemas(filter?: string): NodeSchemaEntry[] {
    if (!filter) return NODE_SCHEMA;
    const re = globToRegex(filter);
    return NODE_SCHEMA.filter((e) => re.test(e.path));
}

function globToRegex(glob: string): RegExp {
    // ** -> .* ; * -> [^/]* ; everything else escaped
    let out = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === "*" && glob[i + 1] === "*") { out += ".*"; i++; }
        else if (c === "*") out += "[^/]*";
        else if (/[.+^$(){}|\\]/.test(c)) out += "\\" + c;
        else out += c;
    }
    return new RegExp("^" + out + "$");
}

// ========== Field decode (raw /node text token → JS value) ==========

/** Decode a /node text token into a typed JS value per the field's schema. */
export function decodeField(field: FieldDef, raw: string): any {
    switch (field.type) {
        case "bool":
            return raw === "ON" || raw === "TRUE" || raw === "1";
        case "int":
            return parseInt(raw, 10);
        case "float":
            return parseFloat(raw);
        case "db":
            if (raw === "-oo" || raw === "-∞") return -Infinity;
            return parseFloat(raw);
        case "freq": {
            const m = raw.match(/^(\d+)k(\d*)$/);
            if (m) {
                const thousands = parseInt(m[1], 10) * 1000;
                if (m[2] === "") return thousands;
                const sub = parseInt(m[2], 10) * Math.pow(10, 3 - m[2].length);
                return thousands + sub;
            }
            return parseFloat(raw);
        }
        case "ms":
        case "pct":
            return parseFloat(raw);
        case "enum":
            return raw;
        case "string":
            return raw;
        case "bitmask":
            return raw.startsWith("%") ? parseInt(raw.substring(1), 2) : parseInt(raw, 10);
    }
}

// ========== Field encode (JS value → arg suitable for nodeWrite) ==========
// Returns a value that nodeWrite's encodeWriteValue will format correctly:
// numbers stay numbers (incl. -Infinity → "-oo"), booleans stay booleans
// (→ "ON"/"OFF"), and pre-formatted strings (enum symbols, "%bbbbbbbb" bitmasks)
// pass through unquoted (no whitespace).

/** Encode a JS value into the form nodeWrite expects, per the field's schema. */
export function encodeFieldValue(field: FieldDef, value: any): any {
    switch (field.type) {
        case "bool":
            if (typeof value === "boolean") return value;
            if (typeof value === "number") return value !== 0;
            if (typeof value === "string") {
                const s = value.toLowerCase();
                return s === "on" || s === "true" || s === "1" || s === "yes";
            }
            return Boolean(value);
        case "int": {
            const n = typeof value === "number" ? value : parseInt(String(value), 10);
            if (Number.isNaN(n)) throw new Error(`Cannot coerce ${JSON.stringify(value)} to int for field "${field.name}"`);
            return Math.trunc(n);
        }
        case "float":
        case "freq":
        case "ms":
        case "pct": {
            const n = typeof value === "number" ? value : parseFloat(String(value));
            if (Number.isNaN(n)) throw new Error(`Cannot coerce ${JSON.stringify(value)} to ${field.type} for field "${field.name}"`);
            return n;
        }
        case "db": {
            if (value === -Infinity || value === "-oo" || value === "-∞" || value === null) return -Infinity;
            const n = typeof value === "number" ? value : parseFloat(String(value));
            if (Number.isNaN(n)) throw new Error(`Cannot coerce ${JSON.stringify(value)} to dB for field "${field.name}"`);
            return n;
        }
        case "enum": {
            const values = field.values || [];
            if (typeof value === "number") {
                if (values.length > 0 && (value < 0 || value >= values.length)) {
                    throw new Error(`enum index ${value} out of range for "${field.name}" (0..${values.length - 1})`);
                }
                if (values.length > 0) return values[value];
                return String(value);
            }
            const s = String(value);
            if (values.length > 0) {
                if (values.includes(s)) return s;
                const ix = values.findIndex((v) => v.toLowerCase() === s.toLowerCase());
                if (ix >= 0) return values[ix];
                // Pass through; X32 may accept it. (Insert "sel" has many enum values we don't fully enumerate.)
            }
            return s;
        }
        case "string":
            return String(value);
        case "bitmask": {
            if (typeof value === "string") {
                if (value.startsWith("%")) return value;
                const n = parseInt(value, 10);
                if (Number.isNaN(n)) throw new Error(`Cannot parse bitmask string ${JSON.stringify(value)} for "${field.name}"`);
                return "%" + n.toString(2).padStart(8, "0");
            }
            const n = typeof value === "number" ? value : parseInt(String(value), 10);
            if (Number.isNaN(n)) throw new Error(`Cannot coerce ${JSON.stringify(value)} to bitmask for "${field.name}"`);
            return "%" + n.toString(2).padStart(8, "0");
        }
    }
}
