import type { AppState } from '../../types';
import { formatMoney } from '../money';
import type { AdvisorFacts } from './facts';
import { GLOSSARY, getTerm, termsIn } from './glossary';
import { containsTerm } from './matching';
import type { AgentId } from './roster';

/**
 * Conversation memory.
 *
 * Without it every question is answered cold, which is what makes an assistant
 * feel like a search box rather than someone you are talking to. Ask "how do I
 * fix my utilization?", then "what about the Visa?" — the second question is
 * unanswerable on its own and completely clear in context.
 *
 * Three things are tracked, because they are what a follow-up actually depends
 * on: the entities under discussion (which account, which category), the terms
 * already defined (so they become shorthand rather than being re-explained),
 * and the last recommendation (so "why?" and "how much would that save?" have
 * something to attach to).
 */

export type EntityKind = 'category' | 'debt' | 'goal';

export interface Entity {
  kind: EntityKind;
  id: string;
  name: string;
}

export interface Turn {
  role: 'user' | 'advisor';
  text: string;
}

export interface ConversationMemory {
  /** Most recent first. The subject a bare follow-up refers to. */
  entities: Entity[];
  /** Glossary term ids the advisor has already defined in this conversation. */
  introducedTerms: string[];
  /** The specialist that answered last, for sticky routing on follow-ups. */
  lastAgent: AgentId | null;
  /** The last question, so an elliptical follow-up can be expanded against it. */
  lastQuestion: string | null;
  /** A short description of the last thing the advisor suggested. */
  lastRecommendation: string | null;
  /** Monthly figure attached to the last suggestion, for "how much would that save?". */
  lastProposedMonthlyDeltaCents: number | null;
  turns: Turn[];
}

export function emptyMemory(): ConversationMemory {
  return {
    entities: [],
    introducedTerms: [],
    lastAgent: null,
    lastQuestion: null,
    lastRecommendation: null,
    lastProposedMonthlyDeltaCents: null,
    turns: [],
  };
}

// ---------------------------------------------------------------------------
// Entity extraction
// ---------------------------------------------------------------------------

/** Everything in the user's data that a conversation could be *about*. */
export function knownEntities(state: AppState): Entity[] {
  return [
    ...state.categories.map((c) => ({ kind: 'category' as const, id: c.id, name: c.name })),
    ...state.debts.map((d) => ({ kind: 'debt' as const, id: d.id, name: d.name })),
    ...state.goals.map((g) => ({ kind: 'goal' as const, id: g.id, name: g.name })),
  ];
}

/**
 * Finds entities named in a piece of text.
 *
 * Matches on significant words rather than the whole label, because nobody
 * types "Visa — everyday card". They type "the Visa", and a whole-label match
 * would find nothing.
 */
export function entitiesIn(text: string, state: AppState): Entity[] {
  const lower = text.toLowerCase();
  const found: Entity[] = [];

  for (const entity of knownEntities(state)) {
    const words = entity.name
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
    if (words.length === 0) continue;
    // Whole words only. A prefix match made "auto" (Auto/Transportation) fire on
    // "autopay" in a credit answer, so the thread's subject silently became a
    // category nobody had mentioned.
    if (words.some((word) => containsTerm(lower, word))) found.push(entity);
  }
  return found;
}

const STOP_WORDS = new Set(['card', 'loan', 'fund', 'note', 'everyday', 'standing', 'budget', 'payments']);

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

/**
 * Openings that only make sense as a continuation.
 *
 * Anchored to the start of the question rather than searched anywhere in it:
 * "why" appearing mid-sentence ("I want to know why savings matter") is a
 * complete question, and treating it as a follow-up would answer the wrong one.
 */
const FOLLOW_UP_OPENER =
  /^\s*(?:and|but|so|ok|okay|why|how come|what about|how about|is that|are those|does that|would that|will that|which one|explain that|say more|go on|tell me more|compared to|what else|and then)\b/i;

/**
 * Demonstratives, which nearly always point at something already said.
 *
 * "it" is deliberately excluded: it appears in ordinary self-contained
 * questions ("are my subscriptions worth it?") far too often to be a signal,
 * and treating those as follow-ups sent them to the wrong handler entirely.
 */
