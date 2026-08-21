import { useEffect, useMemo, useRef, useState } from 'react';
import type Anthropic from '@anthropic-ai/sdk';
import { useStore } from '../state/store';
import { buildRecap, generateInsights, redactSensitive } from '../lib/advisor';
import {
  AGENT_LIST,
  ask,
  buildFacts,
  isConfigured,
  route,
  type Agent,
  type ToolCallRecord,
} from '../lib/agents';
import { loadAdvisorConfig, toClaudeConfig } from '../lib/advisorConfig';
import { cycleKeyOf, monthPeriod, shiftCycle } from '../lib/dates';
import { computeSnapshot } from '../lib/finance';
import { formatMoney, formatSigned } from '../lib/money';
import { AlertIcon, Card, CheckIcon, InfoIcon, RichText, Segmented } from './ui';

interface Message {
  id: number;
  role: 'user' | 'bot';
  text: string;
  agent?: Agent;
  toolCalls?: ToolCallRecord[];
  refused?: boolean;
  fellBack?: boolean;
  error?: string;
}

/**
 * The advisor.
 *
 * Every answer is attributed to the specialist that produced it and lists what
 * it looked at. That is not decoration: the difference between advice you can
 * act on and advice you nod along to is usually whether you can see where the
 * numbers came from.
 */
export function AdvisorView({ reference }: { reference: string }) {
  const { state } = useStore();
  const [tab, setTab] = useState<'chat' | 'team' | 'insights' | 'recap'>('chat');

  return (
    <div className="stack">
      <Segmented
        ariaLabel="Advisor view"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'chat', label: 'Ask' },
          { value: 'team', label: 'Team' },
          { value: 'insights', label: 'Insights' },
          { value: 'recap', label: 'Recap' },
        ]}
      />
      {tab === 'chat' && <Chat reference={reference} />}
      {tab === 'team' && <TeamPanel reference={reference} />}
      {tab === 'insights' && <Insights reference={reference} />}
      {tab === 'recap' && <RecapPanel reference={reference} />}
      <p className="disclaimer">
        The CashCompass Advisor is a financial literacy assistant, not a licensed financial advisor, CPA or attorney.
        It will not recommend specific securities and cannot advise on your individual tax or legal situation.
        {state.settings.householdMode && ' Household mode is on — figures cover the shared budget.'}
      </p>
    </div>
  );
}

const SUGGESTIONS = [
  'Where did my money go this month?',
  'How much should I have in an emergency fund?',
  'How do I get my credit score up?',
  'Snowball or avalanche for my debt?',
  'What if I earned $85,000 a year — could I afford a house?',
  'If I invested $400 a month at 7% for 25 years, what would I have?',
  'Are my subscriptions worth it?',
  'Am I saving enough?',
];

