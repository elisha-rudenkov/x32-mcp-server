// Batch-operations + relative-adjust + undo-journal integration test. Drives the COMPILED
// dist/ OSCClient in-process against the fake X32 responder. Run: `npm test` (build first).
//
// Asserts:
//   1. a batch of get+set+adjust ops returns per-op results in order
//   2. adjust computes from the current value and clamps at the schema range (incl. -∞ floor)
//   3. adjust on a non-numeric field errors cleanly (per-op)
//   4. stopOnError halts-and-skips when true, runs-through when false
//   5. undo reverts a multi-write batch in reverse order; read-back confirms
//   6. undo-of-undo restores again (redo)
//   7. journal lists entries with correct labels / revertibility; get-only batch adds none
//   8. scene recall drops a non-revertible marker and clears prior entries

import { FakeX32 } from "./fake-x32.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  PASS: ${name}`);
    } else {
        failures++;
        console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

// ch/NN/mix schema field order: on, fader, st, pan, mono, mlevel
const MIX = (on, fader, st, pan, mono, mlevel) => [on, fader, st, pan, mono, mlevel];

async function main() {
    const { OSCClient } = await import("../dist/osc-client.js");

    const fake = new FakeX32();
    const port = await fake.start(0);
    console.log(`fake X32 listening on 127.0.0.1:${port}`);

    // Seed the containers the tests touch.
    fake.setNode("ch/01/mix", MIX("ON", "-10", "OFF", "0", "OFF", "-oo"));
    fake.setNode("ch/02/mix", MIX("ON", "-20", "OFF", "0", "OFF", "-oo"));
    fake.setNode("ch/05/mix", MIX("ON", "-10", "OFF", "0", "OFF", "-oo"));
    fake.setNode("ch/06/mix", MIX("ON", "-20", "OFF", "10", "OFF", "-oo"));
    fake.setNode("ch/09/mix", MIX("ON", "-10", "OFF", "0", "OFF", "-oo"));
    // FX slot 1 = HALL; par[0] = predly.
    fake.setNode("fx/1/type", ["HALL"]);
    fake.setNode("fx/1/par", ["26", "2.0", "50", "10000", "10", "0", "100", "10000", "1", "10", "100", "50"]);

    const client = new OSCClient("127.0.0.1", port);
    await client.connect();
    await sleep(120);

    // ---- Test 1: batch of get + set + adjust, per-op results in order ----
    console.log("\n[1] batch get + set + adjust (ordered results)");
    const b1 = await client.batch([
        { get: { path: "ch/01/mix", field: "fader" } },        // read -10
        { set: { path: "ch/01/mix", fields: { fader: -6, on: false } } },
        { set: { path: "ch/02/mix", fields: { fader: { adjust: 3 } } } }, // -20 + 3 = -17
        { get: { path: "ch/02/mix", field: "fader" } },        // read back -17
    ]);
    check("returns one result per op, in order", b1.results.length === 4, JSON.stringify(b1.results));
    check("op0 get returned current fader -10", b1.results[0].ok && b1.results[0].result === -10, JSON.stringify(b1.results[0]));
    check("op1 set ok, wrote fader+on", b1.results[1].ok && b1.results[1].result.wrote.join() === "fader,on", JSON.stringify(b1.results[1]));
    check("op2 adjust ok", b1.results[2].ok, JSON.stringify(b1.results[2]));
    check("op3 read-back shows adjust from current (-17)", b1.results[3].result === -17, JSON.stringify(b1.results[3]));
    check("write ops carry an undoIndex", typeof b1.results[1].undoIndex === "number" && b1.results[1].undoIndex >= 0, JSON.stringify(b1.results[1]));

    // ---- Test 2: adjust clamps at schema range + -∞ floor ----
    console.log("\n[2] adjust clamps at range; -∞ adjusts from floor");
    const b2 = await client.batch([
        { set: { path: "ch/09/mix", fields: { fader: 8 } } },
        { set: { path: "ch/09/mix", fields: { fader: { adjust: 50 } } } }, // 8 + 50 -> clamp to +10
        { get: { path: "ch/09/mix", field: "fader" } },
        { set: { path: "ch/09/mix", fields: { mlevel: { adjust: 5 } } } }, // -oo -> floor -90 + 5 = -85
        { get: { path: "ch/09/mix", field: "mlevel" } },
    ]);
    check("fader clamped to schema max +10", b2.results[2].result === 10, JSON.stringify(b2.results[2]));
    check("-∞ mlevel adjusted from floor to -85", b2.results[4].result === -85, JSON.stringify(b2.results[4]));

    // ---- Test 3: adjust on a non-numeric field errors cleanly ----
    console.log("\n[3] adjust on non-numeric field errors");
    const b3 = await client.batch([
        { set: { path: "ch/01/mix", fields: { on: { adjust: 1 } } } }, // 'on' is bool
    ]);
    check("bool adjust op failed", !b3.results[0].ok, JSON.stringify(b3.results[0]));
    check("error message mentions adjust/numeric", /adjust/i.test(b3.results[0].error || ""), b3.results[0].error);

    // ---- Test 4: stopOnError both ways ----
    console.log("\n[4] stopOnError true vs false");
    const opsWithBad = [
        { set: { path: "ch/01/mix", fields: { fader: -5 } } },
        { set: { path: "ch/01/mix", fields: { bogusField: 1 } } }, // unknown field -> error
        { set: { path: "ch/02/mix", fields: { fader: -5 } } },
    ];
    const stopT = await client.batch(opsWithBad, true);
    check("stop=true: op0 ok", stopT.results[0].ok, JSON.stringify(stopT.results[0]));
    check("stop=true: op1 failed", !stopT.results[1].ok && !stopT.results[1].skipped, JSON.stringify(stopT.results[1]));
    check("stop=true: op2 skipped", stopT.results[2].skipped === true, JSON.stringify(stopT.results[2]));
    const stopF = await client.batch(opsWithBad, false);
    check("stop=false: op1 failed", !stopF.results[1].ok, JSON.stringify(stopF.results[1]));
    check("stop=false: op2 still ran", stopF.results[2].ok === true, JSON.stringify(stopF.results[2]));

    // ---- Test 5: undo reverts a multi-write batch in reverse; read-back confirms ----
    console.log("\n[5] undo reverts a multi-write batch");
    // Fresh known state.
    fake.setNode("ch/05/mix", MIX("ON", "-10", "OFF", "0", "OFF", "-oo"));
    fake.setNode("ch/06/mix", MIX("ON", "-20", "OFF", "10", "OFF", "-oo"));
    await client.batch([
        { set: { path: "ch/05/mix", fields: { fader: -3, on: false } } },
        { set: { path: "ch/06/mix", fields: { pan: -50 } } },
    ]);
    // Confirm the batch applied.
    const after05 = await client.nodeGetField("ch/05/mix");
    const after06 = await client.nodeGetField("ch/06/mix");
    check("batch applied ch05 fader=-3, on=false", after05.fader === -3 && after05.on === false, JSON.stringify(after05));
    check("batch applied ch06 pan=-50", after06.pan === -50, JSON.stringify(after06));
    const u1 = await client.undo(1);
    check("undo reverted 1 entry", u1.reverted.length === 1, JSON.stringify(u1));
    check("undo reverted 3 writes", u1.reverted[0].revertedWrites === 3, JSON.stringify(u1.reverted[0]));
    check("undo targeted the batch entry", u1.reverted[0].label.startsWith("batch:"), u1.reverted[0].label);
    const rev05 = await client.nodeGetField("ch/05/mix");
    const rev06 = await client.nodeGetField("ch/06/mix");
    check("ch05 restored fader=-10, on=true", rev05.fader === -10 && rev05.on === true, JSON.stringify(rev05));
    check("ch06 restored pan=10", rev06.pan === 10, JSON.stringify(rev06));

    // ---- Test 6: undo-of-undo restores again (redo) ----
    console.log("\n[6] undo of undo = redo");
    const u2 = await client.undo(1);
    check("second undo reverted the undo entry", u2.reverted[0].label.startsWith("undo: batch:"), u2.reverted[0].label);
    const redo05 = await client.nodeGetField("ch/05/mix");
    const redo06 = await client.nodeGetField("ch/06/mix");
    check("redo re-applied ch05 fader=-3, on=false", redo05.fader === -3 && redo05.on === false, JSON.stringify(redo05));
    check("redo re-applied ch06 pan=-50", redo06.pan === -50, JSON.stringify(redo06));

    // ---- Test 6b: fx op in a batch journals + reverts ----
    console.log("\n[6b] fx op in batch is journaled + revertible");
    const fxBatch = await client.batch([{ fx: { slot: 1, params: { predly: 30 } } }]);
    check("fx op ok, wrote predly (HALL)", fxBatch.results[0].ok && fxBatch.results[0].result.type === "HALL", JSON.stringify(fxBatch.results[0]));
    const parAfter = await client.nodeRead("fx/1/par");
    check("fx par[0] predly now 30", parAfter.values[0] === "30", parAfter.values[0]);
    await client.undo(1);
    const parRev = await client.nodeRead("fx/1/par");
    check("fx par[0] predly restored to 26", parRev.values[0] === "26", parRev.values[0]);

    // ---- Test 7: journal listing + get-only batch adds no entry ----
    console.log("\n[7] journal listing + revertibility");
    const jBefore = client.listJournal(50).count;
    const getOnly = await client.batch([{ get: { path: "ch/01/mix", field: "fader" } }]);
    check("get-only batch succeeds", getOnly.results[0].ok, JSON.stringify(getOnly.results[0]));
    check("get-only batch adds no journal entry", client.listJournal(50).count === jBefore, `before=${jBefore} after=${client.listJournal(50).count}`);
    const jl = client.listJournal(5);
    check("journal rows carry ts/label/writeCount/revertible", jl.entries.every((e) =>
        typeof e.ts === "number" && typeof e.label === "string" && typeof e.writeCount === "number" && typeof e.revertible === "boolean"),
        JSON.stringify(jl.entries));
    check("most recent entries are revertible writes", jl.entries[0].revertible === true, JSON.stringify(jl.entries[0]));

    // ---- Test 8: scene recall marker clears revertibility ----
    console.log("\n[8] scene recall marker clears the journal");
    await client.nodeSetField("ch/01/mix", { fader: -12 }); // ensure at least one revertible entry
    check("journal non-empty before recall", client.listJournal(50).count > 0, `count=${client.listJournal(50).count}`);
    await client.recallScene(1);
    const jAfter = client.listJournal(50);
    check("recall left exactly the marker entry", jAfter.count === 1, `count=${jAfter.count}`);
    check("marker entry is non-revertible", jAfter.entries[0].revertible === false, JSON.stringify(jAfter.entries[0]));
    check("marker entry labeled 'scene recall — journal cleared'", jAfter.entries[0].label.includes("scene recall"), jAfter.entries[0].label);
    const uNone = await client.undo(1);
    check("undo after recall reverts nothing", uNone.reverted.length === 0, JSON.stringify(uNone));
    check("undo after recall warns about non-revertible", uNone.warnings.length > 0, JSON.stringify(uNone.warnings));

    // ---- summary ----
    fake.close();
    console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error("test-batch-undo crashed:", e);
    process.exit(1);
});
