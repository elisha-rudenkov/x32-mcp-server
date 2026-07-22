#!/usr/bin/env node
// Phase D quick smoke-test of nodeGetField/nodeSetField.

import { OSCClient } from "./dist/osc-client.js";

const HOST = process.env.OSC_HOST || "192.168.1.248";
const PORT = parseInt(process.env.OSC_PORT || "10023");

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await new Promise((r) => setTimeout(r, 200));

    console.log("=".repeat(60));
    console.log("listNodeSchemas() — first 5 + count");
    console.log("=".repeat(60));
    const all = osc.listNodeSchemas();
    console.log(`  total entries: ${all.length}`);
    for (const e of all.slice(0, 5)) {
        console.log(`  ${e.path.padEnd(28)} fields=[${e.fields.map(f => `${f.name}:${f.type}`).join(", ")}]`);
    }

    console.log();
    console.log("=".repeat(60));
    console.log("nodeGetField — typed reads");
    console.log("=".repeat(60));
    const ch01 = await osc.nodeGetField("ch/01/config");
    console.log("  ch/01/config full:", JSON.stringify(ch01));
    const ch01name = await osc.nodeGetField("ch/01/config", "name");
    console.log("  ch/01/config.name =", JSON.stringify(ch01name));
    const ch01gate = await osc.nodeGetField("ch/01/gate");
    console.log("  ch/01/gate full:", JSON.stringify(ch01gate));
    const ha000 = await osc.nodeGetField("headamp/000");
    console.log("  headamp/000 full:", JSON.stringify(ha000));
    const preamp = await osc.nodeGetField("ch/01/preamp");
    console.log("  ch/01/preamp full:", JSON.stringify(preamp));
    const grp = await osc.nodeGetField("ch/01/grp");
    console.log("  ch/01/grp full:", JSON.stringify(grp));
    const muteG = await osc.nodeGetField("config/mute");
    console.log("  config/mute full:", JSON.stringify(muteG));

    osc.close();
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
