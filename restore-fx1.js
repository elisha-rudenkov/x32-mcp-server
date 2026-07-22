#!/usr/bin/env node
// Restore FX1 (HALL) to its pre-test baseline captured by probe-phase-d-prime.js
// before any test mutations: par=["26","2.99","52","3k48","25","0.0","83","7k2","0.95","25","50","30",...]

import { OSCClient } from "./dist/osc-client.js";

const HOST = process.env.OSC_HOST || "192.168.1.248";
const PORT = parseInt(process.env.OSC_PORT || "10023");

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await new Promise((r) => setTimeout(r, 200));

    await osc.fxSetType(1, "HALL");
    await new Promise((r) => setTimeout(r, 200));
    await osc.fxSet(1, {
        predly: 26, decay: 2.99, size: 52, damping: 3480, diffuse: 25,
        level: 0, loCut: 83, hiCut: 7200, bassMulti: 0.95, spread: 25,
        shape: 50, modSpeed: 30,
    });
    await new Promise((r) => setTimeout(r, 200));
    const got = await osc.fxGet(1);
    console.log(`FX1 restored: ${got.type}`);
    console.log(JSON.stringify(got.params));
    osc.close();
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
