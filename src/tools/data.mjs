// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// tools/data.mjs — the generic collection tools: the read and mutation surface every widget shares.
// Registered by engine.mjs. Moved here verbatim: the tool surface is byte-identical to before
// the split, which test/tool-surface.mjs proves against its golden file.

import { z } from "zod";
import { RO, WRITE, DESTRUCTIVE, snapshotSchema, ackSchema, cmdArgs, answer, toMcp, sizeOf, RESULT_BUDGET } from "../contracts.mjs";

export function register(ctx) {
  const { server, store, hostName, run, toResult, toStale, toFull, toPage, toAck, toConflict, toFail, renderItems, failNote, fail } = ctx;

  // ------------------------------------------------------------------ generic data tools

  server.registerTool(
    "data_list",
    {
      title: "List collection data",
      annotations: RO,
      description: "Read items in full — every field, plus the item id you need to update or delete it. No UI (use open_app for that). Returns a PAGE: up to `limit` (default 100) matching items, with `total` and — when more exist — `next_cursor`; returned/total make a short delivery self-evident. `match` filters: a bare value means equals; an object is operators {ne, lt, lte, gt, gte, contains, prefix, exists} (numeric filters compare numerically, strings lexicographically — ISO dates work). Paging is a live keyset walk; items moved mid-page can be skipped or repeated.",
      inputSchema: {
        collection: z.string(),
        group: z.string().optional().describe("only items in this group/lane"),
        match: z.record(z.string(), z.any()).optional().describe("filter on top-level fields, e.g. {\"done\": false} or {\"amount\": {\"gte\": 100}}"),
        limit: z.number().optional().describe("page size (1-500, default 100)"),
        cursor: z.string().optional().describe("opaque cursor from the previous page's next_cursor"),
      },
      outputSchema: {
        ...snapshotSchema,
        group: z.string().optional(),
        returned: z.number().optional(),
        total: z.number().optional().describe("how many items exist (the collection/group, pre-filter) — compare it with the rows you actually received"),
        next_cursor: z.string().nullable().optional().describe("pass back as `cursor` for the next page; null = no more"),
        note: z.string().optional(),
        eot: z.string().optional(),
      },
    },
    async (a) => {
      const r = store.queryItems(a.collection, { group: a.group, match: a.match, limit: a.limit, cursor: a.cursor });
      if (r.error) return fail(r.error === "bad_cursor" ? "Invalid cursor — restart from the first page (omit cursor)."
        : r.error === "unknown_operator" ? `Unknown filter operator(s): ${r.detail}. A bare value means equals; operators are {eq, ne, lt, lte, gt, gte, contains, prefix, exists}.`
        : `Query failed: ${r.error}.`);
      // A page is explicit paging, not truncation: the caller is told N of TOTAL plus how to
      // continue, so it can never mistake the page for the collection. Items render in full — a
      // page that dropped fields would be the silent sample by another name. Rows are caller-sized,
      // so the page also shrinks to the result budget, and the cursor follows the rows that
      // actually shipped — a shrunk page continues exactly where it ended.
      // The version trio comes FROM queryItems' own transaction (a second call could postdate the
      // rows and stamp a torn page); `host` is the runtime's documented oma.host source.
      let items = r.items;
      let next = r.next_cursor;
      let note;
      // A zero-row collection is the cold-start moment, and THIS reply is what the model is looking
      // at when it decides what an empty lookup means. Same rule data_collections' empty state
      // carries; total is pre-filter, so this fires only when truly nothing is stored here.
      // Not for the settings collection: that one is engine-owned — "build the app for it" is
      // wrong advice there, and every widget boot reads it (first seen as noise in a live tap).
      if (r.total === 0 && !a.cursor && a.collection !== "settings")
        note = `Empty is the normal start, not a blocker. If the user is asking about content nothing holds yet, say so in one line, then build or open the app for it in the SAME reply and get rows in: seed what you genuinely know with data_batch, ask them to paste what they have — never invent rows. Sensitive data still needs their one-line yes first.`;
      const bodyOf = (rows) => ({ collection: a.collection, ...(a.group != null ? { group: String(a.group) } : {}),
        items: rows, version: r.version, settings_version: r.settings_version, files_version: r.files_version,
        host: hostName(), ...(note ? { note } : {}) });
      if (sizeOf(bodyOf(items)) > RESULT_BUDGET) {
        let keep = items.length;
        while (keep > 1 && sizeOf(bodyOf(items.slice(0, keep))) > RESULT_BUDGET) keep = Math.ceil(keep / 2);
        if (keep < items.length) {
          items = items.slice(0, keep);
          next = store.cursorAfter(items.at(-1));
          note = `page shrunk to ${keep} row(s) to fit the result budget — continue with next_cursor.`;
        }
      }
      const text = `Collection "${a.collection}"${a.group != null ? ` group "${a.group}"` : ""} — ${items.length} of ${r.total} item(s)${next ? ", more pages (pass next_cursor)" : ""}.\n` +
        (renderItems(items) || "  (none matched)") + (note ? `\n${note}` : "");
      return toMcp(answer.page(bodyOf(items), { returned: items.length, total: r.total, next, text }));
    },
  );

  server.registerTool(
    "data_batch",
    {
      title: "Many writes, one transaction",
      // Idempotent for the same reason the single-write tools are: the batch's command_id gives each
      // command inside it a derived, stable id, so replaying the batch replays nothing. Measured.
      annotations: WRITE,
      description: "Apply up to 200 writes in ONE transaction — for seeding an app from what you already know, or filling a board in one go, instead of one call per row. Each command is exactly what you would send to data_add_item / data_update_item / data_move_item / data_delete_item, as {type, ...args}: type is add_item | update_item | move_item | delete_item. All or nothing: the first failure rolls back everything and names which command failed. The reply is one line per command ({id, seq}) — not the rows, which you already have.",
      inputSchema: {
        ...cmdArgs,
        // The commands are NOT re-declared here, on purpose. They are the same four typed commands the
        // single-write tools already publish, the store validates each one exactly as it would alone,
        // and copying their schemas into this one would mean two places to change and two chances to
        // disagree. The shape is taught once, in get_app_guide.
        commands: z.array(z.record(z.string(), z.any())).describe("[{type: \"add_item\", collection, fields, group?}, {type: \"update_item\", id, fields}, …] — same arguments as the single-write tools"),
      },
      outputSchema: {
        ok: z.boolean(),
        count: z.number().optional(),
        seq: z.number().optional().describe("the batch's last ledger position — pass it to data_changes as `since`"),
        results: z.array(z.object({ id: z.string().optional(), seq: z.number().optional() })).optional(),
        failed_index: z.number().optional(),
        reason: z.string().optional(),
        request_state: z.string().optional(),
        expires_at: z.string().optional(),
        preview: z.string().optional(),
        note: z.string().optional(),
        eot: z.string().optional(),
      },
    },
    async (a) => {
      const host = hostName();
      // One command_id for the batch, derived per command: the batch is one action to the caller and
      // N events in the ledger, so replaying the batch has to be a no-op the same way replaying a
      // single write is. Deriving the per-command ids from the batch's own id keeps that true without
      // asking the caller to generate 200 uuids.
      //
      // No `|| randomUUID()` here, and that absence is the honest one: `cmdArgs` declares
      // command_id as a required string, so a call without one never reaches this line — it comes
      // back "Input validation error: … expected string, received undefined" with nothing applied
      // (measured 2026-08-22). A fallback would be dead code that reads as a promise: anyone
      // writing a client from this source would conclude the key is optional, ship without it, and
      // meet the validator instead. What the tool actually asks for is what the schema says.
      const base = a.command_id;
      const commands = (a.commands || []).map((c, i) => ({
        ...c, command_id: `${base}:${i}`, actor: c.actor || a.actor || "agent", host,
      }));
      const r = store.executeBatch(commands);
      // A confirmation demand inside a batch is not a batch failure — it is the same two-phase
      // flow, reported with the index so the caller knows WHICH command to confirm. Handing it
      // back as a plain isError while dropping the state told the caller to "resend with a
      // request_state" it had never been given (codex review): an instruction that cannot be
      // followed is worse than a refusal. Nothing was applied — the batch is all-or-nothing —
      // so re-sending the whole batch with the state attached to that one command is the retry.
      if (!r.ok && r.failure && r.failure.confirmation_required) {
        const f = r.failure;
        const note = `Command ${r.index} needs the user's confirmation — deleting "${f.preview}". NOTHING was applied. Confirm with the user, then re-send the WHOLE batch with request_state on that command (expires ${f.expires_at}).`;
        return toMcp(answer.ack({ ok: false, reason: "confirmation_required", failed_index: r.index,
          request_state: f.request_state, expires_at: f.expires_at, preview: f.preview, note }, note));
      }
      if (!r.ok) {
        const why = r.error === "batch_failed"
          ? `Command ${r.index} failed (${failNote(r.failure)}) — NOTHING was applied. Fix that one and resend the whole batch.`
          : r.error === "batch_too_large" ? `A batch takes at most ${r.limit} commands; you sent ${r.given}. Send it in chunks.`
          : r.error === "empty_batch" ? "A batch needs at least one command."
          : `Batch failed: ${r.error}.`;
        return toMcp(answer.fail(r.error, { failed_index: r.index }, why), { isError: true });
      }
      // Per command: the id and where it landed on the ledger. Echoing each row back would put the
      // whole write set in the reply — measured at 300 rows that is 2.85x the result budget, so the
      // headline use case would spend its life being truncated. The caller wrote the fields; it has them.
      const results = r.results.map((x) => ({ ...(x.id ? { id: x.id } : {}), ...(x.seq ? { seq: x.seq } : {}) }));
      const last = r.results.at(-1);
      // No `collection` on a batch ack: a batch may span collections, so naming one would be a
      // guess dressed as a fact (prev_collection_seq is off the ack for the same reason — one
      // per-collection mark is ill-defined across collections). `seq` is the batch's LAST ledger
      // position, which is the useful single number — hand it to data_changes as `since`.
      let body = { ok: true, count: r.count, results, seq: last?.seq };
      // Receipts are caller-sized (ids can be long), so the budget is CHECKED, not assumed. Every
      // command was applied either way — a truncated tail of receipts stays recoverable from the
      // ledger, which is more than a silently truncated result could say.
      let shown = results.length;
      if (sizeOf(body) > RESULT_BUDGET) {
        while (shown > 1 && sizeOf({ ...body, results: results.slice(0, shown) }) > RESULT_BUDGET) shown = Math.ceil(shown / 2);
        body = { ...body, results: results.slice(0, shown),
          note: `receipts truncated to the first ${shown} of ${r.count} — every command WAS applied; the rest are on the ledger (data_changes since=${(r.results[0]?.seq ?? 1) - 1}).` };
      }
      // The receipts ride the TEXT channel too: a host that hands the model only content (measured:
      // claude.ai) must not leave it knowing that 50 rows landed but not which ids they got.
      const receipts = results.slice(0, shown).map((x) => `  ${x.id ?? "-"} → v${x.seq}`).join("\n");
      return toMcp(answer.ack(
        body,
        `Applied ${r.count} command(s) in one transaction.` + (receipts ? "\n" + receipts : "") +
          (shown < results.length ? `\n(receipts for the remaining ${results.length - shown} are on the ledger)` : ""),
      ));
    },
  );

  server.registerTool(
    "data_changes",
    {
      title: "What changed since you last looked",
      annotations: RO,
      description: "What happened in a collection after a ledger position YOU hold — including edits the USER made in the widget, which never pass through you. Any mark you already have works as `since`: a write ack's `seq`, data_list's `version`, or the last call's `next_since`. Returns the contiguous run of events right after it (oldest first, whole events: actor, item id, fields) plus `next_since` to continue; omit `since` to just learn the current position.",
      inputSchema: {
        collection: z.string(),
        since: z.number().optional().describe("your held mark — events strictly after this seq; omit to just learn latest_seq"),
        limit: z.number().optional().describe("max events to return (default 50, max 500)"),
      },
      outputSchema: {
        collection: z.string(), since: z.number().optional(), latest_seq: z.number(), next_since: z.number(),
        total: z.number().optional(), returned: z.number().optional(), dropped: z.number().optional(),
        events: z.array(z.record(z.string(), z.any())),
        note: z.string().optional(), eot: z.string().optional(),
      },
    },
    async (a) => {
      // No server-held mark, on purpose: it was keyed by (collection, host) and hostName is not
      // stable (one claude.ai user presents three clientInfo names — measured), on top of two chats
      // on one host sharing it. A mark the CALLER holds is scoped exactly to the conversation that
      // holds it, and a compacted conversation that lost its mark re-anchors here in one call.
      if (a.since == null) {
        const latest = store.dataVersion().seq;
        return toMcp(answer.page(
          { collection: a.collection, latest_seq: latest, next_since: latest, events: [] },
          { returned: 0, text: `Ledger for "${a.collection}" stands at seq ${latest}. Hold that as your mark — pass it as \`since\` next time to see exactly what happened after this moment.` },
        ));
      }
      const d = store.changesSince(a.collection, Number(a.since), a.limit);
      // A mark AHEAD of this ledger (another store's number, a compact artifact) can never be
      // satisfied — nothing will ever arrive after it. Re-anchor loudly instead of pinning the
      // caller to a number that can only be wrong.
      if (Number(a.since) > d.latest_seq) {
        return toMcp(answer.page(
          { collection: d.collection, since: d.since, latest_seq: d.latest_seq, next_since: d.latest_seq,
            total: 0, dropped: 0, events: [],
            note: `your mark (${d.since}) is ahead of this ledger (latest ${d.latest_seq}) — it may belong to another store. Re-anchored: hold ${d.latest_seq}.` },
          { returned: 0, total: 0,
            text: `Mark ${d.since} is ahead of "${a.collection}"'s ledger (latest ${d.latest_seq}) — re-anchor: hold ${d.latest_seq} as your mark.` },
        ));
      }
      // Events are the CONTIGUOUS run right after `since`, so a shrink (budget) or a small `limit`
      // can only cut the TAIL — next_since still equals the last event actually delivered, and
      // everything undelivered is still strictly after it. Nothing can be skipped over.
      let events = d.events;
      let next_since = d.next_since;
      const bodyOf = (evs) => ({ collection: d.collection, since: d.since, latest_seq: d.latest_seq,
        next_since, total: d.total, dropped: d.dropped + (d.events.length - evs.length), events: evs });
      if (sizeOf(bodyOf(events)) > RESULT_BUDGET) {
        let keep = events.length;
        while (keep > 1 && sizeOf(bodyOf(events.slice(0, keep))) > RESULT_BUDGET) keep = Math.ceil(keep / 2);
        events = events.slice(0, keep);
        next_since = events.at(-1)?.seq ?? d.since;
      }
      const verb = { item_added: "added", item_updated: "updated", item_moved: "moved", item_deleted: "deleted" };
      const line = (e) => {
        const what = e.type === "item_moved" ? `→ ${e.to || "(ungrouped)"}`
          : e.fields ? JSON.stringify(e.fields) + (e.group ? ` [${e.group}]` : "") : "";
        return `  ${e.actor.padEnd(5)} ${(verb[e.type] || e.type).padEnd(7)} ${e.id}${what ? " " + what : ""}`;
      };
      const remaining = d.total - events.length;
      const head = d.total === 0
        ? `Collection "${a.collection}" — nothing changed since ${d.since} (now ${d.latest_seq}).`
        : `Collection "${a.collection}" — ${events.length} of ${d.total} change(s) since ${d.since}${remaining > 0 ? `; continue with since=${next_since}` : ""} (now ${d.latest_seq}).`;
      return toMcp(answer.page(bodyOf(events), { returned: events.length, total: d.total,
        text: head + (events.length ? "\n" + events.map(line).join("\n") : "") }));
    },
  );

  server.registerTool(
    "data_version",
    {
      title: "Data change probe",
      annotations: RO,
      description: "The cheapest possible change check: returns the global change counter (seq) plus settings/files sub-counters. If seq hasn't moved since you last looked, NOTHING changed anywhere — skip re-reading. Widgets use this for adaptive polling; you can too before re-listing a collection.",
      inputSchema: {},
      outputSchema: { seq: z.number(), settings_version: z.number(), files_version: z.number(), schema_version: z.number() },
    },
    async () => {
      // The four DECLARED keys, projected by name — never the store's whole answer. The store's
      // probe also carries `live_n` (which app a wall display is showing), and that is not a
      // data change: forwarding it would put a counter on the model's face that moves when nothing
      // in the data moved, under a schema that never promised it.
      const v = store.dataVersion();
      const out = { seq: v.seq, settings_version: v.settings_version, files_version: v.files_version, schema_version: v.schema_version };
      return { content: [{ type: "text", text: `seq ${out.seq} (settings ${out.settings_version}, files ${out.files_version}, schema v${out.schema_version})` }], structuredContent: out };
    },
  );

  server.registerTool(
    "data_collections",
    {
      title: "List collections",
      annotations: RO,
      description: "List every data collection that exists (name, item count, last activity). Use when unsure where data lives, what boards the user has, or which collection to bind an app to. Renders no UI.",
      inputSchema: {},
      outputSchema: {
        collections: z.array(z.object({
          collection: z.string(), items: z.number(), last_activity: z.string().nullable(),
        })),
        note: z.string().optional(),
      },
    },
    async () => {
      const collections = store.listCollections();
      // The empty answer CARRIES the rule for the empty state. This fact used to live only in the
      // resident INSTRUCTIONS — the channel that measurably loses (prose lost the birthday fight in
      // apps.mjs, and one measured host truncates the tail of INSTRUCTIONS entirely). "No
      // collections yet." was exactly the reply the model was reading when it gave up on "what's in
      // our freezer?". The note rides BOTH channels because hosts forward either one alone.
      const note = collections.length ? undefined
        : 'No collections yet — an empty store is the NORMAL start, not a blocker. If the user asked about something no app holds yet ("what\'s in the freezer?", "who has my books?"), say in one line that nothing is stored, then BUILD the app that would hold it and open it in the SAME reply — a lookup that comes back empty is a request you have not met yet, not an answer. Missing data is never a reason to wait; missing CONSENT still is: health, financial, or other personal data needs their one-line yes first. Then get rows in — seed what you genuinely know from this chat and your memory with data_batch, and ask them to paste what they have; never invent rows.';
      const text = collections.length
        ? collections.map((c) => `- ${c.collection}: ${c.items} item(s), last activity ${c.last_activity || "never"}`).join("\n")
        : note;
      return { content: [{ type: "text", text }], structuredContent: { collections, ...(note ? { note } : {}) } };
    },
  );

  server.registerTool(
    "data_add_item",
    {
      title: "Add item",
      annotations: WRITE,
      description: "Add an item to a collection. `group` is the app-defined lane/section (e.g. a kanban column); `fields` is a JSON object (e.g. {title, done, notes…}).",
      // The four item-write schemas are PASSTHROUGH objects (a real ZodObject, which the SDK
      // uses as-is instead of wrapping a strip-mode one): the runtime/runner stamps `via` —
      // the shadow provenance edge — onto widget writes, and a strip-mode schema would silently
      // eat it in transit. The face never names via (row #8: it is not part of any AI surface);
      // unknown keys die in store.core(), which picks payload fields explicitly.
      inputSchema: z.object({
        ...cmdArgs, collection: z.string(), group: z.string().optional(),
        fields: z.record(z.string(), z.any()), position: z.number().optional(),
      }).passthrough(),
      outputSchema: ackSchema,
    },
    async (a) => {
      const r = run(a, "add_item");
      // The id is the point of the ack: nothing else in the response tells the model which row it
      // just made, and without it the row can never be updated or deleted.
      return r.ok ? toAck(r, `${r.idempotent ? "Already added" : "Added"} item ${r.id}.`) : toFail(r);
    },
  );

  server.registerTool(
    "data_update_item",
    {
      title: "Update item fields",
      annotations: WRITE,
      description: "Shallow-merge fields into an item (set a key to null to remove it). Uses optimistic concurrency.",
      inputSchema: z.object({
        ...cmdArgs, id: z.string(), fields: z.record(z.string(), z.any()),
        expected_version: z.number().optional().describe("the item version you last saw"),
      }).passthrough(),
      outputSchema: ackSchema,
    },
    async (a) => {
      const r = run(a, "update_item");
      return r.ok ? toAck(r, r.idempotent ? "Already updated." : "Updated.") : r.conflict ? toConflict(r, failNote(r)) : toFail(r);
    },
  );

  server.registerTool(
    "data_move_item",
    {
      title: "Move item",
      annotations: WRITE,
      description: "Move an item to another group and/or position (e.g. kanban column).",
      inputSchema: z.object({
        ...cmdArgs, id: z.string(), group: z.string().optional(),
        position: z.number().optional(), expected_version: z.number().optional(),
      }).passthrough(),
      outputSchema: ackSchema,
    },
    async (a) => {
      const r = run(a, "move_item");
      return r.ok ? toAck(r, r.idempotent ? "Already moved." : "Moved.") : r.conflict ? toConflict(r, failNote(r)) : toFail(r);
    },
  );

  server.registerTool(
    "data_delete_item",
    {
      title: "Delete item",
      annotations: DESTRUCTIVE,
      description: "Delete an item permanently. May return reason:\"confirmation_required\" with a request_state — show the user what is named in `note`, then re-send the same call with request_state attached.",
      inputSchema: z.object({ ...cmdArgs, id: z.string(), expected_version: z.number().optional(), request_state: z.string().optional(), require_confirmation: z.boolean().optional() }).passthrough(),
      outputSchema: { ...ackSchema, request_state: z.string().optional(), expires_at: z.string().optional(), preview: z.string().optional() },
    },
    async (a) => {
      const r = run(a, "delete_item");
      // Not isError, same doctrine as a conflict: the demand IS the useful payload — a host that
      // discards errored results would strand the confirmation flow on its first leg.
      if (r.confirmation_required) {
        const note = `Confirmation required — deleting "${r.preview}". Confirm with the user, then re-send with request_state (expires ${r.expires_at}).`;
        return toMcp(answer.ack({ ok: false, reason: "confirmation_required", id: r.id, collection: r.collection,
          request_state: r.request_state, expires_at: r.expires_at, preview: r.preview, note }, note));
      }
      return r.ok ? toAck(r, r.idempotent ? "Already deleted." : "Deleted.") : r.conflict ? toConflict(r, failNote(r)) : toFail(r);
    },
  );

}
