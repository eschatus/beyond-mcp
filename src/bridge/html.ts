// HTML entity decoding, shared by every surface that reads DDB's display strings: campaign
// and character names (ddb-rt.ts) and monster description blobs (dndbeyond.ts). One decoder,
// so names don't decode worse than statblocks — they used to, via a smaller second copy.

// Numeric entities are decoded FIRST (homebrew statblocks litter descriptions with &#160;
// etc.), which also means the named &#39; pass below is normally redundant — it stays as a
// cheap backstop.
const NAMED: Array<[RegExp, string]> = [
  [/&amp;/g, "&"], [/&lt;/g, "<"], [/&gt;/g, ">"], [/&quot;/g, '"'],
  [/&#39;/g, "'"], [/&rsquo;/g, "'"], [/&lsquo;/g, "'"],
  [/&nbsp;/g, " "], [/&mdash;/g, "—"], [/&ndash;/g, "–"],
];

// String.fromCodePoint throws RangeError above 0x10FFFF, and a single malformed entity in one
// homebrew statblock used to fail the whole monster lookup. Out-of-range entities are left as
// the literal text they were, which is what browsers do.
function codePoint(n: number, original: string): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : original;
}

export function decodeEntities(s: string): string {
  let out = s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codePoint(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, n) => codePoint(Number(n), m));
  for (const [pattern, replacement] of NAMED) out = out.replace(pattern, replacement);
  // DDB peppers display names with non-breaking spaces, and the numeric (&#160;) and named
  // (&nbsp;) forms would otherwise decode to different characters. Consumers compare these
  // strings, so both land on a plain space. Written as an escape, not a literal — an nbsp
  // in source is invisible to the next reader.
  return out.replace(/\u00a0/g, " ");
}
