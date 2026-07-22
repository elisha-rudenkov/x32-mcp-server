#!/usr/bin/env node

import { exec, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
    Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { OSCClient } from "./osc-client.js";
import { summarizeFxAlgorithms } from "./fx-schema.js";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default OSC configuration
const OSC_HOST = process.env.OSC_HOST || "192.168.1.17";
const OSC_PORT = parseInt(process.env.OSC_PORT || "10023");

// Initialize OSC client
const osc = new OSCClient(OSC_HOST, OSC_PORT);

// Emulator process management
let emulatorProcess: ReturnType<typeof spawn> | null = null;
let emulatorPid: number | null = null;

// ========== Capability reference (returned by osc_capabilities) ==========
// Single source of LLM-facing context about what the X32 can do, organized
// to defuse common misconceptions. Read by the LLM via tool call, NOT a docstring,
// because tool descriptions are loaded into context but tool *responses* are
// what the LLM actually treats as authoritative observations.
const CAPABILITIES_DOC = `# X32 / M32 MCP — Capability Reference

**Firmware target: 4.x (latest).** Capabilities below DO NOT match older firmware
(2.x, 3.x) priors you may have from training data. When in doubt, trust this doc
over generic X32 knowledge.

## Capabilities you might (wrongly) think don't exist

### Per-slot 1:1 input routing IS supported (firmware 4.0+)
You are **not** limited to 8-channel input blocks. The X32 has TWO routing layers:
1. **Block-level** (\`/config/routing/IN/N-M\`): legacy 8-channel-group selector — picks
   which source group feeds each range of channels.
2. **User In** (\`/config/userrout/in/01..32\`): **per-channel 1:1 patch table.** Each
   of the 32 channel slots can be independently assigned to ANY physical source
   (Local 1-32, AES50A 1-48, AES50B 1-48, Card 1-32, Aux In 1-8, OFF).

When a block is set to \`User In N-M\`, the per-slot table determines the actual
source for each channel in that range. **This is the modern way to build scenes.**

- Read both layers in one call: \`osc_get_routing_overview\`
- Patch a specific channel: \`osc_set_user_routing_in({slot, source})\` — accepts
  labels like \`"Card 1"\`, \`"Local 27"\`, \`"AES50A 5"\`, \`"OFF"\`.

### FX racks are runtime-configurable; never hardcode slot→algorithm assumptions
All 8 racks are user-configurable. The same slot can host different algorithms at
different times. Discover at runtime:
- \`osc_fx_get(slot)\` — read the current algorithm + decoded params
- \`osc_fx_list_algorithms\` — enumerate the 61 algorithms. Defaults to a compact
  \`summary\` (names + codes + param counts); pass \`detail:"names"\` for just names,
  or \`detail:"full", algorithm:"HALL"\` for one algorithm's full param schema.
- \`osc_find_geq_slots\` — scan all 8 racks for any GEQ-class algorithm
- \`osc_fx_set_type(slot, "HALL")\` — set algorithm by symbolic name (validates slot-class)

**Slot classes:**
- Slots 1..4 are stereo-class (61 algorithms valid)
- Slots 5..8 are insert-class (34-algorithm subset valid; \`osc_fx_set_type\` rejects
  stereo-only algorithms like HALL on these slots)

### Insert FX on bus / matrix / main is supported and dynamically discoverable
Each bus/matrix/main has an \`insert\` container with \`{on, pos, sel}\`. The \`sel\` field
points at an FX slot side (e.g. \`"FX5L"\`, \`"FX7"\`). To work with the GEQ on \"main\":
- \`osc_get_insert_state({target: "main"})\` — resolves to the FX slot + algorithm
- \`osc_insert_eq_get/set/reset({target})\` — operates on bands keyed by ISO frequency
  label (\`"20Hz"\`...\`"20kHz"\`, dual algos return \`channelA\`/\`channelB\`)

Targets accepted: \`"bus N"\` (1-16), \`"main"\`, \`"main mono"\`, \`"mtx N"\` (1-6), \`"ch N"\` (1-32).

### Atomic multi-field writes
\`osc_node_set(path, fields)\` writes multiple fields of a /node container in a single
OSC packet. Untouched fields are preserved. This is the canonical way to write to
the X32 — bool, dB, freq, enum, bitmask types all coerce automatically.

### Batch operations, relative adjust, and undo (do multi-step work in ONE call)
Each MCP tool call is a full LLM round trip (seconds); the OSC wire is milliseconds. Collapse
multi-step mixing into ONE call with \`osc_batch({ ops, stopOnError? })\` (max 50 ops, run in
order). Ops: \`{get:{path,field?}}\`, \`{set:{path,fields}}\`, \`{fx:{slot,params}}\`. Inside a
\`set\`, a field value may be a **relative** \`{adjust: N}\` instead of an absolute — the server
reads the current value, adds the delta, and clamps to the field's schema range (numeric fields
only; a -∞ dB value adjusts up from the range floor, e.g. -90 dB for faders).

Every write is journaled. All writes of one call fold into a single undo step. \`osc_undo({steps?})\`
reverts the last N revertible calls (writing prior values back in reverse); undoing an undo is a
redo. \`osc_journal({limit?})\` lists recent history. A scene recall clears the journal (reverting
across a full state change would be wrong).

### Schema engine covers ~6275 leaf fields across 62 containers
Use \`osc_list_nodes\` to discover what's available for any path pattern. \`osc_node_get\`
reads typed values; \`osc_node_set\` writes. This replaces hand-wrapping individual
setters for every parameter.

### Metering: snapshot for "is there signal", watch for "is it clipping / how hot over time"
- \`osc_meter_snapshot({bank})\` returns dB values for all channels in ONE ~50ms frame — the
  fast "is there signal at all?" probe. Pair with \`osc_trace_signal\` to debug "no signal at ch N".
- \`osc_meter_watch({bank, seconds, threshold_db})\` **blocks for \`seconds\`** (default 3, clamped
  0.5-10) sampling that bank ~20x/sec, then returns per-key statistics: \`peakDb\`, \`avgDb\`,
  \`clipPct\` (% of frames above -0.5 dBFS), \`activePct\` (% of frames at/above threshold). On banks
  1/2 it also returns \`gateGainReduction\` / \`dynGainReduction\` (\`maxReductionDb\`, \`avgReductionDb\`,
  \`activePct\`). A \`flags\` array raises **heuristic** hints (not reliable detection): \`clipping\`
  (key clips in >1% of frames) and \`sustained\` (level parked in a 3 dB band above -30 dBFS for
  >90% of frames — a cheap feedback / stuck-signal cue). Use this for "is ch 5 clipping?",
  "how hot is the main over the chorus?", "is the comp actually working?".
Both filter aggressively: keys below threshold (levels) or never reducing (GR) are omitted.

### Live state mirror — reads are cache-accelerated with live invalidation
After connecting, the server keeps a \`/xremote\` subscription alive, so the console pushes
every parameter change (made at the desk or by another client). Container reads
(\`osc_node_get\`, \`osc_get_strip\`, \`osc_scene_snapshot\`, overviews, compares, audits) are
served from an in-memory cache that is invalidated the instant an affected value changes —
whether that change came from us or from the outside — so cached reads are never stale.
\`osc_changes\` reports what changed on the console: e.g. "what did the band touch since
soundcheck?". Cache hit/miss/invalidation counters ride along on \`osc_get_connection\`.

### Comprehensive scene audit
\`osc_scene_snapshot\` walks every /node container in ~1.7s. \`osc_scene_audit\` runs
~15 deterministic heuristics (feedback risk, gate threshold issues, send-to-muted-bus,
FX-configured-but-muted, orphan channels, linked-pair drift, etc.).

### Comparisons + schema-driven copy
\`osc_compare_channels(a, b)\` shows only the fields that differ. \`osc_copy_channel(from, to)\`
copies processing + sends; preserves destination's identity (name/icon/color/source) and
group memberships by default. Override with \`includeConfig\`/\`includeGroups\` flags.

## Common misconceptions defused

| Misconception | Reality |
|---|---|
| FX5..8 use the same int type-code as FX1..4 | **Wrong.** Different encoding. GEQ = 28 on FX1..4, GEQ = 1 on FX5..8. \`osc_fx_get\` reads the symbolic name via /node and avoids this entirely. |
| \`/fx/N/par/PP\` accepts native-unit values like \"50ms\" | **Wrong.** The per-leaf write expects a normalized 0..1 float; native values get clipped to range max. \`osc_fx_set\` uses /node-style writes that DO accept native units. |
| \`/insert/<bus>/geq/*\` paths exist | **Wrong.** GEQ-as-insert means routing FX5..8 (loaded with a GEQ algorithm) through bus/main/mtx insert.sel. Use \`osc_insert_eq_*\` which discovers the slot dynamically. |
| \`/auxin/N/automix\` is readable like \`/ch/N/automix\` | **Wrong on firmware 4.13.** The /node container times out. \`/ch/N/automix\` works fine. |
| \`/-action/copychannel\` and \`/-action/clearchannel\` exist | **Wrong.** Not in firmware 4.x. Use \`osc_copy_channel\` (schema-driven copy) instead. |
| Routing requires switching whole 8-channel blocks | **Wrong on firmware 4.0+.** Set the block to \"User In\" once, then patch individual slots via \`/config/userrout/in/NN\`. See routing section above. |
| FX paths use zero-padded slot numbers like \`/fx/01/type\` | **Wrong.** FX uses unpadded numbers: \`/fx/1/type\`, \`/fx/8/par/01\`. Padded silently fails. (Other paths like \`/ch/05\`, \`/bus/12\` DO use 2-digit padding — FX is the exception.) |
| FX has \`/fx/N/on\` or \`/fx/N/mix\` paths | **Wrong.** FX are always instantiated. "Turn off FX 3" means muting the FX-return channel (\`/fxrtn/03/mix/on\`). Wet/dry varies by algorithm and lives in per-slot params. |
| OSC type tags can be inferred from JS values | **Risky.** X32 silently drops type-mismatched messages on strict addresses (\`/config/color\`, \`/config/icon\`, \`/config/chlink/*\`, scene recall, mute-group, solo). Use \`osc_custom_command\` with explicit \`osctype: "int"\` for these. |

## Recipe workflows

### "Why isn't channel 5 working?"
1. \`osc_trace_signal({channel: 5})\` — full signal-flow tree
2. \`osc_meter_snapshot({bank: 0})\` — confirm signal at the input
3. Fix via \`osc_node_set\` if mute/routing is wrong

### "Why is ch N distorting?"
1. \`osc_meter_watch({bank: 0, seconds: 5})\` — is the INPUT hot? A \`clipping\` flag on ch N (or
   \`clipPct\` > 0) means the source is overdriving the preamp — lower the headamp gain (\`/headamp\`)
   or the digital trim, not the fader.
2. \`osc_meter_watch({bank: 1, seconds: 5})\` — bank 1 adds post-fader level **and** gate/dyn gain
   reduction per channel. Heavy \`dynGainReduction\` on ch N (high \`maxReductionDb\`, \`activePct\` near
   100) means the compressor is slamming it; a \`sustained\` flag hints at feedback. Fix the comp
   threshold/ratio via \`osc_node_set("/ch/NN/dyn", {...})\` or back off the input.

### "Audit my scene"
1. \`osc_scene_snapshot()\` — one-shot snapshot (~1.7s, ~700 fields)
2. \`osc_scene_audit({snapshot})\` — sorted findings (error/warn/info)

### "What did the band change since soundcheck?"
\`osc_changes({sinceSeconds: 1800})\` — deduped list of every console-side parameter edit
in the last 30 min (one row per address: latest value + how many times it moved). Pass
\`includeServer: true\` to also see writes this server made.

### "Set channel 27 to Card input 1"
1. \`osc_get_routing_overview()\` — confirm whether the routing block for ch25-32 is set to "User In"
2a. If yes: \`osc_set_user_routing_in({slot: 27, source: "Card 1"})\` — done
2b. If no: switch the block first (\`osc_custom_command\` to \`/config/routing/IN/25-32\` with int 22 for User In 25-32), then patch the slot

### "Set up monitor bus 3 (build a wedge mix) in one shot"
One \`osc_batch\` call, one undo step. Sends from ch1-3 to bus 3, nudge one up relatively, unmute the bus:
\`\`\`
osc_batch({ ops: [
  { set: { path: "ch/01/mix/03", fields: { level: -8, on: true } } },
  { set: { path: "ch/02/mix/03", fields: { level: -10, on: true } } },
  { set: { path: "ch/03/mix/03", fields: { level: { adjust: 3 } } } },   // vocalist wants "more me"
  { set: { path: "bus/03/mix", fields: { fader: 0, on: true } } },
  { get: { path: "bus/03/mix", field: "fader" } }                         // confirm
]})
\`\`\`
Made it too loud? \`osc_undo()\` reverts the whole batch. Use \`osc_list_nodes("ch/*/mix/*")\` to
confirm the send-level field name for your firmware before relying on it.

### "Compare ch1 vs ch2"
\`osc_compare_channels({a: 1, b: 2})\` — returns only the fields that differ.

### "Copy ch1's processing to ch2"
\`osc_copy_channel({from: 1, to: 2})\` — preserves ch2's identity by default.

### "Find the GEQ on the main mix"
\`osc_get_insert_state({target: "main"})\` — shows insert.sel + which algorithm is in the routed slot.

### "Discover what algorithms are available for FX rack 6"
\`osc_fx_list_algorithms({detail:"names"})\` — the \`insertSlots5to8\` list is exactly what slots 5..8 accept. Then \`osc_fx_list_algorithms({detail:"full", algorithm:"..."})\` for one algo's params.

### "Check if FX1 has too long a reverb tail"
\`osc_fx_get({slot: 1})\` — returns \`{type, params}\` with named params. If type is HALL/PLAT/etc., the \`decay\` param is in seconds.

## Out of scope (intentional skips — don't try to wrap)

- **Talkback** (\`/config/talk/*\`)
- **Monitor / headphone** (\`/-stat/monitor/*\`)
- **Custom user-assignable controls** (\`/config/userctrl/*\`)
- **Scene/show file management** (\`/-show/*\`, \`/-snap/*\`, \`/-libs/*\`)
- **Save/load actions** (\`/-action/save*\`, \`/-action/load*\`, \`/-action/goscene\`, etc.)
- **Console preferences** (\`/-prefs/*\`)
- **USB recorder** (\`/-usb/*\`)
- **Streaming / subscriptions** — meter banks beyond 0/1/2/3, real-time updates
- **DP48 personal mixer** (\`/dp48/*\`)

When the user asks for one of these, tell them it's out of scope and suggest the X32-Edit
software or the console UI as the appropriate tool.

## Common operations via osc_node_set

There are NO dedicated fader/mute/pan/name setters — all writes go through
\`osc_node_set(path, fields)\` (atomic multi-field). Paths use 2-digit zero-padding
for ch/bus/mtx/auxin/fxrtn; DCA is unpadded; FX is unpadded. \`fader\` is in **dB**
(-90..10, use -Infinity/"-oo" for -∞); \`pan\` is an int (-100..+100); \`on\` is a bool
(on=unmuted). Reads: \`osc_node_get(path)\`.

| Operation | Call |
|---|---|
| Channel fader + mute | \`osc_node_set("/ch/05/mix", {fader: -6, on: false})\` |
| Bus fader + mute | \`osc_node_set("/bus/03/mix", {fader: -6, on: true})\` |
| Main LR fader/mute/pan | \`osc_node_set("/main/st/mix", {fader: 0, on: true, pan: 0})\` |
| Mono (M/C) bus | \`osc_node_set("/main/m/mix", {fader: -6, on: true})\` |
| Matrix fader/mute | \`osc_node_set("/mtx/01/mix", {fader: -6, on: true})\` |
| DCA fader/mute (unpadded) | \`osc_node_set("/dca/1", {fader: 0, on: true})\` |
| Aux-in fader/mute | \`osc_node_set("/auxin/03/mix", {fader: -6, on: true})\` |
| FX-return mute ("turn off FX 3") | \`osc_node_set("/fxrtn/03/mix", {on: false})\` |
| Name / icon / color | \`osc_node_set("/ch/05/config", {name: "Vox", color: "RD"})\` (bus/mtx/dca/main use their own \`.../config\`) |
| EQ band | \`osc_node_set("/ch/05/eq/2", {f: 2500, g: 3, q: 1.5})\` |

Use \`osc_list_nodes("ch/*/mix")\` etc. to discover exact field names for any container.

## Tool surface

44 MCP tools:
- **\`osc_capabilities\`** — this doc; **\`osc_identity\`** — model + firmware + IP + name
- **Discovery / connection (3)**: \`osc_discover_mixers\`, \`osc_connect\`, \`osc_get_connection\` (also reports cache stats)
- **Live state (1)**: \`osc_changes\` — deduped feed of console-side parameter changes
- **Batch + undo (3)**: \`osc_batch\` (many ops + relative \`{adjust}\` in one call), \`osc_undo\`, \`osc_journal\`
- **Schema-driven read/write (3)**: \`osc_list_nodes\`, \`osc_node_get\`, \`osc_node_set\` (the canonical way to read/write any parameter)
- **Composite reads (2)**: \`osc_get_strip({type, number?})\` (one tool for ch/bus/auxin/fxrtn/mtx/dca/main/mono strips), \`osc_get_console_overview\`
- **Scene snapshot / audit (2)**: \`osc_scene_snapshot\` (optional \`sections\` filter), \`osc_scene_audit\`
- **Signal-flow diagnostics (2)**: \`osc_trace_signal\`, \`osc_find_routing\`
- **FX (4)**: \`osc_fx_get\`, \`osc_fx_set\`, \`osc_fx_set_type\`, \`osc_fx_list_algorithms\` (\`detail\` levels)
- **Insert-EQ (5)**: \`osc_find_geq_slots\`, \`osc_get_insert_state\`, \`osc_insert_eq_get/set/reset\`
- **Meter (2)**: \`osc_meter_snapshot\` (one frame), \`osc_meter_watch\` (windowed stats + flags)
- **Comparison + copy (3)**: \`osc_compare_channels\`, \`osc_compare_scenes\`, \`osc_copy_channel\`
- **Routing (4)**: \`osc_get_routing_overview\` (recommended), \`osc_set_user_routing_in\`, \`osc_set_user_routing_out\`, \`osc_list_routing_sources\`
- **Scenes (3)**: \`osc_scene_recall\`, \`osc_scene_save\`, \`osc_get_scene_name\`
- **Custom escape hatch**: \`osc_custom_command\` (typed args + read-back)
- **Emulator / app (5)**: \`osc_open_x32_edit\`, \`osc_start/stop_emulator\`, \`osc_get_emulator_status\`

Routing reads are via \`osc_get_routing_overview\`; mixer status via \`osc_identity\`;
FX read/write via \`osc_fx_get\`/\`osc_fx_set\`.

## Hard rules
- **Never assume slot N hosts algorithm X.** Always read \`/fx/N/type\` first.
- **Never write native units to \`/fx/N/par/PP\` leaf.** Use \`osc_fx_set\` which handles encoding.
- **Never assume routing is 8-channel block only.** Check \`osc_get_routing_overview\`.
- **Confirm before destructive actions** (mute main, copy over a configured channel, change FX algorithm).
- **Restore state after probing.** Capture pre-state, modify, restore.
- **Prefer \`osc_batch\` for multi-step changes** (one round trip, one undo step); \`osc_undo\` reverts mistakes.
`;

// Define available tools
const TOOLS: Tool[] = [
    {
        name: "osc_capabilities",
        description:
            "Read this first: X32/M32 capability reference, common misconceptions, and recipes for this tool set.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "osc_get_strip",
        description:
            "Read a full mixer strip in one call. type: ch|bus|auxin|fxrtn|mtx|dca|main|mono; `number` required for ch(1-32)/bus(1-16)/auxin(1-8)/fxrtn(1-8)/mtx(1-6)/dca(1-8), ignored for main/mono.",
        inputSchema: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    enum: ["ch", "bus", "auxin", "fxrtn", "mtx", "dca", "main", "mono"],
                    description: "Strip type.",
                },
                number: {
                    type: "number",
                    description: "Strip number (required for ch/bus/auxin/fxrtn/mtx/dca; ignored for main/mono).",
                },
            },
            required: ["type"],
        },
    },
    {
        name: "osc_get_console_overview",
        description:
            "High-level overview of the whole console: 32 channels, 16 buses, 8 DCAs, 6 matrices, 8 aux inputs, 8 FX returns, 8 FX slot types, main bus (name/fader/mute). Reads ~200 params; takes several seconds.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "osc_set_user_routing_in",
        description:
            "Patch one User In slot (1-32) to any physical source (firmware 4.0+ 1:1 routing). source accepts a label ('Card 1','Local 27','AES50A 5','OFF') or raw int (0-168). Requires the /config/routing/IN block set to 'User In'.",
        inputSchema: {
            type: "object",
            properties: {
                slot: { type: "number", description: "User In slot (1-32)", minimum: 1, maximum: 32 },
                source: { type: ["number", "string"], description: "Source label (e.g. 'Card 1') or raw int (0-168)" },
            },
            required: ["slot", "source"],
        },
    },
    {
        name: "osc_get_routing_overview",
        description:
            "RECOMMENDED first call for routing work: full topology in one shot — input/output/AES50/Card block assignments plus the 32-slot User In and 48-slot User Out tables, all decoded to human labels.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "osc_list_routing_sources",
        description:
            "Reference dump: every valid User In source label with its numeric code, plus the block-level routing enum. Use to know what to pass to osc_set_user_routing_in or to decode raw routing codes.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "osc_set_user_routing_out",
        description:
            "Patch one User Out slot (1-48) to an internal signal source by integer code (firmware 4.0+). Only takes effect if the matching /config/routing/OUT block is set to 'User Out'.",
        inputSchema: {
            type: "object",
            properties: {
                slot: { type: "number", description: "User Out slot (1-48)", minimum: 1, maximum: 48 },
                source: { type: "number", description: "Source index (see X32 OSC spec for values)", minimum: 0 },
            },
            required: ["slot", "source"],
        },
    },
    {
        name: "osc_scene_recall",
        description: "Recall a saved scene (1-100).",
        inputSchema: {
            type: "object",
            properties: {
                scene: { type: "number", description: "Scene number (1-100)", minimum: 1, maximum: 100 },
            },
            required: ["scene"],
        },
    },
    {
        name: "osc_scene_save",
        description: "Save the current mixer state as a scene (1-100), with an optional name.",
        inputSchema: {
            type: "object",
            properties: {
                scene: { type: "number", description: "Scene number (1-100)", minimum: 1, maximum: 100 },
                name: { type: "string", description: "Scene name (optional)" },
            },
            required: ["scene"],
        },
    },
    {
        name: "osc_get_scene_name",
        description: "Get the name of a saved scene (1-100).",
        inputSchema: {
            type: "object",
            properties: {
                scene: { type: "number", description: "Scene number (1-100)", minimum: 1, maximum: 100 },
            },
            required: ["scene"],
        },
    },
    {
        name: "osc_identity",
        description:
            "Mixer identity: model, firmware, IP, hostname, and state (wraps /xinfo + /status). Use as the first call to confirm connectivity and version.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "osc_discover_mixers",
        description:
            "Scan the LAN for X32/M32 mixers by broadcasting /xinfo on UDP 10023. Stateless (doesn't retarget); pair with osc_connect. Returns [] when none found.",
        inputSchema: {
            type: "object",
            properties: {
                port: { type: "number", description: "UDP port to broadcast on (default 10023).", minimum: 1, maximum: 65535 },
                timeout_ms: { type: "number", description: "Listen window in ms before returning (default 1500).", minimum: 200, maximum: 10000 },
            },
        },
    },
    {
        name: "osc_connect",
        description:
            "Retarget the live OSC client at a mixer (host + optional port), rebuilding the connection. verify (default true) issues /xinfo and returns identity; set verify:false to preset an offline target.",
        inputSchema: {
            type: "object",
            properties: {
                host: { type: "string", description: "Mixer IP or hostname (e.g. '192.168.1.70')." },
                port: { type: "number", description: "OSC port (default 10023).", minimum: 1, maximum: 65535 },
                verify: { type: "boolean", description: "If true (default), issue /xinfo after reconnect and return the mixer identity." },
            },
            required: ["host"],
        },
    },
    {
        name: "osc_get_connection",
        description:
            "Return the current OSC target (host, port, whether sockets are bound) plus live-mirror cache stats (entries, hits, misses, invalidations). Doesn't probe the mixer — use osc_identity to confirm reachability.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "osc_changes",
        description:
            "What changed on the console. Returns a deduped feed of parameter changes pushed by the mixer via /xremote (edits made at the desk or by other clients), one row per address with the latest value, a move count, and first/last seconds-ago. Answers 'what did the band touch since soundcheck?'.",
        inputSchema: {
            type: "object",
            properties: {
                sinceSeconds: { type: "number", description: "Look-back window in seconds (default 300)." },
                includeServer: { type: "boolean", description: "Also include writes made by this server (source 'server'); default false shows only console-side changes." },
            },
        },
    },
    {
        name: "osc_custom_command",
        description:
            "Send a raw OSC command. WRITE: pass 'value' (add 'osctype' int/float/string/bool when the address needs a specific tag — X32 silently drops mismatches on color/icon/chlink/mute/solo/scene). READ: omit 'value' to query and return the reply.",
        inputSchema: {
            type: "object",
            properties: {
                address: { type: "string", description: "OSC address (e.g., /ch/01/mix/fader)" },
                value: { description: "Value to send. Omit to READ. Scalar or array of {type, value} for multi-arg messages." },
                osctype: { type: "string", enum: ["int", "float", "string", "bool"], description: "Force the OSC type tag. Use 'int' for color/icon/chlink/mute/solosw/scene addresses." },
            },
            required: ["address"],
        },
    },
    {
        name: "osc_open_x32_edit",
        description: "Open the X32-Edit application to manually control the mixer or verify commands.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "osc_start_emulator",
        description: "Start the local X32 emulator (emulator/X32 binary) so you can test without a physical mixer.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "osc_stop_emulator",
        description: "Stop the running X32 emulator server.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "osc_get_emulator_status",
        description: "Check whether the X32 emulator is currently running.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "osc_list_nodes",
        description:
            "List schema entries for X32 /node containers — path patterns, field names, types, ranges, enums. Use first to discover what osc_node_get/osc_node_set can touch. Optional glob filter (e.g. \"ch/*/gate\", \"config/*\").",
        inputSchema: {
            type: "object",
            properties: {
                filter: { type: "string", description: "Optional glob (e.g. \"ch/*/eq*\", \"config/*\", \"headamp/*\")" },
            },
        },
    },
    {
        name: "osc_node_get",
        description:
            "Read one or all fields of an X32 /node container, decoded per schema (db/freq/enum/bitmask → native JS). Path e.g. \"ch/01/gate\", \"headamp/000\", \"config/mute\". Omit `field` for the whole node as a dict.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Node path without leading slash, e.g. \"ch/01/gate\". See osc_list_nodes." },
                field: { type: "string", description: "Field name within the node. Omit to get the whole node." },
            },
            required: ["path"],
        },
    },
    {
        name: "osc_node_set",
        description:
            "Atomically write named fields of a /node container in one OSC write — the canonical setter for fader/mute/pan/name/EQ/etc. fader is dB (-Infinity/\"-oo\" for -∞); enum takes symbol or index; untouched fields preserved. E.g. osc_node_set ch/01/mix {on:false, fader:-6}.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Node path without leading slash, e.g. \"ch/01/mix\"." },
                fields: { type: "object", description: "Object mapping field name → new value (see osc_list_nodes).", additionalProperties: true },
            },
            required: ["path", "fields"],
        },
    },
    {
        name: "osc_trace_signal",
        description:
            "Trace a channel's full signal path (input → headamp → strip → DCA/mute groups → bus sends → main/mono → output taps) with heuristic warnings. Use for \"why isn't channel X working\".",
        inputSchema: {
            type: "object",
            properties: {
                channel: { type: "number", description: "Channel number (1-32)", minimum: 1, maximum: 32 },
            },
            required: ["channel"],
        },
    },
    {
        name: "osc_find_routing",
        description:
            "Reverse-lookup what feeds a destination (\"MIX 1\",\"BUS 7\",\"MTX 2\",\"MAIN\",\"MONO\",\"OUT 5\",\"P16 3\",\"AES 1\",\"REC 1\",\"FX 2\",\"DCA 1\"). Returns contributing strips with on/level/tap, filtering out off/-∞.",
        inputSchema: {
            type: "object",
            properties: {
                dest: { type: "string", description: "Destination label, e.g. \"MIX 1\", \"OUT 5\", \"FX 2\", \"DCA 1\"." },
            },
            required: ["dest"],
        },
    },
    {
        name: "osc_fx_list_algorithms",
        description:
            "List the 61 FX algorithms. detail:\"summary\" (default) gives names+codes+param counts (~4KB); \"names\" groups names by slot-class validity; \"full\" (requires `algorithm`) returns one algorithm's full param schema.",
        inputSchema: {
            type: "object",
            properties: {
                detail: { type: "string", enum: ["names", "summary", "full"], description: "Verbosity (default \"summary\")." },
                algorithm: { type: "string", description: "Symbolic name (e.g. \"HALL\"); required when detail is \"full\"." },
            },
        },
    },
    {
        name: "osc_fx_get",
        description:
            "Read an FX slot's current algorithm and decoded params: {slot, typeCode, type, description, params}. Call before osc_fx_set to learn valid param names for the slot's current algorithm.",
        inputSchema: {
            type: "object",
            properties: {
                slot: { type: "number", description: "FX slot number (1-8).", minimum: 1, maximum: 8 },
            },
            required: ["slot"],
        },
    },
    {
        name: "osc_fx_set",
        description:
            "Write named params to an FX slot (names must match the slot's current algorithm — see osc_fx_get). Values coerce per type and accept native units. Writes are per-param, NOT atomic. E.g. osc_fx_set 1 {decay:3.5, predly:20}.",
        inputSchema: {
            type: "object",
            properties: {
                slot: { type: "number", description: "FX slot number (1-8).", minimum: 1, maximum: 8 },
                params: { type: "object", description: "Param name → value for the slot's current algorithm.", additionalProperties: true },
            },
            required: ["slot", "params"],
        },
    },
    {
        name: "osc_fx_set_type",
        description:
            "Set an FX slot's algorithm by symbolic name (\"HALL\") or integer code (0..60). Validates slot-class. WARNING: changing the algorithm resets all params to defaults — re-fetch with osc_fx_get afterwards.",
        inputSchema: {
            type: "object",
            properties: {
                slot: { type: "number", description: "FX slot number (1-8).", minimum: 1, maximum: 8 },
                type: { description: "Algorithm name (e.g. \"HALL\") or integer code (0..60).", oneOf: [{ type: "string" }, { type: "number" }] },
            },
            required: ["slot", "type"],
        },
    },
    {
        name: "osc_compare_channels",
        description:
            "Diff two channel strips (1-32 each), returning only differing fields: {differences:[{path,a,b}], identical, elapsedMs}. Floats within ±0.01 count as equal. Use for \"why does vocal 2 differ from vocal 1\".",
        inputSchema: {
            type: "object",
            properties: {
                a: { type: "number", description: "First channel (1-32)", minimum: 1, maximum: 32 },
                b: { type: "number", description: "Second channel (1-32)", minimum: 1, maximum: 32 },
            },
            required: ["a", "b"],
        },
    },
    {
        name: "osc_compare_scenes",
        description:
            "Diff two scene snapshots (from osc_scene_snapshot) — pure data, no mixer reads. Returns {differences:[{path,a,b}], identical, sectionCounts}. Excludes the meta section. Use to find drift or compare saved scenes.",
        inputSchema: {
            type: "object",
            properties: {
                snapshotA: { type: "object", description: "First snapshot (from osc_scene_snapshot).", additionalProperties: true },
                snapshotB: { type: "object", description: "Second snapshot.", additionalProperties: true },
            },
            required: ["snapshotA", "snapshotB"],
        },
    },
    {
        name: "osc_copy_channel",
        description:
            "Copy a channel's processing + 16 bus sends to another channel (schema-driven). Preserves the destination's identity and group memberships by default; pass includeConfig/includeGroups to also copy those. Non-fatal per-container.",
        inputSchema: {
            type: "object",
            properties: {
                from: { type: "number", description: "Source channel (1-32).", minimum: 1, maximum: 32 },
                to: { type: "number", description: "Destination channel (1-32). Must differ from `from`.", minimum: 1, maximum: 32 },
                includeConfig: { type: "boolean", description: "Also copy identity (name, icon, color, source). Default false.", default: false },
                includeGroups: { type: "boolean", description: "Also copy DCA and mute-group memberships. Default false.", default: false },
            },
            required: ["from", "to"],
        },
    },
    {
        name: "osc_meter_snapshot",
        description:
            "One-shot meter snapshot decoded to named dB values; levels below threshold are omitted. Banks: 0 per-channel input, 1 post-fader + gate/dyn GR, 2 bus/matrix/main + GR, 3 aux/fx. Pairs with osc_trace_signal.",
        inputSchema: {
            type: "object",
            properties: {
                bank: { type: "number", description: "Meter bank 0-3 (default 0).", enum: [0, 1, 2, 3] },
                threshold_db: { type: "number", description: "dBfs threshold; level meters below are omitted (default -90)." },
            },
        },
    },
    {
        name: "osc_meter_watch",
        description:
            "BLOCKS for `seconds` (default 3, clamped 0.5-10) while sampling a meter bank ~20x/sec, then returns per-key peak/avg/clip/active stats + gate/dyn gain-reduction stats + heuristic clipping/sustained flags. Use for \"is it clipping / how hot over time\"; use osc_meter_snapshot for a single \"is there signal\" frame.",
        inputSchema: {
            type: "object",
            properties: {
                bank: { type: "number", description: "Meter bank 0-3 (default 0). 0 per-channel input, 1 post-fader + gate/dyn GR, 2 bus/matrix/main + GR, 3 aux/fx.", enum: [0, 1, 2, 3] },
                seconds: { type: "number", description: "Window length in seconds, clamped to [0.5, 10] (default 3). The call blocks for this long." },
                threshold_db: { type: "number", description: "dBfs threshold; level keys whose peak never crosses it are omitted, and it defines activePct (default -60)." },
            },
        },
    },
    {
        name: "osc_find_geq_slots",
        description:
            "Scan all 8 FX slots and return which host a 31-band graphic EQ (GEQ/GEQ2/TEQ/TEQ2). Slot contents are user-configurable, so discover before routing a GEQ as an insert.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "osc_get_insert_state",
        description:
            "Read a target's insert state — insert.on, insert.pos (PRE/POST), insert.sel (routed FX slot), and the algorithm in that slot. Target: \"bus N\"(1-16), \"main\"/\"main mono\", \"mtx N\"(1-6), \"ch N\"(1-32).",
        inputSchema: {
            type: "object",
            properties: {
                target: { type: "string", description: "\"bus N\", \"main\" / \"main mono\", \"mtx N\", \"ch N\"." },
            },
            required: ["target"],
        },
    },
    {
        name: "osc_insert_eq_get",
        description:
            "Read the 31-band GEQ inserted on a target (resolves insert.sel → FX slot dynamically). Bands keyed by ISO frequency label (\"20Hz\"..\"20kHz\") plus master; dual GEQ2/TEQ2 returns channelA/channelB. Non-GEQ slots return a message, not an error.",
        inputSchema: {
            type: "object",
            properties: {
                target: { type: "string", description: "\"bus N\", \"main\", \"main mono\", \"mtx N\", or \"ch N\"." },
            },
            required: ["target"],
        },
    },
    {
        name: "osc_insert_eq_set",
        description:
            "Write band gains to the GEQ inserted on a target (slot discovered from insert.sel). Bands keyed by ISO frequency label; partial writes preserve untouched bands. Stereo: bands+master; dual GEQ2/TEQ2: channelA/channelB.",
        inputSchema: {
            type: "object",
            properties: {
                target: { type: "string", description: "\"bus N\", \"main\", \"mtx N\", \"ch N\"." },
                bands: { type: "object", description: "Stereo GEQ/TEQ — band label → gain dB (-15..+15). E.g. {\"1kHz\": 3, \"100Hz\": -2}", additionalProperties: { type: "number" } },
                master: { type: "number", description: "Stereo GEQ/TEQ master gain dB (-15..+15)" },
                channelA: { type: "object", description: "Dual GEQ2/TEQ2 channel A — { bands: {...}, master: N }", additionalProperties: true },
                channelB: { type: "object", description: "Dual GEQ2/TEQ2 channel B — { bands: {...}, master: N }", additionalProperties: true },
            },
            required: ["target"],
        },
    },
    {
        name: "osc_insert_eq_reset",
        description: "Flatten (zero all 31 bands + master) the GEQ inserted on a target. Slot discovered dynamically.",
        inputSchema: {
            type: "object",
            properties: {
                target: { type: "string", description: "\"bus N\", \"main\", \"mtx N\", \"ch N\"." },
            },
            required: ["target"],
        },
    },
    {
        name: "osc_scene_snapshot",
        description:
            "Walk every /node container into one structured object (meta, channels, auxins, fxrtns, buses, matrices, main, dcas, fx, outputs, routing, config). ~2-5s. Optional `sections` filters top-level keys; meta is always kept.",
        inputSchema: {
            type: "object",
            properties: {
                sections: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional top-level keys to include: channels, auxins, fxrtns, buses, matrices, main, dcas, fx, outputs, routing, config. Omit for all. meta is always included.",
                },
            },
        },
    },
    {
        name: "osc_scene_audit",
        description:
            "Run deterministic heuristics over a scene snapshot, returning findings tagged info|warn|error (feedback risk, gates that won't trigger, send-to-muted-bus, linked-pair drift, etc.). Pass `snapshot` to reuse a prior one; omit to fetch fresh.",
        inputSchema: {
            type: "object",
            properties: {
                snapshot: { type: "object", description: "Optional prior osc_scene_snapshot result.", additionalProperties: true },
            },
        },
    },
    {
        name: "osc_batch",
        description:
            "Run many read/write ops as ONE call (max 50), sequentially, all writes journaled as a single undo step — the way to do multi-step mixing without a round trip per change. Each op is {get:{path,field?}}, {set:{path,fields}} (fields may be absolutes or {adjust:N} relative deltas, clamped to range), or {fx:{slot,params}}. stopOnError (default true) halts at the first failure and marks the rest skipped. Returns per-op {ok,result?,error?,undoIndex?}.",
        inputSchema: {
            type: "object",
            properties: {
                ops: {
                    type: "array",
                    description: "Ordered ops. Each: {get:{path,field?}} | {set:{path,fields}} | {fx:{slot,params}}. In `set` fields, a value may be a {adjust:N} relative delta (numeric fields only).",
                    items: { type: "object", additionalProperties: true },
                    maxItems: 50,
                },
                stopOnError: { type: "boolean", description: "Stop at first failing op and skip the rest. Default true.", default: true },
            },
            required: ["ops"],
        },
    },
    {
        name: "osc_undo",
        description:
            "Revert the last N revertible tool calls (default 1), writing captured prior values back in reverse order. Non-revertible entries (scene-recall markers, uncaptured writes) are skipped with a warning. Each undo is itself journaled, so undoing an undo is a redo.",
        inputSchema: {
            type: "object",
            properties: {
                steps: { type: "number", description: "How many revertible journal entries to revert (default 1).", minimum: 1 },
            },
        },
    },
    {
        name: "osc_journal",
        description:
            "List recent write history (default 20, newest first): each entry's timestamp, label, write count, and whether it is revertible via osc_undo.",
        inputSchema: {
            type: "object",
            properties: {
                limit: { type: "number", description: "Max entries to return (default 20).", minimum: 1 },
            },
        },
    },
];

