// osc_meter_watch integration test. Drives the COMPILED dist/ OSCClient in-process against the
// fake X32 responder, which now streams scriptable meter blobs. Run: `npm test` (build first).
//
// Asserts:
//   1. frames collected ≈ seconds/0.05 within tolerance, sampleRateHz sane
//   2. peak/avg/clipPct/activePct math correct for a scripted ramp (expected computed here)
//   3. threshold filtering omits quiet keys (below-threshold + silent channels absent)
//   4. GR stats appear for scripted dyn GR and omit inactive keys; all-inactive gate GR omitted
//   5. the clipping flag fires for the clipping key ONLY; sustained flag fires for a parked signal
//   6. seconds clamping at both bounds (0.1 -> 0.5, 50 -> 10)

import { FakeX32 } from "./fake-x32.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round1 = (x) => (Number.isFinite(x) ? +x.toFixed(1) : x);
const dbToLin = (db) => Math.pow(10, db / 20);

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  PASS: ${name}`);
    } else {
        failures++;
        console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

// Constants mirrored from the implementation for computing expected values.
const CLIP_DB = -0.5;
const DB_FLOOR = -90;
const THRESH = -60;

// ch01 ramps from -40 dBFS up to 0 dBFS at +4 dB/frame, clamped at clip (reaches 0 dBFS by
// frame 10, so even a short ~15-frame window captures clipping frames).
const rampDb = (f) => Math.min(0, -40 + 4 * f);

/** Recompute the level stats the server should produce for a scripted per-frame dB function. */
function expectedLevelStat(dbOfFrame, frames) {
    let peak = -Infinity, sum = 0, clip = 0, active = 0;
    for (let f = 0; f < frames; f++) {
        const db = dbOfFrame(f);
        if (db > peak) peak = db;
        sum += Math.max(db, DB_FLOOR);
        if (db >= CLIP_DB) clip++;
        if (Number.isFinite(db) && db >= THRESH) active++;
    }
    return {
        peakDb: round1(peak),
        avgDb: round1(sum / frames),
        clipPct: round1((clip / frames) * 100),
        activePct: round1((active / frames) * 100),
    };
}

async function main() {
    const { OSCClient } = await import("../dist/osc-client.js");

    const fake = new FakeX32();
    const port = await fake.start(0);
    console.log(`fake X32 listening on 127.0.0.1:${port}`);

    // Bank 0 (level meters only): ch01 ramps to clip, ch02 steady -12, ch03 at -80 (below
    // threshold), bus01 steady -6; everything else at the noise floor.
    fake.setMeterScript(0, (f, nf) => {
        const arr = new Array(nf).fill(1e-6); // ~-120 dBFS silence
        arr[0] = dbToLin(rampDb(f)); // ch01 (idx 0) ramps to clip
        arr[1] = dbToLin(-12);       // ch02 (idx 1) steady -12
        arr[2] = dbToLin(-80);       // ch03 (idx 2) below -60 threshold -> omitted
        arr[48] = dbToLin(-6);       // bus01 (idx 48) steady -6
        return arr;
    });

    const client = new OSCClient("127.0.0.1", port);
    await client.connect();
    await sleep(120);

    // ---- Test 1 + 2 + 3: bank 0 window, frame count + level math + filtering ----
    console.log("\n[1/2/3] bank 0 window: frame count, level stats, threshold filtering");
    const w0 = await client.meterWatch({ bank: 0, seconds: 1, thresholdDb: THRESH });
    const F = w0.frames;
    check("collected a plausible number of frames (~20 for 1s @ 50ms)", F >= 12 && F <= 25, `frames=${F}`);
    check("sampleRateHz is ~20", w0.sampleRateHz >= 12 && w0.sampleRateHz <= 25, `sampleRateHz=${w0.sampleRateHz}`);
    check("seconds echoed unclamped (1)", w0.seconds === 1, JSON.stringify(w0.seconds));

    const expCh01 = expectedLevelStat(rampDb, F);
    check("ch01 peakDb matches ramp max (0)", w0.levels.ch01 && w0.levels.ch01.peakDb === expCh01.peakDb, `got ${JSON.stringify(w0.levels.ch01)} exp ${JSON.stringify(expCh01)}`);
    // avgDb is a mean of many dB values decoded from float32 wire samples; allow <=0.15 dB of
    // accumulated float32 round-trip error vs the full-precision expected mean.
    check("ch01 avgDb matches dB-domain mean (±0.15)", Math.abs(w0.levels.ch01.avgDb - expCh01.avgDb) <= 0.15, `got ${w0.levels.ch01.avgDb} exp ${expCh01.avgDb}`);
    check("ch01 clipPct matches", w0.levels.ch01.clipPct === expCh01.clipPct, `got ${w0.levels.ch01.clipPct} exp ${expCh01.clipPct}`);
    check("ch01 activePct matches", w0.levels.ch01.activePct === expCh01.activePct, `got ${w0.levels.ch01.activePct} exp ${expCh01.activePct}`);

    const expCh02 = expectedLevelStat(() => -12, F);
    check("ch02 steady peak=avg=-12", w0.levels.ch02 && w0.levels.ch02.peakDb === -12 && w0.levels.ch02.avgDb === -12, JSON.stringify(w0.levels.ch02));
    check("ch02 clipPct 0, activePct 100", w0.levels.ch02.clipPct === 0 && w0.levels.ch02.activePct === 100, JSON.stringify(w0.levels.ch02));
    check("ch02 matches full expected stat", JSON.stringify(w0.levels.ch02) === JSON.stringify(expCh02), `got ${JSON.stringify(w0.levels.ch02)} exp ${JSON.stringify(expCh02)}`);
    check("bus01 present at -6", w0.levels.bus01 && w0.levels.bus01.peakDb === -6, JSON.stringify(w0.levels.bus01));

    check("ch03 (-80, below threshold) omitted", !("ch03" in w0.levels), JSON.stringify(Object.keys(w0.levels)));
    check("silent channels omitted (ch10 absent)", !("ch10" in w0.levels), JSON.stringify(Object.keys(w0.levels)));
    check("levels contain exactly ch01, ch02, bus01", JSON.stringify(Object.keys(w0.levels).sort()) === JSON.stringify(["bus01", "ch01", "ch02"]), JSON.stringify(Object.keys(w0.levels)));

    // ---- Test 5: flags — clipping only on the clipping key; sustained on the parked signal ----
    console.log("\n[5] flags: clipping on ch01 only; sustained on parked ch02");
    const clipFlags = w0.flags.filter((fl) => fl.flag === "clipping");
    check("exactly one clipping flag", clipFlags.length === 1, JSON.stringify(w0.flags));
    check("clipping flag targets ch01", clipFlags[0] && clipFlags[0].key === "ch01", JSON.stringify(clipFlags));
    check("no clipping flag on ch02/bus01", !w0.flags.some((fl) => fl.flag === "clipping" && fl.key !== "ch01"), JSON.stringify(w0.flags));
    check("sustained flag fires for parked ch02", w0.flags.some((fl) => fl.flag === "sustained" && fl.key === "ch02"), JSON.stringify(w0.flags));

    // ---- Test 4: GR stats on bank 1 ----
    console.log("\n[4] bank 1 GR: dyn GR present for active keys, inactive gate GR omitted");
    fake.setMeterScript(1, (f, nf) => {
        const arr = new Array(nf);
        for (let i = 0; i < 32; i++) arr[i] = 1e-6;   // level meters: silence
        for (let i = 32; i < 96; i++) arr[i] = 1.0;   // GR meters: 1.0 = no reduction
        arr[0] = dbToLin(-10);                         // ch01 level -10 (present)
        arr[64] = dbToLin(-6);                         // ch01 dyn GR = 6 dB reduction
        arr[65] = dbToLin(-3);                         // ch02 dyn GR = 3 dB reduction
        arr[33] = dbToLin(-0.02);                      // ch02 gate GR = 0.02 dB (inactive -> omitted)
        return arr;
    });
    const w1 = await client.meterWatch({ bank: 1, seconds: 1, thresholdDb: THRESH });
    check("dynGainReduction present", !!w1.dynGainReduction, JSON.stringify(w1));
    check("dyn GR ch01 ~6 dB, activePct 100", w1.dynGainReduction.ch01 && w1.dynGainReduction.ch01.maxReductionDb === 6 && w1.dynGainReduction.ch01.avgReductionDb === 6 && w1.dynGainReduction.ch01.activePct === 100, JSON.stringify(w1.dynGainReduction && w1.dynGainReduction.ch01));
    check("dyn GR ch02 ~3 dB", w1.dynGainReduction.ch02 && w1.dynGainReduction.ch02.maxReductionDb === 3, JSON.stringify(w1.dynGainReduction && w1.dynGainReduction.ch02));
    check("dyn GR omits inactive keys (only ch01, ch02)", JSON.stringify(Object.keys(w1.dynGainReduction).sort()) === JSON.stringify(["ch01", "ch02"]), JSON.stringify(Object.keys(w1.dynGainReduction)));
    check("all-inactive gate GR omitted entirely", w1.gateGainReduction === undefined, JSON.stringify(w1.gateGainReduction));
    check("bank 1 level ch01 present at -10", w1.levels.ch01 && w1.levels.ch01.peakDb === -10, JSON.stringify(w1.levels.ch01));
    check("ch02 has GR but no level (below threshold)", !("ch02" in w1.levels) && "ch02" in w1.dynGainReduction, JSON.stringify(Object.keys(w1.levels)));

    // ---- Test 6: seconds clamping ----
    console.log("\n[6] seconds clamping at both bounds");
    const wLow = await client.meterWatch({ bank: 0, seconds: 0.1 });
    check("seconds=0.1 clamped up to 0.5", wLow.seconds === 0.5, JSON.stringify(wLow.seconds));
    const tHi = Date.now();
    const wHigh = await client.meterWatch({ bank: 0, seconds: 50 });
    const hiElapsed = Date.now() - tHi;
    check("seconds=50 clamped down to 10", wHigh.seconds === 10, JSON.stringify(wHigh.seconds));
    check("upper-clamp window actually blocked ~10s (>=9s)", hiElapsed >= 9000, `elapsed=${hiElapsed}ms`);

    // ---- summary ----
    fake.close();
    console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error("test-meter-watch crashed:", e);
    process.exit(1);
});
