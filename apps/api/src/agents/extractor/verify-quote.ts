/**
 * Does this quote actually occur in the transcript, and where?
 *
 * This is the provenance check, and SPEC is explicit that it is code rather
 * than a prompt instruction: a model asked whether its own evidence is real
 * will say yes.
 *
 * SPEC describes it as verifying the quote "actually appears" in the
 * transcript, which reads as an exact substring test. Implemented that way it
 * would be worse than useless. A transcript wraps lines; a model re-emitting a
 * span through JSON collapses those newlines to spaces. Transcripts contain
 * typographic quotes and en-dashes; models normalise them to ASCII. Every one
 * of those honest extractions would be recorded as a hallucination, and the
 * Phase 6 hallucination-rate metric would measure Unicode rather than
 * truthfulness.
 *
 * So the comparison is normalised: whitespace runs collapse, typographic
 * punctuation folds to ASCII, NFKC is applied, and case is ignored. What it
 * still catches is the thing worth catching - a quote whose words are not in
 * the transcript at all. You cannot fabricate a requirement by changing
 * capitalisation.
 *
 * The returned offsets index the ORIGINAL transcript, not the normalised one,
 * so Phase 5 can highlight the true span in the text the human reads.
 */

/** Typographic characters models routinely rewrite. Folded before comparison. */
const FOLDED: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "‛": "'",
  "′": "'",
  "“": '"',
  "”": '"',
  "„": '"',
  "″": '"',
  "«": '"',
  "»": '"',
  "–": "-",
  "—": "-",
  "−": "-",
  "…": "...",
};

interface Normalized {
  text: string;
  /** offsets[i] is the index in the original string of normalized character i. */
  offsets: number[];
}

function fold(char: string): string {
  const mapped = FOLDED[char];
  if (mapped !== undefined) return mapped;
  return char.normalize("NFKC");
}

/**
 * Normalises while keeping a per-character map back to the original, which is
 * what makes it possible to report real offsets after a fuzzy match.
 *
 * Iterating with for..of walks code points, so surrogate pairs stay intact; the
 * index is advanced by the character's own UTF-16 length rather than by one.
 */
function normalize(source: string): Normalized {
  const chars: string[] = [];
  const offsets: number[] = [];
  let pendingSpace = false;
  let index = 0;

  for (const char of source) {
    const width = char.length;

    if (/\s/u.test(char)) {
      // Leading whitespace is dropped entirely; interior runs collapse to one
      // space, emitted only once a non-space character follows.
      pendingSpace = chars.length > 0;
      index += width;
      continue;
    }

    if (pendingSpace) {
      chars.push(" ");
      offsets.push(index);
      pendingSpace = false;
    }

    // Stepped by UTF-16 unit rather than by code point: `offsets` is indexed by
    // position in the joined string, so a character that occupies two units
    // needs two entries or every offset after it is wrong.
    const folded = fold(char).toLowerCase();
    for (let unit = 0; unit < folded.length; unit++) {
      chars.push(folded.charAt(unit));
      offsets.push(index);
    }

    index += width;
  }

  return { text: chars.join(""), offsets };
}

export type QuoteVerification =
  | { found: true; start: number; end: number }
  | { found: false };

/** Width of the original character starting at `index`, in UTF-16 units. */
function charWidthAt(source: string, index: number): number {
  const codePoint = source.codePointAt(index);
  return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

export function verifySourceQuote(transcript: string, quote: string): QuoteVerification {
  const haystack = normalize(transcript);
  const needle = normalize(quote);

  // A quote that is only whitespace evidences nothing.
  if (needle.text.length === 0) return { found: false };

  const at = haystack.text.indexOf(needle.text);
  if (at === -1) return { found: false };

  const start = haystack.offsets[at];
  const lastIndex = haystack.offsets[at + needle.text.length - 1];

  /* c8 ignore next 3 */
  if (start === undefined || lastIndex === undefined) {
    // Unreachable: both indices are inside a match that was just found.
    return { found: false };
  }

  return { found: true, start, end: lastIndex + charWidthAt(transcript, lastIndex) };
}
