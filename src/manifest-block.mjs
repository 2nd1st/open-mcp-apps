// SPDX-License-Identifier: MIT
// Copyright (C) 2026 2nd1st
// manifest-block.mjs — read an app's DECLARATION out of its own document.
//
// An app declares what it is in one place: a JSON block inside its own HTML. The engine reads
// that block when the app is saved and materialises it into the `manifest` column, so the
// document is the single source and the column is a view of it. Two consequences worth stating:
//
//   · The declaration vocabulary can grow forever without touching tools/list. Every byte of a tool
//     input schema is resident in every conversation; a byte inside the html string is not.
//   · The block is eventually the gate on anonymous writes (a public function is reachable only if
//     the document declares it), which makes this reader a security boundary.
//
// ── why this is a byte grammar and not an HTML parser ────────────────────────────────────────────
// The first version of this file was a coarse HTML tokenizer, because the settings app used to parse
// the same block in the browser and the two had to agree. Measuring that agreement against a real
// headless browser found two divergences, one of them exploitable: a nested <template> could hide a
// declaration that no browser could see but a tokenizer accepted, and a `<!--<script>` sequence made
// a browser read past the first literal `</script>` while the tokenizer stopped there.
//
// Both were fixable, and both were symptoms. The obligation to match a browser's tokenizer existed
// only because a browser was a reader — and it no longer is: the settings app reads the materialised
// column now. What is left is one reader (this engine) and one writer (the author). So the grammar
// became something a PERSON can execute by eye, which is the property that actually prevents
// smuggling: "what would an HTML tokenizer do with these bytes" is not a question a reviewer can
// answer without a browser — that is precisely why the divergences needed one to be found.
//
// The rule, in full:
//   · The declaration opens with this tag, byte for byte:
//         <script type="application/json" id="oma-manifest">
//     Exactly one occurrence. Two is refused rather than resolved — a rule that picks one of them
//     guarantees some reader is looking at the other.
//   · A <script> tag that mentions the marker in ANY other spelling is refused BY NAME rather than
//     ignored: a declaration that silently does nothing is the worst outcome available here. Prose
//     may still mention the word freely — the check looks for a tag, not for the word.
//   · The declaration is the bytes from that tag to the first `</script`. That is the same rule the
//     author already lives under for any inline script, so `<\/script>` inside a string is nothing new.
//
// Position is irrelevant: head, body, even inside a comment. That is a consequence of scanning bytes,
// it is documented, and it costs nothing — the JSON is inert wherever it sits, and the authoritative
// answer to "what did this app declare" is not the document at all. It is the materialised
// column, which is exact, greppable, and what the App Store and any review pass should read.

/** The one spelling. Written out rather than assembled so that a grep for the literal string in a
 *  app finds the same thing the engine looks for. */
export const DECLARATION_OPEN = '<script type="application/json" id="oma-manifest">';
const CLOSE = "</script";
// A script start tag that MENTIONS the marker without being the canonical opening. This is how a
// near-miss becomes an error instead of a silence — and why the check is scoped to a tag rather than
// to the bare word: an app (this engine's own settings app, for one) may perfectly well discuss
// "oma-manifest" in a comment, and prose must never be mistaken for a declaration attempt.
const NEAR_MISS = /<script\b[^>]*oma-manifest/i;

// The largest declaration we will read. A bound on what has to be held and parsed inside a write
// transaction, in the same spirit as the per-item field cap.
export const MAX_DECLARATION_BYTES = 32_768;

/** Locate the declaration. Returns the raw text, or why there is none. */
export function extractManifestBlock(src) {
  // CRLF and lone CR normalised first, as an HTML input stream does — so a document edited on
  // Windows declares the same thing as one edited anywhere else.
  const html = String(src ?? "").replace(/\r\n?/g, "\n");
  const occurrences = html.split(DECLARATION_OPEN).length - 1;
  if (occurrences > 1) return { found: false, occurrences };
  if (occurrences === 0) return { found: false, occurrences: 0, malformed: NEAR_MISS.test(html) };
  const open = html.indexOf(DECLARATION_OPEN);
  const start = open + DECLARATION_OPEN.length;
  const close = html.indexOf(CLOSE, start);
  const end = close === -1 ? html.length : close;
  // The declaration's CONTENT is exempt from the near-miss check (it may legitimately discuss the
  // marker), but the rest of the document is not: a canonical block PLUS a differently-spelled
  // attempt elsewhere means the second one silently does nothing — the outcome this check exists
  // to refuse. occurrences === 1 here, so anything the residue matches is a near miss by definition.
  const malformed = NEAR_MISS.test(html.slice(0, open)) || NEAR_MISS.test(html.slice(end));
  // `start`/`end` are offsets into the NORMALISED html (the string this grammar runs on) — a
  // rewriter must splice that string, not the raw input, or CRLF documents shift every offset.
  return { found: true, occurrences, malformed, text: html.slice(start, end), start, end, html };
}

