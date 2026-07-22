// Reusable fake X32 UDP responder for the MCP server tests. Plain Node, no deps.
//
// Speaks just enough of the X32 OSC dialect to exercise the live-state-mirror feature:
//   - answers /node container queries with a node line echoing the queried path
//   - answers /xinfo and /status
//   - tracks /xremote subscribers and can push leaf changes to them (the mechanism the
//     real console uses to notify clients of edits made at the desk / by other clients)
//   - counts requests per path so tests can assert cache behavior (a served-from-cache
//     read never reaches the wire, so the count must not move)
//
// Use in-process: `const fake = new FakeX32(); await fake.start();` then drive it with
// setNode() / pushChange() / getCount(). It can also be triggered out-of-process by an
// OSC message to the magic address "/__push__" (,ssf: leafAddress, containerHint, value).

import dgram from "dgram";

// ---------- minimal OSC codec ----------

function padTo4(len) {
    return Math.ceil(len / 4) * 4;
}

function encodeString(s) {
    const raw = Buffer.from(String(s) + "\0", "utf8");
    const padded = Buffer.alloc(padTo4(raw.length));
    raw.copy(padded);
    return padded;
}

/** Build an OSC message from an address and a list of {type,value} args. */
function encodeMessage(address, args) {
    const tags = "," + args.map((a) => a.type).join("");
    const parts = [encodeString(address), encodeString(tags)];
    for (const a of args) {
        if (a.type === "s") {
            parts.push(encodeString(a.value));
        } else if (a.type === "i") {
            const b = Buffer.alloc(4);
            b.writeInt32BE(a.value | 0);
            parts.push(b);
        } else if (a.type === "f") {
            const b = Buffer.alloc(4);
            b.writeFloatBE(a.value);
            parts.push(b);
        } else {
            throw new Error(`fake-x32: unsupported arg type "${a.type}"`);
        }
    }
    return Buffer.concat(parts);
}

/** Parse an OSC message into { address, args } (strings, ints, floats, bools). */
function decodeMessage(buf) {
    const readString = (off) => {
        let end = off;
        while (end < buf.length && buf[end] !== 0) end++;
        const s = buf.subarray(off, end).toString("utf8");
        return { s, next: off + padTo4(end - off + 1) };
    };
    const a = readString(0);
    if (!a.s) return null;
    const t = readString(a.next);
    if (!t.s.startsWith(",")) return { address: a.s, args: [] };
    let off = t.next;
    const args = [];
    for (let i = 1; i < t.s.length; i++) {
        const tag = t.s[i];
        if (tag === "s") {
            const v = readString(off);
            args.push(v.s);
            off = v.next;
        } else if (tag === "i") {
            args.push(buf.readInt32BE(off));
            off += 4;
        } else if (tag === "f") {
            args.push(buf.readFloatBE(off));
            off += 4;
        } else if (tag === "T") {
            args.push(true);
        } else if (tag === "F") {
            args.push(false);
        } else {
            break;
        }
    }
    return { address: a.s, args };
}

const norm = (p) => String(p).replace(/^\/+/, "").replace(/\/+$/, "");

/** Tokenize the value portion of an X32node write, respecting "quoted" tokens (may contain spaces). */
function tokenizeWriteValues(rest) {
    const out = [];
    let i = 0;
    while (i < rest.length) {
        while (i < rest.length && rest[i] === " ") i++;
        if (i >= rest.length) break;
        if (rest[i] === '"') {
            i++;
            let s = "";
            while (i < rest.length && rest[i] !== '"') {
                if (rest[i] === "\\" && i + 1 < rest.length) { s += rest[i + 1]; i += 2; }
                else { s += rest[i]; i++; }
            }
            out.push(s);
            if (i < rest.length) i++;
        } else {
            const start = i;
            while (i < rest.length && rest[i] !== " ") i++;
            out.push(rest.slice(start, i));
        }
    }
    return out;
}

// Float count per implemented meter bank (must match src/osc-client.ts buildMeterLayout).
const METER_FLOAT_COUNTS = { 0: 70, 1: 96, 2: 49, 3: 22 };
// A meter subscription lasts this long on the real console before it must be renewed.
const METER_SUBSCRIPTION_MS = 10_000;
// The console streams a fresh blob about every 50ms.
const METER_INTERVAL_MS = 50;

