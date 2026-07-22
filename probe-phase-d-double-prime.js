#!/usr/bin/env node
// Phase D" probe — what insert / GEQ-insert / AutoMix-group paths actually exist?
//
// Hypotheses to test:
//  1. /insert/<bus>/geq/* — does this path family exist? (plan suggests it)
//  2. GEQ-as-insert is just FX5..8 routed via bus/N/insert.sel → no separate path
//  3. /-stat/automix/* — group master state? gainreduction meters?
//  4. /config/amix/* — automix configuration? (saw config/amix in probe-phase-d-2)
//  5. /-stat/automix/... or similar for live group master gain reduction

import { OSCClient } from "./dist/osc-client.js";

const HOST = process.env.OSC_HOST || "192.168.1.248";
const PORT = parseInt(process.env.OSC_PORT || "10023");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PATHS = [
    // Hypothesis 1: insert-style GEQ paths
    "insert/bus/01/geq",
    "insert/bus/01/geq/01",
    "insert/main/st/geq",
    "/insert/01/geq",

    // Bus/matrix/main insert containers (Phase D schema covers ch/NN/insert; do bus/main equivalents exist?)
    "bus/01/insert",
    "main/st/insert",
    "main/m/insert",
    "mtx/01/insert",

    // FX5..8 source — confirmed timing out per memory but let's verify
    "fx/5/source",
    "fx/5/par",  // does work
    "fx/5/type", // /node container? or only as leaf?

    // AutoMix group masters
    "config/amix",
    "config/amix/x",
    "config/amix/y",
    "-stat/automix",
    "-stat/automix/x",
    "-stat/automix/y",
    "-stat/automix/x/gainreduction",
    "-stat/automix/y/gainreduction",
    "/automix/x",
    "/automix/y",

    // ch/NN/automix already in the schema; verify auxin doesn't (per memory)
    "ch/01/automix",
    "auxin/01/automix",
];

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await sleep(200);

    console.log("=".repeat(80));
    console.log("PROBE — Phase D\" — insert / GEQ-insert / AutoMix groups");
    console.log("=".repeat(80));

    for (const path of PATHS) {
        const cleaned = path.replace(/^\/+/, "");
        try {
            const n = await osc.nodeRead(cleaned);
            console.log(`  [${n.values.length.toString().padStart(2)}]  ${cleaned.padEnd(36)} ${JSON.stringify(n.values)}`);
        } catch (e) {
            console.log(`  [--]  ${cleaned.padEnd(36)} ERR ${e.message.replace(/^Timeout: \/node /, "")}`);
        }
    }

    // Probe the bus/main/mtx insert.sel value to understand how GEQ-as-insert is wired
    console.log();
    console.log("=".repeat(80));
    console.log("Insert.sel survey — which buses/matrices/mains have an FX insert?");
    console.log("=".repeat(80));
    for (let b = 1; b <= 16; b++) {
        const bb = b.toString().padStart(2, "0");
        try {
            const n = await osc.nodeRead(`bus/${bb}/insert`);
            console.log(`  bus/${bb}/insert     ${JSON.stringify(n.values)}`);
        } catch (e) {
            console.log(`  bus/${bb}/insert     ERR`);
        }
    }
    for (let m = 1; m <= 6; m++) {
        const mm = m.toString().padStart(2, "0");
        try {
            const n = await osc.nodeRead(`mtx/${mm}/insert`);
            console.log(`  mtx/${mm}/insert     ${JSON.stringify(n.values)}`);
        } catch (e) {
            console.log(`  mtx/${mm}/insert     ERR`);
        }
    }
    for (const main of ["main/st/insert", "main/m/insert"]) {
        try {
            const n = await osc.nodeRead(main);
            console.log(`  ${main.padEnd(20)}   ${JSON.stringify(n.values)}`);
        } catch (e) {
            console.log(`  ${main.padEnd(20)}   ERR`);
        }
    }

    // What types are loaded in slots 5..8 right now?
    console.log();
    console.log("=".repeat(80));
    console.log("FX5..8 type + first few params");
    console.log("=".repeat(80));
    for (let fx = 5; fx <= 8; fx++) {
        try {
            const t = await osc.sendCustomCommand(`/fx/${fx}/type`);
            const par = await osc.nodeRead(`fx/${fx}/par`);
            console.log(`  fx${fx} type=${t}  par[0..7]=${JSON.stringify(par.values.slice(0, 8))}`);
        } catch (e) {
            console.log(`  fx${fx} ERR ${e.message}`);
        }
    }

    // Probe -stat/automix gain reduction (likely a live meter, may need /xremote subscription)
    console.log();
    console.log("=".repeat(80));
    console.log("AutoMix leaves — direct OSC reads");
    console.log("=".repeat(80));
    for (const path of [
        "/-stat/automix/x/gainreduction",
        "/-stat/automix/y/gainreduction",
        "/-stat/automix/x/on",
        "/-stat/automix/y/on",
        "/config/amix/x/gain",
        "/config/amix/x/response",
        "/config/amix/y/gain",
        "/config/amix/y/response",
    ]) {
        try {
            const v = await osc.sendCustomCommand(path);
            console.log(`  ${path.padEnd(40)} ${JSON.stringify(v)}`);
        } catch (e) {
            console.log(`  ${path.padEnd(40)} ERR ${e.message.replace(/Timeout waiting for response from /, "")}`);
        }
    }

    osc.close();
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
