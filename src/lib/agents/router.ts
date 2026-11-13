import { AGENTS, AGENT_LIST, type Agent, type AgentId } from './roster';
import { isHypothetical } from './calculators';
import { containsTerm } from './matching';

/**
 * Routing.
 *
 * Deterministic and local: a keyword score decides the specialist before any
 * model call. Two reasons it is not an LLM classifier — routing must work
 * offline, and spending a round trip to decide who answers doubles the latency
 * of every question for a decision that scoring gets right.
 *
 * Multi-word phrases outrank single words, since "credit card debt" should
 * reach the Debt Strategist rather than the Credit Coach even though both
 * contain "credit".
 */

export interface Route {
  agent: Agent;
  /** 0–1. Low confidence falls back to the generalist. */
  confidence: number;
  /** Runners-up, for "the Debt Strategist can go deeper on this". */
  alternates: Agent[];
  /** The question asks about a scenario rather than the user's stored data. */
  hypothetical: boolean;
}

const MIN_CONFIDENCE = 0.18;

/** A follow-up must match another specialist this strongly to move the thread. */
const FOLLOW_UP_SWITCH_CONFIDENCE = 0.45;

function scoreAgent(agent: Agent, question: string): number {
  let score = 0;
  for (const keyword of agent.keywords) {
    if (!containsTerm(question, keyword)) continue;
    // Longer, more specific phrases carry more signal than common words.
    const words = keyword.split(' ').length;
    score += words > 1 ? 3 + words : keyword.length > 6 ? 1.6 : 1;
  }
  return score;
}

/**
 * @param previousAgent The specialist that answered last. A follow-up carries
 *   little routing signal of its own ("why?", "what about the Visa?"), so
 *   re-routing it from scratch hands the thread to whoever happens to match a
 *   stray word — the conversational equivalent of being transferred mid-sentence.
 * @param isFollowUp Whether this turn depends on the previous one.
 */
export function route(question: string, previousAgent?: AgentId | null, isFollowUp = false): Route {
  const normalised = question.toLowerCase();
  const hypothetical = isHypothetical(question);

  const scored = AGENT_LIST.filter((agent) => agent.id !== 'triage')
    .map((agent) => ({ agent, score: scoreAgent(agent, normalised) }))
    .sort((a, b) => b.score - a.score);

  const total = scored.reduce((sum, entry) => sum + entry.score, 0);
  const best = scored[0];

  // Hold the thread unless the follow-up clearly changes subject. The bar is
  // deliberately higher than a first question's: switching specialist mid-topic
  // is more disruptive than answering a tangent from the current one.
  const sticky = isFollowUp && previousAgent ? AGENTS[previousAgent] : null;

  if (!best || best.score === 0 || total === 0) {
    return sticky
      ? { agent: sticky, confidence: 0.5, alternates: [], hypothetical }
      : { agent: AGENTS.triage, confidence: 0, alternates: [], hypothetical };
  }

  const confidence = best.score / total;

  if (sticky && confidence < FOLLOW_UP_SWITCH_CONFIDENCE) {
    return { agent: sticky, confidence, alternates: [best.agent], hypothetical };
  }

  if (confidence < MIN_CONFIDENCE) {
    return {
      agent: AGENTS.triage,
      confidence,
      alternates: scored.slice(0, 2).map((entry) => entry.agent),
      hypothetical,
    };
  }

  return {
    agent: best.agent,
    confidence,
    alternates: scored
      .slice(1, 3)
      .filter((entry) => entry.score > 0)
      .map((entry) => entry.agent),
    hypothetical,
  };
}

export function agentById(id: AgentId): Agent {
  return AGENTS[id];
}
