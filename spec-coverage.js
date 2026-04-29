#!/usr/bin/env node
// Phase G — spec conformance harness.
// Generates SPEC_COVERAGE.md by:
//   1. Expanding every NODE_SCHEMA entry's path pattern to concrete paths.
//   2. Probing the live mixer for each container — confirms the schema reflects reality.
//   3. Listing all MCP tools registered, grouped by category.
//   4. Documenting the codified skip list (areas intentionally NOT wrapped).
//
// Output is written to SPEC_COVERAGE.md at the project root.
//
// Run against the live mixer:
//   node spec-coverage.js
//
// Optional env: OSC_HOST, OSC_PORT
// Optional flag: --offline (skip live probing; schema-only report)

import { OSCClient } from "./dist/osc-client.js";
import { NODE_SCHEMA } from "./dist/node-schema.js";
import { FX_ALGORITHM_SCHEMA } from "./dist/fx-schema.js";
import { writeFileSync, readFileSync } from "fs";

const HOST = process.env.OSC_HOST || "192.168.1.248";
const PORT = parseInt(process.env.OSC_PORT || "10023");
const OFFLINE = process.argv.includes("--offline");

// ========== Skip list (codified per IMPLEMENTATION_PLAN.md Phase G) ==========
const SKIP_LIST = [
    { pattern: "/config/talk/*", reason: "talkback (out of scope — live mixing not goal)" },
    { pattern: "/-stat/talk/*", reason: "talkback status" },
    { pattern: "/-stat/monitor/*", reason: "monitor/headphone (not goal)" },
    { pattern: "/config/userctrl/*", reason: "custom controls (not goal)" },
    { pattern: "/-show/*", reason: "scene/show file management (not goal)" },
    { pattern: "/-snap/*", reason: "snapshot file management (not goal)" },
    { pattern: "/-libs/*", reason: "channel libraries (not goal)" },
    { pattern: "/-action/save*", reason: "save file actions (not goal)" },
    { pattern: "/-action/load*", reason: "load file actions (not goal)" },
    { pattern: "/-action/goscene", reason: "scene navigation (not goal)" },
    { pattern: "/-action/gosnippet", reason: "snippet navigation (not goal)" },
    { pattern: "/-action/gocue", reason: "cue navigation (not goal)" },
    { pattern: "/-prefs/*", reason: "console preferences (not goal)" },
    { pattern: "/-usb/*", reason: "USB recorder (not goal)" },
    { pattern: "/meters/4..15", reason: "RTA / per-FX / console-VU banks (Phase E exposes 0/1/2/3)" },
    { pattern: "/subscribe", reason: "streaming (one-shot model)" },
    { pattern: "/batchsubscribe", reason: "streaming" },
    { pattern: "/formatsubscribe", reason: "streaming" },
    { pattern: "/renew", reason: "streaming" },
    { pattern: "/xremote", reason: "all-update streaming (used internally for keepalive)" },
    { pattern: "/dp48/*", reason: "Digital Personal Mixer (out of scope)" },
];

// ========== Path expansion ==========
function expandPattern(pattern) {
    const tokens = pattern.split("/").filter((s) => s.length > 0);
    const out = [];
    function recurse(prefix, idx) {
        if (idx === tokens.length) { out.push(prefix); return; }
        const t = tokens[idx];
        const m = t.match(/^\[(.+)\]$/);
        if (m) {
            const body = m[1];
            const parityM = body.match(/^(.+?):(odd|even)$/);
            const parity = parityM ? parityM[2] : null;
            const range = parityM ? parityM[1] : body;
            const [a, b] = range.split("..");
            const pad = a.startsWith("0") && a.length > 1 ? a.length : 0;
            const start = parseInt(a, 10), end = parseInt(b, 10);
            for (let i = start; i <= end; i++) {
                if (parity === "odd" && i % 2 === 0) continue;
                if (parity === "even" && i % 2 !== 0) continue;
                const tok = pad ? String(i).padStart(pad, "0") : String(i);
                recurse(prefix ? `${prefix}/${tok}` : tok, idx + 1);
            }
        } else {
            recurse(prefix ? `${prefix}/${t}` : t, idx + 1);
        }
    }
    recurse("", 0);
    return out;
}

