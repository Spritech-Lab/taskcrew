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

> **Status: early but working end to end** — 73 tests, including the resident-agent path.
> See [Roadmap](#roadmap) for what's still missing.

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

Each role is a **separate agent definition you own** — see [Customizing agents](#customizing-agents).

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

Those references do real work: **a card is judged only on the tests it claims.** One repo
usually holds several cards, and without scoping each card fails on the others' red tests —
which quietly pressures the agent to reach outside its stated scope to make the suite green.

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

## Customizing agents

`taskcrew init` writes four agent definitions into your board. They use Claude Code's
native agent file format, so the same definitions work in interactive Claude Code too.

```
<board>/agents/
  pm.md          model: opus    effort: xhigh
  junior-rd.md   model: sonnet  effort: high
  senior-rd.md   model: opus    effort: xhigh
  qa.md          model: haiku   effort: medium
```

```yaml
---
name: taskcrew-qa
description: Judges whether the output meets the requirement.
model: haiku
effort: medium
tools: Read, Glob, Grep      # optional — what this role needs
---
（the system prompt goes here）
```

Change the model or the reasoning effort by editing the frontmatter. No taskcrew source
involved. Definitions live in the **board repo**, so they version alongside your cards —
and two boards can run entirely different crews.

**Two things are deliberately *not* in these files:**

| | Where | Why |
|---|---|---|
| Shared protocol rules (`BLOCKED:` signal, never commit or push, scope limits) | Prepended in code | Editing an agent file must not be able to delete a safety rule |
| The hard denial list (push, `main`, `.env`, service restarts) | `--disallowed-tools`, hardcoded | `tools:` says what a role *needs*; the denial says what *nothing* may do. Deny always wins |

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
| `propose` | A **replacement** plan is written to the card and sent back for approval — not executed. **Revisions are unaffected**: they only correct a detail, so the approach you approved hasn't changed |
| `replan:N` | PM replans and executes, up to N times |
| `free` | Keep going until it passes or the subscription limit is hit |

`propose` is the default. Even when it can't act, you wake up to the plan it would have tried — which is the raw material for deciding how much rope to give it next time.

## Commands

```bash
taskcrew init [board]     # write agent definitions into the board
taskcrew plan [board]     # PM produces implementation plans
taskcrew run  [board]     # drain the Ready column
taskcrew <cmd> --dry      # show what would happen, change nothing
```

### Resident agents (optional)

By default each role is spawned as a subprocess and exits when done — **no infrastructure
required**. With Redis, each role instead runs as a resident process subscribed to a work
queue, and a service waits for commands from wherever you send them:

```bash
redis-server &

taskcrew agent pm     ~/my-board &      # one process per role
taskcrew agent junior ~/my-board &
taskcrew agent senior ~/my-board &
taskcrew agent qa     ~/my-board &

taskcrew serve ~/my-board &             # waits for commands
taskcrew watch ~/my-board               # live event stream
```

Then, from anywhere — a chat bot, a cron job, your phone over SSH:

```bash
taskcrew send run  ~/my-board
taskcrew send run  ~/my-board --at 2026-07-29T02:00
```

Resident mode buys three things a subprocess can't:

| | |
|---|---|
| **Agents remember the repo** | Sessions are resumed per `(role, repo)`, so the second card doesn't re-learn the codebase. Deliberately **reset on `REPLACE`** — the branch went back to `base_branch`, so anything the agent remembers changing is now false |
| **Live events** | Everything is published to `taskcrew:<board>:events`. `taskcrew watch` is the reference subscriber — your bot does the same thing with a different renderer |
| **Agents can move or multiply** | A role can run on another machine, or a new role can join by subscribing, without touching the core |

**Queues are namespaced per board.** Two boards never consume each other's work — that
isolation is a firewall guarantee, not housekeeping, and it has a test of its own.

taskcrew ships **no chat bot**. It defines the event contract and the command queue;
the intake layer is yours.

A run ends for exactly two reasons: the queue is empty, or the subscription limit is reached. There is no card cap, time cap, or spend cap — **it only ever uses your subscription quota.**

## Roadmap

| Phase | | |
|---|---|---|
| 0 | Backlog.md compatibility verified | ✅ |
| 1 | Minimal chain: card → agent → verify → write back | ✅ |
| 2 | Four-role pipeline, three-loop escalation | ✅ |
| 3 | Resident agents, command queue, live event stream | ✅ |
| 4 | Postgres execution history | |
| 5 | Parent/child cards: integration + whole-milestone verification | |

## Development

```bash
npm test          # 73 tests; integration tests stub the agent for determinism
                  # 6 of them need Redis and skip automatically when it's absent
```

Control flow is pinned down with a fake `claude` binary — escalation logic can't be tested
reliably against real agents, which behave differently every run. Real agents are reserved
for what a stub can't verify: prompt quality.

## License

MIT
