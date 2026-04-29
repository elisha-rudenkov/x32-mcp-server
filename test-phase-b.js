#!/usr/bin/env node
// Phase B test — composite signal-flow diagnostics.
// Verifies:
//   1. New schema entries (outputs/main, outputs/p16, dca, dca/N/config) match
//      live /node field counts.
//   2. osc_trace_signal walks the path correctly for a channel that's currently
//      feeding MIX 1 — that bus appears in the busSends list.
//   3. osc_find_routing("MIX 1") returns the same channel as a contributor.
//   4. osc_find_routing for OUT and MAIN return sensible shapes.

import { OSCClient } from "./dist/osc-client.js";

const HOST = process.env.OSC_HOST || "192.168.1.248";
const PORT = parseInt(process.env.OSC_PORT || "10023");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function assert(cond, label) {
    if (cond) {
        console.log(`  PASS ${label}`);
        pass++;
    } else {
        console.log(`  FAIL ${label}`);
        fail++;
    }
}

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await sleep(200);

    console.log("=".repeat(72));
    console.log("1. Schema field counts vs live /node");
    console.log("=".repeat(72));
    const probes = [
        { path: "outputs/main/01", expect: 3 },
        { path: "outputs/aux/01", expect: 3 },
        { path: "outputs/p16/01", expect: 3 },
        { path: "outputs/aes/01", expect: 3 },
        { path: "outputs/rec/01", expect: 2 },
        { path: "dca/1", expect: 2 },
        { path: "dca/1/config", expect: 3 },
        { path: "bus/01/config", expect: 3 },
        { path: "bus/01/mix", expect: 6 },
        { path: "bus/01/mix/01", expect: 5 },
        { path: "bus/01/mix/02", expect: 2 },
        { path: "auxin/01/config", expect: 4 },
        { path: "auxin/01/preamp", expect: 2 },
        { path: "fxrtn/01/config", expect: 3 },
        { path: "fxrtn/01/mix", expect: 6 },
        { path: "mtx/01/config", expect: 3 },
        { path: "mtx/01/mix", expect: 2 },
        { path: "main/st/config", expect: 3 },
        { path: "main/st/mix", expect: 3 },
        { path: "main/m/mix", expect: 2 },
        { path: "main/st/mix/01", expect: 5 },
        { path: "main/st/mix/02", expect: 2 },
    ];
    for (const p of probes) {
        try {
            const n = await osc.nodeRead(p.path);
            const ok = n.values.length === p.expect;
            assert(ok, `${p.path.padEnd(28)} fields=${n.values.length} (want ${p.expect})  values=${JSON.stringify(n.values).slice(0, 60)}`);
        } catch (e) {
            assert(false, `${p.path}: ${e.message}`);
        }
    }

    // Verify schema lookup matches each
    console.log("\n  -- Schema entry lookups --");
    const { findSchema } = await import("./dist/node-schema.js");
    for (const p of probes) {
        const s = findSchema(p.path);
        assert(!!s && s.fields.length >= p.expect, `findSchema(${p.path}) ⇒ ${s ? `${s.path} [${s.fields.length}]` : "null"}`);
    }

    console.log();
    console.log("=".repeat(72));
    console.log("2. osc_trace_signal — find a channel feeding MIX 1, then trace it");
    console.log("=".repeat(72));

    // Hunt for a channel with ch/N/mix/01.on=true and level>-90
    let testChannel = null;
    for (let c = 1; c <= 32; c++) {
        const nn = String(c).padStart(2, "0");
        try {
            const send = await osc.nodeRead(`ch/${nn}/mix/01`);
            const on = send.values[0] === "ON";
            const lvl = send.values[1];
            const lvlNum = lvl === "-oo" ? -Infinity : parseFloat(lvl);
            if (on && lvlNum > -90) { testChannel = c; break; }
        } catch {}
    }
    if (testChannel === null) {
        console.log("  No channel currently feeds MIX 1 with level > -∞. Skipping trace assertions.");
    } else {
        console.log(`  Selected ch ${testChannel} (feeds MIX 1)`);
        const trace = await osc.traceSignal(testChannel);
        console.log(`  Trace summary:`);
        console.log(`    name: ${trace.name}`);
        console.log(`    on/fader: ${trace.strip.on}/${trace.strip.fader}`);
        console.log(`    headamp: ${JSON.stringify(trace.input.headamp)}`);
        console.log(`    DCAs: ${trace.strip.dcaMembers.join(",") || "(none)"}`);
        console.log(`    busSends (hot): ${trace.busSends.filter(s => s.hot).map(s => `MIX${s.bus} ${s.level}dB`).join(", ") || "(none)"}`);
        console.log(`    mainSt send: ${JSON.stringify(trace.mainSends.st)}`);
        console.log(`    direct outputs: ${trace.outputs.length}`);
        console.log(`    warnings: ${JSON.stringify(trace.warnings)}`);

        const mix1Hit = trace.busSends.find((s) => s.bus === 1 && s.hot);
        assert(!!mix1Hit, "trace.busSends includes MIX 1 as hot");
        assert(trace.channel === testChannel, "trace.channel matches input");
        assert(typeof trace.warnings === "object" && Array.isArray(trace.warnings), "trace.warnings is an array");
    }

    console.log();
    console.log("=".repeat(72));
    console.log("3. osc_find_routing — MIX 1 should reverse-lookup the same channel");
    console.log("=".repeat(72));
    const r1 = await osc.findRouting("MIX 1");
    console.log(`  contributors: ${r1.contributors.map((c) => `${c.strip}(${c.name || "-"}) ${c.level}dB`).join(", ") || "(none)"}`);
    assert(r1.kind === "bus" && r1.dest === "MIX 1", "findRouting('MIX 1') metadata");
    if (testChannel !== null) {
        const tag = `ch/${String(testChannel).padStart(2, "0")}`;
        const found = r1.contributors.find((c) => c.strip === tag);
        assert(!!found, `findRouting('MIX 1') includes ${tag}`);
    }

    console.log();
    console.log("=".repeat(72));
    console.log("4. osc_find_routing — OUT 1 / MAIN / MTX 1 / FX 1 / DCA 1 shapes");
    console.log("=".repeat(72));

    const r2 = await osc.findRouting("OUT 1");
    console.log(`  OUT 1: ${JSON.stringify(r2)}`);
    assert(r2.kind === "output" && r2.container === "outputs/main/01", "findRouting('OUT 1') resolves to outputs/main/01");
    assert(typeof r2.srcLabel === "string", "OUT 1 has srcLabel");

    const r3 = await osc.findRouting("MAIN");
    console.log(`  MAIN: ${r3.contributors.length} contributors`);
    assert(r3.kind === "main" && r3.dest === "MAIN LR", "findRouting('MAIN') metadata");

    const r4 = await osc.findRouting("MTX 1");
    console.log(`  MTX 1: ${r4.contributors.length} contributors`);
    assert(r4.kind === "matrix" && r4.dest === "MTX 1", "findRouting('MTX 1') metadata");

    const r5 = await osc.findRouting("FX 1");
    console.log(`  FX 1: sourceL=${r5.sourceL} sourceR=${r5.sourceR}`);
    assert(r5.kind === "fx", "findRouting('FX 1') is fx");

    const r6 = await osc.findRouting("DCA 1");
    console.log(`  DCA 1 members: ${r6.contributors.map((c) => c.strip).join(",") || "(none)"}`);
    assert(r6.kind === "dca", "findRouting('DCA 1') is dca");

    // Reject unknown
    let threw = false;
    try { await osc.findRouting("BANANAS"); } catch (e) { threw = true; }
    assert(threw, "findRouting('BANANAS') throws");

    console.log();
    console.log("=".repeat(72));
    console.log(`Done — ${pass} pass, ${fail} fail`);
    console.log("=".repeat(72));

    osc.close();
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("Test crashed:", e); process.exit(1); });
