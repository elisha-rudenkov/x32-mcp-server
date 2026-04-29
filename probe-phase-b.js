#!/usr/bin/env node
// Phase B probe — collect:
//   - full pos enum across all 16 main / 6 aux / 16 p16 / 2 aes / 2 rec outputs
//   - dca shapes (already confirmed; spot-check a few more)
//   - bus/auxin/fxrtn/mtx/main mix-container shapes (broadening question)
//   - bus/NN/config and mtx/NN/config and mtx/NN/mix shapes
//   - bus/NN/mix/BB (sends to matrix from buses) shapes

import { OSCClient } from "./dist/osc-client.js";

const HOST = process.env.OSC_HOST || "192.168.1.248";
const PORT = parseInt(process.env.OSC_PORT || "10023");

const PATHS = [];

// All physical-output containers — collect every pos value the console renders
for (let i = 1; i <= 16; i++) PATHS.push(`outputs/main/${String(i).padStart(2, "0")}`);
for (let i = 1; i <= 6; i++) PATHS.push(`outputs/aux/${String(i).padStart(2, "0")}`);
for (let i = 1; i <= 16; i++) PATHS.push(`outputs/p16/${String(i).padStart(2, "0")}`);
for (let i = 1; i <= 2; i++) PATHS.push(`outputs/aes/${String(i).padStart(2, "0")}`);
for (let i = 1; i <= 2; i++) PATHS.push(`outputs/rec/${String(i).padStart(2, "0")}`);

// DCA spot-check
for (let i = 1; i <= 8; i++) PATHS.push(`dca/${i}`);
for (let i = 1; i <= 8; i++) PATHS.push(`dca/${i}/config`);

// Broadening candidates
PATHS.push(
    "bus/01/config",
    "bus/16/config",
    "bus/01/mix",
    "bus/16/mix",
    "bus/01/mix/01",  // bus -> matrix
    "bus/01/mix/02",
    "bus/01/mix/06",
    "bus/01/grp",

    "auxin/01/config",
    "auxin/08/config",
    "auxin/01/mix",
    "auxin/01/grp",
    "auxin/01/mix/01",
    "auxin/01/mix/02",

    "fxrtn/01/config",
    "fxrtn/08/config",
    "fxrtn/01/mix",
    "fxrtn/01/grp",
    "fxrtn/01/mix/01",
    "fxrtn/01/mix/02",

    "mtx/01/config",
    "mtx/06/config",
    "mtx/01/mix",
    "mtx/06/mix",
    "mtx/01/grp",

    "main/st/config",
    "main/m/config",
    "main/st/mix",
    "main/m/mix",
    "main/st/grp",
    "main/m/grp",
    "main/st/mix/01",
    "main/st/mix/02",
);

async function main() {
    const osc = new OSCClient(HOST, PORT);
    await osc.connect();
    await new Promise((r) => setTimeout(r, 200));

    console.log("=".repeat(90));
    console.log("Phase B probe");
    console.log("=".repeat(90));

    const posValues = new Set();
    for (const path of PATHS) {
        try {
            const n = await osc.nodeRead(path);
            const count = n.values.length;
            console.log(`  [${count.toString().padStart(2)}]  ${path.padEnd(28)} ${JSON.stringify(n.values)}`);

            // Track output pos enum values (field index 1)
            if (path.startsWith("outputs/")) {
                if (n.values.length >= 2) posValues.add(n.values[1]);
            }
        } catch (e) {
            console.log(`  [--]  ${path.padEnd(28)} ERR ${e.message.replace(/^Timeout: \/node /, "")}`);
        }
    }

    console.log("\nDistinct output pos values seen:", [...posValues]);

    osc.close();
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
