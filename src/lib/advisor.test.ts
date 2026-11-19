import { describe, expect, it } from 'vitest';
import type { AppState } from '../types';
import {
  SUGGESTED_QUESTIONS,
  askAdvisor,
  buildAdvisorContext,
  generateInsights,
  redactSensitive,
} from './advisor';
import { monthPeriod } from './dates';
import { computeSnapshot } from './finance';
import { seedState } from './seed';

const REFERENCE = '2026-03-15';
const PERIOD = monthPeriod('2026-03');

function demo(): { state: AppState; ctx: ReturnType<typeof buildAdvisorContext> } {
  const state = seedState(REFERENCE);
  const snapshot = computeSnapshot(state, PERIOD, REFERENCE);
  return { state, ctx: buildAdvisorContext(state, snapshot) };
}

describe('redaction', () => {
  it('strips a formatted SSN', () => {
    expect(redactSensitive('my ssn is 123-45-6789')).not.toContain('123-45-6789');
  });

  it('strips a labelled unformatted SSN', () => {
    expect(redactSensitive('SSN 123456789')).not.toContain('123456789');
  });

  it('strips card numbers, spaced or not', () => {
    expect(redactSensitive('card 4111 1111 1111 1111')).not.toMatch(/4111/);
    expect(redactSensitive('4111111111111111')).not.toMatch(/4111/);
  });

  it('strips a labelled account or routing number', () => {
    expect(redactSensitive('my account 12345678')).not.toContain('12345678');
    expect(redactSensitive('routing: 021000021')).not.toContain('021000021');
  });

  it('strips declared credentials', () => {
    expect(redactSensitive('password: hunter2')).not.toContain('hunter2');
    expect(redactSensitive('pin = 4021')).not.toContain('4021');
  });

  it('leaves ordinary money amounts alone', () => {
    const text = 'I spent $1,250.40 on rent and $89 on groceries';
    expect(redactSensitive(text)).toBe(text);
  });
});

describe('advisor guardrails', () => {
  it('refuses to recommend a specific security', () => {
    const { state, ctx } = demo();
    const reply = askAdvisor('Should I buy Tesla stock?', ctx, state);
    expect(reply.refused).toBe(true);
    expect(reply.text.toLowerCase()).toContain('not licensed');
  });

  it('refuses to recommend a specific coin, and names the volatility', () => {
    const { state, ctx } = demo();
    const reply = askAdvisor('should i invest in bitcoin right now?', ctx, state);
    expect(reply.refused).toBe(true);
    expect(reply.text.toLowerCase()).toMatch(/volatil/);
  });

  it('refuses to imply a guaranteed return', () => {
    const { state, ctx } = demo();
    const reply = askAdvisor('what investment has guaranteed returns?', ctx, state);
    expect(reply.refused).toBe(true);
    expect(reply.text).toMatch(/no guaranteed return/i);
  });

  it('declines individualized tax questions and points to a professional', () => {
    const { state, ctx } = demo();
    const reply = askAdvisor('can I write off my home office on my taxes?', ctx, state);
    expect(reply.refused).toBe(true);
    expect(reply.text).toMatch(/CPA|attorney/);
  });

  it('never names a ticker in an educational investing answer', () => {
    const { state, ctx } = demo();
    const reply = askAdvisor('explain index funds', ctx, state);
    expect(reply.refused).toBeUndefined();
    expect(reply.text).not.toMatch(/\$[A-Z]{2,5}\b/);
    expect(reply.text).toMatch(/expense ratio|0\.03/);
  });
});

describe('advisor topics', () => {
  it('answers credit questions with the score factors', () => {
    const { state, ctx } = demo();
    const reply = askAdvisor('how do I build my credit score?', ctx, state);
    expect(reply.text).toMatch(/utilization/i);
    expect(reply.text).toMatch(/authorized user/i);
    expect(reply.text).toMatch(/secured card/i);
  });

  it('sizes an emergency fund from the user\'s own fixed costs', () => {
    const { state, ctx } = demo();
    const reply = askAdvisor('how big should my emergency fund be?', ctx, state);
    expect(reply.text).toMatch(/three to six months/i);
    // Should quote a real dollar figure derived from their recurring total.
    expect(reply.text).toMatch(/\$[\d,]+\.\d{2}/);
  });

  it('compares debt strategies using the real logged balances', () => {
    const { state, ctx } = demo();
    const reply = askAdvisor('snowball or avalanche?', ctx, state);
    expect(reply.text).toMatch(/Avalanche/);
    expect(reply.text).toMatch(/Snowball/);
    expect(reply.text).toMatch(/3 accounts/);
  });

  it('reads the spending breakdown back with real categories', () => {
    const { state, ctx } = demo();
    const reply = askAdvisor('where did my money go?', ctx, state);
    expect(reply.text).toMatch(/Housing/);
    expect(reply.text).toMatch(/%/);
  });

  it('runs 50/30/20 against the user\'s actual numbers', () => {
    const { state, ctx } = demo();
    const reply = askAdvisor('what budget rule should I use?', ctx, state);
    expect(reply.text).toMatch(/50\/30\/20/);
    expect(reply.text).toMatch(/Recurring\/fixed/);
  });

  it('falls back to a summary rather than inventing an answer', () => {
    const { state, ctx } = demo();
    const reply = askAdvisor('what is the airspeed velocity of a swallow?', ctx, state);
    expect(reply.text).toMatch(/Remaining balance/);
  });

  it('redacts sensitive input before it can reach a log', () => {
    const { state, ctx } = demo();
    // The reply must not echo the identifier back under any topic branch.
    const reply = askAdvisor('my ssn is 123-45-6789, how do I budget?', ctx, state);
    expect(reply.text).not.toContain('123-45-6789');
  });
});

