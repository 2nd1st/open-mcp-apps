// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 2nd1st
// edit-range.mjs — range-hash editing primitives (W-E, redesign §8-R1 lite).
//
// The shape, in one paragraph: get_app hands out windows stamped {offset, length, hash};
// edit_app accepts range edits {offset, length, expect_hash, new_string} addressed against the
// exact document version the caller read. OCC already guarantees the DOCUMENT is the one the
// caller saw — the hash is not about concurrency. It guards against the CALLER: a model that
// mis-copies an offset, or edits from a window it half-remembers, would otherwise splice new
// text into the wrong place and SILENTLY corrupt the source (the D1 failure shape). With the
// hash, that mistake is a clean, retryable error instead of a mutilated app.
//
// data-oma-node lives on the READ side on purpose: get_app {node} resolves the marker to a
// window; edit_app stays pure ranges and never runs a locator. Ambiguity dies at read time,
// where the caller can still ask a better question.
import { createHash } from "node:crypto";

// 12 hex chars of sha256 — enough that an accidental collision is not a real event, short
// enough that models copy it without truncating.
export const sliceHash = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

// Apply range edits against ONE original document. The contract stated once, enforced here:
//   · offsets always address the ORIGINAL text (the expected_version document) — never the
//     result of an earlier edit in the same call;
//   · ranges must not overlap (overlap means two edits disagree about the same bytes);
//   · application happens end-first so earlier ranges never shift later ones.
// Returns {ok, html} or {ok:false, error, detail} — the caller turns this into tool errors.
export function applyRangeEdits(original, ranges) {
  const spans = [];
  for (let i = 0; i < ranges.length; i++) {
    const e = ranges[i];
    const offset = e.offset, length = e.length;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length < 0)
      return { ok: false, error: "bad_range", detail: `edit ${i}: offset/length must be non-negative integers` };
    if (offset + length > original.length)
      return { ok: false, error: "bad_range", detail: `edit ${i}: range ${offset}–${offset + length} runs past the end (total ${original.length}) — re-read (get_app) and re-anchor` };
    const slice = original.slice(offset, offset + length);
    const actual = sliceHash(slice);
    if (actual !== String(e.expect_hash || ""))
      return { ok: false, error: "hash_mismatch", detail: `edit ${i}: the ${length} chars at offset ${offset} hash to ${actual}, not ${e.expect_hash} — the range does not contain what you think. Re-read that window (get_app {offset, length}) and use ITS hash` };
    spans.push({ i, offset, length, text: String(e.new_string ?? "") });
  }
  const sorted = [...spans].sort((a, b) => a.offset - b.offset);
  for (let k = 1; k < sorted.length; k++)
    if (sorted[k].offset < sorted[k - 1].offset + sorted[k - 1].length)
      return { ok: false, error: "overlap", detail: `edits ${sorted[k - 1].i} and ${sorted[k].i} overlap — two edits disagree about the same characters` };
  let html = original;
  for (let k = sorted.length - 1; k >= 0; k--) {
    const s = sorted[k];
    html = html.slice(0, s.offset) + s.text + html.slice(s.offset + s.length);
  }
  return { ok: true, html };
}

// Locate the element carrying data-oma-node="name" and return its {offset, length} span
// (open tag through matching close tag; void/self-closing elements end at their own '>').
//
// This is a tolerant scanner, not an HTML parser — a marker inside a comment or a string
// literal can fool it. That is an accepted trade: the span it returns is only ever used to
// mint a window whose HASH the caller must echo back, so a wrong span produces a visibly
// wrong window now, never a silent mis-splice later.
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
export function locateNode(html, name) {
  const needle = new RegExp(`data-oma-node\\s*=\\s*("${escapeRe(name)}"|'${escapeRe(name)}')`, "g");
  const hits = [];
  for (let m; (m = needle.exec(html)); ) hits.push(m.index);
  if (hits.length === 0) return { ok: false, error: "node_not_found", detail: `no element carries data-oma-node="${name}"` };
  if (hits.length > 1) return { ok: false, error: "node_ambiguous", detail: `data-oma-node="${name}" appears ${hits.length} times — node names must be unique to address by node` };
  const at = hits[0];
  const start = html.lastIndexOf("<", at);
  if (start < 0) return { ok: false, error: "node_unparseable", detail: "marker found but no enclosing tag" };
  const tagM = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(start));
  if (!tagM) return { ok: false, error: "node_unparseable", detail: "marker found but the enclosing tag has no name" };
  const tag = tagM[1].toLowerCase();
  const openEnd = html.indexOf(">", at);
  if (openEnd < 0) return { ok: false, error: "node_unparseable", detail: "open tag never closes" };
  if (VOID_TAGS.has(tag) || html[openEnd - 1] === "/")
    return { ok: true, offset: start, length: openEnd + 1 - start, tag };
  // Balance same-name tags from after the open tag. Tolerant by design (see header note).
  const tokens = new RegExp(`<(/?)${tag}(?=[\\s>/])`, "gi");
  tokens.lastIndex = openEnd + 1;
  let depth = 1;
  for (let m; (m = tokens.exec(html)); ) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) {
      const close = html.indexOf(">", m.index);
      if (close < 0) break;
      return { ok: true, offset: start, length: close + 1 - start, tag };
    }
  }
  return { ok: false, error: "node_unparseable", detail: `<${tag}> carrying the marker never closes — fix the markup or edit by offset` };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
