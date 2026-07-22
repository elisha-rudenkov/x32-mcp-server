#!/usr/bin/env node
// Phase D' probe — capture current FX state across all 8 slots, then cycle
// FX1 through each integer type 0..70 and dump /node fx/1/par. Goal: build
// (typeCode → symbolic name → params) mapping by comparing observed param
// shapes against known pmaillot specs.

import { OSCClient } from "./dist/osc-client.js";

const HOST = process.env.OSC_HOST || "192.168.1.248";
const PORT = parseInt(process.env.OSC_PORT || "10023");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await sleep(200);

    console.log("=".repeat(80));
    console.log("Step 1: current FX state (all 8 slots)");
    console.log("=".repeat(80));
    const originalTypes = [];
    for (let fx = 1; fx <= 8; fx++) {
        let typeInt = null;
        try {
            typeInt = await osc.sendCustomCommand(`/fx/${fx}/type`);
        } catch (e) {
            console.log(`  fx${fx}: type read ERR ${e.message}`);
            originalTypes.push(null);
            continue;
        }
        originalTypes.push(typeInt);
        let par = null;
        try {
            par = await osc.nodeRead(`fx/${fx}/par`);
        } catch (e) {
            par = { values: [] };
        }
        console.log(`  fx${fx}: type=${typeInt}  par.count=${par.values.length}  par=${JSON.stringify(par.values.slice(0, 16))}`);
    }
    console.log(`  originalTypes = ${JSON.stringify(originalTypes)}`);

    console.log();
    console.log("=".repeat(80));
    console.log("Step 2: cycle fx/1/type 0..70, capture par shape");
    console.log("=".repeat(80));
    const observations = [];
    for (let typeInt = 0; typeInt <= 70; typeInt++) {
        // Set type via leaf write — direct OSC int.
        await osc.sendCustomCommand(`/fx/1/type`, typeInt, "int");
        await sleep(80);
        let echoed = null;
        try { echoed = await osc.sendCustomCommand(`/fx/1/type`); } catch {}
        let par = null;
        try { par = await osc.nodeRead("fx/1/par"); } catch (e) { par = { values: [] }; }
        // Find first index where remaining all are "0" / "0.0" — that's the active param count
        let lastNonzero = -1;
        for (let i = 0; i < par.values.length; i++) {
            const v = par.values[i];
            if (!(v === "0" || v === "0.0" || v === "0.00")) lastNonzero = i;
        }
        const activeCount = lastNonzero + 1;
        observations.push({ typeInt, echoed, activeCount, par: par.values });
        console.log(`  type=${typeInt.toString().padStart(2)}  echo=${echoed}  active~${activeCount}  par=${JSON.stringify(par.values.slice(0, 14))}`);
    }

    console.log();
    console.log("=".repeat(80));
    console.log("Step 3: restore FX1 type");
    console.log("=".repeat(80));
    if (originalTypes[0] !== null) {
        await osc.sendCustomCommand(`/fx/1/type`, originalTypes[0], "int");
        await sleep(150);
        const restored = await osc.sendCustomCommand(`/fx/1/type`);
        console.log(`  restored fx/1/type = ${restored} (was ${originalTypes[0]})`);
    }

    osc.close();
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
