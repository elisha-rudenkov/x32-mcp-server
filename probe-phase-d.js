#!/usr/bin/env node
// Phase D probe — confirm /node field counts on live console match memory's spec table.
// Read-only except for one round-trip on ch/32/config.name (restored after).

import { OSCClient } from "./dist/osc-client.js";

const HOST = process.env.OSC_HOST || "192.168.0.162";
const PORT = parseInt(process.env.OSC_PORT || "10023");

const PATHS = [
    // Channel
    "ch/01/config",
    "ch/01/mix",
    "ch/01/eq",
    "ch/01/eq/1",
    "ch/01/eq/B",
    "ch/01/gate",
    "ch/01/gate/filter",
    "ch/01/dyn",
    "ch/01/dyn/filter",
    "ch/01/insert",
    "ch/01/preamp",
    "ch/01/delay",
    "ch/01/grp",
    "ch/01/automix",
    "ch/01/mix/01",
    "ch/01/mix/02",
    // Headamp
    "headamp/000",
    // Config
    "config/mute",
    "config/chlink",
    "config/buslink",
    "config/auxlink",
    "config/mtxlink",
    "config/linkcfg",
    // Bus / main / matrix sample shapes
    "bus/01/config",
    "bus/01/mix",
    "main/st/config",
    "main/st/mix",
    "main/m/mix",
    "mtx/01/config",
    "mtx/01/mix",
    // Routing / userrout
    "config/routing/IN",
    "config/userrout/in",
];

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await new Promise((r) => setTimeout(r, 200));

    console.log("=".repeat(80));
    console.log("PROBE: /node field counts");
    console.log("=".repeat(80));

    for (const path of PATHS) {
        try {
            const n = await osc.nodeRead(path);
            const replyPath = n.path;
            const count = n.values.length;
            console.log(`  [${count.toString().padStart(2)}]  send=${path.padEnd(24)}  reply=${replyPath.padEnd(28)}  values=${JSON.stringify(n.values)}`);
        } catch (e) {
            console.log(`  [--]  send=${path.padEnd(24)}  ERROR ${e.message}`);
        }
    }

    console.log();
    console.log("=".repeat(80));
    console.log("Round-trip test: ch/32/config name via nodeWrite");
    console.log("=".repeat(80));

    const before = await osc.nodeRead("ch/32/config");
    console.log("  before:", JSON.stringify(before.values));
    const originalName = before.values[0];
    const originalIcon = before.values[1];
    const originalColor = before.values[2];
    const originalSource = before.values[3];

    const testName = "PhaseD-Test";
    console.log(`  writing name="${testName}"…`);
    await osc.nodeWrite("ch/32/config", [testName]);
    await new Promise((r) => setTimeout(r, 100));

    const mid = await osc.nodeRead("ch/32/config");
    console.log("  after-write:", JSON.stringify(mid.values));

    // Restore — write all four fields back.
    console.log(`  restoring original name="${originalName}"…`);
    await osc.nodeWrite("ch/32/config", [originalName, originalIcon, originalColor, originalSource]);
    await new Promise((r) => setTimeout(r, 100));

    const after = await osc.nodeRead("ch/32/config");
    console.log("  after-restore:", JSON.stringify(after.values));

    const ok =
        mid.values[0] === testName &&
        after.values[0] === originalName;
    console.log(`  RESULT: ${ok ? "PASS" : "FAIL"}`);

    osc.close();
    process.exit(0);
}

main().catch((e) => {
    console.error("FAILED:", e);
    process.exit(1);
});
