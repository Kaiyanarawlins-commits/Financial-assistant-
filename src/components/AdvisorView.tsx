import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';
import {
  SUGGESTED_QUESTIONS,
  askAdvisor,
  buildAdvisorContext,
  buildRecap,
  generateInsights,
  redactSensitive,
} from '../lib/advisor';
import { cycleKeyOf, monthPeriod, shiftCycle } from '../lib/dates';
import { computeSnapshot } from '../lib/finance';
import { formatMoney, formatSigned } from '../lib/money';
import { AlertIcon, Card, CheckIcon, InfoIcon, RichText, Segmented } from './ui';

interface Message {
  id: number;
  role: 'user' | 'bot';
  text: string;
  refused?: boolean;
}

/**
 * The in-app advisor.
 *
 * The answers come from the local advisor module rather than a network call, so
 * the app works offline and no financial data leaves the device. User input is
 * redacted before it is stored in the transcript at all — the guardrail is at
 * the point of capture, not at the point of display.
 */
export function AdvisorView({ reference }: { reference: string }) {
  const { state } = useStore();
  const [tab, setTab] = useState<'chat' | 'insights' | 'recap'>('chat');

  return (
    <div className="stack">
      <Segmented
        ariaLabel="Advisor view"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'chat', label: 'Ask' },
          { value: 'insights', label: 'Insights' },
          { value: 'recap', label: 'Recap' },
        ]}
      />
      {tab === 'chat' && <Chat reference={reference} />}
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

function Chat({ reference }: { reference: string }) {
  const { state } = useStore();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 0,
      role: 'bot',
      text: "I'm the CashCompass Advisor. I can see your amounts, categories and trends — not account numbers or logins, and I won't ask for them.\n\nAsk me about budgeting, saving, credit, debt payoff, or how investing accounts work. I'll use your real numbers where they help.",
    },
  ]);
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const ctx = useMemo(() => {
    const period = monthPeriod(cycleKeyOf(reference));
    return buildAdvisorContext(state, computeSnapshot(state, period, reference));
  }, [state, reference]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Redact on the way in, so the identifier never enters the transcript.
    const safe = redactSensitive(trimmed);
    const reply = askAdvisor(safe, ctx, state);
    setMessages((current) => [
      ...current,
      { id: current.length, role: 'user', text: safe },
      { id: current.length + 1, role: 'bot', text: reply.text, refused: reply.refused },
    ]);
    setDraft('');
  };

  return (
    <>
      <div className="chat">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`msg msg--${message.role}${message.refused ? ' msg--refused' : ''}`}
          >
            {message.role === 'bot' ? <RichText text={message.text} /> : message.text}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {messages.length <= 1 && (
        <div className="row row--wrap" style={{ gap: 7, marginTop: 4 }}>
          {SUGGESTED_QUESTIONS.map((question) => (
            <button key={question} type="button" className="chip" onClick={() => send(question)}>
              {question}
            </button>
          ))}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
      >
        <input
          className="input grow"
          value={draft}
          placeholder="Ask about your money…"
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Ask the advisor"
        />
        <button type="submit" className="btn btn--primary" disabled={!draft.trim()}>
          Ask
        </button>
      </form>
    </>
  );
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
      {insights.map((insight) => (
        <div
          key={insight.id}
          className={`alert ${
            insight.tone === 'warning' ? 'alert--danger' : insight.tone === 'positive' ? 'alert--good' : ''
          }`}
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
  // Recap the last complete month — the current one is still in progress.
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
        <p className="small">
          <RichText text={recap.tip} />
        </p>
      </Card>
    </div>
  );
}
