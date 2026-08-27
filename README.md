# CashCompass

Personal income & spending navigator — log what comes in, subtract what goes out, and see in real time how much is
actually left, broken down by category.

The name is the thesis: a compass gives direction, and this app's job is to show you where your money is pointed.

```bash
npm install
npm run dev               # http://localhost:5173
npm test                  # 259 tests over the engine, agents, accounting, guardrails and auth
npm run build             # typecheck + production bundle
npm run build:standalone  # everything inlined into one portable HTML file
```

Your financial data never leaves the device — it lives in `localStorage`, and the first run seeds demo data so the
dashboard has something to show. Two optional Node servers sit alongside it: `server/auth.mjs` for real accounts
and emailed verification codes, and `server/proxy.mjs` to keep an Anthropic key off the client. Neither is required
to run the app.

### Single-file build

Nothing in the app requires a network by default, so `npm run build:standalone` can inline the JS and CSS into one
self-contained file that runs from a `file://` URL, an email attachment, or any host with a strict content-security
policy:

```
dist/cashcompass.html           complete document, double-clickable
dist/cashcompass.fragment.html  body content only, for hosts supplying their own skeleton
```

Roughly 615 kB — most of it the Anthropic SDK — and no external requests unless you opt in — the Claude-backed advisor and business mode's market data
are the only two things that reach the network, and both are off until you supply a key. Where `localStorage` is
unavailable — a sandboxed iframe, private browsing —
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
    chatHistory.ts      Saved conversations, persisted separately from AppState
    business/
      accounting.ts     Depreciation, price levels, break-even, margins, appraisal
      market.ts         Market data providers, caching, typed failures
      study.ts          Moving averages, volatility, drawdown — computed locally
    agents/
      facts.ts          Precomputed figures every specialist answers from
      roster.ts         The seven specialists: prompts, tools, local answers
      router.ts         Deterministic keyword routing
      calculators.ts    Financial maths for hypotheticals
      tools.ts          Tool schemas + local execution
      guardrails.ts     Pre-flight, prompt and post-flight enforcement
      verify.ts         Checks every generated figure against source data
      conversation.ts   Multi-turn memory, reference resolution
      glossary.ts       Stateful terminology — defined once, then used bare
      matching.ts       Word-boundary keyword matching
      claude.ts         Claude-backed path (Fable 5) with the tool loop
      conversational.ts Repetition trimming, acknowledgements, next steps
    auth/
      crypto.ts         PBKDF2 hashing, CSPRNG codes, password rules
      localProvider.ts  Accounts in this browser (no server)
      serverProvider.ts Accounts on server/auth.mjs (real auth)
  state/store.tsx       Reducer + context
  components/           Dashboard, charts, forms, advisor, settings, motion
server/proxy.mjs        Keeps the Anthropic key off the client
server/auth.mjs         Real accounts, hashed passwords, emailed codes
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
| Business & Accounting | Depreciation, price levels, margins, and reading a price series |

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

### Numeric verification

Every monetary and percentage figure in a generated answer is checked against the values the model was actually
given — the fact sheet plus every tool result from that turn — **before the user sees it**. A wrong number delivered
confidently is the worst failure this app can have, and a prompt rule is not a control.

The check is one-directional by design: it can prove a figure came from source data, and it cannot prove one did
not. So an unverified figure is treated as *unconfirmed*, not as a lie:

1. The answer goes back to the model with the offending figures named, and it is asked to restate using only source
   values or to say plainly that it does not have the number.
2. If a figure survives that round, the answer is shown with a visible caution naming it, and the reply is badged
   **unverified figures** in the UI.

Suppressing a correct number would be its own kind of wrong, so nothing is silently deleted. Annualising a monthly
source figure is recognised as the model's own arithmetic rather than an invention, and standard guideline
percentages (20% savings, 28/36, the 4% rule) are allowed through.

### Conversation memory

Threads are multi-turn. `lib/agents/conversation.ts` tracks the entities under discussion, the terms already
defined, and the last recommendation, then expands a follow-up into a self-contained question before routing — so
"why?" and "what about the Visa?" resolve instead of starting over. Routing is sticky across a follow-up: a bare
"why?" carries no signal of its own, and re-routing it hands the thread to whoever matches a stray word.

