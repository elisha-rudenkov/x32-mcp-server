import OSC from "osc-js";
import dgram from "dgram";
import {
    NODE_SCHEMA,
    NodeSchemaEntry,
    findSchema,
    listSchemas as listSchemasImpl,
    decodeField,
    encodeFieldValue,
} from "./node-schema.js";

// ========== X32node reply parsers ==========
// X32 /node replies come back on the non-OSC-compliant address "node" (no leading slash).
// Format: single OSC string arg like '/ch/01/config "Voc1" 1 MG 1\n'
// Values are space-delimited; names are quoted; bitmasks prefixed %, -∞ dB rendered as "-oo",
// frequencies rendered in "3k48" shorthand (=3480 Hz).

/** Tokenize a /node reply string. Respects "quoted" values (which may contain spaces). */
export function parseNodeLine(line: string): { path: string; values: string[] } {
    const trimmed = line.replace(/\n$/, "").replace(/\s+$/, "");
    const firstSpace = trimmed.indexOf(" ");
    const path = firstSpace === -1 ? trimmed : trimmed.substring(0, firstSpace);
    const rest = firstSpace === -1 ? "" : trimmed.substring(firstSpace + 1);
    const values: string[] = [];
    let i = 0;
    while (i < rest.length) {
        while (i < rest.length && rest[i] === " ") i++;
        if (i >= rest.length) break;
        if (rest[i] === '"') {
            i++;
            let out = "";
            while (i < rest.length && rest[i] !== '"') {
                if (rest[i] === "\\" && i + 1 < rest.length) {
                    out += rest[i + 1]; i += 2;
                } else {
                    out += rest[i]; i++;
                }
            }
            values.push(out);
            if (i < rest.length) i++;
        } else {
            const start = i;
            while (i < rest.length && rest[i] !== " ") i++;
            values.push(rest.substring(start, i));
        }
    }
    return { path, values };
}

/** X32 dB-string to number: "-oo" → -Infinity, "+3.3" → 3.3, "-44" → -44. */
export function parseX32Db(s: string): number {
    if (s === "-oo" || s === "-∞") return -Infinity;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
}

/** X32 frequency shorthand to Hz: "3k48" → 3480, "12k" → 12000, "500" → 500. */
export function parseX32Freq(s: string): number {
    const m = s.match(/^(\d+)k(\d*)$/);
    if (m) {
        const thousands = parseInt(m[1], 10) * 1000;
        if (m[2] === "") return thousands;
        const sub = parseInt(m[2], 10) * Math.pow(10, 3 - m[2].length);
        return thousands + sub;
    }
    return parseFloat(s);
}

/** X32 bitmask string "%01011010" to integer. */
export function parseX32Bitmask(s: string): number {
    if (s.startsWith("%")) return parseInt(s.substring(1), 2);
    return parseInt(s, 10);
}

/** X32 boolean: "ON"/"OFF" → true/false. */
export function parseX32Bool(s: string): boolean {
    return s === "ON" || s === "TRUE" || s === "1";
}

