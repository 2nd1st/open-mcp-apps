// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// tools/screen.mjs — the screen relay (2026-10-01; on by default since 2026-10-05): the AI uses the app the user
// has open the way the user would — reads the screen, presses the thing — instead of calling a
// function the app author had to expose. "Show me Thursday" is a tap, not an API.
//
// Why a relay: MCP Apps lets a view offer tools to the host (tools/list on the view), and the
// runtime first offered screen_read / screen_act there — but measured 2026-10-01, neither
// claude.ai nor ChatGPT web hands view tools to the model (Claude never even sent tools/list), so
// the runtime stopped declaring them. The model-facing half (screen_read / screen_act) lives
// here, on the server every host already reaches, and the open widget long-polls `screen_poll`
// (app-only) to receive the job and send back the screen it produced.
//
// The cooperative upgrade rides the same relay: an app that registers its own tools
// (oma.tools.register — ext-apps draft "App-provided tools") has them listed at the top of
// screen_read, and screen_act {tool, input} runs one. One verb for "do it in the app", whether
// the way in is a control or a function the app named; the relay is the stand-in for the native
// Host→View tools/call until a host sends it (the runtime answers that road itself).
//
// Sessions are in-process and keyed per store: a widget is "on screen" while it keeps polling.

import { z } from "zod";

const POLL_HOLD_MS = 20_000;      // how long a widget's poll waits for a job
const LIVE_MS = POLL_HOLD_MS + 15_000;   // a widget that has not polled in this long is gone
const JOB_WAIT_MS = 15_000;       // how long the model's call waits for the widget to finish

const registries = new WeakMap();
function registryFor(store) {
  let r = registries.get(store);
  if (!r) registries.set(store, (r = { sessions: new Map(), jobs: new Map(), seq: 0 }));
  return r;
}