export class FakeX32 {
    constructor() {
        this.sock = null;
        this.port = 0;
        // path -> value token array returned by /node
        this.nodes = new Map();
        // path -> number of /node reads seen
        this.reqCounts = new Map();
        // "addr:port" -> {address, port} of live /xremote subscribers
        this.subscribers = new Map();
        this.xinfo = ["127.0.0.1", "FakeX32", "X32EMU", "4.0-fake"];
        this.status = ["active", "127.0.0.1", "FakeX32"];
        // Active meter streams keyed by "addr:port:bank": { timer, expires, frame }.
        this.meterStreams = new Map();
        // Optional per-bank scripting hook: bank -> function(frameIndex, floatCount) -> Float array (linear).
        // If unset, all floats are ~silence (noise floor).
        this.meterScripts = new Map();
    }

    /**
     * Script the linear float values a meter bank streams over time. `fn(frameIndex, floatCount)`
     * returns a full linear-value array (length floatCount) for each blob. Level meters are linear
     * amplitude (1.0 = 0 dBFS); gain-reduction meters are linear (1.0 = no reduction, 0.5 = -6 dB).
     */
    setMeterScript(bank, fn) {
        this.meterScripts.set(Number(bank), fn);
    }

    /** Bind the responder. Pass a port or 0 to let the OS choose; resolves with the port. */
    start(port = 0) {
        return new Promise((resolve, reject) => {
            this.sock = dgram.createSocket("udp4");
            this.sock.on("error", reject);
            this.sock.on("message", (buf, rinfo) => this._onMessage(buf, rinfo));
            this.sock.bind(port, "127.0.0.1", () => {
                this.port = this.sock.address().port;
                resolve(this.port);
            });
        });
    }

    close() {
        for (const s of this.meterStreams.values()) clearInterval(s.timer);
        this.meterStreams.clear();
        if (this.sock) {
            try {
                this.sock.close();
            } catch {
                // already closed
            }
            this.sock = null;
        }
    }

    /** Build one `/meters/N` blob OSC message from a linear float array (X32 wire format:
     *  int32BE blob byte-length, then int32LE float count, then little-endian float32s). */
    _encodeMeterBlob(bank, floats) {
        const nf = floats.length;
        const blob = Buffer.alloc(4 + nf * 4); // int32LE count + floats
        blob.writeInt32LE(nf, 0);
        for (let i = 0; i < nf; i++) blob.writeFloatLE(floats[i], 4 + i * 4);
        const lenPrefix = Buffer.alloc(4);
        lenPrefix.writeInt32BE(blob.length, 0);
        const padded = Buffer.alloc(padTo4(blob.length));
        blob.copy(padded);
        return Buffer.concat([encodeString(`/meters/${bank}`), encodeString(",b"), lenPrefix, padded]);
    }

    /** Compute the linear float array for one blob frame of a bank, using the scripted hook
     *  if present, otherwise a flat noise floor (~-100 dBFS). */
    _meterFrame(bank, frameIndex) {
        const nf = METER_FLOAT_COUNTS[bank];
        const fn = this.meterScripts.get(bank);
        if (fn) {
            const arr = fn(frameIndex, nf);
            if (!Array.isArray(arr) || arr.length !== nf) {
                throw new Error(`fake-x32: meter script for bank ${bank} returned ${Array.isArray(arr) ? arr.length : typeof arr} floats, expected ${nf}`);
            }
            return arr;
        }
        return new Array(nf).fill(1e-5); // ~-100 dBFS noise floor
    }

    /** Start (or renew) a meter stream to `rinfo` for `bank`: emits a blob every ~50ms until the
     *  subscription window elapses, mirroring the real console's push-until-renewed behavior. */
    _startMeterStream(rinfo, bank) {
        if (METER_FLOAT_COUNTS[bank] === undefined) return; // unimplemented bank — ignore like the console
        const key = `${rinfo.address}:${rinfo.port}:${bank}`;
        const existing = this.meterStreams.get(key);
        if (existing) {
            // Renewal: extend the window, keep the same timer / frame counter.
            existing.expires = Date.now() + METER_SUBSCRIPTION_MS;
            return;
        }
        const stream = { frame: 0, expires: Date.now() + METER_SUBSCRIPTION_MS, timer: null };
        stream.timer = setInterval(() => {
            if (!this.sock || Date.now() > stream.expires) {
                clearInterval(stream.timer);
                this.meterStreams.delete(key);
                return;
            }
            try {
                const floats = this._meterFrame(bank, stream.frame++);
                this.sock.send(this._encodeMeterBlob(bank, floats), rinfo.port, rinfo.address);
            } catch {
                // drop a frame on error rather than crashing the responder
            }
        }, METER_INTERVAL_MS);
        this.meterStreams.set(key, stream);
    }

