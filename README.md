# KuseCode

基于 Pi Agent SDK 的 coding agent。

当前阶段在构建它的底座：**TypeScript Agent Core 与 Runtime**，从第一性原理推导，
不依赖任何框架脚手架。Pi Agent SDK（`@earendil-works/pi-coding-agent`）是
**端口后面的适配器**，从来不是架构本身。

## The real task this system is derived from

> Given a local code repository (the material), the user wants an answer to a question
> about it (the decision/action). The Agent is useful when every claim in the answer
> points at evidence — a file path plus line numbers — and when evidence cannot be found
> it reports the missing material explicitly instead of inventing a conclusion.

Derived consequences:

| Question | Answer that shapes the code |
|---|---|
| What must the Agent receive? | A `Task` plus material that carries **provenance** (where it came from, when) |
| What must it produce? | A `Decision`: call a tool, respond, or ask the human |
| What is the smallest loop? | `Task → Context → Model decision → Tool → Observation → State update → Result` |
| What belongs to Core? | Task, context, state, decision, tool intent, observation, result, domain errors, policies |
| What belongs to Runtime? | Session/run identity, event ordering, budgets, cancellation, retries, storage, recovery, trace |
| What evidence proves a run is correct? | An ordered append-only event log that reconstructs state idempotently |

## Layering

```text
Product surface (CLI)        how a person uses and understands a run
      |
Agent Runtime                how a run happens and survives
      |
Agent Core                   what a valid run means  (pure, zero dependencies)
      |
Ports  ModelPort / ToolPort  the boundary SDK objects may not cross
      |
Adapters  Pi Agent SDK / Fake
```

The Core must run to completion with a fake model and fake tools, with no process,
no database, no network and no UI. The Runtime must execute the same Core against
real adapters without changing the Core's meaning.

## Development sequence

Each step is one commit and proves one first-principles claim.

| # | Commit | Claim proved |
|---|---|---|
| 1 | `chore: repo skeleton` | Build and tests are reproducible |
| 2 | `feat(core): domain types` | "What a valid run means" is typed |
| 3 | `feat(core): minimal loop` | The loop completes with no process, network or database |
| 4 | `feat(runtime): session & run events` | One task is one ordered, replayable event stream |
| 5 | `feat(runtime): budget & cancellation` | Runs terminate predictably; cancellation stops future work |
| 6 | `feat(runtime): tool execution layer` | Tool output is untrusted; one failure does not corrupt state |
| 7 | `feat(runtime): durability & recovery` | The event log is the source of truth; replay is idempotent |
| 8 | `feat(adapter): pi agent sdk` | The SDK is replaceable without changing semantics |
| 9 | `feat(product): cli e2e + trace` | A real run answers: what, why it stopped, what it cost |
| 10 | `test: golden transcripts` | An SDK upgrade cannot silently change semantics |

## Status

Step 6 done. Tool calls now go through an execution layer, and everything it touches is treated as
untrusted: the name is checked against the port's allowlist, the arguments and the result must both
be representable in the JSON event log, a single call carries its own timeout, and an oversized
result is truncated **visibly**. A failing tool — rejected args, a throw, a timeout, an
unrepresentable result — becomes an observation with an error, never a `run_failed`: the run keeps
going and finishes `partial` with the missing material named. `provenance` and `truncated` are
written only by this layer, which is what step 2's type split was for. The Core was not touched
at all. Durable storage and the Pi adapter are still ahead.

Per-step reasoning lives in `docs/02-core-contracts.md`, `docs/03-core-loop.md`,
`docs/04-run-events.md`, `docs/05-budget-cancellation.md` and `docs/06-tool-execution.md`.

## Commands

```bash
npm ci
npm run typecheck
npm test
```

Node >= 22 is required.

## 提交约定

```text
type(scope):一句话说明这次改动

type    feat | fix | refactor | test | docs | chore | perf
scope   core | runtime | adapter | product | repo | test | docs | ci
```

例：

```text
feat(core):Task 与 Decision 类型落地，Observation 强制携带 provenance
fix(runtime):事件回放时 human_input_received 重复注入导致 state 漂移
```

标题行之后空一行，正文写**这次改动落实了哪条第一性原理决策**；再空一段写
`验证：` 与 `局限：`。标题行不要写"修了个 bug"，要写清楚改了什么语义。
