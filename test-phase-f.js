#!/usr/bin/env node
// Phase F test — convenience verbs & comparisons.
// Verifies:
//   1. compare_channels: ch01 vs ch01 → 0 differences (self-compare)
//   2. compare_channels: ch01 vs ch02 → some differences (assuming distinct strips)
//   3. compare_scenes: snap vs same snap → 0 differences
//   4. compare_scenes: detects diff when one bit is changed in copy of snap
//   5. copy_channel: capture ch01 + ch02 full state → copy ch01 → ch02 →
//      verify ch01 and ch02 sounds the same (compare_channels post-copy
//      should report only identity-level diffs since we don't copy config) →
//      restore ch02.

import { OSCClient } from "./dist/osc-client.js";
import { writeFileSync } from "fs";

const HOST = process.env.OSC_HOST || "192.168.1.248";
const PORT = parseInt(process.env.OSC_PORT || "10023");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function assert(cond, label) {
    if (cond) { console.log(`  PASS ${label}`); pass++; }
    else { console.log(`  FAIL ${label}`); fail++; }
}

// Capture full ch state via the schema (containers we'll touch in copy_channel)
async function captureChannelFull(osc, n) {
    const nn = String(n).padStart(2, "0");
    const containers = [
        "config", "mix", "eq", "eq/1", "eq/2", "eq/3", "eq/4",
        "gate", "gate/filter", "dyn", "dyn/filter",
        "insert", "preamp", "delay", "automix", "grp",
    ];
    for (let b = 1; b <= 16; b++) containers.push(`mix/${String(b).padStart(2, "0")}`);
    const snap = { channel: n, containers: {} };
    for (const c of containers) {
        try { snap.containers[c] = await osc.nodeGetField(`ch/${nn}/${c}`); }
        catch { snap.containers[c] = null; }
    }
    return snap;
}

