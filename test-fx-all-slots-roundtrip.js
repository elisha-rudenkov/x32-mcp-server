#!/usr/bin/env node
// Comprehensive FX slot test — verify all 8 slots can:
//   1. Be loaded with a different (slot-class-valid) algorithm
//   2. Be configured (param write + read-back)
//   3. Be restored to their pre-test state (type + all 64 par values)
//
// Safety: full pre-state for all 8 slots is captured BEFORE any mutation
// and saved to fx-backup-<timestamp>.json. If restoration fails, the user
// has a record of what to manually restore via osc_node_set or X32-Edit.
//
// Slot-class targets:
//   slots 1..4 (stereo): cycle to PLAT (or HALL if already PLAT)
//   slots 5..8 (insert): cycle to LIM (or PHAS if already LIM)

import { OSCClient } from "./dist/osc-client.js";
import { writeFileSync } from "fs";

const HOST = process.env.OSC_HOST || "192.168.1.248";
const PORT = parseInt(process.env.OSC_PORT || "10023");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, restoreFails = 0;
function assert(cond, label) {
    if (cond) { console.log(`  PASS ${label}`); pass++; }
    else { console.log(`  FAIL ${label}`); fail++; }
}
const close = (a, b, eps = 0.5) => Math.abs(a - b) <= eps;

async function captureSlot(osc, slot) {
    const typeNode = await osc.nodeRead(`fx/${slot}/type`);
    const parNode = await osc.nodeRead(`fx/${slot}/par`);
    return {
        slot,
        type: typeNode.values[0],
        par: parNode.values.slice(),  // 64 raw strings as /node returned them
    };
}