describe('topic matching robustness', () => {
  // Guards the trailing-\b bug class: a matcher written for the singular silently
  // dropping "index funds", "credit scores", "IRAs" or "budgeting" into the
  // generic fallback, which looks like a working answer but is not one.
  const FALLBACK_MARKER = 'I am not sure I have a good answer';

  it('answers every question the UI suggests', () => {
    const { state, ctx } = demo();
    for (const question of SUGGESTED_QUESTIONS) {
      const reply = askAdvisor(question, ctx, state);
      expect(reply.text, `suggested question fell through: "${question}"`).not.toContain(
        FALLBACK_MARKER,
      );
    }
  });

  it('matches plural and gerund forms of its keywords', () => {
    const { state, ctx } = demo();
    const phrasings = [
      'tell me about index funds',
      'how are credit scores calculated',
      'explain IRAs and 401(k)s',
      'help me with budgeting',
      'what about my savings',
      'are my subscriptions too expensive',
      'how do I handle my loans',
      'explain stocks and bonds',
      'what are my assets worth',
      'how do taxes work',
      'tell me about investing',
    ];
    for (const phrase of phrasings) {
      const reply = askAdvisor(phrase, ctx, state);
      expect(reply.text, `unmatched phrasing: "${phrase}"`).not.toContain(FALLBACK_MARKER);
    }
  });
});

describe('proactive insights', () => {
  it('flags an over-cap category', () => {
    const state = seedState(REFERENCE);
    const snapshot = computeSnapshot(state, PERIOD, REFERENCE);
    const insights = generateInsights(state, snapshot, REFERENCE);
    // The demo data spends $88 on entertainment against a $100 cap and $124 on
    // dining against a $200 cap.
    expect(insights.some((i) => i.id.startsWith('cap-'))).toBe(true);
  });

  it('flags the subscription load', () => {
    const state = seedState(REFERENCE);
    const snapshot = computeSnapshot(state, PERIOD, REFERENCE);
    const insights = generateInsights(state, snapshot, REFERENCE);
    const subs = insights.find((i) => i.id === 'subs');
    expect(subs?.title).toMatch(/3 active subscriptions/);
  });

  it('warns when spending exceeds income', () => {
    const state = seedState(REFERENCE);
    const broke: AppState = {
      ...state,
      income: [
        {
          id: 'small',
          source: 'Part-time',
          amountCents: 40_000,
          recurrence: 'recurring',
          schedule: { kind: 'monthly-days', days: [1] },
          active: true,
          createdAt: '2026-01-01',
        },
      ],
    };
    const snapshot = computeSnapshot(broke, PERIOD, REFERENCE);
    const insights = generateInsights(broke, snapshot, REFERENCE);
    expect(insights[0]?.tone).toBe('warning');
    expect(insights.some((i) => i.id === 'overspend')).toBe(true);
  });

  it('asks for income rather than crying overspend when none is logged', () => {
    const state = seedState(REFERENCE);
    const noIncome: AppState = { ...state, income: [] };
    const snapshot = computeSnapshot(noIncome, PERIOD, REFERENCE);
    const insights = generateInsights(noIncome, snapshot, REFERENCE);
    expect(insights.some((i) => i.id === 'no-income')).toBe(true);
    expect(insights.some((i) => i.id === 'overspend')).toBe(false);
  });

  it('sorts warnings ahead of encouragement', () => {
    const state = seedState(REFERENCE);
    const snapshot = computeSnapshot(state, PERIOD, REFERENCE);
    const tones = generateInsights(state, snapshot, REFERENCE).map((i) => i.tone);
    const firstPositive = tones.indexOf('positive');
    const lastWarning = tones.lastIndexOf('warning');
    if (firstPositive !== -1 && lastWarning !== -1) {
      expect(lastWarning).toBeLessThan(firstPositive);
    }
  });
});

describe('advisor context', () => {
  it('exposes amounts and categories only — no identifiers', () => {
    const { ctx } = demo();
    const keys = Object.keys(ctx);
    expect(keys).toContain('totalIncomeCents');
    expect(keys).toContain('topCategories');
    // Nothing account-shaped may appear on the context object.
    const serialized = JSON.stringify(ctx).toLowerCase();
    expect(serialized).not.toMatch(/ssn|account_?number|routing|password/);
  });
});
