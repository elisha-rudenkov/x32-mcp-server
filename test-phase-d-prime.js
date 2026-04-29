#!/usr/bin/env node
// Phase D' test — FX algorithm parameter surface.
// Verifies:
//   1. listFxAlgorithms shape + count (61 entries).
//   2. Per-algorithm fxGet shape on 5 representatives (HALL, DLY, GATE, COMP-ish=ULC, GEQ).
//   3. fxSet round-trip on FX1: set HALL.decay=3.5s, read back, restore.
//   4. fxSetType round-trip: change FX1 type, confirm /fx/1/type echoes new code, restore.
//   5. Slot 5..8 schema lookup still works (channel-insert FX) — fxGet returns named params
//      even though /fx/5..8/source doesn't exist.
//
// Always restores original FX1 type + params at the end.

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
    console.log("1. listFxAlgorithms — shape + count");
    console.log("=".repeat(72));

    const all = osc.listFxAlgorithms();
    console.log(`  total: ${all.length} algorithms`);
    assert(all.length === 61, `61 algorithms total (got ${all.length})`);
    // spot-check a few
    const codes = new Map(all.map((e) => [e.code, e]));
    assert(codes.get(0)?.name === "HALL", "code 0 = HALL");
    assert(codes.get(5)?.name === "PLAT", "code 5 = PLAT");
    assert(codes.get(10)?.name === "DLY", "code 10 = DLY");
    assert(codes.get(28)?.name === "GEQ", "code 28 = GEQ");
    assert(codes.get(46)?.name === "ULC", "code 46 = ULC");
    assert(codes.get(60)?.name === "PIT", "code 60 = PIT");
    // every entry has params
    const noParams = all.filter((e) => !Array.isArray(e.params) || e.params.length === 0);
    assert(noParams.length === 0, `every algorithm has params (offenders: ${noParams.map(e => e.name).join(", ")})`);

    // filter test
    const reverbs = osc.listFxAlgorithms("reverb");
    console.log(`  filter "reverb": ${reverbs.map(e => e.name).join(", ")}`);
    assert(reverbs.some((e) => e.name === "HALL") && reverbs.some((e) => e.name === "PLAT"), "filter \"reverb\" includes HALL and PLAT");

    console.log();
    console.log("=".repeat(72));
    console.log("2. Capture original FX1 state (for restore at end)");
    console.log("=".repeat(72));

    const orig = await osc.fxGet(1);
    console.log(`  FX1 original: type=${orig.type} code=${orig.typeCode}`);
    console.log(`  FX1 params: ${JSON.stringify(orig.params)}`);
    assert(orig.type !== null, "FX1 algorithm matched in schema");
    assert(typeof orig.typeCode === "number", "FX1.typeCode is number");

    console.log();
    console.log("=".repeat(72));
    console.log("3. fxGet shape across 5 representative algorithms");
    console.log("=".repeat(72));

    // Cycle through 5 representative algos and confirm shape matches schema
    const reps = [
        { code: 0, name: "HALL", paramsAtLeast: 12 },
        { code: 10, name: "DLY", paramsAtLeast: 12 },
        { code: 8, name: "GATE", paramsAtLeast: 10 },
        { code: 46, name: "ULC", paramsAtLeast: 6 },   // Ultimo Comp (compressor)
        { code: 28, name: "GEQ", paramsAtLeast: 32 },  // 31-band stereo + master
    ];

    for (const rep of reps) {
        await osc.fxSetType(1, rep.code);
        await sleep(150);
        const got = await osc.fxGet(1);
        console.log(`  FX1 type=${got.type} code=${got.typeCode} params=${Object.keys(got.params).length}`);
        assert(got.type === rep.name, `${rep.name}: type matches schema`);
        assert(got.typeCode === rep.code, `${rep.name}: typeCode === ${rep.code}`);
        assert(Object.keys(got.params).length >= rep.paramsAtLeast,
            `${rep.name}: params >= ${rep.paramsAtLeast} (got ${Object.keys(got.params).length})`);
        // every named param decoded to a non-undefined value (some may be null for unmapped)
        const nullParams = Object.entries(got.params).filter(([_, v]) => v === undefined).length;
        assert(nullParams === 0, `${rep.name}: no undefined params`);
    }

    console.log();
    console.log("=".repeat(72));
    console.log("4. fxSet round-trip — set HALL.decay = 3.5s, read back, restore");
    console.log("=".repeat(72));

    await osc.fxSetType(1, "HALL");
    await sleep(150);
    const hallBefore = await osc.fxGet(1);
    console.log(`  HALL before: decay=${hallBefore.params.decay}, predly=${hallBefore.params.predly}, size=${hallBefore.params.size}`);
    assert(typeof hallBefore.params.decay === "number", "HALL.decay is number");

    // Force a known value
    await osc.fxSet(1, { decay: 3.5 });
    await sleep(120);
    const hallAfter = await osc.fxGet(1);
    console.log(`  HALL after decay=3.5: decay=${hallAfter.params.decay}`);
    // X32's decay encoding is logarithmic so we tolerate the round-trip wobble
    assert(close(hallAfter.params.decay, 3.5, 1.5), `HALL.decay round-trip ≈ 3.5 (got ${hallAfter.params.decay})`);

    // multi-param write — set predly + size atomically (sent as separate OSC msgs)
    await osc.fxSet(1, { predly: 50, size: 80 });
    await sleep(150);
    const hallMulti = await osc.fxGet(1);
    console.log(`  HALL after {predly:50, size:80}: predly=${hallMulti.params.predly}, size=${hallMulti.params.size}`);
    assert(Math.abs(hallMulti.params.predly - 50) <= 5, `HALL.predly ≈ 50 (got ${hallMulti.params.predly})`);
    assert(Math.abs(hallMulti.params.size - 80) <= 5, `HALL.size ≈ 80 (got ${hallMulti.params.size})`);

    // unknown param name should throw
    let threw = false;
    try { await osc.fxSet(1, { notARealParam: 0 }); } catch { threw = true; }
    assert(threw, "fxSet with unknown param name throws");

    console.log();
    console.log("=".repeat(72));
    console.log("5. fxSetType round-trip — symbolic name + numeric code");
    console.log("=".repeat(72));

    // symbolic
    const r1 = await osc.fxSetType(1, "DLY");
    await sleep(150);
    const after1 = await osc.fxGet(1);
    console.log(`  fxSetType "DLY" → type=${after1.type} code=${after1.typeCode}`);
    assert(after1.type === "DLY" && after1.typeCode === 10, "fxSetType(\"DLY\") sets code=10");
    assert(r1.previousTypeCode === 0, "previousTypeCode reflects HALL (0) before change");

    // numeric
    const r2 = await osc.fxSetType(1, 5);
    await sleep(150);
    const after2 = await osc.fxGet(1);
    console.log(`  fxSetType 5 → type=${after2.type} code=${after2.typeCode}`);
    assert(after2.type === "PLAT" && after2.typeCode === 5, "fxSetType(5) sets PLAT");

    // unknown name should throw
    let typeThrew = false;
    try { await osc.fxSetType(1, "NOT_A_REAL_ALGO"); } catch { typeThrew = true; }
    assert(typeThrew, "fxSetType with bogus name throws");

    console.log();
    console.log("=".repeat(72));
    console.log("6. Slot 5..8 (channel-insert FX) — fxGet still works");
    console.log("=".repeat(72));

    // Slots 5..8 host insert-only FX (mostly EQ/dyn/utility). We don't change
    // these — just verify reads return named params per the slot's current algorithm.
    for (const slot of [5, 6, 7, 8]) {
        const r = await osc.fxGet(slot);
        const npn = Object.keys(r.params).length;
        console.log(`  FX${slot}: type=${r.type} code=${r.typeCode} namedParams=${npn} extras=${r.extraParams.length}`);
        assert(typeof r.typeCode === "number", `FX${slot}: typeCode is number`);
        // Either schema matched (type !== null and named params present) or
        // we got raw fallback (type === null and params keyed as par1..parN).
        assert(r.type !== null || npn > 0, `FX${slot}: returns either schema match or raw fallback`);
    }

    console.log();
    console.log("=".repeat(72));
    console.log("7. Restore FX1 to original state");
    console.log("=".repeat(72));

    await osc.fxSetType(1, orig.typeCode);
    await sleep(200);
    // best-effort param restore: write each param the schema knew about
    if (orig.type) {
        const restoreSet = {};
        for (const [k, v] of Object.entries(orig.params)) {
            if (v !== null && v !== undefined) restoreSet[k] = v;
        }
        try {
            await osc.fxSet(1, restoreSet);
            await sleep(200);
        } catch (e) {
            console.log(`  WARN: param restore partial: ${e.message}`);
        }
    }
    const restored = await osc.fxGet(1);
    console.log(`  FX1 restored: type=${restored.type} code=${restored.typeCode}`);
    assert(restored.typeCode === orig.typeCode, `FX1 type restored to ${orig.type}`);

    console.log();
    console.log("=".repeat(72));
    console.log(`SUMMARY: ${pass} pass, ${fail} fail`);
    console.log("=".repeat(72));

    osc.close();
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
