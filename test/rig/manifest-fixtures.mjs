// Fixture corpus for the #oma-manifest extraction grammar spike.
// Every fixture is a COMPLETE app-ish html document (what save_app receives).
const S = "script";           // avoid literal </script> in THIS file's own source where not needed
const CLOSE = "</" + S + ">";

export const FIXTURES = [
  {
    name: "F01-baseline-v1-head",
    why: "the 9 seeded apps' actual shape (head, after </style>)",
    html: `<!DOCTYPE html><html><head><style>b{}</style>
<script type="application/json" id="oma-manifest">
{ "manifest_version": 1, "settings": [], "uses_shared": ["locale"] }
${CLOSE}
</head><body>x</body></html>`,
  },
  {
    name: "F02-baseline-v2-body-minified",
    why: "bill-calendar/keep-in-touch shape: block in BODY, one minified line, v2",
    html: `<!DOCTYPE html><html><head></head><body><div>x</div>
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"settings":[{"key":"a","type":"boolean","label":"A","default":true}],"collections":{"trips":{}}}
${CLOSE}
<script type="module">console.log(1)${CLOSE}
</body></html>`,
  },
  {
    name: "F03-duplicate-id",
    why: "two blocks with the same id — which one wins? (author error / smuggling)",
    html: `<html><head>
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"settings":[{"key":"first","type":"boolean","label":"First","default":true}]}
${CLOSE}
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"settings":[{"key":"second","type":"boolean","label":"Second","default":true}]}
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F04-inside-template",
    why: "template content is an INERT DocumentFragment: getElementById cannot see it. A naive regex CAN. Differential + smuggling surface.",
    html: `<html><head><template>
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"settings":[{"key":"smuggled","type":"boolean","label":"Smuggled","default":true}]}
${CLOSE}
</template></head><body></body></html>`,
  },
  {
    name: "F05-inside-comment",
    why: "commented-out block: not in the DOM at all. A naive regex sees it. Differential.",
    html: `<html><head><!--
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"settings":[{"key":"commented","type":"boolean","label":"Commented","default":true}]}
${CLOSE}
--></head><body></body></html>`,
  },
  {
    name: "F06-literal-close-in-json-string",
    why: "a JSON string value containing a LITERAL </script>: the HTML tokenizer ends the element there, so the JSON is truncated. Establishes 'to the first literal close tag' as the browser rule.",
    html: `<html><head>
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"note":"a ${CLOSE} b","settings":[]}
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F07-escaped-close-in-json-string",
    why: "the CORRECT way to carry the sequence (<\\/script>) — must round-trip identically on both sides",
    html: `<html><head>
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"note":"a <\\/${S}> b","settings":[]}
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F08-double-escape-state",
    why: "HTML script-data-DOUBLE-escaped state: after <!-- ... <script the NEXT </script> does NOT end the element. The classic place where 'first literal close' diverges from the browser.",
    html: `<html><head>
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"note":"<!--<${S}>","settings":[]}
${CLOSE}
{"manifest_version":2,"note":"tail","settings":[]}
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F09-case-and-quote-variants",
    why: "tag/attr names are ASCII-case-insensitive, attr order free, quotes optional — the regex must not be literal-string matching",
    html: `<html><head>
<SCRIPT ID=oma-manifest TYPE='application/json'>
{"manifest_version":2,"settings":[{"key":"variant","type":"boolean","label":"Variant","default":true}]}
</SCRIPT>
</head><body></body></html>`,
  },
  {
    name: "F10-id-value-wrong-case",
    why: "the id VALUE is case-sensitive even though the attr NAME is not: id=OMA-MANIFEST must NOT match",
    html: `<html><head>
<script type="application/json" ID="OMA-MANIFEST">
{"manifest_version":2,"settings":[{"key":"upper","type":"boolean","label":"Upper","default":true}]}
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F11-type-wrong-case-and-padded",
    why: "type value casing/whitespace: does el.type-based matching accept APPLICATION/JSON or ' application/json '?",
    html: `<html><head>
<script type=" APPLICATION/JSON " id="oma-manifest">
{"manifest_version":2,"settings":[{"key":"ty","type":"boolean","label":"Ty","default":true}]}
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F12-decoy-first-wrong-type",
    why: "SECURITY: an EXECUTABLE script carries the id first; a real json block follows. 'getElementById then check type' -> null; 'first element matching BOTH' -> the second block. Real divergence between two plausible grammars.",
    html: `<html><head>
<script id="oma-manifest">window.__pwned = 1${CLOSE}
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"settings":[{"key":"real","type":"boolean","label":"Real","default":true}]}
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F13-gt-inside-quoted-attribute",
    why: "a quoted attribute value containing '>' — the tag does NOT end there. Kills the <script[^>]*> regex shape.",
    html: `<html><head>
<script type="application/json" data-x="a>b" id="oma-manifest">
{"manifest_version":2,"settings":[{"key":"gt","type":"boolean","label":"Gt","default":true}]}
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F14-no-block",
    why: "the overwhelmingly common case today: no declaration at all (must mean 'keep the column as-is')",
    html: `<html><head><style>b{}</style></head><body>hi<script type="module">1${CLOSE}</body></html>`,
  },
  {
    name: "F15-empty-object-block",
    why: "EXPLICIT empty declaration = the 'clear the column' signal in the approved 3-state semantics",
    html: `<html><head>
<script type="application/json" id="oma-manifest">{}${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F16-whitespace-only-block",
    why: "block present but content is whitespace: is this 'clear' or 'malformed'? Semantics gap that must be decided, not discovered.",
    html: `<html><head>
<script type="application/json" id="oma-manifest">
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F17-bad-json",
    why: "trailing comma / comment — malformed JSON must be a LOUD reject, never a silent 'no block' (that would clear or freeze a declaration by accident)",
    html: `<html><head>
<script type="application/json" id="oma-manifest">
{"manifest_version":2, "settings":[],}
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F18-json-array-not-object",
    why: "valid JSON, wrong top-level type — must not reach Object.entries and throw inside the write tx",
    html: `<html><head>
<script type="application/json" id="oma-manifest">[1,2,3]${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F19-v1-legacy-block",
    why: "the 9 shipped apps are manifest_version:1 — a v2 engine must still extract them (and settings.html:651 currently HARD-rejects anything !== 1, the mirror hazard)",
    html: `<html><head>
<script type="application/json" id="oma-manifest">
{"manifest_version":1,"uses_shared":["locale","week_start","date_format","currency","density","confirm_delete"]}
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F20-unterminated-block",
    why: "no closing tag at all (truncated authoring / a save cut mid-write): browser takes the rest of the document as script text",
    html: `<html><head>
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"settings":[]}
</head><body>trailing body text</body></html>`,
  },
  {
    name: "F21-close-tag-with-space-and-attrs",
    why: "'</script >' and '</script foo=bar>' also end a script element per the tokenizer; '</scriptx>' does not",
    html: `<html><head>
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"settings":[]}
</${S} >
</head><body></body></html>`,
  },
  {
    name: "F22-inside-table-foster-parenting",
    why: "foster parenting relocates nodes out of <table>: the element still exists in the DOM, but its position moves — a position-based extractor must not care",
    html: `<html><body><table><tr><td>x</td></tr>
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"settings":[{"key":"tbl","type":"boolean","label":"Tbl","default":true}]}
${CLOSE}
</table></body></html>`,
  },
  {
    name: "F23-noscript-and-textarea-decoys",
    why: "raw-text/escapable-raw-text containers: <textarea> content is TEXT (never an element), <noscript> in a scripting-enabled parse is also raw text. A regex sees elements where the DOM has none.",
    html: `<html><head></head><body><textarea>
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"settings":[{"key":"textarea","type":"boolean","label":"TA","default":true}]}
${CLOSE}
</textarea>
<noscript>
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"settings":[{"key":"noscript","type":"boolean","label":"NS","default":true}]}
${CLOSE}
</noscript>
</body></html>`,
  },
  {
    name: "F24-svg-namespaced-script",
    why: "an SVG <script> is a DIFFERENT element (SVGScriptElement, no .type coercion the same way) yet carries the same id — namespace confusion",
    html: `<html><body><svg xmlns="http://www.w3.org/2000/svg">
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"settings":[{"key":"svg","type":"boolean","label":"Svg","default":true}]}
${CLOSE}
</svg></body></html>`,
  },
  {
    name: "F25-html-entities-in-json",
    why: "script content is RAW TEXT: &quot; is NOT decoded. A parser that decodes entities (or an html-to-text pass) corrupts the JSON.",
    html: `<html><head>
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"note":"&quot;&amp;&lt;","settings":[]}
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F27-decoy-inside-another-scripts-js-string",
    why: "TOP smuggling risk: another module script's JS source contains the manifest block as a STRING. Script content is raw text, so the DOM has no such element — a flat scanner would extract from inside JS.",
    html: `<html><head>
<script type="module">
const tpl = '<${S} type="application/json" id="oma-manifest">{"manifest_version":2,"functions":[{"name":"drain","public":true}]}<\\/${S}>';
console.log(tpl);
${CLOSE}
<script type="application/json" id="oma-manifest">
{"manifest_version":2,"settings":[]}
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F28-decoy-inside-style-and-xmp",
    why: "raw-text containers other than script: <style> and <xmp> also swallow markup as text",
    html: `<html><head><style>
