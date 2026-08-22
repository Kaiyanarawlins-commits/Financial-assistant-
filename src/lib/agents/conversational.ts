import type { ConversationMemory } from './conversation';

/**
 * The conversational layer.
 *
 * The specialists write good *answers*; left alone they write the same good
 * answer every time. Across a thread that reads as a system that is not
 * listening — the third reply repeating the standing advice about autopay is
 * the moment a user stops treating it as a conversation.
 *
 * Three things happen here, all of them functions of what has already been
 * said: content the user has already been given is removed, the opening line
 * acknowledges the turn it is answering, and the reply closes with somewhere
 * to go next.
 */

/** Rough content fingerprint, so near-identical paragraphs collapse together. */
function fingerprint(paragraph: string): string {
  return paragraph
    .toLowerCase()
    .replace(/\*\*/g, '')
    // Figures change between turns while the sentence does not; ignoring them
    // is what lets "your fixed costs are $3,160" match the same line next turn.
    .replace(/[$£€]\s?[\d,]+(?:\.\d+)?/g, '#')
    .replace(/\d+(?:\.\d+)?%/g, '%')
    .replace(/[^a-z#% ]+/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .slice(0, 12)
    .join(' ');
}

/** Paragraphs short enough to be a heading or a figure are never suppressed. */
const MIN_SUPPRESSIBLE_LENGTH = 90;

export interface Trimmed {
  text: string;
  /** How many paragraphs were dropped as already-said. */
  removed: number;
}

/**
 * Removes paragraphs the user has already been given in this thread.
 *
 * Only prose is eligible: figures, headings and bullet lists carry the answer
 * itself, and dropping those to avoid repetition would remove the substance
 * rather than the padding.
 */
export function trimRepetition(answer: string, memory: ConversationMemory): Trimmed {
  const alreadySaid = new Set(
    memory.turns
      .filter((turn) => turn.role === 'advisor')
      .flatMap((turn) => turn.text.split(/\n{2,}/))
      .map(fingerprint)
      .filter(Boolean),
  );
  if (alreadySaid.size === 0) return { text: answer, removed: 0 };

  let removed = 0;
  const kept = answer.split(/\n{2,}/).filter((paragraph) => {
    const trimmedParagraph = paragraph.trim();
    if (trimmedParagraph.length < MIN_SUPPRESSIBLE_LENGTH) return true;
    if (trimmedParagraph.startsWith('-') || trimmedParagraph.startsWith('•')) return true;

    const print = fingerprint(trimmedParagraph);
    if (!print || !alreadySaid.has(print)) return true;
    removed++;
    return false;
  });

  // Never return an empty reply: if everything matched, the user asked
  // something whose answer genuinely has not changed, and saying so is better
  // than an empty bubble.
  if (kept.filter((p) => p.trim()).length === 0) {
    return {
      text: `That is the same picture as before — nothing in your numbers has moved since I last looked. Ask me something narrower and I can go deeper.`,
      removed,
    };
  }

  return { text: kept.join('\n\n'), removed };
}

/**
 * An opening line that acknowledges the turn being answered.
 *
 * Varied by turn count rather than at random, so a thread does not repeat an
 * opener and the sequence is reproducible in a test.
 */
export function acknowledgement(memory: ConversationMemory, isFollowUp: boolean): string | null {
  if (!isFollowUp) return null;

  const answered = memory.turns.filter((turn) => turn.role === 'advisor').length;
  const subject = memory.entities[0]?.name;

  const options = subject
    ? [`On ${subject}:`, `Staying with ${subject}:`, `For ${subject} specifically:`]
    : ['Following on:', 'Picking that up:', 'On that:'];

  return options[answered % options.length] ?? null;
}

/**
 * A closing line offering the obvious next question.
 *
 * Suggested rather than asked: an advisor that ends every reply with a question
 * feels like it is running a script, so this offers a direction and leaves the
 * user to take it.
 */
export function nextStep(memory: ConversationMemory, agentId: string): string | null {
  const answered = memory.turns.filter((turn) => turn.role === 'advisor').length;
  // Not on the first reply — the answer itself is enough to be going on with.
  if (answered < 1) return null;
  // And not every turn after that, or it becomes wallpaper.
  if (answered % 2 === 1) return null;

  const byAgent: Record<string, (string | null)[]> = {
    credit: ['Ask "how much would that save?" and I will price it.', 'I can compare that against your other cards.'],
    debt: ['Ask "why?" and I will show the interest arithmetic.', 'I can model a bigger payment if you want a date.'],
    budget: ['I can break any category down to the individual transactions.', 'Ask what a change would be worth.'],
    savings: ['Tell me a monthly amount and I will give you the date.', 'I can size this against your essentials.'],
    investing: ['I can explain any of those account types in more detail.', 'Ask how the tax treatment works.'],
    subscriptions: ['Ask what cancelling one is worth over a year.', 'I can compare this against your other spending.'],
    tax: ['I can pull the annual figures for a preparer.', 'Ask how any of those principles applies generally.'],
    triage: ['Ask any of the specialists directly and I will route you.', null],
  };

  const options = byAgent[agentId] ?? byAgent.triage!;
  return options[(answered / 2 - 1) % options.length] ?? null;
}

/** Applies all three, in the order they read. */
export function makeConversational(
  answer: string,
  memory: ConversationMemory,
  agentId: string,
  isFollowUp: boolean,
): string {
  const { text, removed } = trimRepetition(answer, memory);

  const opener = acknowledgement(memory, isFollowUp);
  const closer = nextStep(memory, agentId);

  const parts = [
    opener,
    removed > 0 && text.length > 200 ? null : null,
    text,
    closer ? `*${closer}*` : null,
  ].filter((part): part is string => Boolean(part));

  return parts.join('\n\n');
}
