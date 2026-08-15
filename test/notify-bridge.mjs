// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// test/notify-bridge.mjs — the invalidation bridge (W2, redesign §2.5-C).
//
// `subscriptions/listen` is an INVALIDATION primitive, so what has to stay true is narrow and
// exact: the right notification for the right change, nothing at all for the plane MCP does not
// model, one flush per burst, and — the part that only a machine will keep — a subscription that
// dies with its connection. Engines are per-connection and the store's emitter is not, so a
// bridge that forgets to let go is a listener writing into a closed transport for the life of
// the process, once per reconnect, past the emitter's ceiling.
//
// Run: node test/notify-bridge.mjs
import { EventEmitter } from "node:events";
import { bridgeInvalidations } from "../src/notify.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, note) => (cond
  ? (pass++, console.log("  ✓ " + name))
  : (fail++, console.log("  ✗ " + name + (note ? "\n      " + note : ""))));
const tick = () => new Promise((r) => setTimeout(r, 0));

function rig({ dynamicTools = false, apps = [], failing = false } = {}) {
  const sent = [];
  const known = new Set(apps);
  const send = (label) => (arg) => {
    sent.push(arg ? `${label}:${arg.uri}` : label);
    return failing ? Promise.reject(new Error("Not connected")) : Promise.resolve();
  };
  const store = { events: new EventEmitter() };
  const server = { server: {
    sendResourceListChanged: send("resources_list_changed"),
    sendToolListChanged: send("tools_list_changed"),
    sendResourceUpdated: send("resource_updated"),
    onclose: undefined,
  } };
  const release = bridgeInvalidations(store, server, { dynamicTools, hasApp: (n) => known.has(n) });
  const change = (type, name) => store.events.emit("change", { seq: 1, type, name });
  return { sent, store, server, release, change, known };
}

console.log("1. the mapping — the right invalidation, or none at all");
{
  const r = rig({ apps: ["notes"] });
  r.change("save_app", "notes");
  await tick();
  ok("a re-save invalidates that ONE resource, not the list",
    r.sent.join() === "resource_updated:ui://open-mcp-apps/notes.html", r.sent.join());

  const r2 = rig({ apps: [] });
  r2.change("save_app", "brand-new");
  await tick();
  // Decided at EMIT time on purpose: the store emits inside execute(), and the tool handler calls
  // registerApp on the next line, so by flush time every first save looks like an existing one.
  ok("a FIRST save invalidates the list (the resource did not exist yet)",
    r2.sent.join() === "resources_list_changed", r2.sent.join());

  for (const [type, label] of [["delete_app", "delete"], ["archive_app", "archive"]]) {
    const r3 = rig({ apps: ["gone"] });
    r3.change(type, "gone");
    await tick();
    ok(`${label} invalidates the list`, r3.sent.join() === "resources_list_changed", r3.sent.join());
  }
}

console.log("\n2. the data plane is SILENT — and that is the design, not a gap");
{
  const r = rig({ apps: ["notes"] });
  // No MCP resource models a collection, so there is nothing on the host to invalidate. The
  // widget poll and data_changes own this plane. If a resource per collection is ever minted,
  // this test is where the decision gets revisited — deliberately, not by a stray notification.
  for (const t of ["add_item", "update_item", "move_item", "delete_item", "write_file", "delete_file"]) r.change(t, "");
  await tick();
  ok("six data/file writes produce no notification at all", r.sent.length === 0, r.sent.join());
  r.change("save_app", "notes");
  await tick();
  ok("…while the very next app write still does", r.sent.length === 1);
}

console.log("\n3. a burst costs ONE flush per kind");
{
  const r = rig({ apps: ["a", "b"] });
  for (let i = 0; i < 20; i++) r.change("save_app", "a");
  r.change("save_app", "b");
  for (let i = 0; i < 5; i++) r.change("delete_app", "c");
  await tick();
  const counts = r.sent.reduce((m, s) => (m[s.split(":")[0]] = (m[s.split(":")[0]] || 0) + 1, m), {});
  ok("26 events fold into one list invalidation and one update per distinct URI",
    counts.resources_list_changed === 1 && counts.resource_updated === 2, JSON.stringify(counts));
  const before = r.sent.length;
  await tick();
  ok("a quiet tick sends nothing (the pending set really was cleared)", r.sent.length === before);
}

console.log("\n4. tools/list_changed is opt-in — the prompt cache is not collateral");
{
  const off = rig({ apps: [] });
  off.change("save_app", "x");
  await tick();
  ok("with the per-app openers OFF, the tool surface is never declared changed",
    !off.sent.includes("tools_list_changed"), off.sent.join());
  const on = rig({ apps: [], dynamicTools: true });
  on.change("save_app", "x");
  await tick();
  ok("…and WITH them on, it is — because then the surface really did move",
    on.sent.includes("tools_list_changed") && on.sent.includes("resources_list_changed"), on.sent.join());
}

console.log("\n5. ownership — the bridge dies with its connection");
{
  const r = rig({ apps: ["notes"] });
  ok("one listener while live", r.store.events.listenerCount("change") === 1);
  r.release();
  ok("none after release", r.store.events.listenerCount("change") === 0);
  r.change("save_app", "notes");
  await tick();
  ok("a released bridge sends nothing", r.sent.length === 0, r.sent.join());

  // The shape that actually bites: N reconnects over one process-wide store.
  const store = { events: new EventEmitter() };
  const releases = [];
  for (let i = 0; i < 150; i++) {
    const server = { server: { sendResourceListChanged: () => {}, sendToolListChanged: () => {}, sendResourceUpdated: () => {} } };
    releases.push(bridgeInvalidations(store, server, { hasApp: () => false }));
    releases.at(-1)();   // …each connection ending as the next begins
  }
  ok("150 connect/disconnect cycles leave no listener behind (the emitter ceiling is 100)",
    store.events.listenerCount("change") === 0, String(store.events.listenerCount("change")));
  ok("releasing twice is harmless", (() => { releases[0](); return store.events.listenerCount("change") === 0; })());
}

console.log("\n6. a send that fails takes nothing down with it");
{
  const r = rig({ apps: [], failing: true });   // every sender rejects: "Not connected"
  r.change("save_app", "x");
  r.change("save_app", "y");
  await tick();
  await tick();
  ok("rejected sends are swallowed — an engine with no transport is ordinary, not an error",
    r.sent.length >= 1);
  // An unhandled rejection here would kill the host process on a store write nobody asked about.
  ok("…and nothing is left unhandled (the suite would have crashed above)", true);

  const half = bridgeInvalidations({ events: null }, { server: {} }, {});
  ok("a store with no event bus yields a no-op disposer, not a throw", typeof half === "function");
  half();
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILED"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
