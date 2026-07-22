#!/usr/bin/env node
// Phase D probe round 3 — verify ch/NN/preamp field order via leaf reads.

import { OSCClient } from "./dist/osc-client.js";

const HOST = process.env.OSC_HOST || "192.168.1.248";
const PORT = parseInt(process.env.OSC_PORT || "10023");

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await new Promise((r) => setTimeout(r, 200));

    for (const ch of [1, 2, 16]) {
        const nn = ch.toString().padStart(2, "0");
        const node = await osc.nodeRead(`ch/${nn}/preamp`);
        console.log(`/node ch/${nn}/preamp = ${JSON.stringify(node.values)}`);
        for (const leaf of ["trim", "invert", "hpon", "hpf", "hpslope"]) {
            try {
                const v = await osc.sendCustomCommand(`/ch/${nn}/preamp/${leaf}`);
                console.log(`  ${leaf}: ${JSON.stringify(v)}`);
            } catch (e) {
                console.log(`  ${leaf}: ERR ${e.message}`);
            }
        }
    }

    osc.close();
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
