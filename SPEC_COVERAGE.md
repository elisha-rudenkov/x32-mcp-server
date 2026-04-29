# X32 MCP — Spec Coverage

Generated 2026-04-29 05:57:37 UTC by `spec-coverage.js`. Run `node spec-coverage.js` to refresh.

**Live mixer**: X32 `4.13` at `192.168.1.248` (X32-05-1A-58, state=active)

## Summary

- **MCP tools exposed**: 70
- **Schema containers** (`/node` patterns): 62
- **Concrete paths** (after range expansion): 1738
- **Total leaf fields** addressable via schema: 6275
- **FX algorithms** in fx-schema: 61 (insert-class subset: 36)
- **Live probe**: 155/158 sample paths confirmed (3 timeouts/errors)
- **Skipped path patterns**: 21 (codified out-of-scope areas)

## Schema-driven coverage

Every entry below is reachable via `osc_node_get` / `osc_node_set` / `osc_list_nodes`.

`Sampled` is `passed/total` for representative concrete paths from each pattern (first/middle/last).

| Pattern | Concrete paths | Fields | Sampled | Description |
| --- | ---: | ---: | :-: | --- |
| `auxin/[01..08]/automix` | 8 | 2 | 0/3 ⚠ | Aux input automix group assignment |
| `auxin/[01..08]/config` | 8 | 4 | 3/3 | Aux input name, icon, color, source (4 fields — auxin has source like channels) |
| `auxin/[01..08]/grp` | 8 | 2 | 3/3 | Aux input DCA / mute group memberships |
| `auxin/[01..08]/mix` | 8 | 6 | 3/3 | Aux input main mix — same shape as channel mix |
| `auxin/[01..08]/mix/[01..15:odd]` | 64 | 5 | 3/3 | Aux input send to bus (odd BB — head of bus pair) |
| `auxin/[01..08]/mix/[02..16:even]` | 64 | 2 | 3/3 | Aux input send to bus (even BB — tail of bus pair) |
| `auxin/[01..08]/preamp` | 8 | 2 | 3/3 | Aux input preamp — trim and polarity invert (no HPF on auxin) |
| `bus/[01..16]/config` | 16 | 3 | 3/3 | Mix bus name, icon, color (no source field — buses are internal) |
| `bus/[01..16]/grp` | 16 | 2 | 3/3 | Bus DCA / mute group memberships |
| `bus/[01..16]/insert` | 16 | 3 | 3/3 | Bus insert (FX patch point on mix bus) |
| `bus/[01..16]/mix` | 16 | 6 | 3/3 | Mix bus master mix — on, fader, st-send, pan, mono-send, mono-level |
| `bus/[01..16]/mix/[01..05:odd]` | 48 | 5 | 3/3 | Bus send to matrix (odd BB — head of matrix pair) |
| `bus/[01..16]/mix/[02..06:even]` | 48 | 2 | 3/3 | Bus send to matrix (even BB — tail of matrix pair) |
| `ch/[01..32]/automix` | 32 | 2 | 3/3 | Automix group assignment |
| `ch/[01..32]/config` | 32 | 4 | 3/3 | Channel name, icon, color, source select |
| `ch/[01..32]/delay` | 32 | 2 | 3/3 | Channel delay |
| `ch/[01..32]/dyn` | 32 | 15 | 3/3 | Dynamics (compressor / expander) |
| `ch/[01..32]/dyn/filter` | 32 | 3 | 3/3 | Dynamics sidechain filter |
| `ch/[01..32]/eq` | 32 | 1 | 3/3 | Channel EQ master on/off |
| `ch/[01..32]/eq/[1..4]` | 128 | 4 | 3/3 | Channel EQ band (4 bands per channel) |
| `ch/[01..32]/gate` | 32 | 8 | 3/3 | Noise gate / expander / ducker |
| `ch/[01..32]/gate/filter` | 32 | 3 | 3/3 | Gate sidechain filter |
| `ch/[01..32]/grp` | 32 | 2 | 3/3 | DCA and mute group memberships (8-bit and 6-bit bitmasks) |
| `ch/[01..32]/insert` | 32 | 3 | 3/3 | Channel insert (FX patch point) |
| `ch/[01..32]/mix` | 32 | 6 | 3/3 | Main mix on/fader/stereo/pan/mono/mono-level |
| `ch/[01..32]/mix/[01..15:odd]` | 256 | 5 | 3/3 | Channel send to bus (odd BB — head of bus pair) |
| `ch/[01..32]/mix/[02..16:even]` | 256 | 2 | 3/3 | Channel send to bus (even BB — tail of bus pair) |
| `ch/[01..32]/preamp` | 32 | 5 | 3/3 | Preamp trim, polarity, high-pass filter |
| `config/auxlink` | 1 | 4 | 1/1 | Aux input link toggles for 4 pairs (1-2 ... 7-8) |
| `config/buslink` | 1 | 8 | 1/1 | Mix bus link toggles for 8 pairs (1-2 ... 15-16) |
| `config/chlink` | 1 | 16 | 1/1 | Channel link toggles for 16 pairs (1-2, 3-4, ... 31-32) |
| `config/linkcfg` | 1 | 4 | 1/1 | Link behavior flags — which strip sections follow the channel/bus link toggle |
| `config/mtxlink` | 1 | 3 | 1/1 | Matrix link toggles for 3 pairs (1-2, 3-4, 5-6) |
| `config/mute` | 1 | 6 | 1/1 | Mute groups 1..6 master state |
| `dca/[1..8]` | 8 | 2 | 3/3 | DCA master state — on/off and fader |
| `dca/[1..8]/config` | 8 | 3 | 3/3 | DCA name, icon, color |
| `fx/[1..4]/source` | 4 | 2 | 3/3 | FX slot 1..4 stereo source — sourceL / sourceR. Values are bus name strings like 'MIX13' or 'OFF'. |
| `fxrtn/[01..08]/config` | 8 | 3 | 3/3 | FX return name, icon, color (3 fields — no source; tied to FX slot output) |
| `fxrtn/[01..08]/grp` | 8 | 2 | 3/3 | FX return DCA / mute group memberships |
| `fxrtn/[01..08]/mix` | 8 | 6 | 3/3 | FX return main mix — same shape as channel mix |
| `fxrtn/[01..08]/mix/[01..15:odd]` | 64 | 5 | 3/3 | FX return send to bus (odd BB — head of bus pair) |
| `fxrtn/[01..08]/mix/[02..16:even]` | 64 | 2 | 3/3 | FX return send to bus (even BB — tail of bus pair) |
| `headamp/[000..127]` | 128 | 2 | 3/3 | Local/AES50 head amplifier — analog input gain and phantom power |
| `main/m/config` | 1 | 3 | 1/1 | Main mono (Center/Sub) name, icon, color |
| `main/m/grp` | 1 | 2 | 1/1 | Main Mono DCA / mute group memberships |
| `main/m/insert` | 1 | 3 | 1/1 | Main Mono insert (FX patch point on mono main) |
| `main/m/mix` | 1 | 2 | 1/1 | Main Mono — on and fader only |
| `main/st/config` | 1 | 3 | 1/1 | Main stereo (LR) name, icon, color |
| `main/st/grp` | 1 | 2 | 1/1 | Main LR DCA / mute group memberships |
| `main/st/insert` | 1 | 3 | 1/1 | Main LR insert (FX patch point on stereo main) |
| `main/st/mix` | 1 | 3 | 1/1 | Main LR — on, fader, pan (3 fields; no st/mono/mlevel since main IS the destination) |
| `main/st/mix/[01..05:odd]` | 3 | 5 | 3/3 | Main LR send to matrix (odd BB — head of matrix pair) |
| `main/st/mix/[02..06:even]` | 3 | 2 | 3/3 | Main LR send to matrix (even BB — tail of matrix pair) |
| `mtx/[01..06]/config` | 6 | 3 | 3/3 | Matrix name, icon, color |
| `mtx/[01..06]/grp` | 6 | 2 | 3/3 | Matrix DCA / mute group memberships |
| `mtx/[01..06]/insert` | 6 | 3 | 3/3 | Matrix insert (FX patch point on matrix output) |
| `mtx/[01..06]/mix` | 6 | 2 | 3/3 | Matrix master — on and fader only (no panning at matrix output) |
| `outputs/aes/[01..02]` | 2 | 3 | 3/3 | AES50 / AES out — source tap, tap position, polarity invert |
| `outputs/aux/[01..06]` | 6 | 3 | 3/3 | Physical AUX OUT 1-6 — source tap, tap position, polarity invert |
| `outputs/main/[01..16]` | 16 | 3 | 3/3 | Physical OUT 1-16 — source tap, tap position, polarity invert |
| `outputs/p16/[01..16]` | 16 | 3 | 3/3 | P16 personal-monitor outputs 1-16 — source tap, tap position, polarity invert |
| `outputs/rec/[01..02]` | 2 | 2 | 3/3 | Recording outputs — source tap and tap position only (no invert) |

