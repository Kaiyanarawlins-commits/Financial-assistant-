# CashCompass

Personal income & spending navigator — log what comes in, subtract what goes out, and see in real time how much is
actually left, broken down by category.

The name is the thesis: a compass gives direction, and this app's job is to show you where your money is pointed.

```bash
npm install
npm run dev               # http://localhost:5173
npm test                  # 148 tests over the engine, agents and guardrails
npm run build             # typecheck + production bundle
npm run build:standalone  # everything inlined into one portable HTML file
```

No backend, no accounts, no network calls. Everything lives in `localStorage`, and the first run seeds demo data so
the dashboard has something to show.

### Single-file build

Because the app makes no network requests, `npm run build:standalone` can inline the JS and CSS into one
self-contained file that runs from a `file://` URL, an email attachment, or any host with a strict content-security
policy:

```
dist/cashcompass.html           complete document, double-clickable
dist/cashcompass.fragment.html  body content only, for hosts supplying their own skeleton
```

Roughly 264 kB, no external requests. Where `localStorage` is unavailable — a sandboxed iframe, private browsing —
persistence degrades to in-memory for the session rather than failing; the app still runs, it just reopens with demo
data.

### On your phone

Deployed by `.github/workflows/deploy.yml` on every push, gated on `npm test`, to
**https://kaiyanarawlins-commits.github.io/Financial-assistant-/**

**One-time setup:** in the repo, **Settings → Pages → Source: "GitHub Actions"**. Creating a Pages site for the
first time needs a permission the workflow's `GITHUB_TOKEN` does not carry, so this single switch cannot be
automated. Once it is set, every push deploys on its own.

It installs as a PWA — **iOS**: Share → *Add to Home Screen*; **Android**: menu → *Install app*. It then launches
without browser chrome, keeps its own icon, and works offline.

Two details that make the offline claim real:

- The service worker precaches the actual build output, injected by `scripts/precache.mjs` after each build. This is
  load-bearing rather than an optimisation: the first page load happens *before* the worker controls the page, so its
  JS and CSS never reach the fetch handler. Caching only the HTML yields a shell that boots offline and then cannot
  find its own bundle — an app that looks installed and is broken.
- `VITE_BASE` sets the base path, because Pages serves this repo from a subpath where a root-relative bundle would
  404 on every asset.

Tap targets are enlarged under `(pointer: coarse)`. The compact controls measured 31–33px on a phone, below the ~44px
guideline, which turns editing an entry into a game of precision — the exact friction the app exists to remove.
Desktop density is unchanged.

---

## The two headline numbers

This is the part worth reading before anything else, because the whole app hangs off it.

```
Remaining Balance = Income(period) − Σ Recurring − Σ One-Time
Safe-to-Spend     = cash on hand − bills still to land − goal reserves
```

**Remaining balance** is the projection. It counts all of the period's income and all of its expenses, including
income not yet received and bills not yet due. It answers *"how should this month end up?"*

**Safe-to-spend** is the realistic figure. It counts only money actually in the account, then holds back the bills
that have not landed yet and anything reserved for a goal. It answers *"what can I spend right now without missing
something?"*

### Deviation from the original spec

The spec's quick reference defines safe-to-spend as `Remaining Balance − Σ(Recurring not yet billed)`. That
double-counts: remaining balance has *already* deducted every recurring bill, so subtracting the unbilled ones again
charges rent twice.

Concretely — $6,000 income, $1,500 rent not yet paid, nothing else. Remaining balance is $4,500. The literal formula
gives a safe-to-spend of $3,000, but the user has $6,000 in the account and one $1,500 bill coming, so $4,500 is
genuinely free. $3,000 is wrong.

Rebasing safe-to-spend on **cash on hand** produces the conservative figure the spec is after without the
double-count. Remaining balance is implemented exactly as specified, and matches the spec's worked example
(`$6,000 → rent $1,500 → $4,500 → flight $500 → $4,000`), which `finance.test.ts` asserts directly.

### Cash on hand, and why the app asks for your balance

