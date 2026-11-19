import { formatMoney } from '../money';
import type { AdvisorFacts } from './facts';

/**
 * Numeric verification.
 *
 * The prompt tells the model never to invent a figure. That is necessary and
 * not sufficient — a wrong number delivered confidently is the single worst
 * failure this app can have, and "the instructions said not to" is not a
 * control. So every monetary and percentage figure in a generated answer is
 * checked against the values it was actually given before the user sees it.
 *
 * The check is deliberately one-directional: it can prove a figure came from
 * source data, and it cannot prove one did not. An unverified figure is
 * therefore treated as *unconfirmed*, not as a lie — it triggers one correction
 * round, and if it survives that, it is shown with a caution rather than
 * silently dropped. Suppressing a correct number would be its own kind of wrong.
 */

export interface Figure {
  raw: string;
  kind: 'money' | 'percent';
  /** Cents for money, percentage points for percent. */
  value: number;
}

export interface VerificationReport {
  figures: Figure[];
  verified: Figure[];
  unverified: Figure[];
  ok: boolean;
}

/** Cents of tolerance on a money match — the model rounds, and so do we. */
const MONEY_TOLERANCE = 100;
/** Percentage points of tolerance. */
const PERCENT_TOLERANCE = 1.0;

const MONEY = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g;
const PERCENT = /(\d+(?:\.\d+)?)\s?%/g;

export function extractFigures(text: string): Figure[] {
  const figures: Figure[] = [];

  for (const match of text.matchAll(MONEY)) {
    const value = Number((match[1] ?? '').replace(/,/g, ''));
    if (Number.isFinite(value)) {
      figures.push({ raw: match[0], kind: 'money', value: Math.round(value * 100) });
    }
  }
  for (const match of text.matchAll(PERCENT)) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) figures.push({ raw: match[0], kind: 'percent', value });
  }
  return figures;
}

/**
 * Every number the model was legitimately given this turn.
 *
 * Walks the fact sheet's underlying object and each tool result, because the
 * model reads both. Tool results carry dollars, facts carry cents, and getting
 * that backwards would make everything look unverified — hence the explicit
 * `scale` on each walk.
 */
export function collectSourceValues(facts: AdvisorFacts, toolResults: unknown[]): {
  money: Set<number>;
  percent: Set<number>;
} {
  const money = new Set<number>();
  const percent = new Set<number>();

  const addMoney = (cents: number) => {
    if (!Number.isFinite(cents)) return;
    const rounded = Math.round(cents);
    money.add(rounded);
    // Annualising and de-annualising are ubiquitous in this domain and are the
    // model's own arithmetic on a source value, not an invention.
    money.add(rounded * 12);
    money.add(Math.round(rounded / 12));
  };

  const walk = (node: unknown, scale: 'cents' | 'dollars') => {
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) return;
      if (scale === 'cents') addMoney(node);
      else addMoney(Math.round(node * 100));
      // A bare number may also be a percentage or a count.
      percent.add(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, scale);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (typeof value === 'number') {
          // Trust the field name over the container's default scale.
          if (/cents$/i.test(key)) addMoney(value);
          else if (/dollars$/i.test(key)) addMoney(Math.round(value * 100));
          else if (/percent$/i.test(key)) percent.add(value);
          else walk(value, scale);
          continue;
        }
        walk(value, scale);
      }
    }
  };

  walk(facts, 'cents');
  for (const result of toolResults) walk(result, 'dollars');

  // Credit-limit thresholds the specialists quote constantly.
  for (const debt of facts.debt.items) {
    if (!debt.creditLimitCents) continue;
    addMoney(Math.max(0, debt.balanceCents - Math.floor(debt.creditLimitCents * 0.3)));
    addMoney(Math.max(0, debt.balanceCents - Math.floor(debt.creditLimitCents * 0.1)));
  }

  // Round numbers used as guidance rather than as data.
  for (const guideline of [0, 10, 20, 28, 30, 36, 43, 50, 4, 7, 3, 6, 100, 35, 15]) percent.add(guideline);

  return { money, percent };
}

function matches(value: number, candidates: Set<number>, tolerance: number): boolean {
  if (candidates.has(value)) return true;
  for (const candidate of candidates) {
    if (Math.abs(candidate - value) <= tolerance) return true;
  }
  return false;
}

export function verifyAnswer(
  answer: string,
  facts: AdvisorFacts,
  toolResults: unknown[],
): VerificationReport {
  const figures = extractFigures(answer);
  const sources = collectSourceValues(facts, toolResults);

  const verified: Figure[] = [];
  const unverified: Figure[] = [];

  for (const figure of figures) {
    const ok =
      figure.kind === 'money'
        ? matches(figure.value, sources.money, MONEY_TOLERANCE)
        : matches(figure.value, sources.percent, PERCENT_TOLERANCE);
    (ok ? verified : unverified).push(figure);
  }

  return { figures, verified, unverified, ok: unverified.length === 0 };
}

/** The correction turn sent back to the model when figures do not check out. */
export function correctionPrompt(report: VerificationReport): string {
  const list = report.unverified.map((f) => f.raw).join(', ');
  return `Before that answer is shown, these figures could not be matched to the data you were given: ${list}.

Restate your answer using only figures from the fact sheet or from a tool result. If you need a number you do not have, call the appropriate tool for it — use \`calculate\` for any arithmetic. If a figure genuinely is not available, say plainly that you do not have it rather than estimating.

Reply with the corrected answer only.`;
}

/** The caution prepended when a figure survives the correction round. */
export function cautionFor(report: VerificationReport): string {
  const list = report.unverified.map((f) => f.raw).join(', ');
  return `⚠︎ I could not match ${list} to your recorded data — treat ${
    report.unverified.length === 1 ? 'that figure' : 'those figures'
  } as an estimate rather than a number from your accounts.\n\n`;
}

/** Human-readable summary, for the tool trace in the UI. */
export function describeVerification(report: VerificationReport): string {
  if (report.figures.length === 0) return 'No figures to check';
  if (report.ok) return `Checked ${report.figures.length} figures against your data`;
  return `${report.unverified.length} of ${report.figures.length} figures unmatched: ${report.unverified
    .map((f) => f.raw)
    .join(', ')}`;
}

export { formatMoney };