Terminology is stateful. A term is defined the first time it appears and used bare afterwards, which is how a
professional actually talks — re-explaining "utilization" every turn is as wrong as never explaining it.

**Saved conversations** persist to `localStorage` and reopen with their memory intact, listed newest first and
grouped by day. Reopening a thread and finding the advisor had forgotten the account you spent ten turns on would
be worse than not saving it, so the memory is stored alongside the transcript.

### Speed

- **Streaming.** Answers render token-by-token via `client.beta.messages.stream`, with a caret while text arrives.
- **Timeout.** A hard 45-second deadline. Past that the local specialist answers instead — it has a correct answer
  available immediately, and a spinner that never resolves is worse than a less nuanced reply.
- **Caching.** `buildFacts` is memoised in a `WeakMap` keyed on state identity. The store replaces the state object
  on every edit, so a stale entry is unreachable the moment anything changes and the cache cannot pin dead states.
- **Trimmed context.** The fact sheet caps categories and history rather than sending everything.
- **Fallback everywhere.** A failed, refused, slow, or empty model response falls back to the offline specialist,
  and the reply is badged so the user knows which answered.

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

## Accounts

Sign up with a name, email and password; verify with a six-digit code; land on a dashboard that greets you by name.
Each account gets its own namespaced ledger and chat history, so two people on one device never see each other's
figures.

**Sending email needs a server, and passwords hashed in a browser are not authentication** — anything the client
computes, the client controls. So auth is built against one interface with two implementations, and the UI says
which is running rather than implying more security than exists.

**Local mode** (default, no setup): accounts live in this browser. Passwords are hashed with PBKDF2-SHA256 at
210,000 iterations with a per-account salt — not a security boundary, but a shared laptop or an exported backup
does not hand over a credential that is probably reused on a real bank. The verification code is shown on screen in
a panel that says plainly there is no mail server.

**Server mode**: point `VITE_AUTH_SERVER` (or Settings → Account) at `server/auth.mjs`. Passwords are hashed and
compared server-side, the code is emailed and never returned to the client, and sessions are issued somewhere the
user cannot reach.

```bash
RESEND_API_KEY=re_… MAIL_FROM="CashCompass <no-reply@you.com>" \
ALLOWED_ORIGINS=https://your-app.example.com \
node server/auth.mjs
```

Resend, Postmark and SendGrid are all supported over plain HTTPS, so the server has no dependencies — a mail library
is a lot of supply chain for one POST. With no key set it prints codes to the log and says so at startup.

It also rate-limits per IP, returns the same response whether or not an address is registered (so it cannot be used
to enumerate accounts), caps code attempts at five, and stores the accounts file at mode 0600. Storage is a JSON
file, which is honest about what this is: swap `loadDb`/`saveDb` for a real database before it has real users.

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
| Business mode — depreciation, inflation, break-even, margins | Yes — four methods, schedules that foot to the cent |
| Stock prices and study metrics | Yes, with your own free API key — see below |
| Bill due-date reminders | In-app only — push needs a service worker and a server |
| Bank/card sync | Not implemented — needs an aggregator (Plaid or similar) and a backend |

The last two are honest gaps rather than oversights: both require infrastructure this build does not have.

---

## Business mode

Off by default; the toggle is in **Settings → Business mode**, and it adds a sixth tab. Four panels:

**Assets.** A depreciation register. Four methods — straight line, declining balance (any multiplier), sum-of-years-digits,
and units of production — each producing a full schedule with opening book value, the annual charge, accumulated
depreciation and the closing value. Every schedule **foots exactly**: rounding each year independently leaves the total a
few cents off the depreciable base, so each method rounds per period and lets the final period absorb the remainder. That
is not fussiness — a schedule that does not sum to cost less salvage is not usable in a set of books.

Declining balance is capped at salvage rather than allowed to run through it, and the schedule says how much book value
is left stranded above the floor, because that is the number that tells you when to switch to straight line.

