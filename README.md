# x32-mcp-server

A Model Context Protocol (MCP) server that gives Claude (or any MCP-compatible LLM) deep, structured control of a Behringer X32 / Midas M32 mixing console via OSC. Wire it into Claude Desktop, point it at a mixer, and the model can audit a scene, trace signal flow, repair routing, tune EQ, swap FX algorithms, and snapshot meter levels — all over a single UDP socket.

Originally a fork of [anteriovieira/osc-mcp-server](https://github.com/anteriovieira/osc-mcp-server); rewritten and substantially expanded across seven implementation phases (A through G). Verified against live hardware throughout.

## What's tested

- **Hardware**: X32 (full-size), firmware **4.13**
- **Should also work** on any X32 variant (Compact, Rack, Core, Producer) and the M32 family — the OSC surface is identical. Some firmware-4.0+ features (per-slot User In, the FX-rack subsets) require firmware ≥ 4.0.

> Older firmware (2.x, 3.x) had different limits — e.g. routing was bound to 8-channel blocks. Don't assume those constraints apply if you're on 4.x. The MCP exposes a tool (`osc_capabilities`) that explicitly defuses this and other common misconceptions for the LLM.

## Primary use case

**Scene audit for church volunteers.** Ask Claude:

> "Here's our scene — check it. Is anything routed funny? EQ wrong? Channels misconfigured?"

…and get back something like:

> FX1 return isn't sent to the main bus, guitar (ch 7) has +12dB at 4kHz that'll feed back, Vocal 1 (ch 2) has gate threshold at -10dB so soft phrases will cut out.

Secondary: let the AI **fix** what it flags — every readable parameter is also writable.

**Not goals**: live performance control, meter streaming, scene/show file management, talkback, monitor, custom controls, USB recorder. These are intentionally out of scope (codified in `SPEC_COVERAGE.md`).

## Setup

**Prereqs:** Node 18+, an X32 reachable on the network with OSC enabled (default port 10023), an MCP-capable client.

```bash
git clone https://github.com/elisha-rudenkov/x32-mcp-server
cd x32-mcp-server/osc-mcp-server
npm install
npm run build
```

Add to your client's MCP config (Claude Desktop on Windows: `%APPDATA%\Claude\claude_desktop_config.json`; macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "x32": {
      "command": "node",
      "args": ["C:\\path\\to\\x32-mcp-server\\osc-mcp-server\\dist\\index.js"],
      "env": {
        "OSC_HOST": "192.168.1.70",
        "OSC_PORT": "10023"
      }
    }
  }
}
```

Find your mixer's IP from `Setup` → `Network` on the console. Restart your MCP client.

> **Windows MSIX note:** if you installed Claude Desktop from the Microsoft Store, the config path is `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`.

See `INSTALLATION.md` for additional client wiring (Cline, Continue.dev, etc.).

## How the LLM should use it

When connected, **direct the LLM to call `osc_capabilities` first** if it seems uncertain. That tool returns a structured reference — firmware-4.x capabilities, recipe workflows, and an explicit "common misconceptions defused" table — so the model doesn't fall back on stale priors from training data.

Example prompts that work out of the box:

```
"Run a scene audit and tell me what to fix."
"Why isn't channel 5 working?"
"Compare ch1 and ch2 — what's different about ch2?"
"Set channel 27's input to Card 1."
"Is the GEQ on the main mix doing anything?"
"Copy ch1's processing to ch5 but keep ch5's name."
"Lower the 1kHz band on the main GEQ by 2dB."
"What's loaded on FX rack 7?"
```

## Capability highlights

71 MCP tools. The schema engine covers **62 `/node` containers**, **1738 concrete paths**, and **6275 leaf fields** (full breakdown in `SPEC_COVERAGE.md`). High-leverage features:

- **`osc_capabilities`** — single-call structured reference for the LLM. Anti-misconception oriented.
- **Schema-driven reads/writes** — `osc_node_get` / `osc_node_set` / `osc_list_nodes` cover ~80 parameters per channel without per-feature tool sprawl. Atomic multi-field writes preserve untouched fields.
- **Scene audit** — `osc_scene_snapshot` (full mixer dump in ~1.7s) + `osc_scene_audit` (~15 deterministic heuristics: feedback risk, gate threshold issues, send-to-muted-bus, FX-configured-but-muted, orphan channels, linked-pair drift, etc.). Sorted error/warn/info.
- **Signal flow** — `osc_trace_signal({channel: N})` walks input → headamp → strip → DCA/mute groups → bus sends → physical outputs. `osc_find_routing({dest})` reverse-looks up what feeds a destination.
- **FX algorithm parameter surface** — all 61 X32 FX algorithms with named parameters. `osc_fx_get`, `osc_fx_set` (atomic native-unit writes), `osc_fx_set_type` (slot-class-aware). Slot-agnostic — never assumes which rack hosts which algorithm.
- **Insert FX (GEQ/TEQ on bus/main/mtx)** — `osc_insert_eq_get/set/reset({target})` resolves `target` like `"bus 3"` / `"main"` / `"mtx 1"` to its `insert.sel`, finds the FX rack, and operates on bands by ISO frequency label (`"20Hz"`...`"20kHz"`). Dual algos return `channelA`/`channelB`.
- **One-shot meter snapshot** — `osc_meter_snapshot({bank})` decodes the X32's binary meter blob into a named dB dict in ~50ms. Banks 0/1/2/3 (per-channel input, post-fader + GR, bus/matrix/main + GR, aux/fx).
- **Comparisons + copy** — `osc_compare_channels({a, b})` returns only fields that differ. `osc_compare_scenes` diffs two snapshots. `osc_copy_channel({from, to})` schema-driven copy that preserves destination's identity by default.
- **Per-slot 1:1 user routing** — firmware 4.0+. `osc_get_routing_overview` shows BOTH the legacy 8-channel-block layer AND the 32-slot User In / 48-slot User Out tables decoded to human labels. `osc_set_user_routing_in({slot, source: "Card 1"})` for individual patches.
- **Typed custom commands** — `osc_custom_command` with explicit `osctype` override (`int`/`float`/`string`/`bool`) for strict addresses where X32 silently drops type-mismatched messages.

## Things worth knowing (X32 quirks)

The MCP and individual tool descriptions try to flag these inline, but here they are up front:

- **Routing has two layers.** Block-level (8-channel groups, legacy) AND per-slot User In (1:1 patching, firmware 4.0+). Always start routing work with `osc_get_routing_overview`. You are NOT bound to 8-channel blocks on modern firmware.
- **FX racks are user-configurable.** Any compatible algorithm can be loaded into any slot. Never assume "slot N hosts algorithm X" — read `/fx/N/type` first. `osc_fx_get` does this for you.
- **Two FX type-code namespaces.** Slots 1..4 (stereo) and slots 5..8 (insert) use **different** integer codes for the same algorithm. GEQ = code 28 on FX1..4 but code 1 on FX5..8. The MCP reads symbolic names via `/node fx/N/type` to sidestep this entirely.
- **`/fx/N/par/PP` leaf writes expect normalized 0..1.** Native-unit values get clipped to range max. `osc_fx_set` uses `/node`-style writes that preserve native units; use it instead of writing leaves directly.
- **FX has no `/on` or `/mix` paths.** FX are always instantiated. "Turn off FX 3" means muting the FX-return channel.
- **FX slot numbers are unpadded.** `/fx/1/type` works; `/fx/01/type` silently fails. Other addresses (`/ch/05/...`, `/bus/12/...`) DO use 2-digit padding. FX is the exception.
- **OSC types are strict.** X32 silently drops type-mismatched messages on certain addresses (`/config/color`, `/config/icon`, `/config/chlink/*`, scene recall, mute groups, solo). Use `osc_custom_command` with explicit `osctype: "int"` for these.
- **Channel links are per-pair, not a bitmask.** `/config/chlink/1-2`, `/config/chlink/3-4`, etc.
- **Log-scale time fields can wobble** on `/node` prefix-partial writes. `dyn.release`, `gate.attack`, etc. may not propagate exactly. If a value doesn't take, write the leaf address directly.

## Tool surface (high level)

See `SPEC_COVERAGE.md` for the full catalog. Roughly:

| Category | Tools | Key entries |
|---|---:|---|
| Discovery / capabilities | 1 | `osc_capabilities` (CALL FIRST when uncertain) |
| Identity / status | 2 | `osc_identity`, `osc_get_console_overview` |
| Schema-driven (Phase D) | 3 | `osc_list_nodes`, `osc_node_get`, `osc_node_set` |
| Signal-flow diagnostics (Phase B) | 2 | `osc_trace_signal`, `osc_find_routing` |
| Scene audit (Phase C) | 2 | `osc_scene_snapshot`, `osc_scene_audit` |
| FX algorithm surface (Phase D′) | 4 | `osc_fx_get/set/set_type/list_algorithms` |
| Insert-effect (Phase D″) | 5 | `osc_find_geq_slots`, `osc_get_insert_state`, `osc_insert_eq_*` |
| Meter snapshot (Phase E) | 1 | `osc_meter_snapshot` |
| Comparison + copy (Phase F) | 3 | `osc_compare_channels/scenes`, `osc_copy_channel` |
| Routing | 7 | `osc_get_routing_overview` (recommended), `osc_get/set_user_routing_*` |
| Channel/bus/main controls | ~20 | Legacy direct setters: faders, pans, mutes, names |
| Custom escape hatch | 1 | `osc_custom_command` |
| Other | ~20 | Effects (legacy), DCA, headamp, emulator |

## Out of scope

Documented in `SPEC_COVERAGE.md`. Briefly:

- Talkback (`/config/talk/*`)
- Monitor / headphone (`/-stat/monitor/*`)
- Custom user-assignable controls (`/config/userctrl/*`)
- Scene/show file management (`/-show/*`, `/-snap/*`, `/-libs/*`, `/-action/save*`, `/-action/load*`)
- Console preferences (`/-prefs/*`)
- USB recorder (`/-usb/*`)
- Streaming / subscriptions (meter banks beyond 0/1/2/3)
- DP48 personal mixer

If you ask the LLM to do one of these, it'll tell you it's out of scope.

## Architecture

- **`src/osc-client.ts`** — all mixer I/O. Two transports: `osc-js` for OSC-spec-compliant traffic, plus a raw `dgram` socket for the X32's non-spec replies (`/node` returns on address `node` with no leading slash, `/meters` blobs use little-endian floats). Binds UDP on `0.0.0.0` (upstream bound localhost and silently got nothing back).
- **`src/node-schema.ts`** — the canonical `/node` schema. 62 container patterns × ordered field lists × type info (bool / int / float / db / freq / ms / pct / enum / string / bitmask). Decodes `/node` text into typed JS values; encodes JS values back into the wire format.
- **`src/fx-schema.ts`** — 61 FX algorithm parameter tables sourced from the pmaillot Effects appendix and verified against live firmware. Slot-class-aware lookup (FX1..4 vs FX5..8 use different int codes for the same algorithm).
- **`src/index.ts`** — the MCP tool surface. Every tool has a `name`, `description` (LLM-facing), `inputSchema` (JSON schema), and a switch-case handler. Includes the `CAPABILITIES_DOC` returned by `osc_capabilities`.

## Development

```bash
npm run build     # compile TypeScript → dist/
npm run dev       # watch mode
npm start         # run directly (debugging outside the MCP client)
```

### Live tests against the mixer

Tests are tagged by phase and run against a real X32 (set `OSC_HOST`):

```bash
OSC_HOST=192.168.1.70 node test-phase-a.js              # /node primitive + identity
OSC_HOST=192.168.1.70 node test-phase-b.js              # signal-flow diagnostics
OSC_HOST=192.168.1.70 node test-phase-c.js              # scene snapshot + audit
OSC_HOST=192.168.1.70 node test-phase-d.js              # schema engine
OSC_HOST=192.168.1.70 node test-phase-d-prime.js        # FX algorithm surface
OSC_HOST=192.168.1.70 node test-phase-d-double-prime.js # insert-effect surface
OSC_HOST=192.168.1.70 node test-phase-e.js              # meter snapshot
OSC_HOST=192.168.1.70 node test-phase-f.js              # compare + copy
OSC_HOST=192.168.1.70 node test-fx-all-slots-roundtrip.js  # round-trip every FX rack
OSC_HOST=192.168.1.70 node spec-coverage.js             # regenerate SPEC_COVERAGE.md
```

Tests that mutate state always capture pre-state and restore byte-identically; some write a `*-backup-*.json` safety file.

## Reference

- [Patrick-Gilles Maillot's unofficial X32 OSC protocol PDF](https://wiki.munichmakerlab.de/images/1/17/UNOFFICIAL_X32_OSC_REMOTE_PROTOCOL_%281%29.pdf) — closest thing to an authoritative address reference. Verify against live hardware before trusting any address; some paths in the doc don't exist on current firmware (the MCP's schema reflects what actually works on firmware 4.13).
- `IMPLEMENTATION_PLAN.md` (project root) — phase-by-phase build plan with rationale.
- `SPEC_COVERAGE.md` — generated coverage report. Re-run `node spec-coverage.js` to refresh against current schema + live mixer.
- Upstream: [anteriovieira/osc-mcp-server](https://github.com/anteriovieira/osc-mcp-server).

## License

MIT (inherited from upstream).