// ========== MCP tool inventory ==========
function categorizeTools() {
    const indexSrc = readFileSync(new URL("./src/index.ts", import.meta.url), "utf8");
    const toolNames = [];
    const re = /name:\s*"(osc_[a-z0-9_]+)"/g;
    let m;
    while ((m = re.exec(indexSrc)) !== null) toolNames.push(m[1]);

    const categories = {
        "Schema-driven (Phase D)": (n) => /^osc_(list_nodes|node_get|node_set)$/.test(n),
        "FX algorithm surface (Phase D′)": (n) => /^osc_fx_/.test(n),
        "Insert-effect (Phase D″)": (n) => /^(osc_insert_eq_|osc_get_insert_state|osc_find_geq_slots)/.test(n),
        "Meter snapshot (Phase E)": (n) => n === "osc_meter_snapshot",
        "Comparison & copy (Phase F)": (n) => /^osc_(compare_channels|compare_scenes|copy_channel)$/.test(n),
        "Signal-flow diagnostics (Phase B)": (n) => /^osc_(trace_signal|find_routing|identity)$/.test(n),
        "Scene snapshot/audit (Phase C)": (n) => /^osc_scene_/.test(n),
        "Channel/bus/main controls (legacy direct setters)": (n) =>
            /^osc_(set|get|mute)_(channel|bus|main|matrix|fader|fx)/.test(n) ||
            /^osc_(set|get)_(eq|gate|dyn|name|color|icon|hp|pan|fx|fxretu|ch|aux)/.test(n) ||
            n === "osc_copy_eq",
        "Headamp / preamp (legacy)": (n) => /^osc_(set|get)_(head|preamp|gain|phantom|invert)/.test(n),
        "Routing (legacy)": (n) => /^osc_(get|set)_(routing|user_routing|user_in|user_out)/.test(n),
        "Custom commands": (n) => /^osc_(custom|raw_send|sleep|emulator)/.test(n),
        "Other": (_n) => true,
    };

    const grouped = Object.fromEntries(Object.keys(categories).map((k) => [k, []]));
    for (const name of toolNames) {
        for (const [cat, pred] of Object.entries(categories)) {
            if (pred(name)) { grouped[cat].push(name); break; }
        }
    }
    return { total: toolNames.length, grouped };
}

// ========== Live probe ==========
async function probeLive(osc) {
    const results = new Map(); // pattern → { totalConcrete, ok, timeout, errors }
    for (const entry of NODE_SCHEMA) {
        const concrete = expandPattern(entry.path);
        // Probe a SAMPLE of paths per pattern (first + last + one in middle) to keep total time reasonable.
        // For single-path entries (e.g. config/mute), probe the one.
        const samples = concrete.length === 1
            ? concrete
            : [concrete[0], concrete[Math.floor(concrete.length / 2)], concrete[concrete.length - 1]];
        let ok = 0, fail = 0;
        const failed = [];
        for (const p of samples) {
            try {
                const node = await osc.nodeRead(p);
                if (node.values && node.values.length > 0) ok++;
                else fail++;
            } catch (e) {
                fail++;
                failed.push({ path: p, err: e.message.replace(/^Timeout: \/node /, "") });
            }
        }
        results.set(entry.path, {
            totalConcrete: concrete.length,
            samplesProbed: samples.length,
            ok,
            fail,
            failedPaths: failed.slice(0, 3),
            fields: entry.fields.length,
            description: entry.description,
        });
    }
    return results;
}

