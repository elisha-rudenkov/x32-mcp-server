#!/usr/bin/env node
// Phase E test — meter snapshot.
// Verifies:
//   1. Each implemented bank (0/1/2/3) returns the documented float count.
//   2. Snapshot completes in <500ms (one /meters reply, ~50ms cadence).
//   3. Decoded dB values are in plausible ranges (≤ 0 dBfs for levels, ≤ 0 dB for GR).
//   4. Threshold filtering works (lower threshold = more entries).
//   5. Invalid bank throws.

import { OSCClient } from "./dist/osc-client.js";

const HOST = process.env.OSC_HOST || "192.168.1.248";
const PORT = parseInt(process.env.OSC_PORT || "10023");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function assert(cond, label) {
    if (cond) { console.log(`  PASS ${label}`); pass++; }
    else { console.log(`  FAIL ${label}`); fail++; }
}

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await sleep(200);

    const expectedFloats = { 0: 70, 1: 96, 2: 49, 3: 22 };

    for (const bank of [0, 1, 2, 3]) {
        console.log("=".repeat(72));
        console.log(`Bank ${bank}`);
        console.log("=".repeat(72));

        const t0 = Date.now();
        const snap = await osc.meterSnapshot(bank);
        const wall = Date.now() - t0;

        console.log(`  ${snap.description}`);
        console.log(`  elapsed: ${snap.elapsedMs}ms (wall: ${wall}ms)  floats: ${snap.floatCount}`);
        assert(snap.bank === bank, `snap.bank === ${bank}`);
        assert(snap.floatCount === expectedFloats[bank], `floatCount === ${expectedFloats[bank]}`);
        assert(wall < 500, `snapshot completes in <500ms (got ${wall}ms)`);

        if (snap.levels) {
            const levelKeys = Object.keys(snap.levels);
            const levelValues = Object.values(snap.levels);
            console.log(`  levels: ${levelKeys.length} entries above threshold`);
            console.log(`    sample: ${JSON.stringify(Object.fromEntries(Object.entries(snap.levels).slice(0, 8)))}`);
            // Every level should be in [-90, +18] dBfs (X32 has +18 headroom above 0 dBfs)
            for (const [k, v] of Object.entries(snap.levels)) {
                if (v > 18 || v < -90) {
                    assert(false, `level ${k}=${v} dBfs out of range`);
                    break;
                }
            }
            assert(levelValues.every((v) => v <= 18 && v >= -90), `all levels in [-90, +18] dBfs`);
        }

        if (snap.gateGainReduction) {
            const grKeys = Object.keys(snap.gateGainReduction);
            console.log(`  gate GR: ${grKeys.length} channels actively gating`);
            if (grKeys.length > 0) {
                console.log(`    sample: ${JSON.stringify(Object.fromEntries(Object.entries(snap.gateGainReduction).slice(0, 4)))}`);
            }
            // GR should be ≤ 0 dB (negative = reducing)
            assert(Object.values(snap.gateGainReduction).every((v) => v <= 0), `all gate GR ≤ 0 dB`);
        }

        if (snap.dynGainReduction) {
            const grKeys = Object.keys(snap.dynGainReduction);
            console.log(`  dyn GR: ${grKeys.length} channels/buses actively compressing`);
            if (grKeys.length > 0) {
                console.log(`    sample: ${JSON.stringify(Object.fromEntries(Object.entries(snap.dynGainReduction).slice(0, 4)))}`);
            }
            assert(Object.values(snap.dynGainReduction).every((v) => v <= 0), `all dyn GR ≤ 0 dB`);
        }

        console.log();
    }

    console.log("=".repeat(72));
    console.log("Threshold filtering — lower threshold reveals more entries");
    console.log("=".repeat(72));
    const tight = await osc.meterSnapshot(0, -60);
    const loose = await osc.meterSnapshot(0, -120);
    const tightCount = Object.keys(tight.levels ?? {}).length;
    const looseCount = Object.keys(loose.levels ?? {}).length;
    console.log(`  threshold -60 dBfs: ${tightCount} entries`);
    console.log(`  threshold -120 dBfs: ${looseCount} entries`);
    assert(looseCount >= tightCount, `looser threshold returns ≥ entries`);

    console.log();
    console.log("=".repeat(72));
    console.log("Invalid bank rejection");
    console.log("=".repeat(72));
    let threw = false;
    try { await osc.meterSnapshot(15); } catch (e) {
        threw = true;
        console.log(`  caught: ${e.message}`);
    }
    assert(threw, `meterSnapshot(15) throws (banks 4..15 not implemented)`);

    console.log();
    console.log("=".repeat(72));
    console.log(`SUMMARY: ${pass} pass, ${fail} fail`);
    console.log("=".repeat(72));

    osc.close();
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
