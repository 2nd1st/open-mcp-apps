// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// tools/files.mjs — the per-app file plane (scope b): list / read / write / chunked upload / delete / usage.
// Registered by engine.mjs. Moved here verbatim: the tool surface is byte-identical to before
// the split, which test/tool-surface.mjs proves against its golden file.

import { z } from "zod";
import { COMPONENT_NAME_RE, MAX_FILE_INLINE_BYTES, MAX_FILE_BYTES } from "../store.mjs";
import { RO, WRITE, WRITE_NOT_IDEMPOTENT, DESTRUCTIVE, fileMetaShape, answer, toMcp, sizeOf, RESULT_BUDGET } from "../contracts.mjs";

export function register(ctx) {
  const { server, store, fileChannel, fail, fileFailNote } = ctx;

  // ------------------------------------------------------------ per-app file plane (scope b)
  // Opaque user-file storage the AI uses to stash + retrieve files the user hands it (chat
  // attachments, generated exports). Bytes ride a swappable backend (src/files.mjs); these tools
  // mirror the data_* shape. The file_read/file_write caps exist as the tier SEAM but are NOT gated
  // here — direct/AI use is local-tier (full). The runner enforces them for untrusted components
  // once tiering lands. We store bytes OPAQUELY: any file, accepted wholesale, never interpreted.
  server.registerTool(
    "file_list",
    {
      title: "List app files",
      annotations: RO,
      description: "List the files an app (component) has stored — a PAGE of {path, size, mime, version} plus usage totals; limit/cursor page through, prefix narrows. These are opaque user files (attachments, exports) the app keeps — separate from its structured data collection. Renders no UI.",
      inputSchema: {
        component: z.string().describe("the app whose files to list"),
        prefix: z.string().optional().describe("only paths starting with this prefix"),
        limit: z.number().optional().describe("page size (default 200)"),
        cursor: z.string().optional().describe("opaque cursor from the previous page's next_cursor"),
      },
      outputSchema: {
        component: z.string(), files: z.array(fileMetaShape),
        usage: z.object({ bytes: z.number(), count: z.number() }), files_version: z.number(),
        returned: z.number().optional(), total: z.number().optional(),
        next_cursor: z.string().nullable().optional(), note: z.string().optional(), eot: z.string().optional(),
      },
    },
    async (a) => {
      if (!COMPONENT_NAME_RE.test(a.component || "")) return fail("Invalid app name.");
      const { files: all } = fileChannel.list(a.component, a.prefix);
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
      const usage = store.fileUsage(a.component);
      let note;
      const bodyOf = (rows) => ({ component: a.component, files: rows,
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
        ? `Files for "${a.component}" — ${files.length} of ${all.length} (${usage.bytes} bytes total):\n` +
          files.map((f) => `  - ${f.path} (${f.mime}, ${f.size} bytes, v${f.version})`).join("\n") +
          (next ? "\nmore: pass next_cursor" : "") + (note ? `\n${note}` : "")
        : `No files stored for "${a.component}"${a.prefix ? ` under "${a.prefix}"` : ""}.`;
      return toMcp(answer.page(bodyOf(files), { returned: files.length, total: all.length, next, text }));
    },
  );

  server.registerTool(
    "file_read",
    {
      title: "Read an app file",
      annotations: RO,
      description: "Read one file an app has stored, as a WINDOW of its bytes: offset/length select it, data_base64 carries exactly that window, next_offset continues (same window grammar as get_component, and for the same reason). Reassemble by concatenating decoded windows; sha256 is the WHOLE file's hash, so reassembly is checkable.",
      inputSchema: {
        component: z.string(), path: z.string().describe("the file's logical name"),
        offset: z.number().optional().describe("byte offset to read from (default 0)"),
        length: z.number().optional().describe("max bytes for this window (default fits the result budget)"),
      },
      outputSchema: {
        component: z.string(), path: z.string(), mime: z.string(), size: z.number(), sha256: z.string(), version: z.number(),
        offset: z.number().optional(), next_offset: z.number().nullable().optional(),
        returned: z.number().optional(), total: z.number().optional(),
        data_base64: z.string().optional(), eot: z.string().optional(),
      },
    },
    async (a) => {
      if (!COMPONENT_NAME_RE.test(a.component || "")) return fail("Invalid app name.");
      const meta = fileChannel.stat(a.component, a.path);
      if (!meta) return fail(`No file "${a.path}" stored for "${a.component}". Use file_list to see what exists.`);
      let got;
      try { got = await fileChannel.get(a.component, a.path); }
      catch { return fail(`File "${a.path}" failed its integrity check (content-hash mismatch) — it may be corrupted.`); }
      if (!got) return fail(`File "${a.path}" is missing its stored bytes.`);
      const whole = got.bytes;
      const base = { component: a.component, path: a.path, mime: meta.mime, size: meta.size, sha256: meta.sha256, version: meta.version };
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

  server.registerTool(
    "file_write",
    {
      title: "Store an app file",
      annotations: DESTRUCTIVE,  // overwriting a path unlinks the old blob — those bytes are unrecoverable
      description: "Store a file for an app (create or overwrite by path). `data_base64` is the file bytes, base64-encoded — pass any file the user gave you or that you generated. Overwriting an existing path bumps its version. Single-call writes are limited to a few MiB. Files persist and are the app's own, reusable across chats.",
      inputSchema: {
        command_id: z.string().describe("idempotency key — a fresh uuid per write"),
        component: z.string().describe("the app this file belongs to"),
        path: z.string().describe("logical file name, e.g. 'receipt.pdf' or 'exports/2026-q1.csv'"),
        data_base64: z.string().describe("file bytes, base64-encoded"),
        mime: z.string().optional().describe("content type, e.g. 'image/png' (default application/octet-stream)"),
        expected_version: z.number().optional().describe("the version you last saw, for optimistic concurrency (optional)"),
      },
      outputSchema: { component: z.string(), path: z.string(), size: z.number(), mime: z.string(), sha256: z.string(), version: z.number(), files_version: z.number() },
    },
    async (a) => {
      let bytes;
      try { bytes = Buffer.from(a.data_base64 || "", "base64"); } catch { return fail("data_base64 is not valid base64."); }
      if (bytes.length > MAX_FILE_INLINE_BYTES) return fail(`Single-call write is limited to ${MAX_FILE_INLINE_BYTES} bytes; this file is ${bytes.length}. Use the chunked path: file_write_begin → file_write_chunk (in order) → file_write_commit.`);
      const r = await fileChannel.put(a.component, a.path, bytes, { mime: a.mime, command_id: a.command_id, expected_version: a.expected_version });
      if (!r.ok) return fail(fileFailNote(r));
      const m = r.meta;
      return { content: [{ type: "text", text: `Stored "${a.path}" (${m.size} bytes, ${m.mime}, v${m.version}) for "${a.component}".${r.idempotent ? " (already stored)" : ""}` }], structuredContent: { component: a.component, path: a.path, size: m.size, mime: m.mime, sha256: m.sha256, version: m.version, files_version: store.filesVersion() } };
    },
  );

  // Chunked write — the large-file path (single-shot file_write caps at MAX_FILE_INLINE_BYTES,
  // the per-file ceiling is MAX_FILE_BYTES). begin → chunk (in order, one at a time) → commit;
  // bytes stream to backend staging, so nothing big ever sits in RAM, and commit lands through
  // the exact same ref/quota/idempotency transaction as a single-shot write.
  server.registerTool(
    "file_write_begin",
    {
      title: "Begin a chunked file write",
      annotations: WRITE_NOT_IDEMPOTENT,  // no idempotency key: replaying it starts another upload / appends the bytes again
      description: `Start a chunked upload for a file too big for file_write's single call. Returns an upload_id; send the bytes in order with file_write_chunk (each chunk up to ~${Math.floor(MAX_FILE_INLINE_BYTES / 1024 / 1024)} MiB of raw bytes), then file_write_commit names the file. Uploads expire after 30 idle minutes; per-file ceiling ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MiB.`,
      inputSchema: { component: z.string().describe("the app this file will belong to") },
      outputSchema: { upload_id: z.string(), chunk_limit_bytes: z.number(), file_limit_bytes: z.number() },
    },
    async (a) => {
      const r = await fileChannel.beginUpload(a.component);
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
      const bytes = Buffer.from(a.data_base64 || "", "base64");
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
        expected_sha256: z.string().optional().describe("precheck: refuse (losslessly — the upload survives) if the staged bytes hash differently"),
      },
      outputSchema: { component: z.string(), path: z.string(), size: z.number(), mime: z.string(), sha256: z.string(), version: z.number(), files_version: z.number() },
    },
    async (a) => {
      const r = await fileChannel.commitUpload(a.upload_id, a.path, { mime: a.mime, command_id: a.command_id, expected_version: a.expected_version, expected_sha256: a.expected_sha256 });
      if (!r.ok) return fail(fileFailNote(r));
      const m = r.meta;
      return {
        content: [{ type: "text", text: `Stored "${m.path}" (${m.size} bytes, ${m.mime}, v${m.version}) for "${m.component}".${r.idempotent ? " (already committed by this command_id — nothing re-uploaded)" : ""}` }],
        structuredContent: { component: m.component, path: m.path, size: m.size, mime: m.mime, sha256: m.sha256, version: m.version, files_version: store.filesVersion() },
      };
    },
  );

  server.registerTool(
    "file_write_abort",
    {
      title: "Abort a chunked file write",
      annotations: WRITE,
      description: "Discard an in-flight upload and its staged bytes. Safe to call on an already-gone upload.",
      inputSchema: { upload_id: z.string() },
      outputSchema: { upload_id: z.string(), aborted: z.boolean() },
    },
    async (a) => {
      await fileChannel.abortUpload(a.upload_id);
      return { content: [{ type: "text", text: "Upload discarded." }], structuredContent: { upload_id: a.upload_id, aborted: true } };
    },
  );

  server.registerTool(
    "file_delete",
    {
      title: "Delete an app file",
      annotations: DESTRUCTIVE,
      description: "Permanently delete one file an app has stored.",
      inputSchema: { command_id: z.string().describe("idempotency key (uuid)"), component: z.string(), path: z.string(), expected_version: z.number().optional() },
      outputSchema: { component: z.string(), path: z.string(), deleted: z.boolean(), files_version: z.number() },
    },
    async (a) => {
      const r = await fileChannel.del(a.component, a.path, { command_id: a.command_id, expected_version: a.expected_version });
      if (!r.ok) return fail(fileFailNote(r));
      return { content: [{ type: "text", text: `Deleted "${a.path}" from "${a.component}".` }], structuredContent: { component: a.component, path: a.path, deleted: true, files_version: store.filesVersion() } };
    },
  );

  // file_usage RETIRED (signed v0.3 break): file_list already reports the same usage totals on
  // every page, so the seat was a second spelling of one fact.

}