    /** Seed / replace the value tokens returned for a /node container. */
    setNode(path, values) {
        this.nodes.set(norm(path), values.slice());
    }

    /** How many /node reads the fake has answered for `path`. */
    getCount(path) {
        return this.reqCounts.get(norm(path)) ?? 0;
    }

    getSubscriberCount() {
        return this.subscribers.size;
    }

    /**
     * Simulate an external edit: push a leaf OSC message to every /xremote subscriber and,
     * optionally, mutate the stored container so a subsequent /node read returns fresh data.
     *
     * @param leafAddress  e.g. "/ch/01/mix/fader"
     * @param rawValue     the pushed float (X32 pushes raw normalized values)
     * @param mutate       optional { containerPath, index, token } to update stored state so
     *                     the post-invalidation read genuinely differs.
     */
    pushChange(leafAddress, rawValue, mutate) {
        if (mutate) {
            const key = norm(mutate.containerPath);
            const vals = this.nodes.get(key);
            if (vals && mutate.index < vals.length) vals[mutate.index] = mutate.token;
        }
        const msg = encodeMessage(leafAddress, [{ type: "f", value: rawValue }]);
        for (const sub of this.subscribers.values()) {
            this.sock.send(msg, sub.port, sub.address);
        }
    }

    _reply(rinfo, address, args) {
        const buf = encodeMessage(address, args);
        this.sock.send(buf, rinfo.port, rinfo.address);
    }

    _nodeLine(path) {
        const clean = norm(path);
        const vals = this.nodes.get(clean);
        const body = vals && vals.length ? " " + vals.join(" ") : " 0";
        return `/${clean}${body}`;
    }

    _onMessage(buf, rinfo) {
        const msg = decodeMessage(buf);
        if (!msg) return;
        const { address, args } = msg;

        if (address === "/node") {
            const path = norm(args[0] ?? "");
            this.reqCounts.set(path, (this.reqCounts.get(path) ?? 0) + 1);
            // X32 /node replies land on address "node" (no leading slash) with the node line
            // as a single string arg.
            this._reply(rinfo, "node", [{ type: "s", value: this._nodeLine(path) }]);
            return;
        }

        if (address === "/xinfo") {
            this._reply(rinfo, "/xinfo", this.xinfo.map((v) => ({ type: "s", value: v })));
            return;
        }

        if (address === "/status") {
            this._reply(rinfo, "/status", this.status.map((v) => ({ type: "s", value: v })));
            return;
        }

        if (address === "/xremote") {
            const key = `${rinfo.address}:${rinfo.port}`;
            this.subscribers.set(key, { address: rinfo.address, port: rinfo.port });
            return;
        }

        // Meter subscription request: "/meters" ,s "/meters/N". Stream blobs to the sender until
        // the window elapses; a repeat request renews it. (The real console behaves identically.)
        if (address === "/meters") {
            const tag = String(args[0] ?? "");
            const m = tag.match(/\/meters\/(\d+)/);
            if (m) this._startMeterStream(rinfo, Number(m[1]));
            return;
        }

        // X32node write: "/" with a single string arg "path val1 val2 ...". Apply it as a
        // PREFIX-PARTIAL write (like the real console): the incoming tokens overwrite the
        // leading fields and any untouched trailing fields are preserved, so a subsequent
        // /node read reflects the merged state.
        if (address === "/") {
            const text = String(args[0] ?? "");
            const sp = text.indexOf(" ");
            const path = norm(sp === -1 ? text : text.slice(0, sp));
            const rest = sp === -1 ? "" : text.slice(sp + 1);
            if (rest.length) {
                const incoming = tokenizeWriteValues(rest);
                const merged = (this.nodes.get(path) ?? []).slice();
                for (let i = 0; i < incoming.length; i++) merged[i] = incoming[i];
                this.nodes.set(path, merged);
            }
            return;
        }

        // Out-of-process trigger: "/__push__" ,ssf leafAddress containerHint value.
        if (address === "/__push__") {
            const [leaf, container, value] = args;
            this.pushChange(String(leaf), Number(value), container ? { containerPath: String(container), index: 1, token: String(value) } : undefined);
            return;
        }
        // Anything else (meters, heartbeat echoes, ...) is ignored.
    }
}

export default FakeX32;