/** Four states, because a document either says nothing, says "nothing", says something, or is
 *  broken — and collapsing any pair of those loses information the caller needs:
 *
 *    absent  — no block. The document is not talking about its declaration, so neither are we.
 *    empty   — a block with nothing in it. That IS a statement: clear the declaration.
 *    present — a parsed object.
 *    bad     — the document tried to declare something and failed. Never silently treated as
 *              absent: "I wrote a declaration and it did nothing" is the worst of the four.
 */
export function readDeclaration(html) {
  const b = extractManifestBlock(html);
  if (b.occurrences > 1)
    return { state: "bad", error: "duplicate_manifest_block",
      detail: `the declaration block appears ${b.occurrences} times — an app declares itself exactly once` };
  if (b.malformed)
    return { state: "bad", error: "manifest_block_malformed",
      detail: `the declaration must open with exactly: ${DECLARATION_OPEN} — a <script> tag mentioning the marker in any other spelling is refused rather than ignored` };
  if (!b.found) return { state: "absent" };
  if (b.text.length > MAX_DECLARATION_BYTES)
    return { state: "bad", error: "manifest_too_large", detail: `${b.text.length} chars, limit ${MAX_DECLARATION_BYTES}` };
  if (!b.text.trim()) return { state: "empty" };
  let value;
  try { value = JSON.parse(b.text); }
  catch (e) { return { state: "bad", error: "manifest_bad_json", detail: e.message }; }   // keep the position: it saves the author a round trip
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { state: "bad", error: "manifest_not_object", detail: "the declaration must be a JSON object" };
  // `{}` and a whitespace-only block are the SAME statement — "I declare nothing" — and the guide
  // teaches them as one. Two spellings of clear must not behave differently.
  if (Object.keys(value).length === 0) return { state: "empty" };
  return { state: "present", value };
}

/** Does this document carry (or nearly carry) a legacy declaration tag? The v6 save guard: from
 *  W-N the declaration arrives as a structured parameter, so a document still carrying the block —
 *  a model transcribing pre-v6 examples — must be refused LOUDLY, never accepted as inert bytes.
 *  Same tag-scoped byte judgement as the legacy reader (prose may mention the marker freely;
 *  teaching examples entity-escape the opening tag), and deliberately not an HTML-tree parse —
 *  that obligation was retired with the browser readers, see the header above. */
export function mentionsDeclarationTag(src) {
  const html = String(src ?? "").replace(/\r\n?/g, "\n");
  return html.includes(DECLARATION_OPEN) || NEAR_MISS.test(html);
}

/** Remove the declaration block from a document — RAW BYTES, no CRLF normalisation, because this
 *  is the v5→v6 migration's writer and everything outside the block must survive byte-for-byte
 *  (splicing with the normalised offsets the reader uses would delete the wrong span in a CRLF
 *  document, or silently rewrite the whole document's line endings). The span removed is the
 *  canonical opening tag through the end of the first closing script tag; the opening tag contains
 *  no newline, so a raw indexOf finds exactly what the normalising reader found. Callers strip only
 *  documents the reader already accepted (one block, well-formed), so "not found" just returns the
 *  input unchanged. */
export function stripDeclarationBlock(src) {
  const raw = String(src ?? "");
  const open = raw.indexOf(DECLARATION_OPEN);
  if (open === -1) return { found: false, html: raw };
  const close = raw.indexOf(CLOSE, open + DECLARATION_OPEN.length);
  let end;
  if (close === -1) end = raw.length;
  else {
    const gt = raw.indexOf(">", close);
    end = gt === -1 ? raw.length : gt + 1;
  }
  return { found: true, html: raw.slice(0, open) + raw.slice(end) };
}