**Money value.** Inflation and deflation, and the distinction people get wrong: what a thing will *cost* later and what
money will be *worth* later are different figures. At 3% for ten years a price rises 34.4% while purchasing power falls
25.6%. Both are shown, side by side, with the year-by-year table. Negative rates are deflation and run through the same
arithmetic. Alongside it, compound appreciation and the **exact Fisher real rate** — 12% nominal against 8% inflation is
3.70%, not the 4% you get from subtracting.

Appreciation is kept visibly distinct from depreciation, since conflating them is the most common small-business
bookkeeping error: depreciation allocates a cost already paid across the years that consume it, appreciation is a change
in market value, and a building can do both at once with neither figure being wrong.

**Pricing.** Break-even units and revenue, contribution margin, and units required for a target profit. When price does
not exceed variable cost it says the plan never breaks even rather than printing a number — volume cannot fix a negative
contribution margin. Margins run down the statement to operating profit, with margin and markup shown together because
a 50% markup is a 33.3% margin and pricing to the wrong one costs a third of the intended profit.

**Stocks.** A watchlist with the last price, the day's change, and locally computed study metrics: 20/50/200-day moving
averages, position within the yearly range, annualised volatility from daily log returns, and maximum drawdown. The chart
overlays the moving averages on the closes.

### Why you supply the market data key

A published static app has no secrets. Anything compiled into the bundle is readable by anyone who opens devtools, and a
free market-data key shared across every user is rate-limited into uselessness within the hour. So CashCompass ships
without one: you paste your own free key (Alpha Vantage or Finnhub) under **Settings → Market data** or the Stocks tab,
it is stored in its own localStorage slot — never in `AppState`, so it is never written into a backup file — and it goes
to that provider and nowhere else.

With no key, the Stocks tab says so and stays empty. It does not show sample prices, a cached figure dressed up as
live, or anything else invented; the same rule that governs the advisor's numbers governs this. Quotes are cached for a
minute and history for six hours, both because free tiers are strict (Alpha Vantage allows roughly 25 requests a day) and
because the advisor's `get_market_data` tool reads the same cache, so asking about a symbol costs nothing extra. Every
quote carries how long ago it was fetched, and requests time out after ten seconds rather than spinning forever.

Finnhub's free tier serves quotes but not daily history, so the charts and study metrics stay blank on it. The UI says
which provider can do what rather than leaving you to work it out from an empty panel.

The advisor may describe a series and refuses to recommend a security — that guardrail predates business mode and
applies unchanged here.

---

## Testing

259 tests, all against the pure modules:

```
finance.test.ts   45  balance maths, recurring expansion, idempotency, month-length
                      clamping, leap years, safe-to-spend, buffer mode, cash-on-hand
                      anchoring, income schedules, irregular income, categories,
                      trends, reminders
agents.test.ts   138  facts, routing, calculators, figure parsing, guardrails,
                      tool execution, specialist answers, hypotheticals,
                      conversation memory, scenario refinement, numeric
                      verification, chat history, the conversational layer,
                      password and email validation
advisor.test.ts   26  redaction, guardrails, topic matching, insights
business.test.ts  41  depreciation schedules footing to the cent, salvage floors,
                      appreciation, inflation vs. purchasing power, deflation,
                      Fisher real rates, CPI restatement, break-even, margin vs.
                      markup, NPV/IRR/payback, moving averages, volatility,
                      drawdown, ticker validation, provider failure modes
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

Everything stays in the browser. No analytics, and no network calls you have not switched on: the Claude-backed
advisor and business mode's market data are the only two, and each stays inert until you supply a key. Backup and
restore are manual JSON download and upload. Per the spec, no sensitive identifier — SSN, full account or card number,
credential — is ever stored, and user input is redacted before it reaches the advisor's context or the transcript.

API keys live in their own `localStorage` slots rather than in `AppState`, for one specific reason: `AppState` is what
"Download backup" serialises, and a key sitting there would be written into a JSON file the user might email to
themselves. A backup carries finances and never credentials. The watchlist holds ticker symbols only — no holdings, no
share counts, no broker connection.