### Live probe failures

Sample concrete paths that timed out or returned empty. Often indicates an inactive slot (e.g. unassigned headamp) rather than a schema bug — verify with X32-Edit.

- **`auxin/[01..08]/automix`** (3/3 failed):
  - `auxin/01/automix` — ["auxin/01/automix"]
  - `auxin/05/automix` — ["auxin/05/automix"]
  - `auxin/08/automix` — ["auxin/08/automix"]

## MCP tools by category

### Schema-driven (Phase D) (3)

- `osc_list_nodes`
- `osc_node_get`
- `osc_node_set`

### FX algorithm surface (Phase D′) (4)

- `osc_fx_get`
- `osc_fx_list_algorithms`
- `osc_fx_set`
- `osc_fx_set_type`

### Insert-effect (Phase D″) (5)

- `osc_find_geq_slots`
- `osc_get_insert_state`
- `osc_insert_eq_get`
- `osc_insert_eq_reset`
- `osc_insert_eq_set`

### Meter snapshot (Phase E) (1)

- `osc_meter_snapshot`

### Comparison & copy (Phase F) (3)

- `osc_compare_channels`
- `osc_compare_scenes`
- `osc_copy_channel`

### Signal-flow diagnostics (Phase B) (3)

- `osc_find_routing`
- `osc_identity`
- `osc_trace_signal`

