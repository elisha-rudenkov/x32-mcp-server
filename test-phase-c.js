#!/usr/bin/env node
// Phase C test — scene snapshot + audit.
// Verifies:
//   1. osc_scene_snapshot returns the expected shape and dimensions
//      (32 channels, 16 buses, 8 dcas, 6 matrices, etc.) and finishes in <5s.
//   2. osc_scene_audit runs over a snapshot and returns sortable findings.
//   3. Provoking a known-bad EQ setting (ch/01/eq/3 g=+12, f=120Hz) is caught
//      by the low-mid-feedback-risk rule. The original setting is restored.
//   4. Passing a snapshot inline to audit matches re-fetching one internally.

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
    console.log("1. osc_scene_snapshot — shape + timing");
    console.log("=".repeat(72));

    const t0 = Date.now();
    const snap = await osc.sceneSnapshot();
    const wall = Date.now() - t0;
    console.log(`  wall time: ${wall}ms (snap.meta.wall_ms=${snap.meta.wall_ms}ms)`);
    console.log(`  meta: ${JSON.stringify({ ...snap.meta, captured_at: undefined })}`);

    assert(wall < 5000, `snapshot completes in <5s (got ${wall}ms)`);
    assert(Array.isArray(snap.channels) && snap.channels.length === 32, `channels.length === 32 (got ${snap.channels?.length})`);
    assert(Array.isArray(snap.auxins) && snap.auxins.length === 8, `auxins.length === 8`);
    assert(Array.isArray(snap.fxrtns) && snap.fxrtns.length === 8, `fxrtns.length === 8`);
    assert(Array.isArray(snap.buses) && snap.buses.length === 16, `buses.length === 16`);
    assert(Array.isArray(snap.matrices) && snap.matrices.length === 6, `matrices.length === 6`);
    assert(Array.isArray(snap.dcas) && snap.dcas.length === 8, `dcas.length === 8`);
    assert(Array.isArray(snap.fx) && snap.fx.length === 8, `fx.length === 8`);
    assert(snap.outputs?.main?.length === 16, `outputs.main.length === 16`);
    assert(snap.outputs?.aux?.length === 6, `outputs.aux.length === 6`);
    assert(snap.outputs?.p16?.length === 16, `outputs.p16.length === 16`);
    assert(snap.outputs?.aes?.length === 2, `outputs.aes.length === 2`);
    assert(snap.outputs?.rec?.length === 2, `outputs.rec.length === 2`);

    // Spot-check schema decoding
    const ch1 = snap.channels[0];
    assert(typeof ch1?.config?.name === "string", `ch01.config.name is string`);
    assert(typeof ch1?.mix?.on === "boolean", `ch01.mix.on is boolean`);
    assert(typeof ch1?.mix?.fader === "number", `ch01.mix.fader is number (got ${typeof ch1?.mix?.fader})`);
    assert(Array.isArray(ch1?.eqBands) && ch1.eqBands.length === 4, `ch01 has 4 EQ bands`);
    assert(Array.isArray(ch1?.sends) && ch1.sends.length === 16, `ch01 has 16 sends`);
    assert(typeof ch1?.grp?.dca === "number", `ch01.grp.dca is number (decoded bitmask)`);

    // config containers
    assert(snap.config?.linkcfg && Object.keys(snap.config.linkcfg).length === 4, `config.linkcfg has 4 fields`);
    assert(snap.config?.mute && Object.keys(snap.config.mute).length === 6, `config.mute has 6 fields`);

    console.log();
    console.log("=".repeat(72));
    console.log("2. osc_scene_audit — initial run");
    console.log("=".repeat(72));

    const audit = await osc.sceneAudit(snap);
    const counts = audit.findings.reduce((m, f) => {
        m[f.severity] = (m[f.severity] || 0) + 1;
        return m;
    }, {});
    console.log(`  ${audit.findings.length} findings: ${JSON.stringify(counts)}`);
    for (const f of audit.findings) {
        console.log(`    [${f.severity}] ${f.path} (${f.rule}): ${f.message}`);
    }

    assert(Array.isArray(audit.findings), `findings is an array`);
    // All findings must have required shape
    for (const f of audit.findings) {
        if (!["info", "warn", "error"].includes(f.severity)) {
            assert(false, `bad severity in finding: ${JSON.stringify(f)}`);
            break;
        }
        if (typeof f.path !== "string" || typeof f.rule !== "string" || typeof f.message !== "string") {
            assert(false, `malformed finding shape: ${JSON.stringify(f)}`);
            break;
        }
    }
    // sort: error must come before warn, warn before info
    let lastRank = -1;
    const rank = { error: 0, warn: 1, info: 2 };
    let sortedOk = true;
    for (const f of audit.findings) {
        if (rank[f.severity] < lastRank) { sortedOk = false; break; }
        lastRank = rank[f.severity];
    }
    assert(sortedOk, `findings sorted by severity (error > warn > info)`);

    console.log();
    console.log("=".repeat(72));
    console.log("3. Provoke EQ feedback finding on ch/01/eq/3 — verify caught + restore");
    console.log("=".repeat(72));

    // Save the original eq band 3 settings so we can restore
    const orig = await osc.nodeGetField("ch/01/eq/3");
    console.log(`  saved ch/01/eq/3 original: ${JSON.stringify(orig)}`);

    // Force a feedback-risk: type=PEQ, f=120Hz, g=+12dB
    await osc.nodeSetField("ch/01/eq/3", { type: "PEQ", f: 120, g: 12, q: 1.0 });
    // Also ensure ch eq is on, otherwise the rule skips
    const eqStateOrig = await osc.nodeGetField("ch/01/eq");
    if (eqStateOrig.on !== true) await osc.nodeSetField("ch/01/eq", { on: true });
    await sleep(300);

    const provokedSnap = await osc.sceneSnapshot();
    const provokedAudit = await osc.sceneAudit(provokedSnap);

    const ch01eq3 = provokedSnap.channels[0].eqBands[2];
    console.log(`  ch01.eqBands[2] now: ${JSON.stringify(ch01eq3)}`);
    const feedbackHit = provokedAudit.findings.find(
        (f) => f.path === "ch/01/eq/3" && (f.rule === "low-mid-feedback-risk" || f.rule === "subwoofer-feedback-risk"),
    );
    if (feedbackHit) {
        console.log(`  caught: [${feedbackHit.severity}] ${feedbackHit.message}`);
    }
    assert(!!feedbackHit, `provoked EQ feedback finding caught for ch/01/eq/3`);

    // Restore
    await osc.nodeSetField("ch/01/eq/3", { type: orig.type, f: orig.f, g: orig.g, q: orig.q });
    if (eqStateOrig.on !== true) await osc.nodeSetField("ch/01/eq", { on: false });
    await sleep(200);
    const restored = await osc.nodeGetField("ch/01/eq/3");
    console.log(`  restored ch/01/eq/3 to: ${JSON.stringify(restored)}`);
    assert(
        restored.type === orig.type && Math.abs((restored.g ?? 0) - (orig.g ?? 0)) < 0.05,
        `ch/01/eq/3 restored to original`,
    );

    console.log();
    console.log("=".repeat(72));
    console.log("4. Idempotency — passing snap inline matches re-fetching");
    console.log("=".repeat(72));

    const auditFromSnap = await osc.sceneAudit(snap);
    // Re-fetch a fresh snapshot inside audit (omit param)
    const auditFromFresh = await osc.sceneAudit();
    // Findings counts should match category-wise (the scene didn't change between
    // the two calls — the EQ was already restored before this section).
    const c1 = auditFromSnap.findings.reduce((m, f) => { m[f.severity] = (m[f.severity] || 0) + 1; return m; }, {});
    const c2 = auditFromFresh.findings.reduce((m, f) => { m[f.severity] = (m[f.severity] || 0) + 1; return m; }, {});
    console.log(`  audit(snap) counts: ${JSON.stringify(c1)}`);
    console.log(`  audit() counts:     ${JSON.stringify(c2)}`);
    // Allow ±1 in any category since live-read fluctuations can flip a hot-send near -90
    const close = (a, b) => Math.abs((a || 0) - (b || 0)) <= 1;
    assert(
        close(c1.error, c2.error) && close(c1.warn, c2.warn) && close(c1.info, c2.info),
        `audit findings counts agree within ±1 between inline and re-fetched snapshots`,
    );

    console.log();
    console.log("=".repeat(72));
    console.log(`Done — ${pass} pass, ${fail} fail`);
    console.log("=".repeat(72));
    console.log(`Snapshot wall time: ${wall}ms`);
    console.log(`Findings on current scene: ${JSON.stringify(counts)}`);

    osc.close();
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("Test crashed:", e); process.exit(1); });
