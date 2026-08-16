// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/capabilities.mjs — every bit the engine declares at initialize is a promise; this suite
// makes each one land somewhere. Run: node test/capabilities.mjs
//
// WHY A SUITE FOR A DOZEN BOOLEANS. Two of them were false for a long time without any test going
// red, and both in the same way: a capability object is a set of claims about VERBS, and nothing
// else in the suite ever calls the verb the claim is about.
//   · `resources.subscribe: true` was declared from the first release, and `resources/subscribe`
//     answered -32601 Method not found on every legacy wire era the SDK negotiates. Every shipping
//     host today speaks a legacy era. Measured 2026-08-16.
//   · `tools.listChanged` was written as a CONDITIONAL declaration (`...(dynamicTools ? {…} : {})`),
//     meant to say `true` only when the per-app openers are on. It said `true` in every mode: an
//     ABSENT key is not `false` to the SDK — registering a tool makes it fill the bit with `?? true`.
//     The comment above that line described a behaviour that had never once been observed.
// So the shape here is: connect, read what was declared, then EXERCISE what was declared, on the
// wire era shipping hosts use — and separately confirm the modern era's replacement verb exists.
// Every call carries a timeout: a suite that can HANG on a missing handler is a suite nobody
// waits for, and the one long-lived verb here (`subscriptions/listen`) hangs BY DESIGN when it
// works — §4 says how that is told apart from a verb nobody serves.
import { z } from "zod";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB = join(ROOT, "test", "capabilities.db");
for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (detail ? `\n      ${detail}` : "")); }
};

// A ui:// URI that exists once the seeds are in — any seeded app will do; habit-streaks ships.
const URI = "ui://open-mcp-apps/habit-streaks.html";
const connect = async (dynamicTools, clientOpts = {}) => {
  const client = new Client({ name: "capabilities", version: "1.0.0" }, clientOpts);
  await client.connect(new StdioClientTransport({
    command: "node",
    args: [join(ROOT, "src", "server.mjs")],
    env: { ...process.env, OMA_DB: DB, OMA_HOST: "capabilities", OMA_VIEWER: "0",
      OMA_DYNAMIC_TOOLS: dynamicTools ? "1" : "" },
  }));
  return client;
};
const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, code: e?.code, message: String(e?.message ?? e) }; } };

console.log("1. tools.listChanged says what the mode does — off");
{
  const c = await connect(false);
  const caps = c.getServerCapabilities();
  // With the per-app openers OFF the tool surface is fixed for the life of the process, and the
  // declaration must say so. Pinned as an exact object: a missing key would be filled in as
  // `true` by the SDK, which is precisely the failure this line exists to catch.
  ok("OMA_DYNAMIC_TOOLS off ⇒ tools: {listChanged: false}",
    JSON.stringify(caps?.tools) === JSON.stringify({ listChanged: false }),
    `declared ${JSON.stringify(caps?.tools)} — a fixed surface must not invite re-listing`);
  await c.close();
}

console.log("2. tools.listChanged says what the mode does — on");
{
  const c = await connect(true);
  const caps = c.getServerCapabilities();
  ok("OMA_DYNAMIC_TOOLS on ⇒ tools: {listChanged: true}",
    JSON.stringify(caps?.tools) === JSON.stringify({ listChanged: true }),
    `declared ${JSON.stringify(caps?.tools)} — with per-app openers the surface DOES move on save_app`);
  await c.close();
}

console.log("3. resources.subscribe is honoured on the legacy wire (what shipping hosts speak)");
{
  const c = await connect(false);
  const caps = c.getServerCapabilities();
  ok("resources: {subscribe: true, listChanged: true} declared",
    JSON.stringify(caps?.resources) === JSON.stringify({ subscribe: true, listChanged: true }),
    `declared ${JSON.stringify(caps?.resources)}`);
  const sub = await attempt(() => c.subscribeResource({ uri: URI }));
  ok("resources/subscribe is answered (not -32601)", sub.ok, `${sub.code ?? ""} ${sub.message ?? ""}`);
  const unsub = await attempt(() => c.unsubscribeResource({ uri: URI }));
  ok("resources/unsubscribe is answered (not -32601)", unsub.ok, `${unsub.code ?? ""} ${unsub.message ?? ""}`);
  // The other half of the same bit: `listChanged: true` on resources is a claim the engine can
  // send `notifications/resources/list_changed`. It does — bridgeInvalidations fires it on every
  // app-plane write — and the SDK refuses to send it unless `resources` is declared at all, so
  // the presence check above is what keeps that sender alive. Nothing further to exercise here
  // without a write; server-smoke covers the write path.
  await c.close();
}

console.log("4. the modern wire replaces the verb, and the replacement exists");
{
  // Pinned 2026-07-28: `resources/subscribe` is gone from that era by design and
  // `subscriptions/listen` is what the same declared bit entitles a client to. Both facts are
  // asserted: the old verb must be refused BY ERA (not by absence), the new one must be routed.
  const c = await connect(false, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const old = await attempt(() => c.subscribeResource({ uri: URI }));
  ok("resources/subscribe refused by era on 2026-07-28 (not -32601)",
    !old.ok && old.code === "METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION",
    `${old.code ?? ""} ${old.message ?? ""}`);
  // `subscriptions/listen` is a LONG-LIVED request by design: an accepted filter answers only when
  // the subscription is cancelled, so a well-formed listen that is being served never resolves.
  // That is why this uses a short timeout and reads the timeout as the pass: an unrouted verb
  // fails instantly with -32601 (measured 1 ms), a malformed filter fails instantly with -32602,
  // and only a routed, accepted subscription sits there. Three outcomes, three different answers.
  const listen = await attempt(() => c.request(
    { method: "subscriptions/listen", params: { notifications: { resourceSubscriptions: [URI] } } },
    z.any(), { timeout: 1500 }));
  const routed = listen.ok
    || /timed out|timeout/i.test(listen.message ?? "")
    || (listen.code !== -32601 && !/Method not found/.test(listen.message ?? ""));
  ok("subscriptions/listen is routed and accepts our URI (held open, not refused)",
    routed && !/-32601|Method not found|Invalid params/.test(`${listen.code ?? ""} ${listen.message ?? ""}`),
    `${listen.code ?? ""} ${listen.message ?? ""}`);
  await c.close();
}

console.log("5. prompts.listChanged is the explicit false, both eras");
{
  // Already pinned by test/prompt-surface.mjs on the legacy wire; repeated here because this
  // suite is the one place that reads the WHOLE capability object, and a reader should not need
  // two files to learn what the engine declares.
  for (const [label, opts] of [["legacy", {}], ["2026-07-28", { versionNegotiation: { mode: { pin: "2026-07-28" } } }]]) {
    const c = await connect(false, opts);
    ok(`${label}: prompts: {listChanged: false}`,
      JSON.stringify(c.getServerCapabilities()?.prompts) === JSON.stringify({ listChanged: false }));
    await c.close();
  }
}

for (const f of [DB, DB + "-wal", DB + "-shm"]) if (existsSync(f)) unlinkSync(f);
console.log(`\ncapabilities: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