function summarize(probeResults) {
    let totalContainers = 0;
    let totalConcretePaths = 0;
    let totalLeafFields = 0;
    let totalSamples = 0;
    let totalOk = 0;
    let totalFail = 0;
    for (const [, r] of probeResults) {
        totalContainers++;
        totalConcretePaths += r.totalConcrete;
        totalLeafFields += r.fields * r.totalConcrete;
        totalSamples += r.samplesProbed;
        totalOk += r.ok;
        totalFail += r.fail;
    }
    return { totalContainers, totalConcretePaths, totalLeafFields, totalSamples, totalOk, totalFail };
}

// ========== Markdown emit ==========
function emitMarkdown(probeResults, toolInfo, identity, summary, isOffline) {
    const lines = [];
    const ts = new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC";

    lines.push("# X32 MCP — Spec Coverage");
    lines.push("");
    lines.push(`Generated ${ts} by \`spec-coverage.js\`. Run \`node spec-coverage.js\` to refresh.`);
    if (isOffline) lines.push("> **OFFLINE MODE** — schema-only report; no live probe results below.");
    lines.push("");
    if (identity) {
        lines.push(`**Live mixer**: ${identity.model} \`${identity.firmware}\` at \`${identity.ip}\` (${identity.name || "unnamed"}, state=${identity.state})`);
        lines.push("");
    }

    // ---- Summary ----
    lines.push("## Summary");
    lines.push("");
    lines.push(`- **MCP tools exposed**: ${toolInfo.total}`);
    lines.push(`- **Schema containers** (\`/node\` patterns): ${summary.totalContainers}`);
    lines.push(`- **Concrete paths** (after range expansion): ${summary.totalConcretePaths}`);
    lines.push(`- **Total leaf fields** addressable via schema: ${summary.totalLeafFields}`);
    lines.push(`- **FX algorithms** in fx-schema: ${FX_ALGORITHM_SCHEMA.length} (insert-class subset: ${FX_ALGORITHM_SCHEMA.filter((e) => e.slots.insert).length})`);
    if (!isOffline) {
        lines.push(`- **Live probe**: ${summary.totalOk}/${summary.totalSamples} sample paths confirmed (${summary.totalFail} timeouts/errors)`);
    }
    lines.push(`- **Skipped path patterns**: ${SKIP_LIST.length} (codified out-of-scope areas)`);
    lines.push("");

    // ---- Schema coverage table ----
    lines.push("## Schema-driven coverage");
    lines.push("");
    lines.push("Every entry below is reachable via `osc_node_get` / `osc_node_set` / `osc_list_nodes`.");
    lines.push("");
    if (!isOffline) {
        lines.push("`Sampled` is `passed/total` for representative concrete paths from each pattern (first/middle/last).");
        lines.push("");
    }
    lines.push("| Pattern | Concrete paths | Fields | Sampled | Description |");
    lines.push("| --- | ---: | ---: | :-: | --- |");
    const sortedEntries = [...probeResults.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [pattern, r] of sortedEntries) {
        const sampled = isOffline ? "—" : `${r.ok}/${r.samplesProbed}`;
        const flag = !isOffline && r.fail > 0 ? " ⚠" : "";
        lines.push(`| \`${pattern}\` | ${r.totalConcrete} | ${r.fields} | ${sampled}${flag} | ${r.description} |`);
    }
    lines.push("");

    // Probe failures
    if (!isOffline) {
        const failedEntries = [...probeResults.entries()].filter(([, r]) => r.fail > 0);
        if (failedEntries.length > 0) {
            lines.push("### Live probe failures");
            lines.push("");
            lines.push("Sample concrete paths that timed out or returned empty. Often indicates an inactive slot (e.g. unassigned headamp) rather than a schema bug — verify with X32-Edit.");
            lines.push("");
            for (const [pattern, r] of failedEntries) {
                lines.push(`- **\`${pattern}\`** (${r.fail}/${r.samplesProbed} failed):`);
                for (const fp of r.failedPaths) {
                    lines.push(`  - \`${fp.path}\` — ${fp.err}`);
                }
            }
            lines.push("");
        }
    }

    // ---- Tools inventory ----
    lines.push("## MCP tools by category");
    lines.push("");
    for (const [category, names] of Object.entries(toolInfo.grouped)) {
        if (names.length === 0) continue;
        lines.push(`### ${category} (${names.length})`);
        lines.push("");
        for (const n of names.sort()) lines.push(`- \`${n}\``);
        lines.push("");
    }

    // ---- Skip list ----
    lines.push("## Codified skip list");
    lines.push("");
    lines.push("Areas intentionally NOT wrapped, per the project's stated scope (scene audit + repair, not live mixing or scene file management).");
    lines.push("");
    lines.push("| Pattern | Reason |");
    lines.push("| --- | --- |");
    for (const s of SKIP_LIST) lines.push(`| \`${s.pattern}\` | ${s.reason} |`);
    lines.push("");

    // ---- Known unwrapped surface ----
    lines.push("## Known unwrapped surface");
    lines.push("");
    lines.push("Documented X32 paths that are NOT in the schema and NOT in the skip list. These are candidates for future phases or one-off `osc_custom_command` use.");
    lines.push("");
    lines.push("- **`/auxin/*/automix`** — does NOT exist as a `/node` container on firmware 4.13 (verified by probe). Schema entry retained for write-only paths but bulk readers must skip.");
    lines.push("- **`/fx/[5..8]/source`** — times out on firmware 4.13 (slots 5..8 are channel-insert FX with no source field).");
    lines.push("- **`/fx/[1..8]/par/PP` leaves** — exposed via `osc_fx_set` (uses `/node`-style write to `fx/N/par` for native-unit round-trip; the per-leaf write expects normalized 0..1 floats).");
    lines.push("- **`/-stat/automix/*`, `/config/amix/*`** — probed; no response on firmware 4.13. AutoMix per-channel covered via `ch/NN/automix`; group-master controls aren't OSC-exposed.");
    lines.push("- **`/-stat/solosw/*`, `/-stat/solo`** — solo state. Not currently wrapped; addable via leaf tool if user need surfaces.");
    lines.push("- **`/-stat/keysolo`, `/-stat/aes50/*`, `/-stat/screen/*`, `/-stat/tape/*`** — console state observables. Not wrapped.");
    lines.push("- **`/headamp/*` for slots 064..127** — covered by schema, but slots above 64 are AES50A/B and depend on console state. Probe results above.");
    lines.push("");

    return lines.join("\n");
}

