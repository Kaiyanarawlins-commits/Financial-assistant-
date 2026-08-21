import Anthropic from '@anthropic-ai/sdk';
import type { AppState, ISODate } from '../../types';
import { redactSensitive } from '../advisor';
import { screenAnswer, screenQuestion } from './guardrails';
import { buildSystemPrompt, type Agent } from './roster';
import { executeTool, toolsFor } from './tools';
import { formatFactSheet, type AdvisorFacts } from './facts';
import {
  cautionFor,
  correctionPrompt,
  describeVerification,
  verifyAnswer,
  type VerificationReport,
} from './verify';

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
  /** What the numeric check found, for display and for the tool trace. */
  verification?: VerificationReport;
  /** True when a figure survived the correction round unmatched. */
  unverifiedFigures?: boolean;
}

/** Cap on tool round trips. Every specialist's job fits well inside this. */
const MAX_ITERATIONS = 6;

/**
 * Hard ceiling on one question. Past this the answer is not worth waiting for:
 * the local specialist has a correct answer available immediately, and a spinner
 * that never resolves is worse than a slightly less nuanced reply.
 */
const REQUEST_TIMEOUT_MS = 45_000;

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
  /** Established context — entities under discussion, terms already defined. */
  conversationState?: string;
  /** Called as each tool runs, so the UI can show the work in progress. */
  onToolCall?: (call: ToolCallRecord) => void;
  /** Called with each text chunk as it arrives, for token-by-token rendering. */
  onText?: (chunk: string) => void;
  /** Called when the answer is being re-checked, so the UI can say so. */
  onStatus?: (status: string) => void;
  signal?: AbortSignal;
}

export async function askClaude(question: string, options: AskOptions): Promise<AgentReply> {
  const {
    agent,
    facts,
    state,
    reference,
    config,
    history,
    hypothetical,
    conversationState = '',
    onToolCall,
    onText,
    onStatus,
    signal,
  } = options;

  // Redact before anything leaves the device, then screen before spending a
  // token. A refusal decided locally cannot be argued out of by the prompt.
  const clean = redactSensitive(question);
  const blocked = screenQuestion(clean);
  if (blocked) return { text: blocked.text, agent, toolCalls: [], refused: true };

  const client = createClient(config);
  const tools = toolsFor(agent.tools);
  const system = buildSystemPrompt(
    agent,
    formatFactSheet(facts),
    state.settings.householdMode,
    conversationState,
  );

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
  /** Everything the tools returned, so the verifier knows what was legitimately available. */
  const toolResults: unknown[] = [];

  // A slow call must not strand the user: the local specialist has a correct
  // answer ready immediately, so the request gets a hard deadline.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
  const abortSignal = combineSignals(signal, deadline.signal);

  /** One request/tool cycle, streaming text as it arrives. Returns the final text. */
  const runLoop = async (): Promise<string | null> => {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const stream = client.beta.messages.stream(
        {
          model: config.model,
          max_tokens: 8000,
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages,
          tools,
          output_config: { effort: config.effort },
          // Fable 5 and Opus 5 can decline on policy grounds. Server-side
          // fallbacks re-run the same request on a capable alternative inside
          // the same call, so a refusal on a benign finance question is not a
          // dead end for the user.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          ...(isFableFamily(config.model) ? {} : { thinking: { type: 'adaptive' as const } }),
        },
        { signal: abortSignal },
      );

      if (onText) stream.on('text', onText);
      const response = await stream.finalMessage();

      if (response.stop_reason === 'refusal') return null;

      const toolUses = response.content.filter(
        (block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use',
      );

      if (toolUses.length === 0 || response.stop_reason !== 'tool_use') {
        return response.content
          .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim();
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
          const output = executeTool(use.name, input, state, reference);
          toolResults.push(output);
          return { type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(output) };
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
    return null;
  };

  try {
    let answer = await runLoop();
    if (!answer) {
      return { text: agent.localAnswer(facts, state, clean), agent, toolCalls, fellBackToLocal: true };
    }

    // Every figure is checked against what the model was actually given. A
    // wrong number delivered confidently is the worst failure this app has, and
    // "the prompt said not to" is not a control.
    let report = verifyAnswer(answer, facts, toolResults);

    if (!report.ok) {
      onStatus?.(describeVerification(report));
      messages.push({ role: 'assistant', content: answer });
      messages.push({ role: 'user', content: correctionPrompt(report) });

      const corrected = await runLoop();
      if (corrected) {
        answer = corrected;
        report = verifyAnswer(answer, facts, toolResults);
      }
    }

    const violation = screenAnswer(answer);
    if (violation) return { text: violation.text, agent, toolCalls, refused: true };

    return {
      text: report.ok ? answer : `${cautionFor(report)}${answer}`,
      agent,
      toolCalls,
      verification: report,
      unverifiedFigures: !report.ok,
    };
  } catch (error) {
    const timedOut = deadline.signal.aborted;
    return {
      text: agent.localAnswer(facts, state, clean),
      agent,
      toolCalls,
      fellBackToLocal: true,
      error: timedOut
        ? 'The AI advisor took too long, so the built-in specialist answered instead.'
        : describeError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Aborts when either signal does.
 *
 * `AbortSignal.any` is not available everywhere this runs, and a missing
 * timeout would be invisible until a request hung — so the fallback wires the
 * listeners by hand rather than assuming.
 */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  if (typeof AbortSignal !== 'undefined' && 'any' in AbortSignal) {
    return (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([a, b]);
  }
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  a.addEventListener('abort', forward, { once: true });
  b.addEventListener('abort', forward, { once: true });
  return controller.signal;
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
