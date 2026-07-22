#!/usr/bin/env node
// Phase D probe (round 2) — verify edge cases:
// - ch/NN/preamp on multiple channels (5th field "189" is suspicious)
// - bus/NN/dyn, bus/NN/eq shapes
// - mix/BB stereo-vs-mono on a 5-6 not-linked pair
// - mtx and main eq/dyn shapes
// - routing/OUT, routing/PLAY, routing/REC, AES50A/B, CARD shapes
// - dca/N node shape
// - auxin/NN/* shape
// - fxrtn/NN/* shape

import { OSCClient } from "./dist/osc-client.js";

const HOST = process.env.OSC_HOST || "192.168.1.248";
const PORT = parseInt(process.env.OSC_PORT || "10023");

const PATHS = [
    "ch/01/preamp",
    "ch/02/preamp",
    "ch/16/preamp",
    "ch/01/insert",
    "ch/01/mix/03",
    "ch/01/mix/04",
    "ch/01/mix/05",
    "ch/01/mix/06",
    "ch/01/mix/15",
    "ch/01/mix/16",
    "bus/01/eq",
    "bus/01/eq/1",
    "bus/01/dyn",
    "bus/01/grp",
    "bus/01/insert",
    "bus/01/dyn/filter",
    "bus/01/mix/01",
    "main/st/eq",
    "main/st/eq/1",
    "main/st/dyn",
    "main/st/insert",
    "main/m/eq",
    "main/m/dyn",
    "main/m/config",
    "mtx/01/eq",
    "mtx/01/dyn",
    "mtx/01/insert",
    "auxin/01/config",
    "auxin/01/mix",
    "auxin/01/preamp",
    "fxrtn/01/config",
    "fxrtn/01/mix",
    "fx/1/source",
    "fx/1/par",
    "dca/1/config",
    "dca/1",
    "config/solo",
    "config/amix",
    "config/routing/AES50A",
    "config/routing/AES50B",
    "config/routing/CARD",
    "config/routing/OUT",
    "config/routing/PLAY",
    "config/routing/REC",
    "config/userrout/out",
    "outputs/main/01",
    "outputs/aux/01",
    "outputs/p16/01",
    "outputs/aes/01",
    "outputs/rec/01",
];

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await new Promise((r) => setTimeout(r, 200));

    console.log("=".repeat(80));
    console.log("PROBE round 2");
    console.log("=".repeat(80));

    for (const path of PATHS) {
        try {
            const n = await osc.nodeRead(path);
            const count = n.values.length;
            console.log(`  [${count.toString().padStart(2)}]  ${path.padEnd(28)} ${JSON.stringify(n.values)}`);
        } catch (e) {
            console.log(`  [--]  ${path.padEnd(28)} ERR ${e.message.replace(/^Timeout: \/node /, "")}`);
        }
    }
    osc.close();
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