async function restoreChannelFull(osc, snap) {
    const nn = String(snap.channel).padStart(2, "0");
    let failures = 0;
    for (const [container, fields] of Object.entries(snap.containers)) {
        if (!fields) continue;
        try { await osc.nodeSetField(`ch/${nn}/${container}`, fields); }
        catch (e) { console.log(`  WARN restore ${container}: ${e.message}`); failures++; }
    }
    return failures;
}

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await sleep(200);

    console.log("=".repeat(72));
    console.log("1. compare_channels — self-compare");
    console.log("=".repeat(72));
    const r1 = await osc.compareChannelStrips(1, 1);
    console.log(`  ch01 vs ch01: ${r1.differences.length} differences (${r1.elapsedMs}ms)`);
    assert(r1.identical, `ch01 vs ch01 is identical`);
    assert(r1.differences.length === 0, `0 differences for self-compare`);

    console.log();
    console.log("=".repeat(72));
    console.log("2. compare_channels — ch01 vs ch02");
    console.log("=".repeat(72));
    const r2 = await osc.compareChannelStrips(1, 2);
    console.log(`  ch01 vs ch02: ${r2.differences.length} differences (${r2.elapsedMs}ms)`);
    if (r2.differences.length > 0) {
        console.log(`  sample diffs: ${JSON.stringify(r2.differences.slice(0, 5), null, 2)}`);
    }
    // Differences depend on user's setup — just verify the shape
    assert(typeof r2.identical === "boolean", `ch01 vs ch02 has identical: bool`);
    assert(Array.isArray(r2.differences), `differences is array`);
    for (const d of r2.differences) {
        if (typeof d.path !== "string") {
            assert(false, `diff entry has string path: ${JSON.stringify(d)}`);
            break;
        }
    }
    assert(r2.differences.every((d) => typeof d.path === "string"), `every diff has a path string`);

    console.log();
    console.log("=".repeat(72));
    console.log("3. compare_scenes — snap vs same snap");
    console.log("=".repeat(72));
    const t0 = Date.now();
    const snap = await osc.sceneSnapshot();
    console.log(`  snapshot captured in ${Date.now() - t0}ms`);
    const sceneSelf = osc.compareScenes(snap, snap);
    console.log(`  diff: ${sceneSelf.differences.length} differences`);
    assert(sceneSelf.identical, `scene self-compare is identical`);
    assert(sceneSelf.differences.length === 0, `0 differences for scene self-compare`);

    console.log();
    console.log("=".repeat(72));
    console.log("4. compare_scenes — detect a single mutation in a clone");
    console.log("=".repeat(72));
    const snapMutated = JSON.parse(JSON.stringify(snap));
    if (snapMutated.channels && snapMutated.channels[6] && snapMutated.channels[6].mix) {
        snapMutated.channels[6].mix.fader = -42;  // ch07 fader
    }
    const sceneMut = osc.compareScenes(snap, snapMutated);
    console.log(`  diff: ${sceneMut.differences.length} differences, sections: ${JSON.stringify(sceneMut.sectionCounts)}`);
    if (sceneMut.differences.length > 0) {
        console.log(`  first diff: ${JSON.stringify(sceneMut.differences[0])}`);
    }
    assert(!sceneMut.identical, `mutated scene is not identical`);
    assert(sceneMut.differences.length >= 1, `≥1 difference detected`);
    assert(sceneMut.differences.some((d) => d.path.includes("channels[6].mix.fader")),
        `diff includes channels[6].mix.fader path`);

    console.log();
    console.log("=".repeat(72));
    console.log("5. copy_channel — ch1 → ch2 with capture/restore safety");
    console.log("=".repeat(72));

    const ch1Backup = await captureChannelFull(osc, 1);
    const ch2Backup = await captureChannelFull(osc, 2);
    const backupPath = `ch-backup-${Date.now()}.json`;
    writeFileSync(backupPath, JSON.stringify({ ch1Backup, ch2Backup }, null, 2));
    console.log(`  backup saved: ${backupPath}`);

    let restoreFailures = 0;
    try {
        const r = await osc.copyChannel(1, 2);
        console.log(`  copy ch1 → ch2: ${r.copied.length} copied, ${r.skipped.length} skipped, ${r.failed.length} failed (${r.elapsedMs}ms)`);
        if (r.failed.length > 0) console.log(`  failures: ${JSON.stringify(r.failed)}`);
        assert(r.copied.length > 0, `copyChannel copied at least one container`);
        assert(r.failed.length === 0, `copyChannel had no failures`);

        await sleep(300);
        // After copy with default options, ch1 vs ch2 should differ ONLY in
        // identity (config.name/icon/color/source) and group (grp.dca/mute) —
        // since we preserve those on the destination by default. Some log-scale
        // time fields (dynRelease, dynAttack, gateRelease, gateHold) may wobble
        // by a few ms due to X32 internal float precision; these are allowed.
        const postCopy = await osc.compareChannelStrips(1, 2);
        console.log(`  post-copy ch1 vs ch2: ${postCopy.differences.length} remaining diffs`);
        for (const d of postCopy.differences) {
            console.log(`    ${d.path}: a=${JSON.stringify(d.a)}  b=${JSON.stringify(d.b)}`);
        }
        const ALLOWED_FIELDS = new Set([
            "channel", "headampGain", "headampPhantom", "headampSlot",
            "name", "color", "source",
            // log-scale time fields can wobble ±a few ms on X32 prefix-partial writes
            "dynAttack", "dynRelease", "dynHold", "gateAttack", "gateRelease", "gateHold",
        ]);
        const ALLOWED_PREFIXES = ["config.", "grp."];
        const unexpectedDiffs = postCopy.differences.filter((d) => {
            if (ALLOWED_FIELDS.has(d.path)) return false;
            return !ALLOWED_PREFIXES.some((p) => d.path.startsWith(p));
        });
        if (unexpectedDiffs.length > 0) {
            console.log(`  UNEXPECTED diffs (not in allowlist): ${JSON.stringify(unexpectedDiffs, null, 2)}`);
        }
        assert(unexpectedDiffs.length === 0, `post-copy diffs are limited to identity/group/headamp/log-time fields`);
    } finally {
        console.log(`\n  Restoring ch2 from backup ...`);
        restoreFailures = await restoreChannelFull(osc, ch2Backup);
        await sleep(400);
        // Verify ch2 matches its captured backup
        const ch2Now = await captureChannelFull(osc, 2);
        let mismatches = 0;
        for (const c of Object.keys(ch2Backup.containers)) {
            const before = JSON.stringify(ch2Backup.containers[c]);
            const after = JSON.stringify(ch2Now.containers[c]);
            if (before !== after) { mismatches++; }
        }
        console.log(`  restore complete (${restoreFailures} failures, ${mismatches} container mismatches)`);
        assert(restoreFailures === 0, `ch2 restore had no failures`);
        assert(mismatches === 0, `ch2 restored byte-identical for all captured containers`);
    }

    console.log();
    console.log("=".repeat(72));
    console.log(`SUMMARY: ${pass} pass, ${fail} fail`);
    console.log(`backup file: ${backupPath} (delete after verifying)`);
    console.log("=".repeat(72));

    osc.close();
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