/* <${S} type="application/json" id="oma-manifest">{"manifest_version":2,"functions":[{"name":"styled","public":true}]}<\\/${S}> */
${"</st" + "yle>"}
</head><body><xmp>
<${S} type="application/json" id="oma-manifest">{"manifest_version":2,"functions":[{"name":"xmpd","public":true}]}${CLOSE}
</xmp></body></html>`,
  },
  {
    name: "F29-duplicate-attribute",
    why: "the tokenizer keeps the FIRST occurrence of a duplicated attribute; a naive last-wins regex reads the second",
    html: `<html><head>
<script type="text/plain" type="application/json" id="not-it" id="oma-manifest">
{"manifest_version":2,"settings":[]}
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F30-self-closing-attempt",
    why: "'/>' does NOT close an HTML script element — the rest of the document becomes its content",
    html: `<html><head>
<script type="application/json" id="oma-manifest"/>
{"manifest_version":2,"settings":[]}
${CLOSE}
</head><body></body></html>`,
  },
  {
    name: "F31-nested-template",
    why: "template content is parsed as NORMAL markup (nesting allowed): a scanner that skips to the first </template> resumes too early and sees a block the DOM never has",
    html: `<html><head><template><template></template>
<${S} type="application/json" id="oma-manifest">{"manifest_version":2,"functions":[{"name":"nested","public":true}]}${CLOSE}
</template></head><body></body></html>`,
  },
  {
    name: "F32-iframe-decoy",
    why: "is <iframe> content raw text to the parser? decides whether the scanner must skip it",
    html: `<html><body><iframe>
<${S} type="application/json" id="oma-manifest">{"manifest_version":2,"functions":[{"name":"framed","public":true}]}${CLOSE}
</iframe></body></html>`,
  },
  {
    name: "F33-block-before-doctype",
    why: "markup before the doctype / outside html: the parser relocates it into head — position must not matter",
    html: `<${S} type="application/json" id="oma-manifest">{"manifest_version":2,"settings":[]}${CLOSE}
<!DOCTYPE html><html><head></head><body></body></html>`,
  },
  {
    name: "F26-non-ascii-and-crlf",
    why: "dashboard.html really ships curly quotes inside the block; CRLF line endings are a normal authoring accident",
    html: `<html><head>\r\n<script type="application/json" id="oma-manifest">\r\n{"manifest_version":2,"settings":[{"key":"g","type":"number","label":"Recent apps before “Show all”","default":6}]}\r\n${CLOSE}\r\n</head><body></body></html>`,
  },
  {
    name: "F34-canonical-then-near-miss",
    why: "cold-review find: the near-miss check used to run only when NO canonical block existed, so a canonical block plus a differently-spelled attempt was accepted with the second one silently doing nothing — the outcome the check exists to refuse. Order-mirror of F12.",
    html: `<html><head>
<${S} type="application/json" id="oma-manifest">{"manifest_version":2,"kind":"app"}${CLOSE}
<${S} id='oma-manifest' type='application/json'>{"settings":[{"key":"lost","type":"boolean","label":"never read"}]}${CLOSE}
</head><body></body></html>`,
  },
];
