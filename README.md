# taskcrew

> Turn a [Backlog.md](https://github.com/MrLesk/Backlog.md) board into an unattended multi-agent development pipeline.

taskcrew drives **your own local [Claude Code](https://claude.com/claude-code)** — so it runs on the Claude subscription you already have. No API key, no separate bill. taskcrew never touches authentication.

You approve a card. It gets built, reviewed, tested, and handed back for your sign-off.

```
$ taskcrew run

▸  TASK-178 Handle punctuation and whitespace in slug()
   [attempt 1] branch task/task-178-attempt-1
   [attempt 1·round 1] junior develops (sonnet / high)
   [attempt 1·round 1] verify 3/3 passed
   [attempt 1·round 1] senior reduction review
   [attempt 1·round 1] verify after reduction 3/3 passed
   [attempt 1·round 1] QA verdict
   ✓ passed (1 attempt, $0.19)
```

> **Status: early.** The pipeline works end to end and is covered by 38 tests, but the
> resident service, Redis queue, and multi-channel intake are not built yet. See [Roadmap](#roadmap).

## Install

Requires **Node ≥ 24** (runs TypeScript natively — no build step) and a logged-in Claude Code.

```bash
npm install -g taskcrew
```

## Quick start

```bash
# 1. Set up a board (once)
backlog init my-board
cd my-board

# 2. Configure the nine-column workflow
#    backlog/config.yml → statuses: [...]

# 3. Write a card, drag it to 待執行 / Ready, then:
taskcrew run
```

## How it works

taskcrew adds two commands to a Backlog.md board. Each covers one stretch where the ball is in the agents' court — the stretch between them is yours.

```
Inbox → Discuss → Planning → Awaiting approval → Ready → Running → Report → Done
                  └ plan ──┘                     └────────── run ─────────┘
```

| Command | Moves cards | Who acts |
|---|---|---|
| `taskcrew plan` | Planning → Awaiting approval | **PM** researches the codebase, writes an implementation plan |
| *(you drag the card)* | Awaiting approval → Ready | **You.** Dragging *is* the approval — there is no command |
| `taskcrew run` | Ready → Report | The four-role pipeline builds it |

Cards in the queue **only queue**. Nothing starts until you issue a command — every run is an explicit authorization.

### The pipeline

```
PM (opus/xhigh)        →  implementation plan  →  you approve
    ↓
junior RD (sonnet)     →  implement
    ↓
verify                 →  per-test results
    ↓
senior RD (opus/xhigh) →  reduction review
    ↓
verify                 →  confirm nothing broke
    ↓
QA (haiku)             →  does this meet the requirement?
```

Failure escalates through three loops, and **each step up changes something real** rather than retrying the same thing:

| Loop | Problem | Response |
|---|---|---|
| Inner | The implementation is wrong | Senior takes over from junior — keeps their work, the approach was right |
| Middle · **revise** | A **detail** is wrong (a file that doesn't exist, a missing step) | Same branch, same work; only the plan is corrected |
| Middle · **replace** | The **approach** is wrong | New attempt, new branch from `base_branch`; the old code is discarded |
| Outer | The **requirement** is wrong | Stop. Hand the card back with everything it tried |

The revise tier matters more than it looks: **most failures are an unverified fact, not a wrong approach.**
Throwing away a working branch because one filename was wrong is an expensive overreaction.
PM decides which tier applies and must say so explicitly — the two paths treat the branch in opposite ways.

## Design decisions

**Intake is wide open; the gate is narrow.** Anyone can create a card — a chat session, a Discord bot, the web UI, a script you wrote. Quality is not protected by restricting who writes cards; it is protected by seven checks when a card enters the queue. The strictest one: **every acceptance criterion must reference an executable test case.**

```markdown
- [ ] Whitespace becomes a hyphen → `test/run.js::spaces-to-dashes`
```

A criterion you cannot back with a test isn't a criterion. It's a wish.

**"Did it work" is mechanical; "is it good" is judgment.** `verify` must emit per-test results, not just an exit code — because comparing per-test results *across rounds* is the only objective way to tell "the implementation is wrong" from "the approach is wrong":

| Across rounds | Diagnosis | Action |
|---|---|---|
| Failures decreasing | Converging | Stay in the inner loop |
| Same tests failing, count unchanged | Stuck — this approach can't reach them | Escalate |
| Fixed some, broke others | The approach is structurally wrong | Escalate |
| Nearly everything failing from round 1 | Wrong direction | Escalate immediately |

No agent is asked for an opinion here. Getting this wrong sends the whole effort down the wrong path, which makes it exactly the question you should never answer by feel.

**Guardrails are mechanical, not requested.** Pushing, touching `main`, editing `.env`, restarting services — these are blocked with `--disallowed-tools`, not asked for politely in a prompt. An agent that misjudges still cannot do anything irreversible.

**A card is only as large as one reviewable diff.** The bottleneck is your attention, not the machine's throughput. An oversized card doesn't go faster; it produces a diff you skim and rubber-stamp, which means you no longer have a review step.

## Card format

Backlog.md strips frontmatter keys it doesn't recognize, so taskcrew's settings live in a **body section**:

````markdown
## Runner Config

<!-- RUNNER:BEGIN -->
```yaml
project: ~/code/my-repo          # target repository
base_branch: main                # where the branch grows from
verify: "npm test -- --json"     # must emit per-test results
autonomy: propose                # none | propose | replan:N | free
```
<!-- RUNNER:END -->

## Description

**What to do**
…

**What NOT to do**               ← required; blocks more damage than any other field
- …

## Acceptance Criteria

- [ ] Whitespace becomes a hyphen → `test/run.js::spaces-to-dashes`

## Implementation Plan

(Produced by PM. This is what you review in "Awaiting approval".)
````

### `autonomy`

What the pipeline may do when an approach fails:

| Value | Behavior |
|---|---|
| `none` | Stop. Mark failed |
| `propose` | PM writes a new plan to the card and sends it back for approval — **does not execute it** |
| `replan:N` | PM replans and executes, up to N times |
| `free` | Keep going until it passes or the subscription limit is hit |

`propose` is the default. Even when it can't act, you wake up to the plan it would have tried — which is the raw material for deciding how much rope to give it next time.

## Commands

```bash
taskcrew plan [board]     # PM produces implementation plans
taskcrew run  [board]     # drain the Ready column
taskcrew <cmd> --dry      # show what would happen, change nothing
```

A run ends for exactly two reasons: the queue is empty, or the subscription limit is reached. There is no card cap, time cap, or spend cap — **it only ever uses your subscription quota.**

## Roadmap

| Phase | | |
|---|---|---|
| 0 | Backlog.md compatibility verified | ✅ |
| 1 | Minimal chain: card → agent → verify → write back | ✅ |
| 2 | Four-role pipeline, three-loop escalation | ✅ |
| 3 | Resident service, Redis queue, Postgres execution history | |
| 4 | Intake API for Discord / Telegram / custom clients | |

## Development

```bash
npm test          # 38 tests; integration tests stub the agent for determinism
```

Control flow is pinned down with a fake `claude` binary — escalation logic can't be tested
reliably against real agents, which behave differently every run. Real agents are reserved
for what a stub can't verify: prompt quality.

## License

MIT
