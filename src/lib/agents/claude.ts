import Anthropic from '@anthropic-ai/sdk';
import type { AppState, ISODate } from '../../types';
import { redactSensitive } from '../advisor';
import { screenAnswer, screenQuestion } from './guardrails';
import { buildSystemPrompt, type Agent } from './roster';
import { executeTool, toolsFor } from './tools';
import { formatFactSheet, type AdvisorFacts } from './facts';

/**
 * The model-backed advisor.
 *
 * Runs the tool loop manually rather than through the SDK's tool runner, for
 * three reasons specific to this app: every tool call is surfaced in the UI as
 * it happens ("checked your debt analysis"), which is most of what makes the
 * advisor feel like it is doing work rather than improvising; the iteration
 * count needs a hard ceiling because a runaway loop on a consumer app spends
 * the user's money; and the loop must stay usable when the request is proxied
 * rather than direct.
 */

export type ModelId = 'claude-fable-5' | 'claude-opus-5' | 'claude-sonnet-5' | 'claude-haiku-4-5';

export interface ClaudeConfig {
  /** Direct browser calls. Only for a personal build — see the warning in Settings. */
  apiKey?: string;
  /** A server that holds the key and forwards to the API. The correct production shape. */
  proxyUrl?: string;
  model: ModelId;
  effort: 'low' | 'medium' | 'high';
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
}

export interface AgentReply {
  text: string;
  agent: Agent;
  toolCalls: ToolCallRecord[];
  refused?: boolean;
  /** Set when the model path failed and the local specialist answered instead. */
  fellBackToLocal?: boolean;
  error?: string;
}

/** Cap on tool round trips. Every specialist's job fits well inside this. */
const MAX_ITERATIONS = 6;

/**
 * Thinking is always on for Fable 5, so the parameter is omitted entirely —
 * sending `budget_tokens`, or `{type:"disabled"}`, is a 400 on this family.
 * Depth is controlled through `output_config.effort` instead.
 */
function isFableFamily(model: ModelId): boolean {
  return model === 'claude-fable-5';
}

function createClient(config: ClaudeConfig): Anthropic {
  if (config.proxyUrl) {
    // The proxy injects the real key server-side; the placeholder satisfies the
    // SDK's constructor without a key ever existing in the browser.
    return new Anthropic({
      apiKey: 'proxy',
      baseURL: config.proxyUrl,
      dangerouslyAllowBrowser: true,
    });
  }
  return new Anthropic({ apiKey: config.apiKey ?? '', dangerouslyAllowBrowser: true });
}

export function isConfigured(config: Partial<ClaudeConfig> | undefined): boolean {
  return Boolean(config?.proxyUrl || config?.apiKey);
}

export interface AskOptions {
  agent: Agent;
  facts: AdvisorFacts;
  state: AppState;
  reference: ISODate;
  config: ClaudeConfig;
  history: Anthropic.Beta.BetaMessageParam[];
  hypothetical: boolean;
  /** Called as each tool runs, so the UI can show the work in progress. */
  onToolCall?: (call: ToolCallRecord) => void;
  signal?: AbortSignal;
}

export async function askClaude(question: string, options: AskOptions): Promise<AgentReply> {
  const { agent, facts, state, reference, config, history, hypothetical, onToolCall, signal } = options;

  // Redact before anything leaves the device, then screen before spending a
  // token. A refusal decided locally cannot be argued out of by the prompt.
  const clean = redactSensitive(question);
  const blocked = screenQuestion(clean);
  if (blocked) return { text: blocked.text, agent, toolCalls: [], refused: true };

  const client = createClient(config);
  const tools = toolsFor(agent.tools);
  const system = buildSystemPrompt(agent, formatFactSheet(facts), state.settings.householdMode);

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history,
    {
      role: 'user',
      content: hypothetical
        ? `${clean}\n\n(This is a hypothetical — reason from the figures in the question, state any assumptions you make, and use the calculate tool for the arithmetic.)`
        : clean,
    },
  ];

  const toolCalls: ToolCallRecord[] = [];

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const response = await client.beta.messages.create(
        {
          model: config.model,
          max_tokens: 8000,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages,
          tools,
          output_config: { effort: config.effort },
          // Fable 5 and Opus 5 can decline on policy grounds. Server-side
          // fallbacks re-run the same request on a capable alternative inside
          // the same call, so a refusal on a benign finance question does not
          // surface to the user as a dead end.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          ...(isFableFamily(config.model) ? {} : { thinking: { type: 'adaptive' as const } }),
        },
        { signal },
      );

      if (response.stop_reason === 'refusal') {
        return {
          text: `I could not answer that one. If it was a question about budgeting, debt, credit, saving or how investing accounts work, try rephrasing it — those are all in scope.`,
          agent,
          toolCalls,
          refused: true,
        };
      }

      const toolUses = response.content.filter(
        (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use',
      );

      if (toolUses.length === 0 || response.stop_reason !== 'tool_use') {
        const text = response.content
          .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim();

        if (!text) {
          return {
            text: agent.localAnswer(facts, state, clean),
            agent,
            toolCalls,
            fellBackToLocal: true,
          };
        }

        // Last line of defence: the prompt forbids recommendations and
        // guarantees, but "usually complies" is not the bar for a finance app.
        const violation = screenAnswer(text);
        if (violation) return { text: violation.text, agent, toolCalls, refused: true };

        return { text, agent, toolCalls };
      }

      messages.push({ role: 'assistant', content: response.content });

      // All tool results must return in a single user message — splitting them
      // across messages teaches the model to stop calling tools in parallel.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((use) => {
        const input = (use.input ?? {}) as Record<string, unknown>;
        const record = { name: use.name, input };
        toolCalls.push(record);
        onToolCall?.(record);
        try {
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: JSON.stringify(executeTool(use.name, input, state, reference)),
          };
        } catch (error) {
          return {
            type: 'tool_result',
            tool_use_id: use.id,
            content: `Tool failed: ${error instanceof Error ? error.message : 'unknown error'}`,
            is_error: true,
          };
        }
      });

      messages.push({ role: 'user', content: results });
    }

    // Ran out of iterations without a final answer.
    return { text: agent.localAnswer(facts, state, clean), agent, toolCalls, fellBackToLocal: true };
  } catch (error) {
    return {
      text: agent.localAnswer(facts, state, clean),
      agent,
      toolCalls,
      fellBackToLocal: true,
      error: describeError(error),
    };
  }
}

/**
 * Turns an SDK error into something a user can act on. Checked most specific
 * first — a single broad catch would collapse "your key is wrong" and "you are
 * rate limited" into the same unhelpful message.
 */
export function describeError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'That API key was rejected. Check it in Settings, or switch back to the built-in advisor.';
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return 'That key does not have access to this model. Try a different model in Settings.';
  }
  if (error instanceof Anthropic.RateLimitError) {
    return 'Rate limited by the API. Wait a moment and ask again.';
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `The API rejected the request: ${error.message}`;
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the API — check your connection. The built-in advisor answered instead.';
  }
  if (error instanceof Anthropic.APIError) {
    return `API error ${error.status}: ${error.message}`;
  }
  if (error instanceof Error && error.name === 'AbortError') return 'Cancelled.';
  return error instanceof Error ? error.message : 'Something went wrong.';
}