export function register(ctx) {
  const { server, store, hostName } = ctx;
  const reg = registryFor(store);

  // Which widget a call means: the one the user was on LAST — whatever host it is in. The user
  // looks at one thing at a time, so "the latest" is the answer, not a guess: an app rendered in
  // ChatGPT and then talked about in Claude is the same app, and driving it from either is the
  // point (the UI is the user's, not the chat's). "Latest" = the most recent of: rendered, went
  // fullscreen, touched by the user — acts on ONE widget. Page visibility is not one of them: it
  // belongs to the page, so a tab coming back flips every widget in it at once, scrolled-off old
  // cards included (measured 2026-10-02: the job went to a background ChatGPT tab). It neither
  // ranks nor gates — an occluded window reads as hidden too — it only adds the "not in view"
  // note to the result. (Host names were tried first and dropped: one host names itself
  // differently per channel — "Anthropic/ClaudeAI" vs "claude-ai" — and a table of hosts cannot
  // know every host there is.)
  const live = () => [...reg.sessions.values()].filter((s) => Date.now() - s.seen < LIVE_MS);
  const pick = (app) => live().filter((s) => !app || !s.app || s.app === app).sort((a, b) => (b.active || 0) - (a.active || 0))[0];
  const text = (t, isError) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

  const send = async (app, job) => {
    const s = pick(app);
    console.error(`[oma] screen ${job.tool ? "tool" : job.action || "act"} ${job.tool || job.ref || job.label || ""} host=${hostName() || "?"} → ${s ? s.id + "@" + (s.host || "?") : "none"} · live ${live().map((x) => x.id + "@" + (x.host || "?")).join(",")}`);
    if (!s) return text(`No app is open on screen${app ? ` as "${app}"` : ""} right now. Open one with open_app first.`, true);
    const id = "j" + ++reg.seq;
    const done = new Promise((resolve) => {
      const timer = setTimeout(() => { reg.jobs.delete(id); resolve(null); }, JOB_WAIT_MS);
      reg.jobs.set(id, (r) => { clearTimeout(timer); reg.jobs.delete(id); resolve(r); });
    });
    const full = { id, ...job };
    if (s.waiter) { const w = s.waiter; s.waiter = null; w(full); } else s.queue.push(full);
    const r = await done;
    if (!r) return text(`The app "${s.app}" did not answer in time — it may have been closed.`, true);
    const note = s.visible ? "" : "\n\n(The app is not in view right now — the user may not see this change until they bring it back.)";
    return text((r.text || "(empty screen)") + note, !!r.isError);
  };
  const appArg = z.string().optional().describe("which open app (default: the one the user is on)");

  server.registerTool(
    "screen_read",
    {
      title: "Read the app on screen",
      annotations: { readOnlyHint: true, openWorldHint: false },
      description: "What the user is looking at in the app they have open: its text, every control they could press or fill (each with a ref like r3), and the app's own tools if it has any. Use it when the user talks about what is on screen (\"what's on Thursday?\", \"that one\").",
      inputSchema: { app: appArg },
    },
    (a) => send(a.app, { action: "read" }),
  );

  server.registerTool(
    "screen_act",
    {
      title: "Use the app on screen",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      description: "Do what the user would do in the app they have open: press a control, or fill/select a value (ref from screen_read, or the control's visible label) — or call one of the app's own tools that screen_read lists (tool + input). The user watches it happen; returns the screen after a press, the tool's answer after a call. \"Show me Thursday\" is an action in the app, not a data query.",
      inputSchema: {
        ref: z.string().optional().describe("control ref from screen_read, e.g. r3"),
        label: z.string().optional().describe("the control's visible label, if you have no ref"),
        action: z.enum(["press", "fill", "select"]).optional().describe("default: fill for text inputs, select for dropdowns, press otherwise"),
        value: z.string().optional().describe("for fill / select"),
        tool: z.string().optional().describe("one of the app's own tools, from screen_read"),
        input: z.record(z.string(), z.unknown()).optional().describe("the tool's arguments"),
        app: appArg,
      },
    },
    (a) => send(a.app, a.tool ? { tool: a.tool, input: a.input || {} } : { action: a.action, ref: a.ref, label: a.label, value: a.value }),
  );

  server.registerTool(
    "screen_poll",
    {
      title: "Screen relay (internal)",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      description: "Internal (app-only): the open app's long poll for screen jobs.",
      inputSchema: {
        session: z.string(),
        app: z.string().optional(),
        visible: z.boolean().optional(),
        display: z.string().optional(),
        born: z.number().optional(),
        touched: z.number().optional(),
        ping: z.boolean().optional(),   // state update only: returns at once, the waiting poll stays
        done: z.object({ id: z.string(), text: z.string(), isError: z.boolean().optional() }).optional(),
      },
    },
    async (a) => {
      if (a.done) { const fin = reg.jobs.get(a.done.id); if (fin) fin(a.done); }
      let s = reg.sessions.get(a.session);
      if (!s) {
        reg.sessions.set(a.session, (s = { id: a.session, app: "", host: hostName(), seen: 0, queue: [], waiter: null }));
        console.error(`[oma] screen widget connected ${a.session} host=${s.host || "?"} app=${a.app || "-"} visible=${a.visible} display=${a.display || "-"}`);
      }
      if (a.done) console.error(`[oma] screen ${a.session} finished ${a.done.id}${a.done.isError ? " (error)" : ""}`);
      if (a.ping) console.error(`[oma] screen ${a.session} ping visible=${a.visible} display=${a.display || "-"}`);
      // "active" moves when the USER moves this widget: rendered, fullscreened, touched.
      const now = Date.now();
      if (!s.active) s.active = a.born || now;
      if (a.display === "fullscreen" && s.display !== "fullscreen") s.active = now;
      if (a.touched && a.touched > (s.touched || 0)) s.active = Math.max(s.active, a.touched);
      s.seen = now;
      for (const k of ["app", "visible", "display", "born", "touched"]) if (a[k] !== undefined) s[k] = a[k];
      if (a.ping) return { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } };
      if (s.waiter) { const w = s.waiter; s.waiter = null; w(null); }   // a newer poll supersedes
      const job = s.queue.shift() || await new Promise((resolve) => {
        const waiter = (j) => { clearTimeout(timer); resolve(j); };
        const timer = setTimeout(() => { if (s.waiter === waiter) s.waiter = null; resolve(null); }, POLL_HOLD_MS);
        s.waiter = waiter;
      });
      s.seen = Date.now();
      return { content: [{ type: "text", text: job ? JSON.stringify(job) : "idle" }], structuredContent: job ? { job } : { idle: true } };
    },
  );
}