Safe-to-spend is only as good as its starting point. Without knowing what is actually in the account, the engine has
to assume each month opens at zero — and that quietly breaks for anyone paid twice a month who pays rent on the 1st.
They read as overdrawn from the 1st to the 15th every single month despite a perfectly healthy budget. A
safe-to-spend indicator that cries wolf is worse than not having one.

So the balance is an **optional anchor**: enter what you have and the date it was true, and the engine rolls it
forward with your paydays and spending from there. Leave it unset and it falls back to the within-period basis, with
`Snapshot.cashOnHandAnchored: false` so the dashboard can say the number is an estimate instead of presenting a guess
as fact.

### Buffer mode

```
Buffer mode: Safe-to-Spend = cash on hand − Σ(Recurring due before next payday) − goal reserves
```

Paycheck-to-paycheck users do not need to hold back a bill that lands *after* their next paycheck arrives — that
paycheck covers it. Buffer mode narrows the hold-back window to bills due before the next payday. The spec's version
of this formula omits spending-to-date; including it is necessary for the number to be correct.

---

## Architecture

```
src/
  types.ts              Domain model. Money is integer cents everywhere.
  lib/
    dates.ts            Payday schedules, billing cycles, month-length clamping
    finance.ts          The calculation engine — pure, the source of every figure
    debt.ts             Snowball vs. avalanche payoff simulation
    advisor.ts          Advisor system prompt, guardrails, insights, recaps
    categories.ts       Default categories and the colour ramp
    money.ts            Cent maths and formatting
    storage.ts          localStorage persistence with forward-compatible merge
    seed.ts             Demo data, generated relative to today
    exporter.ts         CSV export for tax prep
    advisorConfig.ts    Advisor backend settings (API key kept out of AppState)
    agents/
      facts.ts          Precomputed figures every specialist answers from
      roster.ts         The seven specialists: prompts, tools, local answers
      router.ts         Deterministic keyword routing
      calculators.ts    Financial maths for hypotheticals
      tools.ts          Tool schemas + local execution
      guardrails.ts     Pre-flight, prompt and post-flight enforcement
      matching.ts       Word-boundary keyword matching
      claude.ts         Claude-backed path (Fable 5) with the tool loop
  state/store.tsx       Reducer + context
  components/           Dashboard, charts, forms, advisor, settings, motion
server/proxy.mjs        Keeps the API key off the client
```

Three decisions shaped the rest:

**The engine is pure.** Every figure is a function of `(state, period, referenceDate)`. Nothing mutates, nothing reads
the clock, nothing touches storage. The spec's "balance updates instantly" requirement then costs nothing — the UI
recomputes on render — and the entire engine is testable without mocking time.

**Money is integer cents.** The headline number is a sum of dozens of entries, and floating-point dollars accumulate
visible error at that scale. Conversion happens only at the UI edge.

**Recurring bills are derived, not materialised.** A recurring expense produces its posting for a cycle as a pure
function of the template. A stored `Posting` row exists only when the user has *overridden* something — confirmed a
variable amount, skipped a month. Since overrides are keyed on `expenseId + cycleKey`, a bill cannot post twice no
matter how often the calculation runs, and no background job is needed to roll the cycle over.

### Charts

Hand-rolled SVG — donut, trend bars, per-category trend, net-worth line. Four small purpose-built charts cost less
than a charting library here: no bundle weight, no fighting a theme system, and they inherit the app's CSS variables
so light and dark mode work for free.

---

## The advisor

The first version was one prompt covering credit, debt, investing and budgeting, so it could only say what was true
of all four. Ask about credit and it printed the same essay whether you owed $340 or $34,000. It read as
knowledgeable and was useless.

It is now three things: a facts layer, a roster of specialists, and a pluggable backend.

### The facts layer

`lib/agents/facts.ts` computes precise, citable figures before anyone answers anything — per-category deltas against
last month and the six-month average, monthly interest cost per debt, credit utilization per card, emergency-fund
targets sized from *essentials* rather than income, runway in months, goal timelines at the current leftover.

This is what converts "keep your utilization low" into "your store card is at 77% — paying $560 before the statement
closes takes it under 30%, and $800 takes it under 10%". The same figures are rendered into the system prompt, so
even a single-turn answer with no tool calls is anchored to real data.

