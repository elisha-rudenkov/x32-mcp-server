// Live-state-mirror integration test. Drives the COMPILED dist/ OSCClient in-process
// against the fake X32 responder. Run: `npm test` (build first).
//
// Asserts:
//   1. second read of the same container is served from cache (fake request count unchanged)
//   2. a pushed leaf change invalidates the container -> next read hits the wire, fresh data
//   3. the change feed reports the pushed change with source "console"
//   4. our own nodeSet invalidates + records the change with source "server"
//   5. OSC_NO_CACHE=1 bypasses serving (every read hits the wire)

import { FakeX32 } from "./fake-x32.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  PASS: ${name}`);
    } else {
        failures++;
        console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

async function main() {
    // Import the compiled client (proves the build is wired correctly).
    const { OSCClient } = await import("../dist/osc-client.js");

    const fake = new FakeX32();
    const port = await fake.start(0);
    console.log(`fake X32 listening on 127.0.0.1:${port}`);

    // Seed the container the tests read. ch/01/mix schema: on, fader, st, pan, mono, mlevel.
    fake.setNode("ch/01/mix", ["ON", "-10", "OFF", "0", "OFF", "-oo"]);

    const client = new OSCClient("127.0.0.1", port);
    await client.connect();
    await sleep(120); // let /xremote register the subscriber

    check("fake registered our /xremote subscription", fake.getSubscriberCount() >= 1, `subs=${fake.getSubscriberCount()}`);

    // ---- Test 1: cache hit ----
    console.log("\n[1] container read cache");
    const r1 = await client.nodeRead("ch/01/mix");
    const wireAfterFirst = fake.getCount("ch/01/mix");
    const r2 = await client.nodeRead("ch/01/mix");
    const wireAfterSecond = fake.getCount("ch/01/mix");
    check("first read reached the wire", wireAfterFirst === 1, `count=${wireAfterFirst}`);
    check("second read served from cache (no new wire request)", wireAfterSecond === 1, `count=${wireAfterSecond}`);
    check("cached read returns identical data", r1.raw === r2.raw, `"${r1.raw}" vs "${r2.raw}"`);
    check("cache stats show a hit", client.getCacheStats().hits >= 1, JSON.stringify(client.getCacheStats()));

    // ---- Test 2: pushed change invalidates -> fresh wire read ----
    console.log("\n[2] xremote push invalidates cache");
    const rawBefore = r2.raw;
    fake.pushChange("/ch/01/mix/fader", 0.5, { containerPath: "ch/01/mix", index: 1, token: "-5" });
    await sleep(120); // let the push arrive + handler run
    const invalidationsAfterPush = client.getCacheStats().invalidations;
    check("push produced a cache invalidation", invalidationsAfterPush >= 1, `invalidations=${invalidationsAfterPush}`);
    const r3 = await client.nodeRead("ch/01/mix");
    const wireAfterPush = fake.getCount("ch/01/mix");
    check("post-invalidation read hit the wire again", wireAfterPush === 2, `count=${wireAfterPush}`);
    check("post-invalidation read returns fresh data", r3.raw !== rawBefore && r3.raw.includes("-5"), `"${r3.raw}"`);

    // ---- Test 3: change feed reports the console push ----
    console.log("\n[3] change feed (source console)");
    const feed = client.getChanges({ sinceSeconds: 60 });
    const consoleRow = feed.changes.find((c) => c.address === "/ch/01/mix/fader");
    check("feed contains the pushed leaf", !!consoleRow, JSON.stringify(feed.changes));
    check("pushed change is tagged source 'console'", consoleRow?.source === "console", consoleRow?.source);
    check("default feed excludes server writes", feed.changes.every((c) => c.source === "console"), JSON.stringify(feed.changes));

    // ---- Test 4: our own write invalidates + records source server ----
    console.log("\n[4] server write invalidates + records");
    // Re-read to re-populate the cache first, so we can prove the write clears it.
    await client.nodeRead("ch/01/mix");
    const invBeforeWrite = client.getCacheStats().invalidations;
    await client.nodeSetField("ch/01/mix", { fader: -3 });
    await sleep(30);
    const invAfterWrite = client.getCacheStats().invalidations;
    check("nodeSet invalidated the container", invAfterWrite > invBeforeWrite, `${invBeforeWrite} -> ${invAfterWrite}`);
    const wireBeforeReadback = fake.getCount("ch/01/mix");
    await client.nodeRead("ch/01/mix");
    check("read after write hit the wire (cache was cleared)", fake.getCount("ch/01/mix") === wireBeforeReadback + 1, `count=${fake.getCount("ch/01/mix")}`);
    const serverFeed = client.getChanges({ sinceSeconds: 60, includeServer: true });
    const serverRow = serverFeed.changes.find((c) => c.address === "/ch/01/mix" && c.source === "server");
    check("write recorded with source 'server'", !!serverRow, JSON.stringify(serverFeed.changes));
    check("server write hidden unless includeServer", !client.getChanges({ sinceSeconds: 60 }).changes.some((c) => c.source === "server"), "server row leaked into default feed");

    // ---- Test 5: OSC_NO_CACHE bypass ----
    console.log("\n[5] OSC_NO_CACHE=1 bypasses serving");
    process.env.OSC_NO_CACHE = "1";
    const noCacheClient = new OSCClient("127.0.0.1", port);
    await noCacheClient.connect();
    await sleep(60);
    fake.setNode("bus/01/mix", ["ON", "0"]);
    const c0 = fake.getCount("bus/01/mix");
    await noCacheClient.nodeRead("bus/01/mix");
    await noCacheClient.nodeRead("bus/01/mix");
    check("both reads hit the wire (no serving)", fake.getCount("bus/01/mix") === c0 + 2, `count=${fake.getCount("bus/01/mix")}`);
    check("no-cache client reports zero hits", noCacheClient.getCacheStats().hits === 0, JSON.stringify(noCacheClient.getCacheStats()));
    check("no-cache client reports serving:false", noCacheClient.getCacheStats().serving === false, JSON.stringify(noCacheClient.getCacheStats()));
    delete process.env.OSC_NO_CACHE;

    // ---- summary ----
    console.log(`\ncache stats (serving client): ${JSON.stringify(client.getCacheStats())}`);
    fake.close();
    console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error("test-mirror crashed:", e);
    process.exit(1);
});