### Scene snapshot/audit (Phase C) (4)

- `osc_scene_audit`
- `osc_scene_recall`
- `osc_scene_save`
- `osc_scene_snapshot`

### Channel/bus/main controls (legacy direct setters) (21)

- `osc_copy_eq`
- `osc_get_aux_fader`
- `osc_get_aux_strip`
- `osc_get_bus_fader`
- `osc_get_bus_strip`
- `osc_get_channel_strip`
- `osc_get_fxreturn_strip`
- `osc_get_main_fader`
- `osc_get_main_strip`
- `osc_get_matrix_strip`
- `osc_mute_bus`
- `osc_mute_main`
- `osc_mute_matrix`
- `osc_set_aux_fader`
- `osc_set_aux_pan`
- `osc_set_bus_fader`
- `osc_set_bus_name`
- `osc_set_bus_pan`
- `osc_set_main_fader`
- `osc_set_main_pan`
- `osc_set_matrix_fader`

### Routing (legacy) (7)

- `osc_get_routing`
- `osc_get_routing_overview`
- `osc_get_user_routing`
- `osc_get_user_routing_in`
- `osc_get_user_routing_out`
- `osc_set_user_routing_in`
- `osc_set_user_routing_out`

### Custom commands (1)

- `osc_custom_command`

### Other (18)

- `osc_get_all_effects`
- `osc_get_console_overview`
- `osc_get_dca`
- `osc_get_effect_on`
- `osc_get_effect_param`
- `osc_get_effect_type`
- `osc_get_emulator_status`
- `osc_get_full_fx_chain`
- `osc_get_mixer_status`
- `osc_get_scene_name`
- `osc_list_routing_sources`
- `osc_mute_aux`
- `osc_node_read`
- `osc_open_x32_edit`
- `osc_set_effect_on`
- `osc_set_effect_param`
- `osc_start_emulator`
- `osc_stop_emulator`

## Codified skip list

Areas intentionally NOT wrapped, per the project's stated scope (scene audit + repair, not live mixing or scene file management).

| Pattern | Reason |
| --- | --- |
| `/config/talk/*` | talkback (out of scope — live mixing not goal) |
| `/-stat/talk/*` | talkback status |
| `/-stat/monitor/*` | monitor/headphone (not goal) |
| `/config/userctrl/*` | custom controls (not goal) |
| `/-show/*` | scene/show file management (not goal) |
| `/-snap/*` | snapshot file management (not goal) |
| `/-libs/*` | channel libraries (not goal) |
| `/-action/save*` | save file actions (not goal) |
| `/-action/load*` | load file actions (not goal) |
| `/-action/goscene` | scene navigation (not goal) |
| `/-action/gosnippet` | snippet navigation (not goal) |
| `/-action/gocue` | cue navigation (not goal) |
| `/-prefs/*` | console preferences (not goal) |
| `/-usb/*` | USB recorder (not goal) |
| `/meters/4..15` | RTA / per-FX / console-VU banks (Phase E exposes 0/1/2/3) |
| `/subscribe` | streaming (one-shot model) |
| `/batchsubscribe` | streaming |
| `/formatsubscribe` | streaming |
| `/renew` | streaming |
| `/xremote` | all-update streaming (used internally for keepalive) |
| `/dp48/*` | Digital Personal Mixer (out of scope) |

## Known unwrapped surface

Documented X32 paths that are NOT in the schema and NOT in the skip list. These are candidates for future phases or one-off `osc_custom_command` use.

- **`/auxin/*/automix`** — does NOT exist as a `/node` container on firmware 4.13 (verified by probe). Schema entry retained for write-only paths but bulk readers must skip.
- **`/fx/[5..8]/source`** — times out on firmware 4.13 (slots 5..8 are channel-insert FX with no source field).
- **`/fx/[1..8]/par/PP` leaves** — exposed via `osc_fx_set` (uses `/node`-style write to `fx/N/par` for native-unit round-trip; the per-leaf write expects normalized 0..1 floats).
- **`/-stat/automix/*`, `/config/amix/*`** — probed; no response on firmware 4.13. AutoMix per-channel covered via `ch/NN/automix`; group-master controls aren't OSC-exposed.
- **`/-stat/solosw/*`, `/-stat/solo`** — solo state. Not currently wrapped; addable via leaf tool if user need surfaces.
- **`/-stat/keysolo`, `/-stat/aes50/*`, `/-stat/screen/*`, `/-stat/tape/*`** — console state observables. Not wrapped.
- **`/headamp/*` for slots 064..127** — covered by schema, but slots above 64 are AES50A/B and depend on console state. Probe results above.