const DEMONSTRATIVE = /\b(?:that|this|those|these|the same)\b/i;

/** "the Visa?", "my emergency fund?" — a bare noun phrase with no verb. */
const BARE_REFERENCE = /^\s*(?:the|my|those|that|this)\s+[\w\s'-]{1,28}\??\s*$/i;

export interface Resolution {
  /** The question with references expanded, for routing and for the model. */
  question: string;
  /** True when this turn depends on the previous one. */
  isFollowUp: boolean;
  /** The entity the follow-up is about, if one carried over. */
  subject: Entity | null;
}

/**
 * Expands a follow-up into a self-contained question.
 *
 * Routing and the offline specialists both work on a single question, so
 * "what about the Visa?" has to become "what about the Visa (credit utilization,
 * following on from: how do I fix my utilization?)" before either sees it.
 * The model gets the same expansion, which keeps the two paths consistent.
 */
export function resolveReferences(
  question: string,
  memory: ConversationMemory,
  state: AppState,
): Resolution {
  const trimmed = question.trim();
  const mentioned = entitiesIn(trimmed, state);
  const wordCount = trimmed.split(/\s+/).length;

  const opener = FOLLOW_UP_OPENER.test(trimmed);
  const demonstrative = DEMONSTRATIVE.test(trimmed) && wordCount <= 9;
  const bare = wordCount <= 6 && BARE_REFERENCE.test(trimmed);

  const isFollowUp = Boolean(memory.lastQuestion) && (opener || demonstrative || bare);
  if (!isFollowUp) {
    return { question: trimmed, isFollowUp: false, subject: mentioned[0] ?? null };
  }

  // A named entity in the follow-up wins; otherwise carry the last subject.
  const subject = mentioned[0] ?? memory.entities[0] ?? null;

  const context: string[] = [];
  if (subject) context.push(`about ${subject.name}`);
  if (memory.lastQuestion) context.push(`following on from: "${memory.lastQuestion}"`);
  if (memory.lastRecommendation) context.push(`last suggestion: ${memory.lastRecommendation}`);

  return {
    question: context.length > 0 ? `${trimmed} (${context.join('; ')})` : trimmed,
    isFollowUp: true,
    subject,
  };
}

// ---------------------------------------------------------------------------
// Updating
// ---------------------------------------------------------------------------

const MAX_ENTITIES = 4;
const MAX_TURNS = 12;

export function rememberQuestion(
  memory: ConversationMemory,
  question: string,
  state: AppState,
): ConversationMemory {
  const mentioned = entitiesIn(question, state);
  return {
    ...memory,
    entities: mergeEntities(mentioned, memory.entities),
    lastQuestion: question,
    turns: [...memory.turns, { role: 'user' as const, text: question }].slice(-MAX_TURNS),
  };
}

export function rememberAnswer(
  memory: ConversationMemory,
  answer: string,
  agent: AgentId,
  state: AppState,
  facts: AdvisorFacts,
): ConversationMemory {
  // The user decides what the conversation is about; the advisor's own prose
  // does not. An answer can only *reinforce* a subject already raised — without
  // this, a debt answer that happens to say "savings rate" quietly made
  // Savings/Investing the referent of the next "it".
  const known = new Set(memory.entities.map((e) => `${e.kind}:${e.id}`));
  const reinforced = entitiesIn(answer, state).filter((e) => known.has(`${e.kind}:${e.id}`));
  const introduced = new Set([...memory.introducedTerms, ...termsIn(answer)]);

  return {
    ...memory,
    entities: mergeEntities(reinforced, memory.entities),
    introducedTerms: [...introduced],
    lastAgent: agent,
    lastRecommendation: extractRecommendation(answer) ?? memory.lastRecommendation,
    lastProposedMonthlyDeltaCents: extractProposedDelta(answer, facts) ?? memory.lastProposedMonthlyDeltaCents,
    turns: [...memory.turns, { role: 'advisor' as const, text: answer }].slice(-MAX_TURNS),
  };
}

function mergeEntities(fresh: Entity[], existing: Entity[]): Entity[] {
  const seen = new Set<string>();
  const merged: Entity[] = [];
  for (const entity of [...fresh, ...existing]) {
    const key = `${entity.kind}:${entity.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entity);
  }
  return merged.slice(0, MAX_ENTITIES);
}

/**
 * Pulls the actionable sentence out of an answer, so "why?" has an antecedent.
 * Heuristic by necessity — it looks for the imperative shapes the specialists
 * actually use rather than trying to parse the prose.
 */
function extractRecommendation(answer: string): string | null {
  const sentences = answer
    .replace(/\*\*/g, '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const cues =
    /\b(paying|pay|put|move|cancel|cut|set aside|automate|start|clear|hold back|switch|call|raise|add)\b/i;

  for (const sentence of sentences) {
    // Real advice can be terse ("Pay $560 before the statement closes."), so the
    // floor only has to exclude fragments.
    if (sentence.length < 18 || sentence.length > 260) continue;
    if (!cues.test(sentence)) continue;
    if (/^(you have|you owe|your |that is|here is|for )/i.test(sentence)) continue;
    return sentence;
  }
  return null;
}

/** A dollar figure in the last answer, used as the default for "how much would that save?". */
function extractProposedDelta(answer: string, facts: AdvisorFacts): number | null {
  const match = answer.match(/\$([\d,]+(?:\.\d{2})?)\s*(?:a|per|\/)\s*(?:month|mo)\b/i);
  if (match?.[1]) return Math.round(Number(match[1].replace(/,/g, '')) * 100);
  // Fall back to the user's own leftover, which is the realistic lever.
  return facts.cashflow.remainingBalanceCents > 0 ? null : null;
}

// ---------------------------------------------------------------------------
// Rendering for the model
// ---------------------------------------------------------------------------

/**
 * A compact conversation-state block for the system prompt.
 *
 * Deliberately separate from the message history: the history shows what was
 * said, this says what is *established*. A model reading twelve turns can lose
 * track of which terms it already defined; a four-line summary cannot.
 */
export function formatMemory(memory: ConversationMemory): string {
  if (memory.turns.length === 0) return '';

  const lines: string[] = ['CONVERSATION STATE'];

  if (memory.entities.length > 0) {
    lines.push(
      `- Under discussion: ${memory.entities.map((e) => `${e.name} (${e.kind})`).join(', ')}. A bare "it" or "that" means the first of these.`,
    );
  }

  if (memory.introducedTerms.length > 0) {
    const labels = memory.introducedTerms
      .map((id) => getTerm(id)?.label)
      .filter((label): label is string => Boolean(label));
    if (labels.length > 0) {
      lines.push(
        `- Terms already explained: ${labels.join(', ')}. Use these as shorthand now — do not re-define them.`,
      );
    }
  }

  const undefinedTerms = GLOSSARY.filter((term) => !memory.introducedTerms.includes(term.id))
    .slice(0, 6)
    .map((term) => term.label);
  if (undefinedTerms.length > 0) {
    lines.push(`- Not yet explained (define briefly on first use): ${undefinedTerms.join(', ')}`);
  }

  if (memory.lastRecommendation) {
    lines.push(`- Your last suggestion: "${memory.lastRecommendation}". "Why?" refers to this.`);
  }

  if (memory.lastProposedMonthlyDeltaCents) {
    lines.push(
      `- Figure last discussed: ${formatMoney(memory.lastProposedMonthlyDeltaCents)}/month. "That" in an amount question means this.`,
    );
  }

  return lines.join('\n');
}

/** Terms the advisor has used that were never defined — the offline path's first-use check. */
export function needsDefinition(memory: ConversationMemory, termId: string): boolean {
  return !memory.introducedTerms.includes(termId);
}

/** `utilization (the share of a credit limit you are using)` on first use, bare afterwards. */
export function withDefinition(memory: ConversationMemory, termId: string): string {
  const term = getTerm(termId);
  if (!term) return '';
  return needsDefinition(memory, termId) ? `${term.label} — ${term.short} — ` : `${term.label} `;
}