`simulateMonthlyChange` prices any proposed change: what cutting $100/month does to the savings rate, the debt
payoff date, total interest, and each goal.

### The specialists

| Specialist | Owns |
|---|---|
| Budget Analyst | Cash flow, category drift, affordability |
| Debt Strategist | Payoff order, interest cost, rate reduction |
| Credit Coach | Score factors and real utilization per card |
| Savings Planner | Emergency fund sizing, goal timelines, savings rate |
| Investing Educator | Asset classes and retirement accounts — never a recommendation |
| Subscription Auditor | Recurring charges and what they cost annually |
| Tax & Records Guide | General principles and export for a preparer |

Each carries its own system prompt stating the analysis it must perform *before* answering, its own tool subset, and
a deterministic local implementation. A keyword-scored router picks one — deterministic and local, because routing
has to work offline and spending a round trip to decide who answers doubles every question's latency.

### Hypotheticals

Being grounded in your data must not make the advisor narrow. "If I earned $80k, what house could I afford?" is a
good question about figures the app has never seen, and answering it with "I can only see your logged expenses"
would be a worse failure than vagueness.

`lib/agents/calculators.ts` holds pure financial maths — compound growth, loan payments, payoff time, savings
timelines, the 28/36 affordability rule, the 4% rule — exposed to the model as a `calculate` tool and used directly
by the offline path. Compound interest computed token-by-token is exactly what a language model gets subtly and
confidently wrong, so it never does the arithmetic itself.

Scenario answers state which figures are supposed and which are yours, and list their assumptions.

### Backends

**Built-in** (default): the specialists answer deterministically from the facts. No key, no network, works offline.

**Claude**: the same specialists, the same facts, the same tools, with open-ended reasoning. Defaults to
`claude-fable-5`. Thinking is always on for that family, so the `thinking` parameter is omitted entirely — sending
`budget_tokens` is a 400 — and depth is controlled through `output_config.effort`. Server-side fallbacks are enabled
so a policy decline on a benign finance question is not a dead end.

The tool loop is written out rather than delegated to the SDK's tool runner, for reasons specific to this app: every
tool call is surfaced in the UI as it runs ("Ran your debt payoff numbers"), which is most of what makes the advisor
feel like it is working rather than improvising; and the iteration count needs a hard ceiling, because a runaway
loop on a consumer app spends the user's money.

### Guardrails

Enforced in three places, because "the prompt says not to" is not a control:

1. **Pre-flight** — the question is screened before any model call, so a request for a stock pick is refused locally,
   costs nothing, and cannot be talked around by the prompt.
2. **In the system prompt** — every specialist inherits the hard rules.
3. **Post-flight** — output is scanned before display.

Never recommends a specific security or coin. Never implies a guaranteed return. Never advises on your individual
tax or legal situation. Names volatility plainly rather than softening it. `redactSensitive` strips SSNs, card and
account numbers and declared credentials from input *before* it enters the transcript or the network — the cheapest
place to not store an SSN is before it is ever written down.

### Keys

The API key lives in its own `localStorage` slot, deliberately outside `AppState` — `AppState` is what "Download
backup" serialises, and a key there would be written into a JSON file people email to themselves.

A key in a browser is readable by any script on the page. That is acceptable for a personal build on your own
device and wrong for anything deployed, so `server/proxy.mjs` is a dependency-free Node proxy that holds the key
server-side, allowlists origins, and forwards only `/v1/messages`:

```bash
ANTHROPIC_API_KEY=sk-ant-... node server/proxy.mjs
```

Then set the proxy URL in **Settings → AI advisor**. The Settings panel says all of this in the app, at the point
where the choice is made.

---

## Appearance and motion

**Theme** follows your device by default and can be forced to Light or Dark in Settings. Three states, not two: an
explicit choice stamps `data-theme` on the root element and wins over the OS in both directions; `system` removes
the stamp so `prefers-color-scheme` decides. The `<meta name="theme-color">` is updated to match, or the phone's
status bar keeps painting the opposite ground behind the app.

