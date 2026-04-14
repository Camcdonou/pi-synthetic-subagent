# 🤖 pi-synthetic-subagent

A [Pi](https://github.com/badlogic/pi-mono) extension for delegating tasks to specialized subagents with **model-aware concurrency scheduling** for the [Synthetic](https://synthetic.new) provider.

## Features

- **Model-aware slot scheduler** — tracks per-model concurrency instead of a dumb global cap. Each model gets its own slot pool based on your pack count.
- **Tier-aware fallback** — if a model's slots are full, the scheduler falls back to another model in the same tier (power ↔ power, fast ↔ fast). Never crosses tiers silently.
- **Pack-based concurrency** — 1 pack = 1 slot per standard model, 2 slots per small model. N packs = N× multiplier.
- **Interactive setup wizard** — first-run wizard to configure packs, models, and budget. Re-run anytime with `/subagent-setup`.
- **Session budget tracking** — warns when sub-agent spending approaches your weekly budget threshold (80%, 95%, 100%).
- **5 specialized agents** — scout, planner, worker, reviewer, doc-writer — each assigned to the best model for the job.
- **Three execution modes** — single, parallel (scheduler-distributed), chain (sequential with output passing).
- **Rate limit buffer** — 1-second delay between consecutive spawns on the same model to respect Synthetic's rate limits.
- **Custom TUI rendering** — slot usage display, fallback indicators, budget warnings, expandable results.

## Concurrency Model

Synthetic gives you per-model concurrency, not global concurrency. This extension models it like a CPU scheduler:

| Model | Class | Slots/Pack | Tier | Role |
|-------|-------|-----------|------|------|
| GLM-4.7-Flash | Small | 2 | fast | Quick tasks (scout, doc-writer) |
| MiniMax-M2.5 | Standard | 1 | power | Side coder (worker) |
| Kimi-K2.5 | Standard | 1 | power | Deep researcher (planner) |
| GLM-5.1 | Standard | 1 | power | Architectural review (reviewer) |

Only **GLM-4.7-Flash** and **Nemotron-3-Super** are classified as "small models" by Synthetic, giving 2× concurrency per pack. All other models get 1× per pack.

### Slot Totals by Pack Count

| Packs | GLM-4.7-Flash | MiniMax-M2.5 | Kimi-K2.5 | GLM-5.1 | **Total** |
|-------|---------------|--------------|-----------|---------|-----------|
| 1     | 2             | 1            | 1         | 1       | **5**     |
| 2     | 4             | 2            | 2         | 2       | **10**    |
| 3     | 6             | 3            | 3         | 3       | **15**    |

With 1 pack, all 5 agents can run simultaneously with **zero slot contention** — each gets its own dedicated model.

### Scheduling Rules

1. **Soft affinity** — prefer the agent's configured model
2. **Same-tier fallback** — if slots full, use another model in the same tier (sorted by cost)
   - Power tier: MiniMax-M2.5 (0.53x) → Kimi-K2.5 (0.79x) → GLM-5.1 (1.0x)
   - Fast tier: only GLM-4.7-Flash
3. **No cross-tier fallback** — won't silently swap a power-tier agent to a fast-tier model
4. **Queue** — if no same-tier slots available, wait for one to free up

## Setup

### 1. Install the extension

```bash
pi install git:github.com/Camcdonou/pi-synthetic-subagent
```

Or manual:

```bash
# Global
mkdir -p ~/.pi/agent/extensions/subagent
cp -r extensions/subagent/* ~/.pi/agent/extensions/subagent/

# Install agents
mkdir -p ~/.pi/agent/agents
cp extensions/subagent/agents/*.md ~/.pi/agent/agents/
```

Restart pi or run `/reload`.

### 2. Run the setup wizard

On first launch, the extension will prompt you to run the setup wizard. You can also re-run it anytime:

```
/subagent-setup
```

The wizard configures:
- **Pack count** — how many Synthetic packs you have (affects concurrency)
- **Models** — accept the defaults or customize which models to use
- **Weekly budget** — spending limit for warnings

### 3. Verify

```
/subagent
```

Shows current config: models, slot counts, agents, and session budget.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find auth code, one to find API routes
```

The scheduler automatically distributes tasks across available model slots.

### Chained workflow
```
Use a chain: scout the caching code, then plan improvements, then implement them
```

Chain passes each step's output to the next via the `{previous}` placeholder.

### Quick status
```
/subagent
```

## Agents

| Agent | Model | Tier | SWE-Bench | Tools | Purpose |
|-------|-------|------|-----------|-------|---------|
| `scout` | GLM-4.7-Flash | fast | 59.2% | read, grep, find, ls, bash | Fast recon, returns compressed context |
| `planner` | Kimi-K2.5 | power | 76.8% | read, grep, find, ls | Creates implementation plans (read-only) |
| `worker` | MiniMax-M2.5 | power | **80.2%** | all | General-purpose coder, writes code |
| `reviewer` | GLM-5.1 | power | 58.4% (Pro) | read, grep, find, ls, bash | Architectural review (read-only bash) |
| `doc-writer` | GLM-4.7-Flash | fast | 59.2% | read, write, edit, grep, find, ls | Documentation generation |

### Why these models?

- **MiniMax-M2.5 for worker**: 80.2% SWE-Bench Verified — best coding model on Synthetic. Strong tool use (BFCL: 76.8%) and web browsing (BrowseComp: 76.3%).
- **Kimi-K2.5 for planner**: 76.8% SWE-Bench, 50.2% HLE (strongest reasoner), built for long multi-turn agent workflows.
- **GLM-5.1 for reviewer**: SOTA SWE-Bench Pro (58.4%), best architectural understanding (MCP-Atlas: 71.8%), strong agentic performance (τ³-Bench: 70.6%, BrowseComp: 68.0%). Best at understanding code changes in context.
- **GLM-4.7-Flash for scout/doc-writer**: 59.2% SWE-Bench, 87.4% τ²-Bench (excellent tool use), cheapest model at 0.13× relative cost, gets 2× concurrency as a small model.

### Slot diversity

Each agent uses a different model (except scout and doc-writer sharing GLM-4.7-Flash's 2 slots). This means a full chain (scout → planner → worker → reviewer) can run all steps in parallel with zero contention — no fallbacks needed.

### Agent locations

- `~/.pi/agent/agents/*.md` — user-level (always loaded)
- `.pi/agents/*.md` — project-level (only with `agentScope: "project"` or `"both"`)

### Custom agents

Create a markdown file with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: hf:zai-org/GLM-4.7-Flash
---

System prompt for the agent goes here.
```

## Configuration

Config is stored in `~/.pi/agent/settings.json` under the `"subagent"` key:

```json
{
  "subagent": {
    "packs": 1,
    "weeklyBudget": 24,
    "defaultModel": "hf:MiniMaxAI/MiniMax-M2.5",
    "models": {
      "hf:zai-org/GLM-4.7-Flash": {
        "slots": 2, "cost": 0.13, "tier": "fast", "isSmall": true
      },
      "hf:MiniMaxAI/MiniMax-M2.5": {
        "slots": 1, "cost": 0.53, "tier": "power", "isSmall": false
      },
      "hf:moonshotai/Kimi-K2.5": {
        "slots": 1, "cost": 0.79, "tier": "power", "isSmall": false
      },
      "hf:zai-org/GLM-5.1": {
        "slots": 1, "cost": 1.0, "tier": "power", "isSmall": false
      }
    }
  }
}
```

Edit directly or use `/subagent-setup` to reconfigure interactively.

## Budget Tracking

The extension tracks cumulative sub-agent spending within a session and warns when approaching your weekly budget:

- **80%**: mild warning
- **95%**: strong warning
- **100%+**: critical warning

Budget is **not enforced** — it only provides warnings. You decide what to do.

Budget state persists across reloads within the same session but resets on new sessions.

## Tool Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `agent` | string | Agent name (single mode) |
| `task` | string | Task description (single mode) |
| `tasks` | array | `[{agent, task}]` for parallel execution |
| `chain` | array | `[{agent, task}]` for sequential execution with `{previous}` |
| `agentScope` | `"user"` \| `"project"` \| `"both"` | Which agent directories to use (default: `"user"`) |
| `confirmProjectAgents` | boolean | Prompt before project-local agents (default: `true`) |
| `cwd` | string | Working directory (single mode) |

## Commands

| Command | Description |
|---------|-------------|
| `/subagent` | Show status dashboard (agents, slots, budget) |
| `/subagent-setup` | Re-run the setup wizard |
| `/subagent <args>` | Delegate a task (same as the tool) |

## Rendering

### Collapsed view
- Status icon (✓/✗/⏳) and agent name
- Fallback indicator: `⚡ model-name` when a different model was used
- Slot usage: `GLM-4.7-Flash:1/2 | MiniMax-M2.5:1/1 | Kimi-K2.5:0/1 | GLM-5.1:0/1`
- Budget warnings: `⚠ approaching limit`

### Expanded view (Ctrl+O)
- Full task text
- All tool calls
- Final output as Markdown
- Per-task usage stats

## Requirements

- [Pi](https://github.com/badlogic/pi-mono) (`npm install -g @mariozechner/pi-coding-agent`)
- A [Synthetic](https://synthetic.new) account with API key
- `SYNTHETIC_API_KEY` environment variable

## License

MIT
