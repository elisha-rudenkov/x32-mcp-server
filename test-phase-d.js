#!/usr/bin/env node
// Phase D test — schema-driven node engine.
// Verifies: osc_list_nodes (listNodeSchemas), osc_node_get (nodeGetField),
// osc_node_set (nodeSetField), atomic multi-field write, and round-trips
// across 5 representative field types: db, enum, int, bool, string-with-space.

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

const close = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await sleep(200);

    console.log("=".repeat(72));
    console.log("1. listNodeSchemas — print whole schema");
    console.log("=".repeat(72));
    const all = osc.listNodeSchemas();
    console.log(`  total: ${all.length} entries`);
    for (const e of all) {
        console.log(`  ${e.path.padEnd(32)} [${e.fields.length}] ${e.fields.map(f => `${f.name}:${f.type}`).join(", ")}`);
    }

    console.log();
    console.log(`  filtered "ch/*&zwj;/eq*":`);
    for (const e of osc.listNodeSchemas("ch/*/eq*")) {
        console.log(`    ${e.path}`);
    }

    console.log();
    console.log("=".repeat(72));
    console.log("2. Round-trip 5 typed fields (5 type families)");
    console.log("=".repeat(72));

    // ---- (a) db: ch/01/gate.thr ----
    console.log("\n  -- db: ch/01/gate.thr --");
    const gateBefore = await osc.nodeGetField("ch/01/gate");
    console.log(`    before: ${JSON.stringify(gateBefore)}`);
    await osc.nodeSetField("ch/01/gate", { thr: -33.5 });
    await sleep(80);
    const thrAfter = await osc.nodeGetField("ch/01/gate", "thr");
    console.log(`    after thr=${thrAfter}`);
    assert(close(thrAfter, -33.5, 0.5), "ch/01/gate.thr round-trip ≈ -33.5 dB");
    // restore
    await osc.nodeSetField("ch/01/gate", { thr: gateBefore.thr });
    await sleep(80);
    const thrRestored = await osc.nodeGetField("ch/01/gate", "thr");
    assert(close(thrRestored, gateBefore.thr, 0.5), "ch/01/gate.thr restored");

    // ---- (b) enum: ch/01/eq/1.type ----
    console.log("\n  -- enum: ch/01/eq/1.type --");
    const eqBefore = await osc.nodeGetField("ch/01/eq/1");
    console.log(`    before: ${JSON.stringify(eqBefore)}`);
    await osc.nodeSetField("ch/01/eq/1", { type: "LShv" });
    await sleep(80);
    const typeAfter = await osc.nodeGetField("ch/01/eq/1", "type");
    console.log(`    after type=${typeAfter}`);
    assert(typeAfter === "LShv", "ch/01/eq/1.type round-trip == LShv");
    // also test numeric-index input (PEQ is index 2)
    await osc.nodeSetField("ch/01/eq/1", { type: 2 });
    await sleep(80);
    const typeAfter2 = await osc.nodeGetField("ch/01/eq/1", "type");
    console.log(`    after type=2 (numeric input) → ${typeAfter2}`);
    assert(typeAfter2 === "PEQ", "enum numeric-index → symbolic 'PEQ'");
    // restore
    await osc.nodeSetField("ch/01/eq/1", { type: eqBefore.type });
    await sleep(80);

    // ---- (c) int: ch/01/mix.pan (-100..+100) ----
    console.log("\n  -- int: ch/01/mix.pan --");
    const mixBefore = await osc.nodeGetField("ch/01/mix");
    console.log(`    before: pan=${mixBefore.pan}`);
    await osc.nodeSetField("ch/01/mix", { pan: -25 });
    await sleep(80);
    const panAfter = await osc.nodeGetField("ch/01/mix", "pan");
    console.log(`    after: pan=${panAfter}`);
    // X32 stores pan as 0..1 float internally; round-trip can wobble by ±1 LSB.
    assert(Math.abs(panAfter - -25) <= 1, `ch/01/mix.pan round-trip ≈ -25 (got ${panAfter})`);
    // restore
    await osc.nodeSetField("ch/01/mix", { pan: mixBefore.pan });
    await sleep(80);

    // ---- (d) bool: headamp/000.phantom ----
    console.log("\n  -- bool: headamp/000.phantom --");
    const haBefore = await osc.nodeGetField("headamp/000");
    console.log(`    before: ${JSON.stringify(haBefore)}`);
    const target = !haBefore.phantom;
    await osc.nodeSetField("headamp/000", { phantom: target });
    await sleep(80);
    const phantomAfter = await osc.nodeGetField("headamp/000", "phantom");
    console.log(`    after: phantom=${phantomAfter}`);
    assert(phantomAfter === target, `headamp/000.phantom round-trip == ${target}`);
    // restore
    await osc.nodeSetField("headamp/000", { phantom: haBefore.phantom });
    await sleep(80);
    const phantomRestored = await osc.nodeGetField("headamp/000", "phantom");
    assert(phantomRestored === haBefore.phantom, "headamp/000.phantom restored");

    // ---- (e) string-with-space: ch/32/config.name ----
    console.log("\n  -- string-with-space: ch/32/config.name --");
    const cfgBefore = await osc.nodeGetField("ch/32/config");
    console.log(`    before: ${JSON.stringify(cfgBefore)}`);
    const spacedName = "Phase D Test";
    await osc.nodeSetField("ch/32/config", { name: spacedName });
    await sleep(80);
    const nameAfter = await osc.nodeGetField("ch/32/config", "name");
    console.log(`    after: name="${nameAfter}"`);
    assert(nameAfter === spacedName, `ch/32/config.name round-trip == "${spacedName}"`);
    // restore — write all four fields back to be safe
    await osc.nodeSetField("ch/32/config", {
        name: cfgBefore.name,
        icon: cfgBefore.icon,
        color: cfgBefore.color,
        source: cfgBefore.source,
    });
    await sleep(80);
    const cfgRestored = await osc.nodeGetField("ch/32/config");
    console.log(`    after-restore: ${JSON.stringify(cfgRestored)}`);
    assert(cfgRestored.name === cfgBefore.name, "ch/32/config.name restored");

    console.log();
    console.log("=".repeat(72));
    console.log("3. Atomic multi-field write — ch/01/gate (3 fields, single read verify)");
    console.log("=".repeat(72));
    const initialGate = await osc.nodeGetField("ch/01/gate");
    console.log(`  initial: ${JSON.stringify(initialGate)}`);
    const target3 = { thr: -41.5, attack: 12, release: 750 };
    console.log(`  setting 3 fields atomically: ${JSON.stringify(target3)}`);
    const setRes = await osc.nodeSetField("ch/01/gate", target3);
    console.log(`  wrote: [${setRes.wrote.join(", ")}], encoded payload: ${JSON.stringify(setRes.sent)}`);
    await sleep(120);
    const post3 = await osc.nodeGetField("ch/01/gate");
    console.log(`  after one /node read: ${JSON.stringify(post3)}`);
    assert(close(post3.thr, target3.thr, 0.5), "atomic.thr ≈ -41.5");
    assert(close(post3.attack, target3.attack, 0.5), "atomic.attack ≈ 12");
    assert(close(post3.release, target3.release, 5), "atomic.release ≈ 750");
    // verify untouched fields preserved
    assert(post3.on === initialGate.on, "atomic preserved gate.on");
    assert(post3.mode === initialGate.mode, "atomic preserved gate.mode");
    assert(close(post3.range, initialGate.range, 0.5), "atomic preserved gate.range");
    // restore
    await osc.nodeSetField("ch/01/gate", {
        thr: initialGate.thr, attack: initialGate.attack, release: initialGate.release,
    });
    await sleep(80);

    console.log();
    console.log("=".repeat(72));
    console.log("4. Bitmask + -Infinity edge cases");
    console.log("=".repeat(72));
    // bitmask via ch/01/grp.dca (uses 8-bit mask)
    const grpBefore = await osc.nodeGetField("ch/01/grp");
    console.log(`  ch/01/grp before: ${JSON.stringify(grpBefore)}`);
    await osc.nodeSetField("ch/01/grp", { dca: 5 }); // bits 0 and 2
    await sleep(80);
    const dcaAfter = await osc.nodeGetField("ch/01/grp", "dca");
    console.log(`  ch/01/grp.dca after int 5: ${dcaAfter}`);
    assert(dcaAfter === 5, "bitmask int 5 round-trip");
    await osc.nodeSetField("ch/01/grp", { dca: "%01010101" });
    await sleep(80);
    const dcaAfter2 = await osc.nodeGetField("ch/01/grp", "dca");
    console.log(`  ch/01/grp.dca after %01010101: ${dcaAfter2}`);
    assert(dcaAfter2 === parseInt("01010101", 2), "bitmask %01010101 round-trip");
    // restore
    await osc.nodeSetField("ch/01/grp", { dca: grpBefore.dca });
    await sleep(80);

    // -Infinity round-trip on ch/01/mix.fader (db)
    const mix2Before = await osc.nodeGetField("ch/01/mix");
    console.log(`  ch/01/mix before: fader=${mix2Before.fader}`);
    await osc.nodeSetField("ch/01/mix", { fader: -Infinity });
    await sleep(80);
    const faderAfter = await osc.nodeGetField("ch/01/mix", "fader");
    console.log(`  ch/01/mix.fader after -Infinity: ${faderAfter}`);
    assert(faderAfter === -Infinity, "db -Infinity → -oo round-trip");
    // restore
    await osc.nodeSetField("ch/01/mix", { fader: mix2Before.fader });
    await sleep(80);

    console.log();
    console.log("=".repeat(72));
    console.log(`SUMMARY: ${pass} pass, ${fail} fail`);
    console.log("=".repeat(72));

    osc.close();
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