// Create MCP server
const server = new Server(
    {
        name: "osc-mcp",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        switch (name) {
            // ========== Discovery / capability reference ==========
            case "osc_capabilities": {
                return {
                    content: [{ type: "text", text: CAPABILITIES_DOC }],
                };
            }

            // ========== Composite strip read ==========
            case "osc_get_strip": {
                const { type, number } = args as { type: string; number?: number };
                const ranges: Record<string, number> = { ch: 32, bus: 16, auxin: 8, fxrtn: 8, mtx: 6, dca: 8 };
                if (type in ranges) {
                    const max = ranges[type];
                    if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number > max) {
                        throw new Error(`osc_get_strip type "${type}" requires an integer number in 1..${max} (got ${number}).`);
                    }
                }
                let strip: any;
                switch (type) {
                    case "ch": strip = await osc.getChannelStrip(number!); break;
                    case "bus": strip = await osc.getBusStrip(number!); break;
                    case "auxin": strip = await osc.getAuxStrip(number!); break;
                    case "fxrtn": strip = await osc.getFxReturnStrip(number!); break;
                    case "mtx": strip = await osc.getMatrixStrip(number!); break;
                    case "dca": strip = await osc.getDCA(number!); break;
                    case "main":
                    case "mono": strip = await osc.getMainStrip(); break;
                    default: throw new Error(`Unknown strip type "${type}". Valid: ch, bus, auxin, fxrtn, mtx, dca, main, mono.`);
                }
                const label = type in ranges ? `${type} ${number}` : type;
                return {
                    content: [{ type: "text", text: `Strip ${label}:\n${JSON.stringify(strip)}` }],
                };
            }

            // ========== Console overview ==========
            case "osc_get_console_overview": {
                const overview = await osc.getConsoleOverview();
                return {
                    content: [{ type: "text", text: `Console overview:\n${JSON.stringify(overview)}` }],
                };
            }

            case "osc_set_user_routing_in": {
                const { slot, source } = args as { slot: number; source: number | string };
                await osc.setUserRoutingIn(slot, source);
                return {
                    content: [{ type: "text", text: `Set User In slot ${slot} source to ${source}` }],
                };
            }

            case "osc_get_routing_overview": {
                const ov = await osc.getRoutingOverview();
                return { content: [{ type: "text", text: `Routing overview:\n${JSON.stringify(ov)}` }] };
            }

            case "osc_list_routing_sources": {
                const userIn: Record<string, number> = { OFF: 0 };
                for (let i = 1; i <= 32; i++) userIn[`Local ${i}`] = i;
                for (let i = 1; i <= 48; i++) userIn[`AES50A ${i}`] = 32 + i;
                for (let i = 1; i <= 48; i++) userIn[`AES50B ${i}`] = 80 + i;
                for (let i = 1; i <= 32; i++) userIn[`Card ${i}`] = 128 + i;
                for (let i = 1; i <= 8; i++) userIn[`AUX In ${i}`] = 160 + i;
                const blockEnum: Record<number, string> = {};
                for (let n = 0; n <= 24; n++) blockEnum[n] = (await import("./osc-client.js")).decodeBlockInSource(n);
                return {
                    content: [{
                        type: "text",
                        text: `User In source codes (for /config/userrout/in/NN):\n${JSON.stringify(userIn)}\n\nBlock-level routing enum (for /config/routing/IN, AES50A, AES50B, CARD blocks):\n${JSON.stringify(blockEnum)}`,
                    }],
                };
            }

            case "osc_set_user_routing_out": {
                const { slot, source } = args as { slot: number; source: number };
                await osc.setUserRoutingOut(slot, source);
                return {
                    content: [{ type: "text", text: `Set User Out slot ${slot} source to ${source}` }],
                };
            }

            case "osc_scene_recall": {
                const { scene } = args as { scene: number };
                await osc.recallScene(scene);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Recalled scene ${scene}`,
                        },
                    ],
                };
            }

            case "osc_scene_save": {
                const { scene, name } = args as {
                    scene: number;
                    name?: string;
                };
                await osc.saveScene(scene, name);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Saved scene ${scene}${name ? ` as "${name}"` : ""}`,
                        },
                    ],
                };
            }

            case "osc_get_scene_name": {
                const { scene } = args as { scene: number };
                const name = await osc.getSceneName(scene);
                return {
                    content: [
                        {
                            type: "text",
                            text: `Scene ${scene} name is "${name}"`,
                        },
                    ],
                };
            }

            // ========== Status ==========
            case "osc_identity": {
                const id = await osc.getIdentity();
                return {
                    content: [{ type: "text", text: `Mixer identity:\n${JSON.stringify(id)}` }],
                };
            }

            case "osc_discover_mixers": {
                const { port: scanPort, timeout_ms } = args as { port?: number; timeout_ms?: number };
                const mixers = await OSCClient.discoverMixers(scanPort ?? 10023, timeout_ms ?? 1500);
                const summary = mixers.length === 0
                    ? "No mixers responded. Check that the mixer is powered on, on the same subnet, and that UDP 10023 isn't blocked by a firewall."
                    : `Found ${mixers.length} mixer${mixers.length === 1 ? "" : "s"}.`;
                return {
                    content: [{
                        type: "text",
                        text: `${summary}\n${JSON.stringify(mixers)}`,
                    }],
                };
            }

            case "osc_connect": {
                const { host, port: connPort, verify } = args as { host: string; port?: number; verify?: boolean };
                if (!host || typeof host !== "string") {
                    throw new Error("osc_connect requires a 'host' string argument.");
                }
                const targetPort = connPort ?? 10023;
                await osc.reconnect(host, targetPort);
                const shouldVerify = verify !== false;
                if (!shouldVerify) {
                    return {
                        content: [{ type: "text", text: `Retargeted to ${host}:${targetPort} (skipped /xinfo verification).` }],
                    };
                }
                try {
                    const id = await osc.getIdentity();
                    return {
                        content: [{
                            type: "text",
                            text: `Connected to ${host}:${targetPort}.\nMixer identity:\n${JSON.stringify(id)}`,
                        }],
                    };
                } catch (err) {
                    return {
                        content: [{
                            type: "text",
                            text: `Retargeted to ${host}:${targetPort} but /xinfo did not respond within 1s: ${err instanceof Error ? err.message : String(err)}. Mixer may be offline, on a different subnet, or behind a firewall.`,
                        }],
                        isError: true,
                    };
                }
            }

            case "osc_get_connection": {
                const info = osc.getConnectionInfo();
                return {
                    content: [{ type: "text", text: `Current OSC target:\n${JSON.stringify(info)}` }],
                };
            }

            case "osc_changes": {
                const { sinceSeconds, includeServer } = (args ?? {}) as {
                    sinceSeconds?: number;
                    includeServer?: boolean;
                };
                const result = osc.getChanges({ sinceSeconds, includeServer });
                return {
                    content: [{ type: "text", text: JSON.stringify(result) }],
                };
            }

            case "osc_custom_command": {
                const { address, value, osctype } = args as {
                    address: string;
                    value?: any;
                    osctype?: "int" | "float" | "string" | "bool";
                };
                const result = await osc.sendCustomCommand(address, value, osctype);
                if (value === undefined) {
                    return {
                        content: [{ type: "text", text: `READ ${address} => ${JSON.stringify(result)}` }],
                    };
                }
                return {
                    content: [{ type: "text", text: `WROTE ${address} = ${JSON.stringify(value)}${osctype ? ` (forced ${osctype})` : ""}` }],
                };
            }

            // ========== Application Controls ==========
            case "osc_open_x32_edit": {
                try {
                    await execAsync("open /Applications/X32-Edit.app");
                    return {
                        content: [
                            {
                                type: "text",
                                text: "X32-Edit application opened successfully. You can now manually control the mixer or verify that commands were applied.",
                            },
                        ],
                    };
                } catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Failed to open X32-Edit: ${error instanceof Error ? error.message : String(error)}. Make sure X32-Edit.app is installed at /Applications/X32-Edit.app`,
                            },
                        ],
                        isError: true,
                    };
                }
            }

            case "osc_start_emulator": {
                try {
                    // Check if emulator is already running
                    if (emulatorPid !== null) {
                        try {
                            // Check if process is still alive (signal 0 doesn't kill, just checks)
                            process.kill(emulatorPid, 0);
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `X32 emulator is already running (PID: ${emulatorPid}). No need to start it again.`,
                                    },
                                ],
                            };
                        } catch {
                            // Process doesn't exist, reset variables
                            emulatorProcess = null;
                            emulatorPid = null;
                        }
                    }

                    const emulatorPath = path.resolve(__dirname, "../emulator/X32");

                    const child = spawn(emulatorPath, [], {
                        detached: true,
                        stdio: "ignore",
                    });

                    emulatorProcess = child;
                    emulatorPid = child.pid || null;

                    child.unref();

                    // Wait a moment to check if process started successfully
                    await new Promise((resolve) => setTimeout(resolve, 500));

                    // Verify process is still running
                    if (emulatorPid !== null) {
                        try {
                            process.kill(emulatorPid, 0);
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `X32 emulator started successfully (PID: ${emulatorPid}) from ${emulatorPath}. It is now running in the background so you can test without connecting to a physical mixer.`,
                                    },
                                ],
                            };
                        } catch {
                            return {
                                content: [
                                    {
                                        type: "text",
                                        text: `X32 emulator process started but appears to have exited immediately. Check if the emulator binary exists at ${emulatorPath} and is executable (chmod +x emulator/X32).`,
                                    },
                                ],
                                isError: true,
                            };
                        }
                    } else {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `Failed to get PID from emulator process. The emulator may not have started correctly.`,
                                },
                            ],
                            isError: true,
                        };
                    }
                } catch (error) {
                    emulatorProcess = null;
                    emulatorPid = null;
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Failed to start X32 emulator: ${
                                    error instanceof Error ? error.message : String(error)
                                }. Make sure the emulator binary exists at emulator/X32 and is executable (chmod +x emulator/X32).`,
                            },
                        ],
                        isError: true,
                    };
                }
            }

            case "osc_stop_emulator": {
                try {
                    if (emulatorPid === null || emulatorProcess === null) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "X32 emulator is not running. Nothing to stop.",
                                },
                            ],
                        };
                    }

                    // Check if process is still alive
                    try {
                        process.kill(emulatorPid, 0);
                    } catch {
                        // Process already dead
                        emulatorProcess = null;
                        emulatorPid = null;
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "X32 emulator process was not running (may have already stopped).",
                                },
                            ],
                        };
                    }

                    // Try to kill the process gracefully first (SIGTERM)
                    try {
                        process.kill(emulatorPid, "SIGTERM");
                        // Wait a bit for graceful shutdown
                        await new Promise((resolve) => setTimeout(resolve, 1000));

                        // Check if still running
                        try {
                            process.kill(emulatorPid, 0);
                            // Still running, force kill
                            process.kill(emulatorPid, "SIGKILL");
                        } catch {
                            // Process terminated successfully
                        }
                    } catch (killError) {
                        // If kill fails, process might already be dead
                        try {
                            process.kill(emulatorPid, 0);
                            // Still alive, try force kill
                            process.kill(emulatorPid, "SIGKILL");
                        } catch {
                            // Process is dead
                        }
                    }

                    emulatorProcess = null;
                    emulatorPid = null;

                    return {
                        content: [
                            {
                                type: "text",
                                text: "X32 emulator stopped successfully.",
                            },
                        ],
                    };
                } catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Failed to stop X32 emulator: ${error instanceof Error ? error.message : String(error)}`,
                            },
                        ],
                        isError: true,
                    };
                }
            }

            case "osc_get_emulator_status": {
                try {
                    if (emulatorPid === null) {
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "X32 emulator is not running.",
                                },
                            ],
                        };
                    }

                    // Check if process is still alive
                    try {
                        process.kill(emulatorPid, 0);
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `X32 emulator is running (PID: ${emulatorPid}).`,
                                },
                            ],
                        };
                    } catch {
                        // Process is dead, reset variables
                        emulatorProcess = null;
                        emulatorPid = null;
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: "X32 emulator is not running (process has terminated).",
                                },
                            ],
                        };
                    }
                } catch (error) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `Error checking emulator status: ${error instanceof Error ? error.message : String(error)}`,
                            },
                        ],
                        isError: true,
                    };
                }
            }

            // ========== Schema-driven node tools (Phase D) ==========
            case "osc_list_nodes": {
                const { filter } = (args ?? {}) as { filter?: string };
                const entries = osc.listNodeSchemas(filter);
                return {
                    content: [{
                        type: "text",
                        text: `Node schema (${entries.length} of ${osc.nodeSchemaCount()} entries${filter ? `, filter "${filter}"` : ""}):\n${JSON.stringify(entries)}`,
                    }],
                };
            }

            case "osc_node_get": {
                const { path: nodePath, field } = args as { path: string; field?: string };
                const result = await osc.nodeGetField(nodePath, field);
                if (field) {
                    return {
                        content: [{ type: "text", text: `${nodePath}.${field} = ${JSON.stringify(result)}` }],
                    };
                }
                return {
                    content: [{ type: "text", text: `${nodePath}:\n${JSON.stringify(result)}` }],
                };
            }

            case "osc_node_set": {
                const { path: nodePath, fields } = args as { path: string; fields: Record<string, any> };
                const { wrote, sent } = await osc.nodeSetField(nodePath, fields);
                return {
                    content: [{
                        type: "text",
                        text: `Wrote ${wrote.length} field(s) on ${nodePath}: ${wrote.join(", ")}\n  encoded payload: ${JSON.stringify(sent)}`,
                    }],
                };
            }

            case "osc_trace_signal": {
                const { channel } = args as { channel: number };
                const trace = await osc.traceSignal(channel);
                return {
                    content: [{
                        type: "text",
                        text: `Signal trace for ch ${channel}:\n${JSON.stringify(trace)}`,
                    }],
                };
            }

            case "osc_find_routing": {
                const { dest } = args as { dest: string };
                const result = await osc.findRouting(dest);
                return {
                    content: [{
                        type: "text",
                        text: `Routing into ${dest}:\n${JSON.stringify(result)}`,
                    }],
                };
            }

            case "osc_fx_list_algorithms": {
                const { detail, algorithm } = (args ?? {}) as {
                    detail?: "names" | "summary" | "full";
                    algorithm?: string;
                };
                const result = summarizeFxAlgorithms(detail ?? "summary", algorithm);
                return {
                    content: [{
                        type: "text",
                        text: `FX algorithms (detail "${detail ?? "summary"}"):\n${JSON.stringify(result)}`,
                    }],
                };
            }

            case "osc_fx_get": {
                const { slot } = args as { slot: number };
                const result = await osc.fxGet(slot);
                return {
                    content: [{
                        type: "text",
                        text: `FX slot ${slot} (${result.type ?? "unknown"} / code ${result.typeCode}):\n${JSON.stringify(result)}`,
                    }],
                };
            }

            case "osc_fx_set": {
                const { slot, params } = args as { slot: number; params: Record<string, any> };
                const result = await osc.fxSet(slot, params);
                return {
                    content: [{
                        type: "text",
                        text: `Wrote ${result.wrote.length} param(s) to FX slot ${slot} (${result.type}):\n${JSON.stringify(result.sent)}`,
                    }],
                };
            }

            case "osc_fx_set_type": {
                const { slot, type } = args as { slot: number; type: string | number };
                const result = await osc.fxSetType(slot, type);
                return {
                    content: [{
                        type: "text",
                        text: `FX slot ${slot}: ${result.type} (code ${result.typeCode}) — was code ${result.previousTypeCode}. NOTE: type change typically resets params; re-fetch with osc_fx_get if needed.`,
                    }],
                };
            }

            case "osc_compare_channels": {
                const { a, b } = args as { a: number; b: number };
                const r = await osc.compareChannelStrips(a, b);
                return {
                    content: [{
                        type: "text",
                        text: r.identical
                            ? `ch ${a} and ch ${b} are identical (compared in ${r.elapsedMs}ms).`
                            : `ch ${a} vs ch ${b} — ${r.differences.length} differences (${r.elapsedMs}ms):\n${JSON.stringify(r)}`,
                    }],
                };
            }

            case "osc_compare_scenes": {
                const { snapshotA, snapshotB } = args as { snapshotA: any; snapshotB: any };
                const r = osc.compareScenes(snapshotA, snapshotB);
                return {
                    content: [{
                        type: "text",
                        text: r.identical
                            ? `Scenes are identical (excluding meta).`
                            : `Scene diff — ${r.differences.length} differences across sections ${JSON.stringify(r.sectionCounts)}:\n${JSON.stringify(r)}`,
                    }],
                };
            }

            case "osc_copy_channel": {
                const { from, to, includeConfig, includeGroups } = args as {
                    from: number; to: number; includeConfig?: boolean; includeGroups?: boolean;
                };
                const r = await osc.copyChannel(from, to, { includeConfig, includeGroups });
                return {
                    content: [{
                        type: "text",
                        text: `Copied ch ${from} → ch ${to} (${r.elapsedMs}ms): ${r.copied.length} containers copied${r.skipped.length ? `, ${r.skipped.length} skipped` : ""}${r.failed.length ? `, ${r.failed.length} FAILED` : ""}.\n${JSON.stringify(r)}`,
                    }],
                };
            }

            case "osc_meter_snapshot": {
                const { bank, threshold_db } = (args ?? {}) as { bank?: number; threshold_db?: number };
                const snap = await osc.meterSnapshot(bank ?? 0, threshold_db ?? -90);
                return {
                    content: [{
                        type: "text",
                        text: `Meter snapshot bank ${snap.bank} (${snap.description}, ${snap.elapsedMs}ms, ${snap.floatCount} floats):\n${JSON.stringify(snap)}`,
                    }],
                };
            }

            case "osc_meter_watch": {
                const { bank, seconds, threshold_db } = (args ?? {}) as { bank?: number; seconds?: number; threshold_db?: number };
                const w = await osc.meterWatch({ bank: bank ?? 0, seconds: seconds ?? 3, thresholdDb: threshold_db ?? -60 });
                const flagNote = w.flags.length ? ` — ${w.flags.length} flag(s)` : "";
                return {
                    content: [{
                        type: "text",
                        text: `Meter watch bank ${w.bank} (${w.description}) over ${w.seconds}s: ${w.frames} frames @ ~${w.sampleRateHz}Hz${flagNote}:\n${JSON.stringify(w)}`,
                    }],
                };
            }

            case "osc_find_geq_slots": {
                const slots = await osc.findGeqSlots();
                return {
                    content: [{
                        type: "text",
                        text: slots.length === 0
                            ? "No FX slot currently hosts a GEQ-class algorithm (GEQ/GEQ2/TEQ/TEQ2). Load one via osc_fx_set_type first."
                            : `GEQ-class slots loaded:\n${JSON.stringify(slots)}`,
                    }],
                };
            }

            case "osc_get_insert_state": {
                const { target } = args as { target: string };
                const state = await osc.getInsertState(target);
                return {
                    content: [{
                        type: "text",
                        text: `Insert state for ${state.target}:\n${JSON.stringify(state)}`,
                    }],
                };
            }

            case "osc_insert_eq_get": {
                const { target } = args as { target: string };
                const result = await osc.insertEqGet(target);
                return {
                    content: [{
                        type: "text",
                        text: result.message
                            ? `${result.target}: ${result.message}\n${JSON.stringify(result)}`
                            : `Insert EQ on ${result.target} (${result.type} on FX${result.slot}):\n${JSON.stringify(result)}`,
                    }],
                };
            }

            case "osc_insert_eq_set": {
                const { target, bands, master, channelA, channelB } = args as {
                    target: string;
                    bands?: Record<string, number>;
                    master?: number;
                    channelA?: { bands?: Record<string, number>; master?: number };
                    channelB?: { bands?: Record<string, number>; master?: number };
                };
                const r = await osc.insertEqSet(target, { bands, master, channelA, channelB });
                return {
                    content: [{
                        type: "text",
                        text: `Wrote ${r.wrote.length} band(s) to ${r.target} (${r.type} on FX${r.slot}): ${r.wrote.join(", ")}`,
                    }],
                };
            }

            case "osc_insert_eq_reset": {
                const { target } = args as { target: string };
                const r = await osc.insertEqReset(target);
                return {
                    content: [{
                        type: "text",
                        text: `Reset ${r.target} GEQ (${r.type} on FX${r.slot}) — ${r.wrote.length} bands flattened.`,
                    }],
                };
            }

            case "osc_scene_snapshot": {
                const { sections } = (args ?? {}) as { sections?: string[] };
                const snap = await osc.sceneSnapshot();
                let out = snap;
                if (Array.isArray(sections) && sections.length > 0) {
                    // Always retain small meta keys regardless of filter.
                    const keep = new Set<string>(["meta", ...sections]);
                    out = {};
                    for (const k of Object.keys(snap)) {
                        if (keep.has(k)) out[k] = snap[k];
                    }
                }
                return {
                    content: [{
                        type: "text",
                        text: `Scene snapshot (captured ${snap.meta.captured_at}, ${snap.meta.wall_ms}ms):\n${JSON.stringify(out)}`,
                    }],
                };
            }

            case "osc_scene_audit": {
                const { snapshot } = args as { snapshot?: any };
                const result = await osc.sceneAudit(snapshot);
                const counts = result.findings.reduce((m: Record<string, number>, f: any) => {
                    m[f.severity] = (m[f.severity] || 0) + 1;
                    return m;
                }, {});
                return {
                    content: [{
                        type: "text",
                        text: `Scene audit (${result.findings.length} findings — ${JSON.stringify(counts)}):\n${JSON.stringify(result)}`,
                    }],
                };
            }

            case "osc_batch": {
                const { ops, stopOnError } = args as { ops: any[]; stopOnError?: boolean };
                const r = await osc.batch(ops, stopOnError ?? true);
                const okCount = r.results.filter((x: any) => x.ok).length;
                const failCount = r.results.filter((x: any) => !x.ok && !x.skipped).length;
                const skipCount = r.results.filter((x: any) => x.skipped).length;
                return {
                    content: [{
                        type: "text",
                        text: `Batch of ${r.count} op(s) — ${okCount} ok, ${failCount} failed, ${skipCount} skipped (stopOnError=${r.stopOnError}):\n${JSON.stringify(r.results)}`,
                    }],
                };
            }

            case "osc_undo": {
                const { steps } = (args ?? {}) as { steps?: number };
                const r = await osc.undo(steps ?? 1);
                const totalWrites = r.reverted.reduce((s, e) => s + e.revertedWrites, 0);
                return {
                    content: [{
                        type: "text",
                        text: `Undid ${r.reverted.length} entr(ies), ${totalWrites} write(s) reverted${r.warnings.length ? ` — warnings: ${r.warnings.join("; ")}` : ""}.\n${JSON.stringify(r)}`,
                    }],
                };
            }

            case "osc_journal": {
                const { limit } = (args ?? {}) as { limit?: number };
                const r = osc.listJournal(limit ?? 20);
                return {
                    content: [{
                        type: "text",
                        text: `Journal: ${r.entries.length} of ${r.count} entr(ies) shown (newest first):\n${JSON.stringify(r.entries)}`,
                    }],
                };
            }

            default:
                return {
                    content: [
                        {
                            type: "text",
                            text: `Unknown tool: ${name}`,
                        },
                    ],
                    isError: true,
                };
        }
    } catch (error) {
        return {
            content: [
                {
                    type: "text",
                    text: `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
            isError: true,
        };
    }
});

// Start server
async function main() {
    console.error("Starting OSC MCP Server...");
    console.error(`Connecting to OSC device at ${OSC_HOST}:${OSC_PORT}`);

    await osc.connect();

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error("OSC MCP Server running");
}

main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});
