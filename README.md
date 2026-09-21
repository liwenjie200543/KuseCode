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

All ten steps done. Step 9 gave the project a product surface (`kuse run` / `trace` / `runs` /
`sessions`, exit codes as machine-readable "why did it stop", evidence audit, two-directional
secret handling — see `docs/09-cli-trace.md`). Step 10 closed the loop with **golden transcripts**:
eight pinned runs cover every ending (complete / two kinds of partial / failed / cancelled /
awaiting a human); each is driven through two independent paths — the fake model port (no SDK)
and the real `pi-ai` stream through the adapter — and the two event logs must match byte for byte,
while the SDK-path artifacts are pinned on disk (`test/golden/pinned/`). An SDK upgrade that
silently changes semantics now fails a test instead of shipping. Recording is explicit
(`KUSE_RECORD_GOLDEN=1`) because a golden file is a *reviewed assertion*, not a cache.
The corpus forced one real fix: `search_text` traversal order used to depend on the filesystem;
it is now sorted, and the order is pinned like any other behavior.

Steps 1–9 in brief: domain types with no imports; a minimal loop that is the only state machine;
an append-only event log with write-ahead emission; budgets and cancellation checked *before*
each action; a tool execution layer with eight gates around untrusted output; durable logs and
idempotent replay; the Pi Agent SDK living only behind ports (deleting the adapter still
compiles and runs); and a CLI that answers what / why / how much from the log alone.

Per-step reasoning lives in `docs/02-core-contracts.md`, `docs/03-core-loop.md`,
`docs/04-run-events.md`, `docs/05-budget-cancellation.md`, `docs/06-tool-execution.md`,
`docs/07-durability-replay.md`, `docs/08-pi-adapter.md`, `docs/09-cli-trace.md` and
`docs/10-golden-transcripts.md`.

## Commands

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Node >= 22 is required.

The CLI needs a build first (`bin/kuse.mjs` loads `dist/`):

```bash
npm run build
node bin/kuse.mjs help
# an offline smoke run: real tools, real filesystem, real event log, scripted "model"
node bin/kuse.mjs run "这个仓库里有哪些 TODO？" --repo . --offline
# re-read a finished run without re-running anything (no SDK is loaded)
node bin/kuse.mjs runs <sessionId>
node bin/kuse.mjs trace <sessionId> <runId>
```

`--model provider/model` uses a real provider (credentials come from the environment); `--offline`
is a scripted provider that walks `list_dir → search_text → read_file → submit_report`, so the whole
chain can be exercised with no credentials, deterministically and offline.

For the parts the CLI cannot show — swapping the model out mid-run, cancellation landing **between**
the decision and the tool call, a suspended run being recovered from disk after a "crash" — there is
a narrative walkthrough:

```bash
node examples/end-to-end.mjs
```

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