/** Encode a JS value for the /  (X32node write) command. Strings with whitespace get quoted. */
function encodeWriteValue(v: any): string {
    if (typeof v === "boolean") return v ? "ON" : "OFF";
    if (typeof v === "number") {
        if (v === -Infinity) return "-oo";
        return String(v);
    }
    const s = String(v);
    if (s === "" || /[\s"]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
    return s;
}

/**
 * Coerce a JS value to the correct JS type for osc-js's inference.
 * osc-js picks OSC type tag from JS type: integer number -> 'i', decimal -> 'f', string -> 's', bool -> 'T'/'F'.
 * If `osctype` is given, we force the conversion; otherwise we parse-through:
 *  - string "6" + osctype "int" => 6
 *  - string "0.5" + osctype "float" => 0.5
 *  - number 6 with no osctype => 6 (int)
 *  - number 0.5 with no osctype => 0.5 (float)
 *
 * Critical for X32: `/config/color`, `/config/icon`, `/config/chlink`, scene recall, etc. all require int type.
 * LLMs often pass ints as JSON strings when schemas are loose — this lets callers force the right tag.
 */
export function coerceOscArg(v: any, osctype?: "int" | "float" | "string" | "bool"): any {
    if (osctype === "int") {
        const n = typeof v === "number" ? Math.trunc(v) : parseInt(String(v), 10);
        if (Number.isNaN(n)) throw new Error(`Cannot coerce ${JSON.stringify(v)} to int`);
        // ensure integer for osc-js isInt() check (n % 1 === 0)
        return n;
    }
    if (osctype === "float") {
        const n = typeof v === "number" ? v : parseFloat(String(v));
        if (Number.isNaN(n)) throw new Error(`Cannot coerce ${JSON.stringify(v)} to float`);
        // osc-js isFloat requires n % 1 !== 0; force a fractional component if whole
        return Number.isInteger(n) ? n + 0.0000001 : n;
    }
    if (osctype === "string") return String(v);
    if (osctype === "bool") {
        if (typeof v === "boolean") return v;
        const s = String(v).toLowerCase();
        return s === "true" || s === "1" || s === "on";
    }
    // No explicit type — pass through; osc-js will infer from JS type.
    return v;
}

// ========== Routing source encoders/decoders ==========
// Confirmed against live X32 (firmware 2.07+) on 2026-04-14.
// Probe data: slot 27 source 129 => X32-Edit label "Card 01" => 129-160 = Card 1-32.

/**
 * Decode a User In slot source code to a human label.
 * Domain: /config/userrout/in/NN (0..168).
 */
export function decodeUserInSource(n: number): string {
    if (n === 0) return "OFF";
    if (n >= 1 && n <= 32) return `Local ${n}`;
    if (n >= 33 && n <= 80) return `AES50A ${n - 32}`;
    if (n >= 81 && n <= 128) return `AES50B ${n - 80}`;
    if (n >= 129 && n <= 160) return `Card ${n - 128}`;
    if (n >= 161 && n <= 168) return `AUX In ${n - 160}`;
    return `UNKNOWN(${n})`;
}

/**
 * Encode a human label back to a User In source code.
 * Accepts labels like "Card 1", "Local 27", "AES50A 5", "AES50B 12", "AUX In 3", "OFF".
 * Case-insensitive, tolerant of extra spaces.
 */
export function encodeUserInSource(label: string | number): number {
    if (typeof label === "number") return label;
    const s = label.trim().toUpperCase().replace(/\s+/g, " ");
    if (s === "OFF" || s === "0") return 0;
    const m = s.match(/^(LOCAL|AES50A|AES50B|CARD|AUX IN|AUX)\s*(\d+)$/);
    if (!m) throw new Error(`Cannot parse User In source label: "${label}". Expected e.g. "Card 1", "Local 27", "AES50A 5", "OFF".`);
    const kind = m[1];
    const n = parseInt(m[2], 10);
    if (kind === "LOCAL") {
        if (n < 1 || n > 32) throw new Error(`Local out of range: ${n}`);
        return n;
    }
    if (kind === "AES50A") {
        if (n < 1 || n > 48) throw new Error(`AES50A out of range: ${n}`);
        return 32 + n;
    }
    if (kind === "AES50B") {
        if (n < 1 || n > 48) throw new Error(`AES50B out of range: ${n}`);
        return 80 + n;
    }
    if (kind === "CARD") {
        if (n < 1 || n > 32) throw new Error(`Card out of range: ${n}`);
        return 128 + n;
    }
    // AUX IN / AUX
    if (n < 1 || n > 8) throw new Error(`AUX In out of range: ${n}`);
    return 160 + n;
}

/**
 * Decode a block-level routing selector (the 8-channel block value).
 * Used by /config/routing/IN/*, /config/routing/AES50A/*, /config/routing/AES50B/*, /config/routing/CARD/*.
 * Each block represents 8 channels; the value selects which source group feeds that block.
 * Confirmed on live hardware: IN 1-8=20..IN 25-32=23 => User In 1-8..25-32.
 */
export function decodeBlockInSource(n: number): string {
    if (n >= 0 && n <= 3) return `Local ${n * 8 + 1}-${n * 8 + 8}`;
    if (n >= 4 && n <= 9) return `AES50A ${(n - 4) * 8 + 1}-${(n - 4) * 8 + 8}`;
    if (n >= 10 && n <= 15) return `AES50B ${(n - 10) * 8 + 1}-${(n - 10) * 8 + 8}`;
    if (n >= 16 && n <= 19) return `Card ${(n - 16) * 8 + 1}-${(n - 16) * 8 + 8}`;
    if (n >= 20 && n <= 23) return `User In ${(n - 20) * 8 + 1}-${(n - 20) * 8 + 8}`;
    if (n === 24) return "AUX In 1-6 / TB / USB";
    return `UNKNOWN(${n})`;
}

/**
 * Decode a User Out slot source code (output tap selection).
 * Note: this enum is less fully verified than User In. Identity mapping (slot 1-32 = source 1-32)
 * was observed on the live mixer, which matches the pmaillot spec for Out 1-32 taps,
 * but ranges above 32 are best-effort and should be verified before relied upon.
 */
export function decodeUserOutSource(n: number): string {
    if (n === 0) return "OFF";
    if (n >= 1 && n <= 16) return `Out ${n} (Local)`;
    if (n >= 17 && n <= 32) return `Out ${n}`;
    if (n >= 33 && n <= 48) return `P16 ${n - 32}`;
    if (n >= 49 && n <= 50) return n === 49 ? "Monitor L" : "Monitor R";
    return `UNKNOWN(${n}) — see X32 OSC spec, not fully verified`;
}

type RawReply = { address: string; args: any[]; raw: string };

export class OSCClient {
    private osc: any;
    private host: string;
    private port: number;
    private responseCallbacks: Map<string, (value: any) => void> = new Map();
    private isConnected: boolean = false;

    // Parallel UDP socket for X32node traffic.
    // Reasons we can't reuse the osc-js socket:
    //   1. X32 /node replies land on address "node" (no leading slash). osc-js's OSC parser
    //      validates addresses and silently drops these, so the "*" listener never fires.
    //   2. /xinfo replies carry 4 string args, but existing sendAndReceive only surfaces args[0].
    // This socket speaks raw OSC via a hand-rolled parser so we can see everything.
    private rawSock: dgram.Socket | null = null;
    private rawInflight: {
        matchAddr: (a: string) => boolean;
        resolve: (r: RawReply) => void;
        reject: (e: Error) => void;
        timer: NodeJS.Timeout;
    } | null = null;
    private rawQueue: Array<() => void> = [];

    constructor(host: string, port: number) {
        this.host = host;
        this.port = port;

        // Create OSC instance with UDP plugin
        const plugin = new (OSC as any).DatagramPlugin({
            open: {
                host: "0.0.0.0",
                port: 0,
            },
            send: {
                host: this.host,
                port: this.port,
            },
        });

        this.osc = new (OSC as any)({
            plugin: plugin,
        });

        // Handle incoming OSC messages
        this.osc.on("*", (message: any) => {
            const address = message.address;
            const callback = this.responseCallbacks.get(address);

            if (callback && message.args && message.args.length > 0) {
                callback(message.args[0]);
                this.responseCallbacks.delete(address);
            }
        });

        this.osc.on("error", (err: Error) => {
            console.error("OSC Error:", err);
        });
    }

    async connect(): Promise<void> {
        this.osc.open({ host: "0.0.0.0", port: 0 });
        this.isConnected = true;
        console.error("OSC UDP Port ready");

        this.sendCommand("/xremote");
        setInterval(() => this.sendCommand("/xremote"), 9000);

        this.rawSock = dgram.createSocket("udp4");
        this.rawSock.on("message", (buf) => this._handleRawReply(buf));
        this.rawSock.on("error", (e) => console.error("rawSock error:", e));
        await new Promise<void>((resolve) => {
            this.rawSock!.bind(0, "0.0.0.0", () => resolve());
        });
        console.error("Raw OSC socket bound on port", this.rawSock!.address().port);
    }

    private _handleRawReply(buf: Buffer): void {
        try {
            const readCString = (off: number) => {
                let end = off;
                while (end < buf.length && buf[end] !== 0) end++;
                const s = buf.subarray(off, end).toString("utf8");
                const padded = Math.ceil((end - off + 1) / 4) * 4;
                return { s, next: off + padded };
            };
            const a = readCString(0);
            const t = readCString(a.next);
            if (!t.s.startsWith(",")) return;
            let off = t.next;
            const args: any[] = [];
            let raw = "";
            for (let i = 1; i < t.s.length; i++) {
                const tag = t.s[i];
                if (tag === "s") {
                    const v = readCString(off);
                    args.push(v.s);
                    if (i === 1) raw = v.s;
                    off = v.next;
                } else if (tag === "i") {
                    args.push(buf.readInt32BE(off)); off += 4;
                } else if (tag === "f") {
                    args.push(buf.readFloatBE(off)); off += 4;
                } else if (tag === "T") { args.push(true); }
                else if (tag === "F") { args.push(false); }
                else { break; }
            }
            if (!this.rawInflight) return;
            if (!this.rawInflight.matchAddr(a.s)) return;
            const inflight = this.rawInflight;
            this.rawInflight = null;
            clearTimeout(inflight.timer);
            inflight.resolve({ address: a.s, args, raw });
            const next = this.rawQueue.shift();
            if (next) next();
        } catch {
            // ignore malformed packets
        }
    }

    private _buildOscMessage(address: string, ...args: any[]): Buffer {
        const m = args.length
            ? new (OSC as any).Message(address, ...args)
            : new (OSC as any).Message(address);
        return Buffer.from(m.pack());
    }

    /**
     * Send a raw OSC message and wait for a matching reply on this.rawSock.
     * Serialized — one in-flight at a time per client. Returns { address, args, raw }.
     * @param matchAddr filter for the expected reply address (e.g. "node", "/xinfo").
     */
    private rawQuery(
        sendAddress: string,
        sendArgs: any[],
        matchAddr: (a: string) => boolean,
        timeoutMs: number = 1000,
    ): Promise<RawReply> {
        if (!this.rawSock) throw new Error("rawSock not initialized — call connect() first");
        return new Promise((resolve, reject) => {
            const fire = () => {
                const buf = this._buildOscMessage(sendAddress, ...sendArgs);
                const timer = setTimeout(() => {
                    if (this.rawInflight && this.rawInflight.resolve === resolve) {
                        this.rawInflight = null;
                        reject(new Error(`Timeout: ${sendAddress} ${JSON.stringify(sendArgs)}`));
                        const next = this.rawQueue.shift();
                        if (next) next();
                    }
                }, timeoutMs);
                this.rawInflight = { matchAddr, resolve, reject, timer };
                this.rawSock!.send(buf, this.port, this.host);
            };
            if (this.rawInflight) {
                this.rawQueue.push(fire);
            } else {
                fire();
            }
        });
    }

    // ========== X32node primitives ==========

    /**
     * Request an X32 "node" — a bundle of related parameters at a given path.
     * Valid paths are enumerated in the pmaillot spec (e.g. ch/NN/config, ch/NN/mix,
     * ch/NN/eq/B, ch/NN/mix/BB, headamp/NNN, bus/NN/mix, main/st/eq, etc.).
     * Not recursive: one call returns one node's values.
     *
     * Returns { path, raw, values } where `values` is the tokenized space-delimited list
     * (quoted strings unwrapped). Callers decode individual tokens using parseX32Db/
     * parseX32Freq/parseX32Bitmask/parseX32Bool as appropriate for the node's schema.
     */
    async nodeRead(path: string): Promise<{ path: string; raw: string; values: string[] }> {
        const clean = path.replace(/^\/+/, "");
        const reply = await this.rawQuery("/node", [clean], (a) => a === "node");
        const text = String(reply.args[0] ?? "");
        const parsed = parseNodeLine(text);
        return { path: parsed.path, raw: text, values: parsed.values };
    }

    /**
     * Write multiple fields of an X32 node atomically using the `/` (X32node) command.
     * The X32 parses the text, applies all listed values in one pass, and echoes the
     * command back for flow control.
     *
     * Values are provided as a positional array matching the node's field order from the
     * spec. The spec allows PREFIX-PARTIAL writes — you can send fewer values than the
     * node has, but the ones you send must be in order from the first field.
     *
     * Strings containing whitespace or empty strings are automatically quoted.
     * Booleans become ON/OFF. -Infinity becomes "-oo".
     *
     * Fires-and-forgets: the mixer will echo the command on address "/" but we do not
     * wait for it. Use nodeRead to verify after.
     */
    async nodeWrite(path: string, values: any[]): Promise<void> {
        if (!this.rawSock) throw new Error("rawSock not initialized");
        const clean = path.replace(/^\/+/, "");
        const encoded = values.map(encodeWriteValue).join(" ");
        const arg = `${clean} ${encoded}`;
        const buf = this._buildOscMessage("/", arg);
        this.rawSock.send(buf, this.port, this.host);
    }

    // ========== Schema-driven node access (Phase D) ==========

    /**
     * Read a single field of a node by name, decoded per the node-schema entry.
     * Pass `field` undefined to get the whole node as a {name: value, ...} dict.
     * Throws if no schema entry matches the path or if the field name is unknown.
     */
    async nodeGetField(path: string, field?: string): Promise<any> {
        const schema = findSchema(path);
        if (!schema) {
            throw new Error(`No schema entry for path "${path}". Use osc_list_nodes to enumerate.`);
        }
        const node = await this.nodeRead(path);
        if (field === undefined || field === null || field === "") {
            const out: Record<string, any> = {};
            for (let i = 0; i < schema.fields.length; i++) {
                const f = schema.fields[i];
                const raw = node.values[i];
                out[f.name] = raw === undefined ? null : decodeField(f, raw);
            }
            return out;
        }
        const idx = schema.fields.findIndex((f) => f.name === field);
        if (idx === -1) {
            const valid = schema.fields.map((f) => f.name).join(", ");
            throw new Error(`Field "${field}" not in schema for "${path}". Valid: ${valid}`);
        }
        const raw = node.values[idx];
        if (raw === undefined) return null;
        return decodeField(schema.fields[idx], raw);
    }

    /**
     * Atomically write multiple named fields of a node.
     * Reads current values to fill in untouched positions, splices in the named
     * overrides preserving order, encodes per type, and sends one /(X32node) write.
     * Returns the list of fields that were written and the encoded values.
     */
    async nodeSetField(
        path: string,
        fields: Record<string, any>,
    ): Promise<{ wrote: string[]; sent: any[] }> {
        const schema = findSchema(path);
        if (!schema) {
            throw new Error(`No schema entry for path "${path}". Use osc_list_nodes to enumerate.`);
        }
        if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
            throw new Error(`fields must be an object {fieldName: value, ...} — got ${typeof fields}`);
        }
        const fieldNames = Object.keys(fields);
        if (fieldNames.length === 0) return { wrote: [], sent: [] };
        const valid = schema.fields.map((f) => f.name);
        const unknown = fieldNames.filter((k) => !valid.includes(k));
        if (unknown.length > 0) {
            throw new Error(`Unknown fields for "${path}": ${unknown.join(", ")}. Valid: ${valid.join(", ")}`);
        }

        // We need positional values up through the highest-index field touched.
        // Untouched leading/middle slots are preserved by reading current state and
        // re-encoding through the schema (so e.g. db tokens like "-oo" round-trip).
        const current = await this.nodeRead(path);
        let lastIdx = -1;
        for (let i = 0; i < schema.fields.length; i++) {
            if (schema.fields[i].name in fields) lastIdx = i;
        }
        const sent: any[] = [];
        for (let i = 0; i <= lastIdx; i++) {
            const f = schema.fields[i];
            if (f.name in fields) {
                sent.push(encodeFieldValue(f, fields[f.name]));
            } else {
                const raw = current.values[i];
                // For untouched fields, decode then re-encode so the JS value goes
                // through the same path (no double-quoting, -oo handled, etc.).
                if (raw === undefined) {
                    // /node didn't return this slot — bail rather than guessing.
                    throw new Error(`Cannot fill untouched field "${f.name}" of "${path}": current /node response had no value at position ${i}`);
                }
                sent.push(encodeFieldValue(f, decodeField(f, raw)));
            }
        }
        await this.nodeWrite(path, sent);
        return { wrote: fieldNames, sent };
    }

    /** Return the schema, optionally filtered by glob pattern (e.g. "ch/*&zwj;/gate", "config/*"). */
    listNodeSchemas(filter?: string): NodeSchemaEntry[] {
        return listSchemasImpl(filter);
    }

    /** Total number of canonical node entries in the schema. */
    nodeSchemaCount(): number {
        return NODE_SCHEMA.length;
    }

    /**
     * Identity block: combined /xinfo + /status read in compact form.
     * /xinfo returns [ip, name, model, firmware]; /status returns [state, ip, name].
     */
    async getIdentity(): Promise<{ model: string; firmware: string; ip: string; name: string; state: string }> {
        const xinfo = await this.rawQuery("/xinfo", [], (a) => a === "/xinfo");
        const status = await this.rawQuery("/status", [], (a) => a === "/status");
        return {
            ip: String(xinfo.args[0] ?? ""),
            name: String(xinfo.args[1] ?? ""),
            model: String(xinfo.args[2] ?? ""),
            firmware: String(xinfo.args[3] ?? ""),
            state: String(status.args[0] ?? ""),
        };
    }

    private sendCommand(address: string, args?: any[]): void {
        if (!this.isConnected) {
            console.error("OSC not connected");
            return;
        }

        const message = new (OSC as any).Message(address, ...(args || []));
        this.osc.send(message);
    }

    private async sendAndReceive(address: string, args?: any[]): Promise<any> {
        return new Promise((resolve, reject) => {
            this.responseCallbacks.set(address, resolve);
            this.sendCommand(address, args);

            // Timeout after 1 second
            setTimeout(() => {
                if (this.responseCallbacks.has(address)) {
                    this.responseCallbacks.delete(address);
                    reject(new Error(`Timeout waiting for response from ${address}`));
                }
            }, 1000);
        });
    }

    private getChannelPath(channel: number): string {
        return `/ch/${channel.toString().padStart(2, "0")}`;
    }

    private getBusPath(bus: number): string {
        return `/bus/${bus.toString().padStart(2, "0")}`;
    }

    private getAuxPath(aux: number): string {
        return `/aux/${aux.toString().padStart(2, "0")}`;
    }

    // ========== Channel Controls ==========

    async setFader(channel: number, level: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/fader`;
        this.sendCommand(path, [level]);
    }

    async getFader(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/mix/fader`;
        return await this.sendAndReceive(path);
    }

    async muteChannel(channel: number, mute: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/on`;
        // Mixer uses 1 for ON (unmuted) and 0 for OFF (muted)
        this.sendCommand(path, [mute ? 0 : 1]);
    }

    async getMute(channel: number): Promise<boolean> {
        const path = `${this.getChannelPath(channel)}/mix/on`;
        const value = await this.sendAndReceive(path);
        return value === 0;
    }

    async setPan(channel: number, pan: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/pan`;
        // Convert -1 to 1 range to 0 to 1 range (0 = left, 0.5 = center, 1 = right)
        const mixerPan = (pan + 1) / 2;
        this.sendCommand(path, [mixerPan]);
    }

    async getPan(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/mix/pan`;
        const value = await this.sendAndReceive(path);
        // Convert 0-1 range to -1 to 1 range
        return value * 2 - 1;
    }

    async setChannelName(channel: number, name: string): Promise<void> {
        const path = `${this.getChannelPath(channel)}/config/name`;
        this.sendCommand(path, [name]);
    }

    async getChannelName(channel: number): Promise<string> {
        const path = `${this.getChannelPath(channel)}/config/name`;
        return await this.sendAndReceive(path);
    }

    async setChannelColor(channel: number, color: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/config/color`;
        this.sendCommand(path, [color]);
    }

    async getChannelColor(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/config/color`;
        return await this.sendAndReceive(path);
    }

    async setChannelIcon(channel: number, icon: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/config/icon`;
        this.sendCommand(path, [icon]);
    }

    async getChannelIcon(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/config/icon`;
        return await this.sendAndReceive(path);
    }

    // Channel linking is per-pair. Addresses: /config/chlink/1-2, 3-4, ... 31-32.
    // Each returns int 0 (unlinked) or 1 (linked).
    async getChannelLinks(): Promise<Array<{ pair: string; linked: boolean }>> {
        const result: Array<{ pair: string; linked: boolean }> = [];
        for (let i = 1; i <= 31; i += 2) {
            const pair = `${i}-${i + 1}`;
            const v = await this.safeRead(`/config/chlink/${pair}`);
            result.push({ pair, linked: v === 1 });
        }
        return result;
    }

    async setChannelLink(pair: string, linked: boolean): Promise<void> {
        this.sendCommand(`/config/chlink/${pair}`, [linked ? 1 : 0]);
    }

    async getBusLinks(): Promise<Array<{ pair: string; linked: boolean }>> {
        const result: Array<{ pair: string; linked: boolean }> = [];
        for (let i = 1; i <= 15; i += 2) {
            const pair = `${i}-${i + 1}`;
            const v = await this.safeRead(`/config/buslink/${pair}`);
            result.push({ pair, linked: v === 1 });
        }
        return result;
    }

    async setBusLink(pair: string, linked: boolean): Promise<void> {
        this.sendCommand(`/config/buslink/${pair}`, [linked ? 1 : 0]);
    }

    // Read a block-level input routing assignment (8-ch group).
    async getRoutingBlockIn(block: string): Promise<{ raw: number; label: string } | null> {
        const raw = await this.safeRead(`/config/routing/IN/${block}`);
        if (raw === null) return null;
        return { raw, label: decodeBlockInSource(raw) };
    }

    // ========== EQ Controls ==========

    async setEQ(channel: number, band: number, gain: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/g`;
        // Convert dB to mixer range (0.0 to 1.0, where 0.5 is 0dB)
        const mixerGain = (gain + 15) / 30; // -15dB to +15dB mapped to 0-1
        this.sendCommand(path, [mixerGain]);
    }

    async getEQ(channel: number, band: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/g`;
        const value = await this.sendAndReceive(path);
        // Convert mixer range to dB
        return value * 30 - 15;
    }

    async getEQFrequency(channel: number, band: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/f`;
        return await this.sendAndReceive(path);
    }

    async setEQFrequency(channel: number, band: number, frequency: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/f`;
        this.sendCommand(path, [frequency]);
    }

    async getEQQ(channel: number, band: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/q`;
        return await this.sendAndReceive(path);
    }

    async setEQQ(channel: number, band: number, q: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/q`;
        this.sendCommand(path, [q]);
    }

    async getEQType(channel: number, band: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/type`;
        return await this.sendAndReceive(path);
    }

    async setEQType(channel: number, band: number, type: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/${band}/type`;
        this.sendCommand(path, [type]);
    }

    async getEQOn(channel: number): Promise<boolean> {
        const path = `${this.getChannelPath(channel)}/eq/on`;
        const value = await this.sendAndReceive(path);
        return value === 1;
    }

    async setEQOn(channel: number, on: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/eq/on`;
        this.sendCommand(path, [on ? 1 : 0]);
    }

    // ========== Dynamics Controls ==========

    async setGate(channel: number, threshold: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/thr`;
        // Convert dB to mixer range
        const mixerThreshold = (threshold + 80) / 80; // -80dB to 0dB mapped to 0-1
        this.sendCommand(path, [mixerThreshold]);
    }

    async getGate(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/gate/thr`;
        const value = await this.sendAndReceive(path);
        return value * 80 - 80;
    }

    async setGateRange(channel: number, range: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/range`;
        this.sendCommand(path, [range]);
    }

    async setGateAttack(channel: number, attack: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/attack`;
        this.sendCommand(path, [attack]);
    }

    async setGateHold(channel: number, hold: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/hold`;
        this.sendCommand(path, [hold]);
    }

    async setGateRelease(channel: number, release: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/release`;
        this.sendCommand(path, [release]);
    }

    async setGateOn(channel: number, on: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/gate/on`;
        this.sendCommand(path, [on ? 1 : 0]);
    }

    async setCompressor(
        channel: number,
        threshold: number,
        ratio: number
    ): Promise<void> {
        const thrPath = `${this.getChannelPath(channel)}/dyn/thr`;
        const ratioPath = `${this.getChannelPath(channel)}/dyn/ratio`;

        // Convert threshold dB to mixer range
        const mixerThreshold = (threshold + 60) / 60; // -60dB to 0dB mapped to 0-1
        this.sendCommand(thrPath, [mixerThreshold]);

        // Convert ratio to mixer range
        const mixerRatio = (ratio - 1) / 19; // 1:1 to 20:1 mapped to 0-1
        this.sendCommand(ratioPath, [mixerRatio]);
    }

    async setCompressorAttack(channel: number, attack: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/attack`;
        this.sendCommand(path, [attack]);
    }

    async setCompressorRelease(channel: number, release: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/release`;
        this.sendCommand(path, [release]);
    }

    async setCompressorKnee(channel: number, knee: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/knee`;
        this.sendCommand(path, [knee]);
    }

    async setCompressorGain(channel: number, gain: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/gain`;
        this.sendCommand(path, [gain]);
    }

    async setCompressorOn(channel: number, on: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/dyn/on`;
        this.sendCommand(path, [on ? 1 : 0]);
    }

    // ========== Bus Controls ==========

    async setBusFader(bus: number, level: number): Promise<void> {
        const path = `${this.getBusPath(bus)}/mix/fader`;
        this.sendCommand(path, [level]);
    }

    async getBusFader(bus: number): Promise<number> {
        const path = `${this.getBusPath(bus)}/mix/fader`;
        return await this.sendAndReceive(path);
    }

    async muteBus(bus: number, mute: boolean): Promise<void> {
        const path = `${this.getBusPath(bus)}/mix/on`;
        this.sendCommand(path, [mute ? 0 : 1]);
    }

    async setBusPan(bus: number, pan: number): Promise<void> {
        const path = `${this.getBusPath(bus)}/mix/pan`;
        const mixerPan = (pan + 1) / 2;
        this.sendCommand(path, [mixerPan]);
    }

    async setBusName(bus: number, name: string): Promise<void> {
        const path = `${this.getBusPath(bus)}/config/name`;
        this.sendCommand(path, [name]);
    }

    // ========== Aux Controls ==========

    async setAuxFader(aux: number, level: number): Promise<void> {
        const path = `${this.getAuxPath(aux)}/mix/fader`;
        this.sendCommand(path, [level]);
    }

    async getAuxFader(aux: number): Promise<number> {
        const path = `${this.getAuxPath(aux)}/mix/fader`;
        return await this.sendAndReceive(path);
    }

    async muteAux(aux: number, mute: boolean): Promise<void> {
        const path = `${this.getAuxPath(aux)}/mix/on`;
        this.sendCommand(path, [mute ? 0 : 1]);
    }

    async setAuxPan(aux: number, pan: number): Promise<void> {
        const path = `${this.getAuxPath(aux)}/mix/pan`;
        const mixerPan = (pan + 1) / 2;
        this.sendCommand(path, [mixerPan]);
    }

    // ========== Sends ==========

    async sendToBus(channel: number, bus: number, level: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/${bus.toString().padStart(2, "0")}/level`;
        this.sendCommand(path, [level]);
    }

    async getSendToBus(channel: number, bus: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/mix/${bus.toString().padStart(2, "0")}/level`;
        return await this.sendAndReceive(path);
    }

    async sendToAux(channel: number, aux: number, level: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/${(aux + 15).toString().padStart(2, "0")}/level`;
        this.sendCommand(path, [level]);
    }

    async setSendPrePost(channel: number, bus: number, pre: boolean): Promise<void> {
        const path = `${this.getChannelPath(channel)}/mix/${bus.toString().padStart(2, "0")}/preamp`;
        this.sendCommand(path, [pre ? 1 : 0]);
    }

    // ========== Main Mix ==========

    async setMainFader(level: number): Promise<void> {
        this.sendCommand("/main/st/mix/fader", [level]);
    }

    async getMainFader(): Promise<number> {
        return await this.sendAndReceive("/main/st/mix/fader");
    }

    async muteMain(mute: boolean): Promise<void> {
        this.sendCommand("/main/st/mix/on", [mute ? 0 : 1]);
    }

    async setMainPan(pan: number): Promise<void> {
        const path = "/main/st/mix/pan";
        const mixerPan = (pan + 1) / 2;
        this.sendCommand(path, [mixerPan]);
    }

    // ========== Matrix ==========

    async setMatrixFader(matrix: number, level: number): Promise<void> {
        const path = `/mtx/${matrix.toString().padStart(2, "0")}/mix/fader`;
        this.sendCommand(path, [level]);
    }

    async muteMatrix(matrix: number, mute: boolean): Promise<void> {
        const path = `/mtx/${matrix.toString().padStart(2, "0")}/mix/on`;
        this.sendCommand(path, [mute ? 0 : 1]);
    }

    // ========== Effects ==========

    private getFxPath(effect: number): string {
        return `/fx/${effect}`;
    }

    async getEffectType(effect: number): Promise<number> {
        return await this.sendAndReceive(`${this.getFxPath(effect)}/type`);
    }

    // NOTE: X32 has no /fx/N/on or /fx/N/mix addresses. FX slots are always
    // instantiated; "on/off" is controlled by whether the FX return fader/mute
    // is up, and wet/dry is an internal FX parameter (varies by algorithm).
    // Use getFxReturnStrip() to check if an FX is effectively active.

    async setEffectOn(effect: number, on: boolean): Promise<void> {
        // Rewired: mute/unmute the corresponding FX return channel
        const fxrPath = `/fxrtn/${effect.toString().padStart(2, "0")}/mix/on`;
        this.sendCommand(fxrPath, [on ? 1 : 0]);
    }

    async getEffectOn(effect: number): Promise<boolean> {
        // Rewired: read the FX return channel mute state
        const fxrPath = `/fxrtn/${effect.toString().padStart(2, "0")}/mix/on`;
        const value = await this.sendAndReceive(fxrPath);
        return value === 1;
    }

    async setEffectParam(effect: number, param: number, value: number): Promise<void> {
        this.sendCommand(`${this.getFxPath(effect)}/par/${param.toString().padStart(2, "0")}`, [value]);
    }

    async getEffectParam(effect: number, param: number): Promise<number> {
        return await this.sendAndReceive(`${this.getFxPath(effect)}/par/${param.toString().padStart(2, "0")}`);
    }

    // ========== Routing ==========

    async setChannelSource(channel: number, source: number): Promise<void> {
        const path = `${this.getChannelPath(channel)}/config/source`;
        this.sendCommand(path, [source]);
    }

    async getChannelSource(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/config/source`;
        return await this.sendAndReceive(path);
    }

    // ========== Scenes ==========

    async recallScene(scene: number): Promise<void> {
        const path = `/-snap/load`;
        this.sendCommand(path, [scene - 1]); // Mixer scenes are 0-indexed
    }

    async saveScene(scene: number, name?: string): Promise<void> {
        const path = `/-snap/store`;
        this.sendCommand(path, [scene - 1]);
        if (name) {
            const namePath = `/-snap/${(scene - 1).toString().padStart(3, "0")}/name`;
            this.sendCommand(namePath, [name]);
        }
    }

    async getSceneName(scene: number): Promise<string> {
        const path = `/-snap/${(scene - 1).toString().padStart(3, "0")}/name`;
        return await this.sendAndReceive(path);
    }

    // ========== Meters ==========

    async getChannelMeter(channel: number): Promise<number> {
        const path = `${this.getChannelPath(channel)}/mix/fader`;
        // Note: Meters are typically sent automatically by the mixer
        // This is a placeholder - actual meter data comes via /meters
        return await this.sendAndReceive(path);
    }

    // ========== Status ==========

    async getMixerStatus(): Promise<any> {
        try {
            const info = await this.sendAndReceive("/info");
            const status = await this.sendAndReceive("/status");

            return {
                connected: true,
                host: this.host,
                port: this.port,
                info,
                status,
            };
        } catch (error) {
            return {
                connected: false,
                host: this.host,
                port: this.port,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    // ========== Bulk Reads ==========

    private async safeRead(address: string): Promise<any> {
        try { return await this.sendAndReceive(address); } catch { return null; }
    }

    private async readEQBands(path: string, bands: number = 4): Promise<any> {
        const eqOn = await this.safeRead(`${path}/eq/on`);
        const eq: any[] = [];
        for (let b = 1; b <= bands; b++) {
            eq.push({
                band: b,
                gain: await this.safeRead(`${path}/eq/${b}/g`),
                freq: await this.safeRead(`${path}/eq/${b}/f`),
                q: await this.safeRead(`${path}/eq/${b}/q`),
                type: await this.safeRead(`${path}/eq/${b}/type`),
            });
        }
        return { eqOn: eqOn === 1, eq };
    }

    /**
     * Read a full channel strip via /node. Replaces ~87 serial leaf reads with 26 /node calls.
     * Values are in NATIVE UNITS from the /node text format (dB, Hz, enum strings, booleans),
     * which is a deliberate change from the pre-rewrite normalized-0..1 floats — native units
     * are what the scene audit heuristics and LLM prose reason about directly.
     *
     * Field names match the old shape so downstream consumers key by the same names.
     *
     * Node shapes (pmaillot spec, verified against firmware 4.13):
     *  - ch/NN/config: [name, icon, color, source]
     *  - ch/NN/mix:    [on, fader, st, pan, mono, mlevel]
     *  - ch/NN/eq:     [on]
     *  - ch/NN/eq/B:   [type, f, g, q]        B ∈ 1..4
     *  - ch/NN/gate:   [on, mode, thr, range, attack, hold, release, keysrc]
     *  - ch/NN/dyn:    [on, mode, det, env, thr, ratio, knee, mgain, attack, hold, release, pos, keysrc, mix, auto]
     *  - ch/NN/mix/BB: [on, level, pan, type, panFollow] for odd BB (stereo)
     *                  [on, level]                      for even BB
     *  - headamp/NNN:  [gain, phantom]
     */
    async getChannelStrip(channel: number): Promise<any> {
        const nn = channel.toString().padStart(2, "0");
        const result: any = { channel };

        const readOrNull = async (path: string): Promise<{ values: string[] } | null> => {
            try { return await this.nodeRead(path); } catch { return null; }
        };

        const config = await readOrNull(`ch/${nn}/config`);
        const mix = await readOrNull(`ch/${nn}/mix`);
        const eqNode = await readOrNull(`ch/${nn}/eq`);
        const eqBands: Array<{ values: string[] } | null> = [];
        for (let b = 1; b <= 4; b++) eqBands.push(await readOrNull(`ch/${nn}/eq/${b}`));
        const gate = await readOrNull(`ch/${nn}/gate`);
        const dyn = await readOrNull(`ch/${nn}/dyn`);
        const sends: Array<{ values: string[] } | null> = [];
        for (let b = 1; b <= 16; b++) {
            const bb = b.toString().padStart(2, "0");
            sends.push(await readOrNull(`ch/${nn}/mix/${bb}`));
        }

        // config: [name, icon, color, source]
        result.name = config?.values[0] ?? null;
        result.fader = mix ? parseX32Db(mix.values[1]) : null;
        result.on = mix ? parseX32Bool(mix.values[0]) : null;
        result.pan = mix?.values[3] !== undefined ? parseFloat(mix.values[3]) : null;
        result.color = config?.values[2] ?? null;
        result.source = config?.values[3] !== undefined ? parseInt(config.values[3], 10) : null;

        // Headamp (only for local/aes50a source codes 0..63, matching prior behavior).
        // NOTE: /node on an unassigned headamp slot times out, hence readOrNull.
        const src = result.source;
        if (src !== null && Number.isFinite(src) && src >= 0 && src < 64) {
            const ha = await readOrNull(`headamp/${src.toString().padStart(3, "0")}`);
            result.headampGain = ha ? parseX32Db(ha.values[0]) : null;
            result.headampPhantom = ha ? parseX32Bool(ha.values[1]) : null;
        }

        // EQ
        result.eqOn = eqNode ? parseX32Bool(eqNode.values[0]) : null;
        result.eq = eqBands.map((band, i) => ({
            band: i + 1,
            gain: band?.values[2] !== undefined ? parseX32Db(band.values[2]) : null,
            freq: band?.values[1] !== undefined ? parseX32Freq(band.values[1]) : null,
            q: band?.values[3] !== undefined ? parseFloat(band.values[3]) : null,
            type: band?.values[0] ?? null,
        }));

        // Gate: [on, mode, thr, range, attack, hold, release, keysrc]
        result.gateOn = gate ? parseX32Bool(gate.values[0]) : null;
        result.gateThr = gate ? parseX32Db(gate.values[2]) : null;
        result.gateRange = gate?.values[3] !== undefined ? parseFloat(gate.values[3]) : null;
        result.gateAttack = gate?.values[4] !== undefined ? parseFloat(gate.values[4]) : null;
        result.gateHold = gate?.values[5] !== undefined ? parseFloat(gate.values[5]) : null;
        result.gateRelease = gate?.values[6] !== undefined ? parseFloat(gate.values[6]) : null;

        // Dyn: [on, mode, det, env, thr, ratio, knee, mgain, attack, hold, release, pos, keysrc, mix, auto]
        result.dynOn = dyn ? parseX32Bool(dyn.values[0]) : null;
        result.dynThr = dyn ? parseX32Db(dyn.values[4]) : null;
        result.dynRatio = dyn?.values[5] !== undefined ? parseFloat(dyn.values[5]) : null;
        result.dynKnee = dyn?.values[6] !== undefined ? parseFloat(dyn.values[6]) : null;
        result.dynGain = dyn?.values[7] !== undefined ? parseX32Db(dyn.values[7]) : null;
        result.dynAttack = dyn?.values[8] !== undefined ? parseFloat(dyn.values[8]) : null;
        result.dynRelease = dyn?.values[10] !== undefined ? parseFloat(dyn.values[10]) : null;

        // Sends: odd buses (stereo-linked) have [on, level, pan, type, panFollow]; even have [on, level].
        result.sends = sends.map((send, i) => {
            const bus = i + 1;
            if (!send) return { bus, level: null, pan: null, type: null };
            return {
                bus,
                level: send.values[1] !== undefined ? parseX32Db(send.values[1]) : null,
                pan: send.values[2] !== undefined ? parseFloat(send.values[2]) : null,
                type: send.values[3] ?? null,
            };
        });

        return result;
    }

    async getBusStrip(bus: number): Promise<any> {
        const path = this.getBusPath(bus);
        const result: any = { bus };

        result.name = await this.safeRead(`${path}/config/name`);
        result.fader = await this.safeRead(`${path}/mix/fader`);
        result.on = (await this.safeRead(`${path}/mix/on`)) === 1;
        result.pan = await this.safeRead(`${path}/mix/pan`);
        result.color = await this.safeRead(`${path}/config/color`);

        const eqData = await this.readEQBands(path, 4);
        result.eqOn = eqData.eqOn;
        result.eq = eqData.eq;

        // Dynamics
        result.dynOn = (await this.safeRead(`${path}/dyn/on`)) === 1;
        result.dynThr = await this.safeRead(`${path}/dyn/thr`);
        result.dynRatio = await this.safeRead(`${path}/dyn/ratio`);

        return result;
    }

    async getAuxStrip(aux: number): Promise<any> {
        const path = `/auxin/${aux.toString().padStart(2, "0")}`;
        const result: any = { aux };

        result.name = await this.safeRead(`${path}/config/name`);
        result.fader = await this.safeRead(`${path}/mix/fader`);
        result.on = (await this.safeRead(`${path}/mix/on`)) === 1;
        result.pan = await this.safeRead(`${path}/mix/pan`);
        result.color = await this.safeRead(`${path}/config/color`);
        result.source = await this.safeRead(`${path}/config/source`);

        return result;
    }

    async getFxReturnStrip(fxr: number): Promise<any> {
        const path = `/fxrtn/${fxr.toString().padStart(2, "0")}`;
        const result: any = { fxReturn: fxr };

        result.name = await this.safeRead(`${path}/config/name`);
        result.fader = await this.safeRead(`${path}/mix/fader`);
        result.on = (await this.safeRead(`${path}/mix/on`)) === 1;
        result.pan = await this.safeRead(`${path}/mix/pan`);
        result.color = await this.safeRead(`${path}/config/color`);

        return result;
    }

    async getMatrixStrip(mtx: number): Promise<any> {
        const path = `/mtx/${mtx.toString().padStart(2, "0")}`;
        const result: any = { matrix: mtx };

        result.name = await this.safeRead(`${path}/config/name`);
        result.fader = await this.safeRead(`${path}/mix/fader`);
        result.on = (await this.safeRead(`${path}/mix/on`)) === 1;
        result.pan = await this.safeRead(`${path}/mix/pan`);

        const eqData = await this.readEQBands(path, 4);
        result.eqOn = eqData.eqOn;
        result.eq = eqData.eq;

        return result;
    }

    async getDCA(dca: number): Promise<any> {
        const path = `/dca/${dca}`;
        const result: any = { dca };

        result.name = await this.safeRead(`${path}/config/name`);
        result.fader = await this.safeRead(`${path}/fader`);
        result.on = (await this.safeRead(`${path}/on`)) === 1;
        result.color = await this.safeRead(`${path}/config/color`);

        return result;
    }

    async getMainStrip(): Promise<any> {
        const result: any = { type: "main_stereo" };

        result.fader = await this.safeRead("/main/st/mix/fader");
        result.on = (await this.safeRead("/main/st/mix/on")) === 1;
        result.pan = await this.safeRead("/main/st/mix/pan");

        const eqData = await this.readEQBands("/main/st", 6);
        result.eqOn = eqData.eqOn;
        result.eq = eqData.eq;

        // Dynamics
        result.dynOn = (await this.safeRead("/main/st/dyn/on")) === 1;
        result.dynThr = await this.safeRead("/main/st/dyn/thr");
        result.dynRatio = await this.safeRead("/main/st/dyn/ratio");

        // Mono bus
        result.mono = {
            fader: await this.safeRead("/main/m/mix/fader"),
            on: (await this.safeRead("/main/m/mix/on")) === 1,
        };

        return result;
    }

    async getHeadamp(index: number): Promise<any> {
        const path = `/headamp/${index.toString().padStart(3, "0")}`;
        return {
            index,
            gain: await this.safeRead(`${path}/gain`),
            phantom: (await this.safeRead(`${path}/phantom`)) === 1,
        };
    }

    async getConsoleOverview(): Promise<any> {
        const overview: any = {};

        // All 32 channels - name, fader, mute only for speed
        overview.channels = [];
        for (let ch = 1; ch <= 32; ch++) {
            const path = this.getChannelPath(ch);
            overview.channels.push({
                ch,
                name: await this.safeRead(`${path}/config/name`),
                fader: await this.safeRead(`${path}/mix/fader`),
                on: (await this.safeRead(`${path}/mix/on`)) === 1,
            });
        }

        // 16 mix buses
        overview.buses = [];
        for (let b = 1; b <= 16; b++) {
            const path = this.getBusPath(b);
            overview.buses.push({
                bus: b,
                name: await this.safeRead(`${path}/config/name`),
                fader: await this.safeRead(`${path}/mix/fader`),
                on: (await this.safeRead(`${path}/mix/on`)) === 1,
            });
        }

        // 8 DCA groups
        overview.dcas = [];
        for (let d = 1; d <= 8; d++) {
            overview.dcas.push({
                dca: d,
                name: await this.safeRead(`/dca/${d}/config/name`),
                fader: await this.safeRead(`/dca/${d}/fader`),
                on: (await this.safeRead(`/dca/${d}/on`)) === 1,
            });
        }

        // 6 matrices
        overview.matrices = [];
        for (let m = 1; m <= 6; m++) {
            const path = `/mtx/${m.toString().padStart(2, "0")}`;
            overview.matrices.push({
                matrix: m,
                name: await this.safeRead(`${path}/config/name`),
                fader: await this.safeRead(`${path}/mix/fader`),
                on: (await this.safeRead(`${path}/mix/on`)) === 1,
            });
        }

        // 8 aux inputs
        overview.auxInputs = [];
        for (let a = 1; a <= 8; a++) {
            const path = `/auxin/${a.toString().padStart(2, "0")}`;
            overview.auxInputs.push({
                aux: a,
                name: await this.safeRead(`${path}/config/name`),
                fader: await this.safeRead(`${path}/mix/fader`),
                on: (await this.safeRead(`${path}/mix/on`)) === 1,
            });
        }

        // 8 FX returns
        overview.fxReturns = [];
        for (let f = 1; f <= 8; f++) {
            const path = `/fxrtn/${f.toString().padStart(2, "0")}`;
            overview.fxReturns.push({
                fxReturn: f,
                name: await this.safeRead(`${path}/config/name`),
                fader: await this.safeRead(`${path}/mix/fader`),
                on: (await this.safeRead(`${path}/mix/on`)) === 1,
            });
        }

        // 8 FX slots
        overview.fxSlots = [];
        for (let fx = 1; fx <= 8; fx++) {
            overview.fxSlots.push({
                slot: fx,
                type: await this.safeRead(`/fx/${fx}/type`),
            });
        }

        // Main
        overview.main = {
            fader: await this.safeRead("/main/st/mix/fader"),
            on: (await this.safeRead("/main/st/mix/on")) === 1,
            monoFader: await this.safeRead("/main/m/mix/fader"),
            monoOn: (await this.safeRead("/main/m/mix/on")) === 1,
        };

        return overview;
    }

    async getRouting(): Promise<any> {
        const routing: any = {};

        // FX source assignments (FX 1-4 are stereo insert, 5-8 are dual mono)
        routing.fxSources = [];
        for (let fx = 1; fx <= 4; fx++) {
            routing.fxSources.push({
                slot: fx,
                sourceL: await this.safeRead(`/fx/${fx}/source/l`),
                sourceR: await this.safeRead(`/fx/${fx}/source/r`),
            });
        }
        // FX 5-8 are inserted on channels, different structure
        for (let fx = 5; fx <= 8; fx++) {
            routing.fxSources.push({
                slot: fx,
                source: await this.safeRead(`/fx/${fx}/source`),
            });
        }

        // Output routing blocks
        routing.outputs = {};
        for (const block of ["1-4", "5-8", "9-12", "13-16"]) {
            routing.outputs[`OUT_${block}`] = await this.safeRead(`/config/routing/OUT/${block}`);
        }

        // Input routing blocks (decoded)
        routing.inputs = {};
        for (const block of ["1-8", "9-16", "17-24", "25-32"]) {
            const raw = await this.safeRead(`/config/routing/IN/${block}`);
            routing.inputs[`IN_${block}`] = { raw, label: raw === null ? null : decodeBlockInSource(raw) };
        }

        // AES50 routing (decoded using same block-in enum)
        routing.aes50a = {};
        for (const block of ["1-8", "9-16", "17-24", "25-32", "33-40", "41-48"]) {
            const raw = await this.safeRead(`/config/routing/AES50A/${block}`);
            routing.aes50a[`AES50A_${block}`] = { raw, label: raw === null ? null : decodeBlockInSource(raw) };
        }
        routing.aes50b = {};
        for (const block of ["1-8", "9-16", "17-24", "25-32", "33-40", "41-48"]) {
            const raw = await this.safeRead(`/config/routing/AES50B/${block}`);
            routing.aes50b[`AES50B_${block}`] = { raw, label: raw === null ? null : decodeBlockInSource(raw) };
        }

        // Card routing (decoded)
        routing.card = {};
        for (const block of ["1-8", "9-16", "17-24", "25-32"]) {
            const raw = await this.safeRead(`/config/routing/CARD/${block}`);
            routing.card[`CARD_${block}`] = { raw, label: raw === null ? null : decodeBlockInSource(raw) };
        }

        return routing;
    }

    // User-defined routing (firmware 4.0+): per-slot patches for the "User In"
    // and "User Out" blocks. When a routing block is set to source type
    // "USER IN" / "USER OUT", these tables determine the actual per-channel source.
    /**
     * Single-call summary of ALL routing layers, decoded. Returns:
     *  - inputBlocks: 4 block assignments (which source group feeds each 8-ch range)
     *  - outputBlocks, aes50a, aes50b, card: same structure for other directions
     *  - userIn: 32 per-slot patches (firmware 4.0+ 1:1 routing)
     *  - userOut: 48 per-slot patches
     *
     * Use this FIRST when planning routing changes — it shows the full topology so you can tell
     * whether a channel is patched via block routing (legacy 8-ch groups) or per-slot User In (firmware 4.0+).
     * If an input block shows "User In 25-32", per-channel patches live in userIn[24..31].
     */
    async getRoutingOverview(): Promise<any> {
        const routing = await this.getRouting();
        const userRouting = await this.getUserRouting();
        return {
            summary: "X32 routing topology. Input blocks select which 8-ch source group feeds each channel range. When a block is set to 'User In N-M', the userIn per-slot table determines the actual physical source for each channel in that range.",
            inputBlocks: routing.inputs,
            outputBlocks: routing.outputs,
            aes50a: routing.aes50a,
            aes50b: routing.aes50b,
            card: routing.card,
            userIn: userRouting.userIn,
            userOut: userRouting.userOut,
        };
    }

    async getUserRouting(): Promise<any> {
        const userRouting: any = { userIn: [], userOut: [] };

        for (let slot = 1; slot <= 32; slot++) {
            const source = await this.safeRead(`/config/userrout/in/${slot.toString().padStart(2, "0")}`);
            userRouting.userIn.push({
                slot,
                source,
                sourceLabel: source === null ? null : decodeUserInSource(source),
            });
        }

        for (let slot = 1; slot <= 48; slot++) {
            const source = await this.safeRead(`/config/userrout/out/${slot.toString().padStart(2, "0")}`);
            userRouting.userOut.push({
                slot,
                source,
                sourceLabel: source === null ? null : decodeUserOutSource(source),
            });
        }

        return userRouting;
    }

    /**
     * Set a User In slot's source. Accepts either a raw int (0..168) or a label like "Card 1", "Local 27", "AES50A 5", "OFF".
     */
    async setUserRoutingIn(slot: number, source: number | string): Promise<void> {
        const code = encodeUserInSource(source);
        const path = `/config/userrout/in/${slot.toString().padStart(2, "0")}`;
        this.sendCommand(path, [code]);
    }

    async getUserRoutingIn(slot: number): Promise<{ source: number; sourceLabel: string }> {
        const path = `/config/userrout/in/${slot.toString().padStart(2, "0")}`;
        const source = await this.sendAndReceive(path);
        return { source, sourceLabel: decodeUserInSource(source) };
    }

    async setUserRoutingOut(slot: number, source: number): Promise<void> {
        const path = `/config/userrout/out/${slot.toString().padStart(2, "0")}`;
        this.sendCommand(path, [source]);
    }

    async getUserRoutingOut(slot: number): Promise<{ source: number; sourceLabel: string }> {
        const path = `/config/userrout/out/${slot.toString().padStart(2, "0")}`;
        const source = await this.sendAndReceive(path);
        return { source, sourceLabel: decodeUserOutSource(source) };
    }

    async getFullFxChain(): Promise<any[]> {
        // For each FX slot: type, source assignment, params, and FX return state
        const chains: any[] = [];
        for (let fx = 1; fx <= 8; fx++) {
            const chain: any = { slot: fx };

            // FX type and params
            chain.type = await this.safeRead(`/fx/${fx}/type`);
            chain.params = [];
            for (let p = 1; p <= 16; p++) {
                const val = await this.safeRead(`/fx/${fx}/par/${p.toString().padStart(2, "0")}`);
                if (val !== null) chain.params.push({ param: p, value: val });
            }

            // Source assignment
            if (fx <= 4) {
                chain.sourceL = await this.safeRead(`/fx/${fx}/source/l`);
                chain.sourceR = await this.safeRead(`/fx/${fx}/source/r`);
            } else {
                chain.source = await this.safeRead(`/fx/${fx}/source`);
            }

            // FX return state
            const fxrPath = `/fxrtn/${fx.toString().padStart(2, "0")}`;
            chain.returnFader = await this.safeRead(`${fxrPath}/mix/fader`);
            chain.returnOn = (await this.safeRead(`${fxrPath}/mix/on`)) === 1;
            chain.returnName = await this.safeRead(`${fxrPath}/config/name`);

            chains.push(chain);
        }
        return chains;
    }

    async getAllEffects(): Promise<any[]> {
        const effects: any[] = [];
        for (let fx = 1; fx <= 8; fx++) {
            const slot: any = { slot: fx };
            try { slot.type = await this.getEffectType(fx); } catch { slot.type = null; }
            slot.params = [];
            for (let p = 1; p <= 8; p++) {
                try {
                    const val = await this.getEffectParam(fx, p);
                    slot.params.push({ param: p, value: val });
                } catch {
                    slot.params.push({ param: p, value: null });
                }
            }
            effects.push(slot);
        }
        return effects;
    }

    // ========== Custom Commands ==========

    /**
     * Send a raw OSC command. Supports two modes:
     *  - Write:  pass `value` (and optionally `osctype` = 'int'|'float'|'string'|'bool').
     *            If `osctype` is omitted, type is inferred from the JS value
     *            (integer numbers → int, decimals → float, strings → string, booleans → T/F).
     *            Pass an array of { type, value } to send multiple typed args.
     *  - Read:   omit `value` entirely — sends a query and returns the mixer's reply value (or null on timeout).
     *
     * X32 is strict about OSC type tags: `/config/color` requires int (',i') — sending string '6' is silently dropped.
     * Use `osctype: 'int'` when LLMs may pass values as strings.
     */
    async sendCustomCommand(
        address: string,
        value?: any,
        osctype?: "int" | "float" | "string" | "bool",
    ): Promise<any> {
        // Read mode
        if (value === undefined) {
            try {
                return await this.sendAndReceive(address);
            } catch {
                return null;
            }
        }

        // Typed multi-arg: value is an array of { type, value } entries
        if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object" && value[0] !== null && "type" in value[0]) {
            const packed = value.map((entry: any) => coerceOscArg(entry.value, entry.type));
            this.sendCommand(address, packed);
            return;
        }

        // Single value, optional explicit type
        const args = Array.isArray(value) ? value : [value];
        const packed = args.map((v: any) => coerceOscArg(v, osctype));
        this.sendCommand(address, packed);
    }

    close(): void {
        this.isConnected = false;
        this.osc.close();
        if (this.rawSock) {
            try { this.rawSock.close(); } catch { /* socket already closed */ }
            this.rawSock = null;
        }
    }
}
