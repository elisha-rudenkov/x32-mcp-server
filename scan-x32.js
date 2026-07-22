#!/usr/bin/env node
// Scan local subnet for an X32 by sending /xinfo to candidate IPs.

import { OSCClient } from "./dist/osc-client.js";

const CANDIDATES = process.argv.slice(2);
const PORT = parseInt(process.env.OSC_PORT || "10023");

if (CANDIDATES.length === 0) {
    console.log("usage: node scan-x32.js IP [IP ...]");
    process.exit(1);
}

async function tryHost(host) {
    const osc = new OSCClient(host, PORT);
    try {
        await osc.connect();
        await new Promise((r) => setTimeout(r, 100));
        const id = await Promise.race([
            osc.getIdentity(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500)),
        ]);
        osc.close();
        return id;
    } catch (e) {
        try { osc.close(); } catch {}
        return null;
    }
}

async function main() {
    for (const host of CANDIDATES) {
        process.stdout.write(`probing ${host}:${PORT} … `);
        const id = await tryHost(host);
        if (id) {
            console.log("HIT");
            console.log("  " + JSON.stringify(id));
        } else {
            console.log("nothing");
        }
    }
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
