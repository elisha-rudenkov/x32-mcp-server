#!/usr/bin/env node
// Phase E probe — verify /meters wire format on the live console.
// Uses raw dgram so we can dump the byte-exact reply for blob 'b' tag.

import dgram from "dgram";

const HOST = process.env.OSC_HOST || "192.168.1.248";
const PORT = parseInt(process.env.OSC_PORT || "10023");

// OSC encoding helpers
function padNul(s) {
    const buf = Buffer.from(s + "\0");
    const padded = Math.ceil(buf.length / 4) * 4;
    return Buffer.concat([buf, Buffer.alloc(padded - buf.length)]);
}
function buildOscMsg(address, typeTag, ...args) {
    const parts = [padNul(address), padNul("," + typeTag)];
    let i = 0;
    for (const t of typeTag) {
        if (t === "s") parts.push(padNul(args[i++]));
        else if (t === "i") {
            const b = Buffer.alloc(4);
            b.writeInt32BE(args[i++]);
            parts.push(b);
        }
    }
    return Buffer.concat(parts);
}

function readCString(buf, off) {
    let end = off;
    while (end < buf.length && buf[end] !== 0) end++;
    const s = buf.subarray(off, end).toString("utf8");
    const padded = Math.ceil((end - off + 1) / 4) * 4;
    return { s, next: off + padded };
}

async function probe(bank, args = [], expectedFloats = null) {
    return new Promise((resolve) => {
        const sock = dgram.createSocket("udp4");
        const replies = [];
        const timeout = setTimeout(() => {
            sock.close();
            resolve(replies);
        }, 500);
        sock.on("message", (buf) => {
            const a = readCString(buf, 0);
            const t = readCString(buf, a.next);
            // Parse blob tag
            if (t.s === ",b") {
                const blobLen = buf.readInt32BE(t.next);
                const dataStart = t.next + 4;
                // First 4 bytes of blob = number of floats, little-endian per spec
                const numFloats = buf.readInt32LE(dataStart);
                const floats = [];
                for (let i = 0; i < numFloats; i++) {
                    floats.push(buf.readFloatLE(dataStart + 4 + i * 4));
                }
                replies.push({ addr: a.s, blobLen, numFloats, floats, totalBytes: buf.length });
            } else {
                replies.push({ addr: a.s, type: t.s, totalBytes: buf.length });
            }
        });
        sock.bind(0, "0.0.0.0", () => {
            // Spec format: /meters with args (string banktag, [int extras...], [int duration_ms])
            const tags = "s" + "i".repeat(args.length);
            const msg = buildOscMsg("/meters", tags, `/meters/${bank}`, ...args);
            sock.send(msg, PORT, HOST);
        });
    });
}

async function main() {
    console.log("=".repeat(72));
    console.log("Phase E probe — /meters wire format");
    console.log("=".repeat(72));

    for (const { bank, args, expected } of [
        { bank: 0, args: [], expected: 70 },
        { bank: 1, args: [], expected: 96 },
        { bank: 2, args: [], expected: 49 },
        { bank: 3, args: [], expected: 22 },
    ]) {
        console.log(`\n--- /meters/${bank} (expected ~${expected} floats) ---`);
        const replies = await probe(bank, args);
        console.log(`  ${replies.length} replies in 500ms`);
        if (replies.length > 0) {
            const r = replies[0];
            console.log(`  reply addr=${r.addr}  blobLen=${r.blobLen}  numFloats=${r.numFloats}`);
            console.log(`  first 16 floats: ${r.floats.slice(0, 16).map((f) => f.toFixed(4)).join(", ")}`);
            console.log(`  last 4 floats:   ${r.floats.slice(-4).map((f) => f.toFixed(4)).join(", ")}`);
            // dB values for sanity
            const linToDb = (v) => v <= 0 ? -Infinity : 20 * Math.log10(v);
            console.log(`  first 8 in dBfs: ${r.floats.slice(0, 8).map((f) => linToDb(f).toFixed(1)).join(", ")}`);
        } else {
            console.log("  NO REPLY");
        }
    }

    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