**Motion** is limited to places where it carries meaning. Goal bars fill from empty and travel amber → yellow-green
→ green as they complete, so progress is readable from hue before you read the number. The headline balance counts
to its new value, so editing an expense visibly lands on the figure. Tool calls stream in as the advisor works.

Every animation checks `prefers-reduced-motion` and snaps to the final value when it is set — animated counting
numbers are a known migraine and vestibular trigger, and the figure *is* the content.

---

## Feature coverage

| Spec feature | Status |
|---|---|
| Income with schedules (monthly days, biweekly, weekly, one-time) | Yes |
| Recurring + one-time expenses, real-time balance | Yes |
| Variable bills confirmed before posting | Yes — prompted on the dashboard, never silent |
| Safe-to-spend | Yes — rebased, see above |
| Paycheck buffer mode | Yes |
| Category breakdown, donut + list, drill-down to transactions | Yes — two taps |
| Monthly / YTD / custom range | Yes |
| Recurring vs. one-time split | Yes |
| Trend across past months | Yes |
| AI advisor with guardrails | Yes — 7 specialists, local or Claude-backed |
| Hypothetical / scenario questions | Yes — real calculators, not estimates |
| Light / dark / system theme | Yes |
| Savings goals with safe-to-spend reserve | Yes |
| Spending caps per category | Yes |
| Debt payoff, snowball vs. avalanche | Yes — full amortisation, flags unpayable plans |
| Monthly recap | Yes |
| Net worth tracking | Yes |
| Irregular income mode | Yes — 3–6 month trailing average |
| Export / tax view | Yes — CSV by category, by transaction, by month |
| Household mode | Partial — relabels the UI; no multi-user sync |
| Bill due-date reminders | In-app only — push needs a service worker and a server |
| Bank/card sync | Not implemented — needs an aggregator (Plaid or similar) and a backend |

The last two are honest gaps rather than oversights: both require infrastructure this build does not have.

---

## Testing

148 tests, all against the pure modules:

```
finance.test.ts   45  balance maths, recurring expansion, idempotency, month-length
                      clamping, leap years, safe-to-spend, buffer mode, cash-on-hand
                      anchoring, income schedules, irregular income, categories,
                      trends, reminders
agents.test.ts    68  facts, routing, calculators, figure parsing, guardrails,
                      tool execution, specialist answers, hypotheticals
advisor.test.ts   26  redaction, guardrails, topic matching, insights
debt.test.ts       9  payoff simulation, strategy comparison, unpayable plans
```

Two bugs the suite caught during development, both worth noting because they were invisible from the UI:

1. **Topic matchers used a trailing `\b` after singular keywords**, so "index fund**s**", "credit score**s**",
   "IRA**s**" and "budget**ing**" all silently fell through to the generic fallback. The advisor looked like it was
   working. There is now a regression test asserting every suggested question and a set of plural/gerund phrasings
   reach a real topic.

2. **The overspend insight fired when no income was logged at all**, telling a user who simply had not finished
   setting up that they were living beyond their means. Now a distinct "add your income" insight handles that case.

3. **The agent router matched keywords as bare substrings**, so "a**irs**peed" contained "irs" and a nonsense
   question routed to the Tax & Records Guide. The same file then made the *opposite* mistake: `\binvest\b` missed
   "invested", so scenario questions fell through to a generic answer that looked plausible. `agents/matching.ts`
   now handles both, with regression tests naming each failure.

4. **The goal progress bar never rendered its fill.** `.goal__fill` is a `<span>` and its track is not a flex
   container, so it stayed `display: inline` and ignored width and height entirely. Caught only by measuring the
   rendered box — an earlier check read the inline `style` attribute, which was set correctly the whole time.

Verified in Chromium end to end: live recalculation on add (−$250 → balance moves exactly $250), category
drill-down, guardrail refusals rendering, buffer mode changing safe-to-spend, persistence across reload, and no
horizontal overflow from 320px to 1100px in both colour schemes.

---

## Data handling

Everything stays in the browser. No network calls, no analytics, no accounts. Backup and restore are manual JSON
download and upload. Per the spec, no sensitive identifier — SSN, full account or card number, credential — is ever
stored, and user input is redacted before it reaches the advisor's context or the transcript.
