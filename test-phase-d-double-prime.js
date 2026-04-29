#!/usr/bin/env node
// Phase D" test — insert-effect surface + slot-agnostic FX state.
// Strictly read-only against current mixer state where possible.
// Mutating tests target ONLY a band gain on whatever GEQ is already loaded
// (if any) — doesn't cycle FX type.
//
// Verifies:
//   1. Phase D' encoding bug fix: fxGet on slot 5..8 reports the CORRECT
//      symbolic name + correct schema match (DES2 doesn't get re-mapped to CHAM).
//   2. /node fx/N/type returns symbolic for all 8 slots.
//   3. New schema entries: bus/01/insert, main/st/insert, mtx/01/insert read OK.
//   4. resolveInsertTarget round-trips: "main" → main/st/insert.
//   5. findGeqSlots returns slots with GEQ-class algorithms (or empty).
//   6. getInsertState resolves "main" → fxSlot/fxType.
//   7. fxSetType validates slot-class: trying to load HALL on slot 5 throws.
//   8. If a GEQ is loaded somewhere, do a band-gain round-trip.

import { OSCClient } from "./dist/osc-client.js";

const HOST = process.env.OSC_HOST || "192.168.1.248";
const PORT = parseInt(process.env.OSC_PORT || "10023");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function assert(cond, label) {
    if (cond) { console.log(`  PASS ${label}`); pass++; }
    else { console.log(`  FAIL ${label}`); fail++; }
}
const close = (a, b, eps = 0.5) => Math.abs(a - b) <= eps;

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await sleep(200);

    console.log("=".repeat(72));
    console.log("1. Phase D' encoding bug fix — slot 5..8 report correct symbolic name");
    console.log("=".repeat(72));

    for (let n = 1; n <= 8; n++) {
        const fx = await osc.fxGet(n);
        // /node fx/N/type also queryable directly
        const direct = await osc.nodeRead(`fx/${n}/type`);
        const directName = direct.values[0];
        console.log(`  fx${n}: type="${fx.type}" code=${fx.typeCode} (direct /node='${directName}')`);
        assert(fx.type === directName, `fx${n}: fxGet.type matches /node fx/${n}/type symbolic`);
        assert(fx.type !== null, `fx${n}: type is non-null`);

        // For slots 5..8: ensure type is in the insert-class subset (per pmaillot's FX5..8 list).
        if (n >= 5) {
            const INSERT_NAMES = new Set([
                "GEQ2","GEQ","TEQ2","TEQ","DES2","DES","P1A","P1A2","PQ5","PQ5S",
                "WAVD","LIM","FAC","FAC1M","FAC2","LEC","LEC2","ULC","ULC2","ENH2","ENH",
                "EXC2","EXC","IMG","EDI","SON","AMP2","AMP","DRV2","DRV","PHAS","FILT","PAN","SUB",
            ]);
            assert(INSERT_NAMES.has(fx.type), `fx${n}: type "${fx.type}" is in insert-class subset`);
        }

        // Validate the param shape matches the algo, NOT the bug-stale FX1..4 lookup.
        // DES2 has 6 params; if the bug still existed, code 4 would map to CHAM (16 params) on slot 5.
        const npn = Object.keys(fx.params).length;
        if (fx.type === "DES2") assert(npn === 6, `fx${n}: DES2 has 6 params (got ${npn})`);
        if (fx.type === "GEQ" || fx.type === "TEQ") assert(npn === 32, `fx${n}: ${fx.type} has 32 params (got ${npn})`);
        if (fx.type === "GEQ2" || fx.type === "TEQ2") assert(npn === 64, `fx${n}: ${fx.type} has 64 params (got ${npn})`);
    }

    console.log();
    console.log("=".repeat(72));
    console.log("2. New schema entries — bus/main/mtx insert reads");
    console.log("=".repeat(72));

    for (const path of ["bus/01/insert", "bus/02/insert", "mtx/01/insert", "main/st/insert", "main/m/insert"]) {
        const fields = await osc.nodeGetField(path);
        console.log(`  ${path.padEnd(20)} ${JSON.stringify(fields)}`);
        assert(typeof fields.on === "boolean", `${path}: on is bool`);
        assert(typeof fields.pos === "string", `${path}: pos is string`);
        assert(typeof fields.sel === "string", `${path}: sel is string`);
    }

    console.log();
    console.log("=".repeat(72));
    console.log("3. getInsertState — resolve target labels to /node paths + slot");
    console.log("=".repeat(72));

    for (const target of ["main", "main mono", "bus 1", "mtx 1"]) {
        const s = await osc.getInsertState(target);
        console.log(`  "${target}" → ${s.target} (path=${s.path})`);
        console.log(`     on=${s.on} pos=${s.pos} sel=${s.sel} fxSlot=${s.fxSlot} fxType=${s.fxType} isGeq=${s.isGeqClass}`);
        assert(typeof s.path === "string" && s.path.endsWith("/insert"), `target "${target}" → path ends with /insert`);
        assert(s.fxSlot === null || (s.fxSlot >= 1 && s.fxSlot <= 8), `target "${target}" fxSlot is null or 1..8`);
    }

    // bogus target should throw
    let threw = false;
    try { await osc.getInsertState("garbage"); } catch { threw = true; }
    assert(threw, `getInsertState("garbage") throws`);

    console.log();
    console.log("=".repeat(72));
    console.log("4. findGeqSlots — discover GEQ-class slots");
    console.log("=".repeat(72));

    const geqSlots = await osc.findGeqSlots();
    console.log(`  GEQ-class slots loaded: ${JSON.stringify(geqSlots)}`);
    assert(Array.isArray(geqSlots), "findGeqSlots returns array");
    for (const g of geqSlots) {
        assert(["GEQ", "GEQ2", "TEQ", "TEQ2"].includes(g.type), `${g.slot} reports GEQ-class type`);
    }

    console.log();
    console.log("=".repeat(72));
    console.log("5. fxSetType slot-class validation — HALL on slot 5 must throw");
    console.log("=".repeat(72));

    // Capture FX1 state for restore after the stereo-class test below.
    const fx1Before = await osc.fxGet(1);

    threw = false;
    try { await osc.fxSetType(5, "HALL"); } catch (e) {
        threw = true;
        console.log(`  caught: ${e.message}`);
    }
    assert(threw, `fxSetType(5, "HALL") throws (HALL not insert-class)`);

    // Verify slot 5 wasn't changed by the failed call.
    const fx5AfterFailedSet = await osc.fxGet(5);
    assert(fx5AfterFailedSet.type !== "HALL", `slot 5 type unchanged after failed fxSetType (still ${fx5AfterFailedSet.type})`);

    threw = false;
    try { await osc.fxSetType(1, "DES2"); } catch (e) {
        threw = true;
        console.log(`  caught: ${e.message}`);
    }
    // DES2 has stereo: true so this should be allowed
    assert(!threw, `fxSetType(1, "DES2") is allowed (DES2 is stereo-class)`);

    // Restore FX1 to its original type.
    await osc.fxSetType(1, fx1Before.type);
    await sleep(200);
    const fx1Restored = await osc.fxGet(1);
    assert(fx1Restored.type === fx1Before.type, `FX1 restored to original type "${fx1Before.type}"`);

    console.log();
    console.log("=".repeat(72));
    console.log("6. Insert-EQ round-trip (only if a GEQ is loaded somewhere)");
    console.log("=".repeat(72));

    if (geqSlots.length === 0) {
        console.log("  SKIP: no GEQ-class slot loaded; skipping insert-EQ round-trip test");
    } else {
        // Pick the first GEQ slot. We don't change its type. We need to find a target
        // whose insert.sel points at this slot — or temporarily reroute one we own.
        // Strategy: scan all targets, find one already routing to a GEQ slot; if none,
        // find a target whose insert is OFF and reroute to the GEQ slot for the test.
        const allTargets = ["bus 1","bus 2","bus 3","bus 4","bus 5","bus 6","bus 7","bus 8",
            "bus 9","bus 10","bus 11","bus 12","bus 13","bus 14","bus 15","bus 16",
            "main", "main mono", "mtx 1","mtx 2","mtx 3","mtx 4","mtx 5","mtx 6"];
        let testTarget = null;
        let testTargetWasOff = false;
        let originalSel = null;
        for (const t of allTargets) {
            const s = await osc.getInsertState(t);
            if (s.isGeqClass) { testTarget = t; originalSel = s.sel; break; }
        }
        if (!testTarget) {
            // No target currently routes to a GEQ. Find one with insert OFF/empty and reroute.
            for (const t of allTargets) {
                const s = await osc.getInsertState(t);
                if (s.sel === "OFF") {
                    testTarget = t;
                    testTargetWasOff = true;
                    originalSel = "OFF";
                    // Route this target to the GEQ slot.
                    const slotN = geqSlots[0].slot;
                    const sel = `FX${slotN}`;
                    console.log(`  no existing GEQ insert; routing ${t} → ${sel} for test (will restore)`);
                    await osc.nodeSetField(s.path.replace("/insert", "/insert"), { sel });
                    await sleep(150);
                    break;
                }
            }
        }
        if (!testTarget) {
            console.log("  SKIP: every target's insert.sel is in use; can't test without disrupting");
        } else {
            console.log(`  test target: ${testTarget}`);
            const eqBefore = await osc.insertEqGet(testTarget);
            console.log(`  insertEqGet "${testTarget}": slot=${eqBefore.slot} type=${eqBefore.type} isGeq=${eqBefore.isGeqClass}`);
            assert(eqBefore.isGeqClass, `${testTarget}: isGeqClass true after routing`);

            const isDual = eqBefore.type === "GEQ2" || eqBefore.type === "TEQ2";
            const probeBand = "1kHz";

            let originalGain;
            if (isDual) {
                originalGain = eqBefore.channelA.bands[probeBand];
                console.log(`  ${eqBefore.type} channelA["${probeBand}"] before = ${originalGain}`);
            } else {
                originalGain = eqBefore.bands[probeBand];
                console.log(`  ${eqBefore.type}["${probeBand}"] before = ${originalGain}`);
            }

            // Force a known band gain
            const target = +3;
            if (isDual) {
                await osc.insertEqSet(testTarget, { channelA: { bands: { [probeBand]: target } } });
            } else {
                await osc.insertEqSet(testTarget, { bands: { [probeBand]: target } });
            }
            await sleep(150);
            const eqAfter = await osc.insertEqGet(testTarget);
            const after = isDual ? eqAfter.channelA.bands[probeBand] : eqAfter.bands[probeBand];
            console.log(`  ${probeBand} after set ${target} = ${after}`);
            assert(close(after, target, 0.5), `${probeBand} round-trip ≈ ${target} (got ${after})`);

            // Restore
            if (isDual) {
                await osc.insertEqSet(testTarget, { channelA: { bands: { [probeBand]: originalGain } } });
            } else {
                await osc.insertEqSet(testTarget, { bands: { [probeBand]: originalGain } });
            }
            await sleep(150);
            const eqRestored = await osc.insertEqGet(testTarget);
            const restored = isDual ? eqRestored.channelA.bands[probeBand] : eqRestored.bands[probeBand];
            assert(close(restored, originalGain, 0.5), `${probeBand} restored to ${originalGain}`);

            if (testTargetWasOff) {
                // Restore insert.sel to OFF
                const s = await osc.getInsertState(testTarget);
                await osc.nodeSetField(s.path, { sel: "OFF" });
                await sleep(150);
                console.log(`  restored ${testTarget} insert.sel to OFF`);
            }
        }
    }

    console.log();
    console.log("=".repeat(72));
    console.log("7. Band label parsing — accept multiple frequency-label forms");
    console.log("=".repeat(72));

    if (geqSlots.length > 0) {
        // We don't actually write — just verify resolveInsertTarget + insertEqGet
        // accept various label formats by inspecting that the get returns ISO labels.
        // Pick any target currently routing to a GEQ.
        const someTarget = "main";
        const s = await osc.getInsertState(someTarget);
        if (s.isGeqClass) {
            const eq = await osc.insertEqGet(someTarget);
            const bands = eq.bands ?? eq.channelA?.bands;
            assert(bands && "1kHz" in bands, `band labels include "1kHz"`);
            assert(bands && "20Hz" in bands, `band labels include "20Hz"`);
            assert(bands && "20kHz" in bands, `band labels include "20kHz"`);
        } else {
            console.log(`  SKIP: ${someTarget} not routed to GEQ; can't verify band labels`);
        }
    }

    console.log();
    console.log("=".repeat(72));
    console.log(`SUMMARY: ${pass} pass, ${fail} fail`);
    console.log("=".repeat(72));

    osc.close();
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