// ========== Entry point ==========
async function main() {
    const toolInfo = categorizeTools();

    let probeResults = new Map();
    let identity = null;
    let osc = null;
    if (!OFFLINE) {
        osc = new OSCClient(HOST, PORT);
        await osc.connect();
        await new Promise((r) => setTimeout(r, 200));
        try { identity = await osc.getIdentity(); } catch { /* keep going */ }
        console.log(`Probing live mixer ${HOST}:${PORT} ...`);
        probeResults = await probeLive(osc);
        osc.close();
    } else {
        // Offline: still build schema entries with no probe results
        for (const entry of NODE_SCHEMA) {
            const concrete = expandPattern(entry.path);
            probeResults.set(entry.path, {
                totalConcrete: concrete.length,
                samplesProbed: 0,
                ok: 0,
                fail: 0,
                failedPaths: [],
                fields: entry.fields.length,
                description: entry.description,
            });
        }
    }

    const summary = summarize(probeResults);
    const md = emitMarkdown(probeResults, toolInfo, identity, summary, OFFLINE);

    const outPath = "SPEC_COVERAGE.md";
    writeFileSync(outPath, md);
    console.log(`\nWrote ${outPath} (${md.length} bytes)`);
    console.log(`Tools: ${toolInfo.total}`);
    console.log(`Containers: ${summary.totalContainers}, concrete paths: ${summary.totalConcretePaths}, leaf fields: ${summary.totalLeafFields}`);
    if (!OFFLINE) {
        console.log(`Live probe: ${summary.totalOk}/${summary.totalSamples} ok, ${summary.totalFail} failed`);
    }

    process.exit(0);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
