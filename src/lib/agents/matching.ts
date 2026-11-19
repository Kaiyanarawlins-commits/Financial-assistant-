/**
 * Keyword matching for routing and intent detection.
 *
 * Exists because the two naive approaches each fail in their own direction, and
 * both failures are silent — the app keeps working and quietly answers the
 * wrong question:
 *
 *   `text.includes(term)` matches inside words. "airspeed" contains "irs", so a
 *   question about swallows routed to the Tax & Records Guide.
 *
 *   `\bterm\b` misses every inflection. "invested", "retirement" and "earned"
 *   all fail against `\binvest\b`, `\bretire\b` and `\bearn\b`, so scenario
 *   questions fell through to a generic answer that looked plausible.
 *
 * Word boundaries with optional English endings handle both.
 */

const SUFFIXES = '(?:s|es|ing|ed|d|ment|ments)?';

const escape = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const cache = new Map<string, RegExp>();

function matcherFor(term: string): RegExp {
  let regex = cache.get(term);
  if (!regex) {
    regex = new RegExp(`\\b${escape(term)}${SUFFIXES}\\b`, 'i');
    cache.set(term, regex);
  }
  return regex;
}

/** True when `text` contains `term` as a whole word, allowing common endings. */
export function containsTerm(text: string, term: string): boolean {
  return matcherFor(term).test(text);
}

export function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => containsTerm(text, term));
}
