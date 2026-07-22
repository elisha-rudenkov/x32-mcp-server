#!/usr/bin/env node
// Phase A smoke test + benchmark.
// - nodeRead on ch/01, bus/01
// - osc_identity (getIdentity)
// - Rewritten getChannelStrip vs pre-rewrite shape
// - Benchmark: 10 runs of getChannelStrip(1), report per-run timing

import { OSCClient } from "./dist/osc-client.js";

const HOST = process.env.OSC_HOST || "192.168.0.162";
const PORT = parseInt(process.env.OSC_PORT || "10023");

const fmt = (ms) => `${ms.toFixed(1)}ms`;
const timeit = async (fn) => {
    const t0 = performance.now();
    const res = await fn();
    return { ms: performance.now() - t0, res };
};

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await new Promise((r) => setTimeout(r, 200)); // let /xremote settle

    console.log("=".repeat(60));
    console.log("1. nodeRead tests — raw /node wrapper");
    console.log("=".repeat(60));

    for (const path of ["ch/01/config", "ch/01/mix", "ch/01/eq/1", "bus/01/config", "headamp/000", "fx/1"]) {
        try {
            const t0 = performance.now();
            const n = await osc.nodeRead(path);
            const ms = performance.now() - t0;
            console.log(`  ${path.padEnd(18)} ${fmt(ms).padStart(8)}  raw=${JSON.stringify(n.raw)}`);
            console.log(`  ${" ".repeat(18)}          values=${JSON.stringify(n.values)}`);
        } catch (e) {
            console.log(`  ${path}: ERROR ${e.message}`);
        }
    }

    console.log();
    console.log("=".repeat(60));
    console.log("2. osc_identity — /xinfo + /status");
    console.log("=".repeat(60));
    const id = await osc.getIdentity();
    console.log("  " + JSON.stringify(id, null, 2).replace(/\n/g, "\n  "));

    console.log();
    console.log("=".repeat(60));
    console.log("3. getChannelStrip(1) — new /node-based impl");
    console.log("=".repeat(60));
    const { res: strip, ms: stripMs } = await timeit(() => osc.getChannelStrip(1));
    console.log(`  elapsed: ${fmt(stripMs)}`);
    // pretty-print with truncation of the sends array
    const trunc = { ...strip, sends: `[${strip.sends.length} entries, first: ${JSON.stringify(strip.sends[0])}, last: ${JSON.stringify(strip.sends[strip.sends.length - 1])}]` };
    console.log("  " + JSON.stringify(trunc, null, 2).replace(/\n/g, "\n  "));

    console.log();
    console.log("=".repeat(60));
    console.log("4. Benchmark: 10× getChannelStrip(1) — new /node impl");
    console.log("=".repeat(60));
    const newTimes = [];
    for (let i = 0; i < 10; i++) {
        const { ms } = await timeit(() => osc.getChannelStrip(1));
        newTimes.push(ms);
        process.stdout.write(`  run ${i + 1}: ${fmt(ms)}\n`);
    }
    const newAvg = newTimes.reduce((a, b) => a + b, 0) / newTimes.length;
    const newMin = Math.min(...newTimes);
    const newMax = Math.max(...newTimes);

    console.log();
    console.log("=".repeat(60));
    console.log("5. Benchmark: 10× legacy impl (inline copy of pre-rewrite leaf-by-leaf reads)");
    console.log("=".repeat(60));
    // Inline copy of the pre-rewrite getChannelStrip, using the osc-js path for raw leaf reads.
    // sendCustomCommand with no value == read.
    async function legacyGetChannelStrip(ch) {
        const chPath = `/ch/${ch.toString().padStart(2, "0")}`;
        const safeRead = async (addr) => {
            try { return await osc.sendCustomCommand(addr); } catch { return null; }
        };
        const r = { channel: ch };
        r.name = await safeRead(`${chPath}/config/name`);
        r.fader = await safeRead(`${chPath}/mix/fader`);
        r.on = (await safeRead(`${chPath}/mix/on`)) === 1;
        r.pan = await safeRead(`${chPath}/mix/pan`);
        r.color = await safeRead(`${chPath}/config/color`);
        r.source = await safeRead(`${chPath}/config/source`);
        const src = r.source;
        if (src !== null && src >= 0 && src < 64) {
            r.headampGain = await safeRead(`/headamp/${src.toString().padStart(3, "0")}/gain`);
            r.headampPhantom = await safeRead(`/headamp/${src.toString().padStart(3, "0")}/phantom`);
        }
        r.eqOn = (await safeRead(`${chPath}/eq/on`)) === 1;
        r.eq = [];
        for (let b = 1; b <= 4; b++) {
            r.eq.push({
                band: b,
                gain: await safeRead(`${chPath}/eq/${b}/g`),
                freq: await safeRead(`${chPath}/eq/${b}/f`),
                q: await safeRead(`${chPath}/eq/${b}/q`),
                type: await safeRead(`${chPath}/eq/${b}/type`),
            });
        }
        r.gateOn = (await safeRead(`${chPath}/gate/on`)) === 1;
        r.gateThr = await safeRead(`${chPath}/gate/thr`);
        r.gateRange = await safeRead(`${chPath}/gate/range`);
        r.gateAttack = await safeRead(`${chPath}/gate/attack`);
        r.gateHold = await safeRead(`${chPath}/gate/hold`);
        r.gateRelease = await safeRead(`${chPath}/gate/release`);
        r.dynOn = (await safeRead(`${chPath}/dyn/on`)) === 1;
        r.dynThr = await safeRead(`${chPath}/dyn/thr`);
        r.dynRatio = await safeRead(`${chPath}/dyn/ratio`);
        r.dynAttack = await safeRead(`${chPath}/dyn/attack`);
        r.dynRelease = await safeRead(`${chPath}/dyn/release`);
        r.dynKnee = await safeRead(`${chPath}/dyn/knee`);
        r.dynGain = await safeRead(`${chPath}/dyn/gain`);
        r.sends = [];
        for (let b = 1; b <= 16; b++) {
            const sp = `${chPath}/mix/${b.toString().padStart(2, "0")}`;
            r.sends.push({
                bus: b,
                level: await safeRead(`${sp}/level`),
                pan: await safeRead(`${sp}/pan`),
                type: await safeRead(`${sp}/type`),
            });
        }
        return r;
    }

    const oldTimes = [];
    for (let i = 0; i < 10; i++) {
        const { ms } = await timeit(() => legacyGetChannelStrip(1));
        oldTimes.push(ms);
        process.stdout.write(`  run ${i + 1}: ${fmt(ms)}\n`);
    }
    const oldAvg = oldTimes.reduce((a, b) => a + b, 0) / oldTimes.length;
    const oldMin = Math.min(...oldTimes);
    const oldMax = Math.max(...oldTimes);

    console.log();
    console.log("=".repeat(60));
    console.log("SUMMARY");
    console.log("=".repeat(60));
    console.log(`  legacy leaf-by-leaf: avg=${fmt(oldAvg)}  min=${fmt(oldMin)}  max=${fmt(oldMax)}`);
    console.log(`  /node impl:          avg=${fmt(newAvg)}  min=${fmt(newMin)}  max=${fmt(newMax)}`);
    console.log(`  speedup:             ${(oldAvg / newAvg).toFixed(2)}×`);

    osc.close();
    process.exit(0);
}

main().catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
});
