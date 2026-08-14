// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// tools/files.mjs — the per-app file plane (scope b): list / read / write / chunked upload / delete / usage.
// Registered by engine.mjs. Moved here verbatim: the tool surface is byte-identical to before
// the split, which test/tool-surface.mjs proves against its golden file.

import { z } from "zod";
import { APP_NAME_RE, MAX_FILE_INLINE_BYTES, MAX_FILE_BYTES } from "../store.mjs";
import { RO, WRITE, WRITE_NOT_IDEMPOTENT, DESTRUCTIVE, fileMetaShape, answer, toMcp, sizeOf, RESULT_BUDGET } from "../contracts.mjs";

export function register(ctx) {
  const { server, store, fileChannel, fail, fileFailNote } = ctx;

  // ------------------------------------------------------------ per-app file plane (scope b)
  // Opaque user-file storage the AI uses to stash + retrieve files the user hands it (chat
  // attachments, generated exports). Bytes live in a local content-addressed folder (src/files.mjs); these tools
  // mirror the data_* shape. The file_read/file_write caps exist as the tier SEAM but are NOT gated
  // here — direct/AI use is local-tier (full). The runner enforces them for untrusted apps
  // once tiering lands. We store bytes OPAQUELY: any file, accepted wholesale, never interpreted.
  server.registerTool(
    "file_list",
    {
      title: "List app files",
      annotations: RO,
      description: "List the files an app (app) has stored — a PAGE of {path, size, mime, version} plus usage totals; limit/cursor page through, prefix narrows. These are opaque user files (attachments, exports) the app keeps — separate from its structured data collection. Renders no UI.",
      inputSchema: {
        app: z.string().describe("the app whose files to list"),
        prefix: z.string().optional().describe("only paths starting with this prefix"),
        limit: z.number().optional().describe("page size (default 200)"),
        cursor: z.string().optional().describe("opaque cursor from the previous page's next_cursor"),
      },
      outputSchema: {
        app: z.string(), files: z.array(fileMetaShape),
        usage: z.object({ bytes: z.number(), count: z.number() }), files_version: z.number(),
        returned: z.number().optional(), total: z.number().optional(),
        next_cursor: z.string().nullable().optional(), note: z.string().optional(), eot: z.string().optional(),
      },
    },
    async (a) => {
      if (!APP_NAME_RE.test(a.app || "")) return fail("Invalid app name.");
      const { files: all } = fileChannel.list(a.app, a.prefix);
      const lim = Math.max(1, Math.min(Number(a.limit) || 200, 1000));
      let start = 0;
      if (a.cursor) {
        // Same refusal grammar as data_list: a corrupted cursor is an ERROR, not a silent restart.
        if (!/^[A-Za-z0-9_-]+$/.test(String(a.cursor))) return fail("Invalid cursor — restart from the first page (omit cursor).");
        const afterPath = Buffer.from(String(a.cursor), "base64url").toString("utf8");
        start = all.findIndex((f) => f.path > afterPath);
        if (start === -1) start = all.length;
      }
      let files = all.slice(start, start + lim);
      const usage = store.fileUsage(a.app);
      let note;
      const bodyOf = (rows) => ({ app: a.app, files: rows,
        usage: { bytes: usage.bytes, count: usage.count }, files_version: store.filesVersion(),
        ...(note ? { note } : {}) });
      // Metadata is small, but paths are caller-sized — same budget discipline as every page.
      if (sizeOf(bodyOf(files)) > RESULT_BUDGET) {
        let keep = files.length;
        while (keep > 1 && sizeOf(bodyOf(files.slice(0, keep))) > RESULT_BUDGET) keep = Math.ceil(keep / 2);
        files = files.slice(0, keep);
        note = `page shrunk to ${keep} file(s) to fit the result budget — continue with next_cursor.`;
      }
      const next = start + files.length < all.length && files.length
        ? Buffer.from(files.at(-1).path, "utf8").toString("base64url") : null;
      const text = files.length
        ? `Files for "${a.app}" — ${files.length} of ${all.length} (${usage.bytes} bytes total):\n` +
          files.map((f) => `  - ${f.path} (${f.mime}, ${f.size} bytes, v${f.version})`).join("\n") +
          (next ? "\nmore: pass next_cursor" : "") + (note ? `\n${note}` : "")
        : `No files stored for "${a.app}"${a.prefix ? ` under "${a.prefix}"` : ""}.`;
      return toMcp(answer.page(bodyOf(files), { returned: files.length, total: all.length, next, text }));
    },
  );

  server.registerTool(
    "file_read",
    {
      title: "Read an app file",
      annotations: RO,
      description: "Read one file an app has stored, as a WINDOW of its bytes: offset/length select it, data_base64 carries exactly that window, next_offset continues (same window grammar as get_app, and for the same reason). Reassemble by concatenating decoded windows; sha256 is the WHOLE file's hash, so reassembly is checkable.",
      inputSchema: {
        app: z.string(), path: z.string().describe("the file's logical name"),
        offset: z.number().optional().describe("byte offset to read from (default 0)"),
        length: z.number().optional().describe("max bytes for this window (default fits the result budget)"),
      },
      outputSchema: {
        app: z.string(), path: z.string(), mime: z.string(), size: z.number(), sha256: z.string(), version: z.number(),
        offset: z.number().optional(), next_offset: z.number().nullable().optional(),
        returned: z.number().optional(), total: z.number().optional(),
        data_base64: z.string().optional(), eot: z.string().optional(),
      },
    },
    async (a) => {
      if (!APP_NAME_RE.test(a.app || "")) return fail("Invalid app name.");
      const meta = fileChannel.stat(a.app, a.path);
      if (!meta) return fail(`No file "${a.path}" stored for "${a.app}". Use file_list to see what exists.`);
      let got;
      try { got = await fileChannel.get(a.app, a.path); }
      catch { return fail(`File "${a.path}" failed its integrity check (content-hash mismatch) — it may be corrupted.`); }
      if (!got) return fail(`File "${a.path}" is missing its stored bytes.`);
      const whole = got.bytes;
      const base = { app: a.app, path: a.path, mime: meta.mime, size: meta.size, sha256: meta.sha256, version: meta.version };
      const at = Math.max(0, Math.min(Math.floor(Number(a.offset) || 0), whole.length));
      // Raw-byte window, shrunk until the base64 body fits the budget — the same doctrine as every
      // other window, in the units a file actually has. (base64 inflates 4/3, hence the 3/4.)
      const rawLen = Math.floor(Number(a.length));
      const wantLen = Number.isFinite(rawLen) && rawLen > 0 ? rawLen : Math.floor(((RESULT_BUDGET - 2_000) * 3) / 4);
      let want = Math.max(1, Math.min(wantLen, Math.max(whole.length - at, 1)));
      let b64 = whole.subarray(at, at + want).toString("base64");
      while (want > 1 && sizeOf({ ...base, offset: at, next_offset: 0, returned: want, total: whole.length, data_base64: b64, eot: "·eot" }) > RESULT_BUDGET) {
        want = Math.ceil(want / 2);
        b64 = whole.subarray(at, at + want).toString("base64");
      }
      const returned = Math.min(want, Math.max(whole.length - at, 0));
      const next = at + returned < whole.length ? at + returned : null;
      return toMcp(answer.chunk(
        { ...base, offset: at, next_offset: next, data_base64: b64 },
        { returned, total: whole.length,
          text: `(file "${a.path}", ${meta.mime} — bytes ${at}–${at + returned} of ${whole.length}${next != null ? `, continue at offset ${next}` : ", end"}; base64 in structuredContent.data_base64)` },
      ));
    },
  );

  // base64 in, bytes out — or null when the input is not base64.
  //
  // This is deliberately NOT a try/catch. `Buffer.from(x, "base64")` does not throw on illegal
  // characters, it silently drops them, so the guard that used to be here could never fire:
  // "!!!not-base64!!!" decoded to seven bytes of garbage, the garbage overwrote a real file, and
  // the reply said "Stored". A tool annotated DESTRUCTIVE has to be sure it was handed what it
  // thinks it was handed.
  //
  // Whitespace is allowed because encoders wrap base64 across lines and rejecting that would trade
  // one bug for another. Missing padding is allowed for the same reason. Everything else has to
  // survive a ROUND TRIP, which is the single check that also catches the subtle case a character
  // class cannot see: trailing bits that are not zero.
  const decodeBase64 = (input) => {
    const raw = String(input ?? "").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) return null;
    const rem = raw.length % 4;
    if (rem === 1) return null;                       // no byte count produces this
    const padded = rem ? raw + "=".repeat(4 - rem) : raw;
    const bytes = Buffer.from(padded, "base64");
    return bytes.toString("base64") === padded ? bytes : null;
  };

  server.registerTool(
    "file_write",
    {
      title: "Store an app file",
      annotations: DESTRUCTIVE,  // overwriting a path unlinks the old blob — those bytes are unrecoverable
      description: "Store a file for an app (create or overwrite by path). `data_base64` is the file bytes, base64-encoded — pass any file the user gave you or that you generated. Overwriting an existing path bumps its version. Single-call writes are limited to a few MiB. Files persist and are the app's own, reusable across chats.",
      inputSchema: {
        command_id: z.string().describe("idempotency key — a fresh uuid per write"),
        app: z.string().describe("the app this file belongs to"),
        path: z.string().describe("logical file name, e.g. 'receipt.pdf' or 'exports/2026-q1.csv'"),
        data_base64: z.string().describe("file bytes, base64-encoded"),
        mime: z.string().optional().describe("content type, e.g. 'image/png' (default application/octet-stream)"),
        expected_version: z.number().optional().describe("the version you last saw, for optimistic concurrency (optional)"),
      },
      outputSchema: { app: z.string(), path: z.string(), size: z.number(), mime: z.string(), sha256: z.string(), version: z.number(), files_version: z.number() },
    },
    async (a) => {
      const bytes = decodeBase64(a.data_base64);
      if (bytes === null) return fail("data_base64 is not valid base64 — nothing was written.");
      if (bytes.length > MAX_FILE_INLINE_BYTES) return fail(`Single-call write is limited to ${MAX_FILE_INLINE_BYTES} bytes; this file is ${bytes.length}. Use the chunked path: file_write_begin → file_write_chunk (in order) → file_write_commit.`);
      const r = await fileChannel.put(a.app, a.path, bytes, { mime: a.mime, command_id: a.command_id, expected_version: a.expected_version });
      if (!r.ok) return fail(fileFailNote(r));
      const m = r.meta;
      return { content: [{ type: "text", text: `Stored "${a.path}" (${m.size} bytes, ${m.mime}, v${m.version}) for "${a.app}".${r.idempotent ? " (already stored)" : ""}` }], structuredContent: { app: a.app, path: a.path, size: m.size, mime: m.mime, sha256: m.sha256, version: m.version, files_version: store.filesVersion() } };
    },
  );

  // Chunked write — the large-file path (single-shot file_write caps at MAX_FILE_INLINE_BYTES,
  // the per-file ceiling is MAX_FILE_BYTES). begin → chunk (in order, one at a time) → commit;
  // bytes stream to on-disk staging, so nothing big ever sits in RAM, and commit lands through
  // the exact same ref/quota/idempotency transaction as a single-shot write.
  server.registerTool(
    "file_write_begin",
    {
      title: "Begin a chunked file write",
      annotations: WRITE_NOT_IDEMPOTENT,  // no idempotency key: replaying it starts another upload / appends the bytes again
      description: `Start a chunked upload for a file too big for file_write's single call. Returns an upload_id; send the bytes in order with file_write_chunk (each chunk up to ~${Math.floor(MAX_FILE_INLINE_BYTES / 1024 / 1024)} MiB of raw bytes), then file_write_commit names the file. Uploads expire after 30 idle minutes; per-file ceiling ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MiB.`,
      inputSchema: { app: z.string().describe("the app this file will belong to") },
      outputSchema: { upload_id: z.string(), chunk_limit_bytes: z.number(), file_limit_bytes: z.number() },
    },
    async (a) => {
      const r = await fileChannel.beginUpload(a.app);
      if (!r.ok) return fail(fileFailNote(r));
      return {
        content: [{ type: "text", text: `Upload started (id ${r.upload_id}). Send chunks in order with file_write_chunk, then file_write_commit.` }],
        structuredContent: { upload_id: r.upload_id, chunk_limit_bytes: MAX_FILE_INLINE_BYTES, file_limit_bytes: MAX_FILE_BYTES },
      };
    },
  );

  server.registerTool(
    "file_write_chunk",
    {
      title: "Append a chunk to an upload",
      annotations: WRITE_NOT_IDEMPOTENT,  // no idempotency key: replaying it starts another upload / appends the bytes again
      description: "Append the next chunk of bytes (base64) to an upload started with file_write_begin. Send chunks strictly in order, one at a time. Pass `seq` (0-based chunk index) so a resend after a lost response is acknowledged instead of double-appended.",
      inputSchema: {
        upload_id: z.string(), data_base64: z.string().describe("this chunk's bytes, base64-encoded"),
        seq: z.number().optional().describe("0-based index of this chunk — a resend of an already-staged index is a safe no-op"),
      },
      outputSchema: { upload_id: z.string(), bytes: z.number().describe("total bytes staged so far"), chunks: z.number().optional(), duplicate: z.boolean().optional() },
    },
    async (a) => {
      const bytes = decodeBase64(a.data_base64);
      if (bytes === null) return fail("data_base64 is not valid base64 — this chunk was not staged.");
      if (!bytes.length) return fail("Empty chunk — send actual bytes.");
      if (bytes.length > MAX_FILE_INLINE_BYTES) return fail(`Chunk too large (${bytes.length} bytes) — keep each chunk at or under ${MAX_FILE_INLINE_BYTES} bytes.`);
      const r = await fileChannel.appendUpload(a.upload_id, bytes, { seq: a.seq });
      if (!r.ok) return fail(fileFailNote(r));
      return { content: [{ type: "text", text: r.duplicate ? `Chunk ${a.seq} was already staged — not appended again (${r.bytes} bytes staged).` : `${r.bytes} bytes staged.` }],
        structuredContent: { upload_id: a.upload_id, bytes: r.bytes, ...(r.chunks != null ? { chunks: r.chunks } : {}), ...(r.duplicate ? { duplicate: true } : {}) } };
    },
  );

  server.registerTool(
    "file_write_commit",
    {
      title: "Commit a chunked file write",
      annotations: DESTRUCTIVE,  // same: committing over an existing path destroys the previous bytes
      description: "Finalize an upload as an app file (create or overwrite by path) — the chunked equivalent of file_write. The upload is consumed either way; on failure, restart from file_write_begin.",
      inputSchema: {
        upload_id: z.string(),
        path: z.string().describe("logical file name, e.g. 'video.mp4' or 'exports/backup.zip'"),
        mime: z.string().optional(),
        command_id: z.string().optional().describe("idempotency key (uuid); auto-generated if omitted. A retried commit with the same id returns the original receipt instead of demanding a re-upload"),
        expected_version: z.number().optional(),
      },
      outputSchema: { app: z.string(), path: z.string(), size: z.number(), mime: z.string(), sha256: z.string(), version: z.number(), files_version: z.number() },
    },
    async (a) => {
      const r = await fileChannel.commitUpload(a.upload_id, a.path, { mime: a.mime, command_id: a.command_id, expected_version: a.expected_version });
      if (!r.ok) return fail(fileFailNote(r));
      const m = r.meta;
      return {
        content: [{ type: "text", text: `Stored "${m.path}" (${m.size} bytes, ${m.mime}, v${m.version}) for "${m.app}".${r.idempotent ? " (already committed by this command_id — nothing re-uploaded)" : ""}` }],
        structuredContent: { app: m.app, path: m.path, size: m.size, mime: m.mime, sha256: m.sha256, version: m.version, files_version: store.filesVersion() },
      };
    },
  );

  // file_write_abort retired 2026-08-04 (elegance A12): abandoned staging expires on its own
  // (30 idle minutes, the TTL sweep in files.mjs), and the explicit abort was the only thing that
  // created the abort-vs-commit race its own comment warned about. A caller that wants a staged
  // upload gone simply stops sending chunks.

  server.registerTool(
    "file_delete",
    {
      title: "Delete an app file",
      annotations: DESTRUCTIVE,
      description: "Permanently delete one file an app has stored.",
      inputSchema: { command_id: z.string().describe("idempotency key (uuid)"), app: z.string(), path: z.string(), expected_version: z.number().optional(),
        actor: z.enum(["human", "agent"]).optional(), request_state: z.string().optional() },
      outputSchema: { app: z.string(), path: z.string(), deleted: z.boolean().optional(), files_version: z.number().optional(),
        ok: z.boolean().optional(), reason: z.string().optional(), preview: z.string().optional(), request_state: z.string().optional(), expires_at: z.string().optional(), note: z.string().optional() },
    },
    async (a) => {
      // No `via`: the file plane never grew the shadow-provenance edge the item plane has, so the
      // confirmation principal for a file delete is the actor alone (per-app confirm_delete
      // overrides therefore do not apply to files — the global preference does).
      const r = await fileChannel.del(a.app, a.path, { command_id: a.command_id, expected_version: a.expected_version,
        actor: a.actor, request_state: a.request_state });
      // Same two-phase shape data_delete_item publishes — a demand is not an error, and it must
      // carry the state or the caller is told to resend something it never received.
      if (r.confirmation_required) {
        const note = `Confirmation required — deleting "${a.path}" from "${a.app}". Confirm with the user, then re-send with request_state (expires ${r.expires_at}).`;
        return { content: [{ type: "text", text: note }],
          // `preview` names what is about to go, in the same key data_delete_item uses — it is
          // what the shell's overlay puts in front of the user, and without it the question
          // degrades to "Delete this item?" about a file whose name we know perfectly well.
          structuredContent: { app: a.app, path: a.path, ok: false, reason: "confirmation_required", preview: a.path, request_state: r.request_state, expires_at: r.expires_at, note } };
      }
      if (!r.ok) return fail(fileFailNote(r));
      return { content: [{ type: "text", text: `Deleted "${a.path}" from "${a.app}".` }], structuredContent: { app: a.app, path: a.path, deleted: true, files_version: store.filesVersion() } };
    },
  );

  // file_usage RETIRED (signed v0.3 break): file_list already reports the same usage totals on
  // every page, so the seat was a second spelling of one fact.

}