function Chat({ reference }: { reference: string }) {
  const { state } = useStore();
  const config = useMemo(() => loadAdvisorConfig(), []);
  const claudeConfig = useMemo(() => toClaudeConfig(config), [config]);
  const modelBacked = isConfigured(claudeConfig);

  const [messages, setMessages] = useState<Message[]>([
    {
      id: 0,
      role: 'bot',
      text: `I'm a team of seven specialists. Ask a question and whichever one owns it answers, using your real numbers — not a general explanation.\n\nI can also run hypotheticals: salaries you don't earn yet, houses you haven't bought, investments you haven't made. Give me the figures and I'll do the arithmetic.\n\nI can see amounts and categories only — never account numbers or logins, and I won't ask for them.`,
    },
  ]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [liveTools, setLiveTools] = useState<ToolCallRecord[]>([]);
  const [pendingAgent, setPendingAgent] = useState<Agent | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController>();

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages, liveTools]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    // Redact on the way in, so an identifier never enters the transcript.
    const safe = redactSensitive(trimmed);
    const routed = route(safe);

    setDraft('');
    setBusy(true);
    setLiveTools([]);
    setPendingAgent(routed.agent);
    setMessages((current) => [...current, { id: current.length, role: 'user', text: safe }]);

    // Replay only the text turns; tool blocks belong to the model that made
    // them and cannot be validly resent alongside a different specialist's tools.
    const history: Anthropic.Beta.BetaMessageParam[] = messages
      .filter((msg) => msg.id > 0)
      .slice(-6)
      .map((msg) => ({ role: msg.role === 'user' ? 'user' : 'assistant', content: msg.text }));

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const reply = await ask({
        question: safe,
        state,
        reference,
        config: claudeConfig,
        history,
        onToolCall: (call) => setLiveTools((current) => [...current, call]),
        signal: controller.signal,
      });

      setMessages((current) => [
        ...current,
        {
          id: current.length,
          role: 'bot',
          text: reply.text,
          agent: reply.agent,
          toolCalls: reply.toolCalls,
          refused: reply.refused,
          fellBack: reply.fellBackToLocal,
          error: reply.error,
        },
      ]);
    } finally {
      setBusy(false);
      setLiveTools([]);
      setPendingAgent(null);
    }
  };

  return (
    <>
      {!modelBacked && (
        <div className="alert" style={{ marginBottom: 4 }}>
          <span className="alert__icon"><InfoIcon /></span>
          <span className="grow small">
            Running the built-in specialists — no API key needed, works offline. Connect Claude in{' '}
            <strong>Settings → AI advisor</strong> for open-ended reasoning over your data.
          </span>
        </div>
      )}

      <div className="chat">
        {messages.map((message) =>
          message.role === 'user' ? (
            <div key={message.id} className="msg msg--user">
              {message.text}
            </div>
          ) : (
            <div key={message.id} className="msg-group">
              {message.agent && message.id > 0 && (
                <div className="agent-tag">
                  <span className="dot" style={{ background: message.agent.color }} aria-hidden="true" />
                  <span>{message.agent.name}</span>
                  {message.fellBack && <span className="pill pill--warn">offline answer</span>}
                </div>
              )}
              {message.toolCalls && message.toolCalls.length > 0 && (
                <ToolTrace calls={message.toolCalls} />
              )}
              <div className={`msg msg--bot${message.refused ? ' msg--refused' : ''}`}>
                <RichText text={message.text} />
              </div>
              {message.error && <div className="tiny warn" style={{ paddingLeft: 4 }}>{message.error}</div>}
            </div>
          ),
        )}

        {busy && (
          <div className="msg-group">
            {pendingAgent && (
              <div className="agent-tag">
                <span className="dot" style={{ background: pendingAgent.color }} aria-hidden="true" />
                <span>{pendingAgent.name}</span>
              </div>
            )}
            {liveTools.length > 0 && <ToolTrace calls={liveTools} live />}
            <div className="msg msg--bot msg--thinking" aria-live="polite">
              <span className="typing" aria-hidden="true">
                <i /><i /><i />
              </span>
              <span className="sr-only">Working on your answer</span>
            </div>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {messages.length <= 1 && !busy && (
        <div className="row row--wrap" style={{ gap: 7, marginTop: 4 }}>
          {SUGGESTIONS.map((question) => (
            <button key={question} type="button" className="chip" onClick={() => void send(question)}>
              {question}
            </button>
          ))}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <input
          className="input grow"
          value={draft}
          placeholder={busy ? 'Working…' : 'Ask about your money, or a what-if…'}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Ask the advisor"
          disabled={busy}
        />
        <button type="submit" className="btn btn--primary" disabled={!draft.trim() || busy}>
          Ask
        </button>
      </form>
    </>
  );
}

/** Human-readable labels for what each tool call actually looked at. */
const TOOL_LABELS: Record<string, string> = {
  get_financial_summary: 'Read your full position',
  get_category_detail: 'Checked a category in detail',
  list_transactions: 'Looked through your transactions',
  get_debt_analysis: 'Ran your debt payoff numbers',
  get_goals: 'Checked your goals and emergency fund',
  get_subscriptions: 'Totalled your subscriptions',
  simulate_change: 'Priced the change',
  calculate: 'Ran the arithmetic',
};

function ToolTrace({ calls, live = false }: { calls: ToolCallRecord[]; live?: boolean }) {
  return (
    <div className="trace">
      {calls.map((call, index) => (
        <div key={`${call.name}-${index}`} className={`trace__item${live ? ' trace__item--live' : ''}`}>
          <CheckIcon size={12} />
          <span>
            {TOOL_LABELS[call.name] ?? call.name}
            {typeof call.input.category_id === 'string' && <> — {String(call.input.category_id)}</>}
            {typeof call.input.operation === 'string' && <> — {String(call.input.operation).replace(/_/g, ' ')}</>}
          </span>
        </div>
      ))}
    </div>
  );
}

/** The roster, so the specialists are discoverable rather than hidden behind routing. */
function TeamPanel({ reference }: { reference: string }) {
  const { state } = useStore();
  const facts = useMemo(() => buildFacts(state, reference), [state, reference]);

  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="small muted">
        Seven specialists. Whichever one owns your question answers it — you never have to pick.
      </p>
      {AGENT_LIST.filter((agent) => agent.id !== 'triage').map((agent) => (
        <div key={agent.id} className="card agent-card" style={{ borderLeftColor: agent.color }}>
          <div className="row row--between">
            <span style={{ fontWeight: 700 }}>{agent.name}</span>
            <span className="tiny faint">{agent.tools.length} tools</span>
          </div>
          <div className="small muted" style={{ marginTop: 2 }}>{agent.beat}</div>
          <div className="tiny faint" style={{ marginTop: 8 }}>
            {agentHeadline(agent.id, facts)}
          </div>
        </div>
      ))}
    </div>
  );
}

/** One live figure per specialist, so the roster shows current state rather than a brochure. */
function agentHeadline(id: Agent['id'], facts: ReturnType<typeof buildFacts>): string {
  switch (id) {
    case 'budget':
      return `Watching ${facts.categories.length} categories · ${formatMoney(facts.cashflow.spentCents)} spent this period`;
    case 'debt':
      return facts.debt.totalCents > 0
        ? `${formatMoney(facts.debt.totalCents)} across ${facts.debt.items.length} accounts · ${formatMoney(facts.debt.monthlyInterestCents)}/mo in interest`
        : 'No debts logged';
    case 'credit':
      return facts.debt.overallUtilizationPercent !== null
        ? `Your utilization: ${facts.debt.overallUtilizationPercent.toFixed(0)}%`
        : 'Add credit limits on the Plan tab to see your utilization';
    case 'savings':
      return `${facts.emergencyFund.monthsCovered.toFixed(1)} months of emergency cover · ${facts.goals.length} goals`;
    case 'investing':
      return 'Explains asset classes and retirement accounts — never recommends a security';
    case 'subscriptions':
      return facts.subscriptions.count > 0
        ? `${facts.subscriptions.count} subscriptions · ${formatMoney(facts.subscriptions.annualCents)}/yr`
        : 'No subscriptions logged';
    case 'tax':
      return `${facts.history.length} months of records ready to export`;
    default:
      return '';
  }
}

function Insights({ reference }: { reference: string }) {
  const { state } = useStore();
  const insights = useMemo(() => {
    const period = monthPeriod(cycleKeyOf(reference));
    return generateInsights(state, computeSnapshot(state, period, reference), reference);
  }, [state, reference]);

  if (insights.length === 0) {
    return (
      <Card>
        <p className="small muted">
          Nothing worth flagging right now. Insights appear as patterns build up — a category climbing three months
          running, a cap you are close to, subscriptions stacking up.
        </p>
      </Card>
    );
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      {insights.map((insight, index) => (
        <div
          key={insight.id}
          className={`alert alert--enter ${
            insight.tone === 'warning' ? 'alert--danger' : insight.tone === 'positive' ? 'alert--good' : ''
          }`}
          style={{ animationDelay: `${index * 55}ms` }}
        >
          <span className="alert__icon">
            {insight.tone === 'warning' ? <AlertIcon /> : insight.tone === 'positive' ? <CheckIcon /> : <InfoIcon />}
          </span>
          <span className="grow">
            <span className="alert__title">{insight.title}</span>
            <span className="alert__detail" style={{ display: 'block' }}>{insight.detail}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function RecapPanel({ reference }: { reference: string }) {
  const { state } = useStore();
  const cycleKey = shiftCycle(cycleKeyOf(reference), -1);
  const period = monthPeriod(cycleKey);

  const recap = useMemo(
    () => buildRecap(state, cycleKey, computeSnapshot(state, period, period.end)),
    [state, cycleKey, period],
  );

  return (
    <div className="stack">
      <Card title={`${period.label} recap`}>
        <div className="split" style={{ marginTop: 0 }}>
          <div className="split__cell">
            <div className="split__label">Income</div>
            <div className="split__value pos">{formatMoney(recap.incomeCents)}</div>
          </div>
          <div className="split__cell">
            <div className="split__label">Spent</div>
            <div className="split__value">{formatMoney(recap.spentCents)}</div>
          </div>
        </div>
        <div className="split">
          <div className="split__cell">
            <div className="split__label">Net</div>
            <div className={`split__value ${recap.netCents < 0 ? 'neg' : 'pos'}`}>
              {formatSigned(recap.netCents)}
            </div>
          </div>
          <div className="split__cell">
            <div className="split__label">Biggest category</div>
            <div className="split__value" style={{ fontSize: 15 }}>
              {recap.biggestCategory ? recap.biggestCategory.name : '—'}
            </div>
            {recap.biggestCategory && (
              <div className="tiny faint">{formatMoney(recap.biggestCategory.spentCents)}</div>
            )}
          </div>
        </div>
      </Card>

      {recap.biggestChange && recap.biggestChange.deltaCents !== 0 && (
        <Card title="Biggest change vs. the month before">
          <div className="row row--between">
            <span style={{ fontWeight: 650 }}>{recap.biggestChange.name}</span>
            <span className={`tnum ${recap.biggestChange.deltaCents > 0 ? 'neg' : 'pos'}`} style={{ fontWeight: 700 }}>
              {formatSigned(recap.biggestChange.deltaCents)}
            </span>
          </div>
        </Card>
      )}

      <Card title="One thing worth doing">
        <div className="small">
          <RichText text={recap.tip} />
        </div>
      </Card>
    </div>
  );
}