async function restoreSlot(osc, snapshot) {
    // Restore type first (X32 resets params to algo defaults on type change),
    // then write all 64 par values back via /node-style write.
    try {
        await osc.fxSetType(snapshot.slot, snapshot.type);
        await sleep(180);
        await osc.nodeWrite(`fx/${snapshot.slot}/par`, snapshot.par);
        await sleep(180);
        const after = await osc.nodeRead(`fx/${snapshot.slot}/type`);
        if (after.values[0] !== snapshot.type) {
            console.log(`  WARN slot ${snapshot.slot} type after restore: ${after.values[0]}, expected ${snapshot.type}`);
            return false;
        }
        return true;
    } catch (e) {
        console.log(`  ERR restore slot ${snapshot.slot}: ${e.message}`);
        return false;
    }
}

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await sleep(200);

    console.log("=".repeat(72));
    console.log("Step 1: capture pre-test state of all 8 FX slots");
    console.log("=".repeat(72));

    const snapshots = [];
    for (let n = 1; n <= 8; n++) {
        const snap = await captureSlot(osc, n);
        snapshots.push(snap);
        console.log(`  fx${n}: type=${snap.type}  par[0..7]=${JSON.stringify(snap.par.slice(0, 8))}`);
    }

    // Persist backup so the user can recover if restoration fails partway
    const backupPath = `fx-backup-${Date.now()}.json`;
    writeFileSync(backupPath, JSON.stringify(snapshots, null, 2));
    console.log(`  backup saved: ${backupPath}`);

    // Test plan per slot — pick a target distinct from current
    const STEREO_TARGETS = ["PLAT", "HALL"];   // both have predly + decay
    const INSERT_TARGETS = ["LIM", "PHAS"];     // LIM has inputGain; PHAS has speed
    function pickTarget(slot, currentType) {
        const list = slot <= 4 ? STEREO_TARGETS : INSERT_TARGETS;
        return list.find((t) => t !== currentType) ?? list[0];
    }

    // Per-target probe param (something we can write + read back reliably)
    const PROBE = {
        PLAT: { name: "predly", value: 50, eps: 2 },     // ms 0..200, linear
        HALL: { name: "predly", value: 30, eps: 2 },
        LIM:  { name: "inputGain", value: 6, eps: 0.5 }, // dB 0..18, linear
        PHAS: { name: "speed", value: 1.5, eps: 0.5 },   // Hz 0.05..5, log
    };

    try {
        console.log();
        console.log("=".repeat(72));
        console.log("Step 2: cycle each slot — change algorithm, configure, verify");
        console.log("=".repeat(72));

        for (const snap of snapshots) {
            const target = pickTarget(snap.slot, snap.type);
            const probe = PROBE[target];
            console.log(`\n  --- slot ${snap.slot}: ${snap.type} → ${target} (probe: ${probe.name}=${probe.value}) ---`);

            // (a) change algorithm
            await osc.fxSetType(snap.slot, target);
            await sleep(180);
            const fxAfterType = await osc.fxGet(snap.slot);
            assert(fxAfterType.type === target, `slot ${snap.slot}: type changed to ${target}`);

            // (b) configure — write a non-default value to one param, read back
            await osc.fxSet(snap.slot, { [probe.name]: probe.value });
            await sleep(180);
            const fxAfterSet = await osc.fxGet(snap.slot);
            const got = fxAfterSet.params[probe.name];
            console.log(`    after set ${probe.name}=${probe.value}: ${probe.name}=${got}`);
            assert(typeof got === "number" && close(got, probe.value, probe.eps),
                `slot ${snap.slot}: ${target}.${probe.name} round-trip ≈ ${probe.value} (got ${got})`);

            // (c) sanity — verify /node fx/N/type symbolic agrees
            const directType = await osc.nodeRead(`fx/${snap.slot}/type`);
            assert(directType.values[0] === target, `slot ${snap.slot}: /node fx/${snap.slot}/type = "${target}"`);
        }
    } finally {
        console.log();
        console.log("=".repeat(72));
        console.log("Step 3: restore all 8 slots to pre-test state");
        console.log("=".repeat(72));
        for (const snap of snapshots) {
            console.log(`  restoring slot ${snap.slot} → ${snap.type} ...`);
            const ok = await restoreSlot(osc, snap);
            if (ok) {
                console.log(`    OK`);
            } else {
                restoreFails++;
                console.log(`    !! RESTORE FAILED — see ${backupPath} for original state`);
            }
        }

        console.log();
        console.log("=".repeat(72));
        console.log("Step 4: verify restoration");
        console.log("=".repeat(72));
        for (const snap of snapshots) {
            const after = await captureSlot(osc, snap.slot);
            const typeMatch = after.type === snap.type;
            // Compare ALL 64 par values byte-identically
            const mismatches = [];
            for (let i = 0; i < 64; i++) {
                if (snap.par[i] !== after.par[i]) {
                    mismatches.push({ idx: i, expected: snap.par[i], got: after.par[i] });
                }
            }
            const parMatch = mismatches.length === 0;
            console.log(`  fx${snap.slot}: type ${after.type} (${typeMatch ? "OK" : "MISMATCH"}), par[0..63] ${parMatch ? "OK (all 64)" : `MISMATCH (${mismatches.length}/64)`}`);
            if (!typeMatch || !parMatch) {
                console.log(`    expected type=${snap.type}, got type=${after.type}`);
                if (mismatches.length > 0) {
                    console.log(`    par mismatches: ${JSON.stringify(mismatches.slice(0, 5))}${mismatches.length > 5 ? ` (... +${mismatches.length - 5} more)` : ""}`);
                }
            }
            assert(typeMatch, `slot ${snap.slot}: type restored to ${snap.type}`);
            assert(parMatch, `slot ${snap.slot}: all 64 par values restored byte-identical`);
        }
    }

    console.log();
    console.log("=".repeat(72));
    console.log(`SUMMARY: ${pass} pass, ${fail} fail, ${restoreFails} restore failures`);
    console.log(`backup file: ${backupPath} (delete after verifying mixer state)`);
    console.log("=".repeat(72));

    osc.close();
    process.exit(fail === 0 && restoreFails === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
