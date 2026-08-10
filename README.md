# CashCompass

Personal income & spending navigator — log what comes in, subtract what goes out, and see in real time how much is
actually left, broken down by category.

The name is the thesis: a compass gives direction, and this app's job is to show you where your money is pointed.

```bash
npm install
npm run dev               # http://localhost:5173
npm test                  # 80 tests over the calculation engine
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
  state/store.tsx       Reducer + context
  components/           Dashboard, charts, forms, advisor, settings
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

`ADVISOR_SYSTEM_PROMPT` in `lib/advisor.ts` holds the spec'd persona verbatim — it is the contract for any
model-backed deployment. What ships is a deterministic local implementation answering from the same scope and
refusing the same things, so the guardrails hold whether or not a model is wired up behind it, and no financial data
leaves the device.

Enforced, with tests:

- **No specific securities.** Refuses buy/sell/hold on any named stock or coin, then pivots to explaining the asset
  class. Matched on question *intent* rather than a ticker list, since no list stays current.
- **No implied guarantees.** Names FDIC insurance and Treasuries as the real "safe" instruments and says plainly that
  above-market guaranteed returns are either mispriced or misrepresented.
- **No individualized tax or legal advice.** Explains the general principle, directs to a CPA or attorney.
- **Volatility named, not softened.** The crypto answer leads with the 50–80% drawdown record.
- **Sensitive identifiers redacted at capture.** `redactSensitive` strips SSNs, card and account numbers, and
  declared credentials from user input *before* it enters the transcript — the cheapest place to not store an SSN is
  before it is ever written down.

The advisor context object carries amounts and categories only. That is a structural property, not a policy: there is
no field on it that could hold an account identifier.

Beyond Q&A it produces **proactive insights** (over-cap categories, a category rising three months running,
subscription load, fixed costs eating the budget) and a **monthly recap** with the biggest change versus the prior
month and one actionable tip.

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
| AI advisor with guardrails | Yes — local implementation |
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

80 tests, all against the pure modules:

```
finance.test.ts   45  balance maths, recurring expansion, idempotency, month-length
                      clamping, leap years, safe-to-spend, buffer mode, cash-on-hand
                      anchoring, income schedules, irregular income, categories,
                      trends, reminders
advisor.test.ts   26  redaction, every guardrail, topic matching, insights
debt.test.ts       9  payoff simulation, strategy comparison, unpayable plans
```

Two bugs the suite caught during development, both worth noting because they were invisible from the UI:

1. **Topic matchers used a trailing `\b` after singular keywords**, so "index fund**s**", "credit score**s**",
   "IRA**s**" and "budget**ing**" all silently fell through to the generic fallback. The advisor looked like it was
   working. There is now a regression test asserting every suggested question and a set of plural/gerund phrasings
   reach a real topic.

2. **The overspend insight fired when no income was logged at all**, telling a user who simply had not finished
   setting up that they were living beyond their means. Now a distinct "add your income" insight handles that case.

Verified in Chromium end to end: live recalculation on add (−$250 → balance moves exactly $250), category
drill-down, guardrail refusals rendering, buffer mode changing safe-to-spend, persistence across reload, and no
horizontal overflow from 320px to 1100px in both colour schemes.

---

## Data handling

Everything stays in the browser. No network calls, no analytics, no accounts. Backup and restore are manual JSON
download and upload. Per the spec, no sensitive identifier — SSN, full account or card number, credential — is ever
stored, and user input is redacted before it reaches the advisor's context or the transcript.
