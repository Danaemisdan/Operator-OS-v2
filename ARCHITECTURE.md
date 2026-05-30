# Operator OS — Architecture

> **The Golden Rule:** AI = Brain. Execution Engine = Hands. Knowledge Graph = Memory. Scheduler = Heartbeat. Site Mapper = Eyes.
> Never let the model click, type, drag, or navigate. Ever.

---

## The Core Philosophy

Most AI agents fail because they make one model do everything — plan, act, observe, recover, remember. That works for demos. It doesn't scale.

Operator OS separates responsibilities so aggressively that a 3B local model feels smarter than a 70B model that tries to do everything itself. The secret is not a better model. It's a better harness.

```
User Input
    ↓
[Intent Classifier]         — What kind of request is this?
    ↓
[Planner AI]                — Break it into steps. Never touches browser.
    ↓
[Execution Engine]          — Deterministic. Clicks, types, navigates.
    ↓
[Observer AI]               — What actually happened? Where are we?
    ↓
[Verification Layer]        — Did the action succeed? Really?
    ↓
[Memory / KG Update]        — Record what we learned.
    ↓
[Planner AI]                — Replan based on real state.
    ↓
(repeat)
```

---

## The 5 AI Roles — Strictly Enforced

### 1. Planner AI
**One job:** Decompose a goal into an ordered list of steps.

**Input:**
```json
{
  "goal": "Find AI startups hiring remote engineers",
  "memory": { "preferred_locations": ["Remote"], "salary_min": "100k" },
  "available_skills": ["search_web", "extract_jobs", "filter_results"]
}
```

**Output:**
```json
{
  "goal_id": "find_ai_startups",
  "confidence": 0.91,
  "steps": [
    { "id": 1, "action": "search_web", "args": { "query": "AI startups hiring remote engineers 2025" } },
    { "id": 2, "action": "extract_jobs", "args": { "filter": "remote" } },
    { "id": 3, "action": "rank_results", "args": { "by": "relevance" } }
  ]
}
```

**Forbidden:** The Planner never sees HTML. Never sees element IDs. Never touches the browser.
**Reads:** User memory, skill registry, current URL.
**Does not read:** DOM, element positions, page content.

---

### 2. Observer AI
**One job:** After every action, describe what actually happened on screen. Objectively.

**Input (after "clicked Apply button"):**
```
Current Page:
  URL: linkedin.com/jobs/apply/123
  Title: Easy Apply — Software Engineer
  Visible Text: ["First Name", "Last Name", "Resume", "Submit Application"]
  New Elements: [INP_001 "First Name", INP_002 "Last Name", BTN_001 "Submit Application"]
  URL Changed: yes (from /jobs/view to /jobs/apply)
```

**Output:**
```json
{
  "state": "application_form_open",
  "what_changed": "Application form appeared with 3 fields and a submit button",
  "blockers": [],
  "confidence": 0.97,
  "next_hint": "Fill First Name, Last Name, then click Submit Application"
}
```

**Why this is the most important role:** Without a dedicated Observer, the Planner is blind. It acts and hopes. The Observer gives it eyes. This is the difference between an agent that loops forever and one that knows exactly where it is.

**Forbidden:** Observer never plans. Never decides. Only reports state.

---

### 3. Recovery Agent
**One job:** When an expected element is missing, find the equivalent and continue.

**Trigger:** Element not found in DOM, action failed, unexpected state.

**Input:**
```json
{
  "goal": "Click Apply button",
  "expected_element": { "text": "Apply Now", "type": "BTN" },
  "current_page_elements": ["Easy Apply", "Save Job", "Share", "Follow"],
  "known_site_graph": { "linkedin_apply_flow": ["Apply Now", "Easy Apply"] }
}
```

**Output:**
```json
{
  "recovery_action": "click",
  "target_text": "Easy Apply",
  "reasoning": "Easy Apply is LinkedIn's replacement for Apply Now on this job type",
  "graph_update": { "linkedin.apply_button_variants": ["Apply Now", "Easy Apply"] },
  "confidence": 0.88
}
```

**Rule:** Recovery Agent updates the Knowledge Graph after every successful recovery. Failures become training data. The system self-heals permanently — not just for this session.

---

### 4. Exploration Agent
**One job:** When Operator visits a site it hasn't seen before, map it automatically before attempting any task.

**Trigger:** `site_graph[domain]` is empty or stale (>30 days).

**Process:**
```
Load site homepage
    ↓
Extract all interactive elements
    ↓
Follow top-level navigation links (max depth 3)
    ↓
Open dropdowns, hover menus
    ↓
Detect forms, modals, filters
    ↓
Build site graph
    ↓
Store in Knowledge Graph under domain
```

**Output (site graph for linkedin.com):**
```json
{
  "domain": "linkedin.com",
  "mapped_at": "2025-05-31",
  "pages": {
    "/jobs": {
      "purpose": "Job search",
      "inputs": ["search_keywords", "location"],
      "filters": ["date_posted", "experience_level", "remote"],
      "actions": ["search", "save_job", "apply", "easy_apply"]
    },
    "/messaging": {
      "purpose": "Direct messaging",
      "inputs": ["message_compose"],
      "actions": ["send", "attach_file"]
    }
  },
  "known_flows": {
    "apply_job": ["search", "open_job", "click_easy_apply", "fill_form", "submit"]
  }
}
```

**This is the moat.** Every site Operator visits, it learns. Over time the site graph becomes more valuable than the model itself.

---

### 5. Research Agent
**One job:** Pure intelligence. No browser interaction. Search, extract, cluster, rank, summarize.

**Never mixed with automation.** Research is its own pipeline.

**Research workflow (graph-based, not page-by-page):**
```
Search query
    ↓
Fetch top N results (parallel)
    ↓
Extract structured data from each
    ↓
Cluster by relevance
    ↓
Rank by user criteria
    ↓
Summarize
    ↓
Return structured output
```

**Output:**
```json
{
  "query": "AI startups hiring remote engineers",
  "results": 47,
  "companies": [
    { "name": "Embra", "url": "embra.ai", "roles": 3, "fit_score": 0.94 },
    { "name": "Cognition", "url": "cognition.ai", "roles": 5, "fit_score": 0.91 }
  ],
  "summary": "Found 47 companies, 12 with strong remote culture and ML engineering roles"
}
```

**Then** automation begins — not before.

---

## The Loops

The system runs five concurrent loops at different frequencies.

### Strategic Loop (per-goal)
```
User Goal
    ↓
Read User Memory
    ↓
Check Skill Registry
    ↓
Planner AI → Steps
    ↓
Dispatch to Workflow Engine
```

### Execution Loop (per-action) — OODA lives here
```
Observe (refresh DOM)
    ↓
Orient (Observer AI reports state)
    ↓
Decide (Planner picks next action)
    ↓
Act (Execution Engine runs it)
    ↓
Verify (did it work?)
    ↓
Update Memory
    ↓
repeat
```

### Learning Loop (per-failure)
```
Action failed / element missing
    ↓
Recovery Agent activates
    ↓
Alternative found and used
    ↓
Update site Knowledge Graph
    ↓
Store as skill repair record
    ↓
Next time: use repaired path directly
```

### Exploration Loop (per new domain)
```
New domain detected
    ↓
Exploration Agent activates
    ↓
Maps pages, forms, flows
    ↓
Builds site graph
    ↓
Stores in KG
    ↓
All future tasks on this site use the graph
```

### Monitoring Loop (continuous)
```
Scheduler fires trigger
    ↓
Check condition (price drop? new job? email?)
    ↓
Triggered? → Run workflow
    ↓
Not triggered? → Wait for next interval
    ↓
Results compared to last run
    ↓
Diff generated
    ↓
Notify user if meaningful change
```

---

## The Full Architecture Stack

```
┌─────────────────────────────────────────────────────────┐
│                      USER INTERFACE                      │
│           Chat · Workflow Builder · Dashboard            │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                   INTENT CLASSIFIER                      │
│   chat / task / research / schedule / explore            │
└────┬──────────┬──────────┬──────────┬───────────────────┘
     │          │          │          │
┌────▼───┐ ┌───▼────┐ ┌───▼────┐ ┌───▼──────────────────┐
│Planner │ │Research│ │Explore │ │  Scheduler / Events   │
│   AI   │ │ Agent  │ │ Agent  │ │  (cron + webhooks)    │
└────┬───┘ └───┬────┘ └───┬────┘ └──────────────────────-┘
     │         │          │
┌────▼─────────▼──────────▼──────────────────────────────┐
│                   WORKFLOW ENGINE                        │
│   Steps · State · Progress · Pause / Resume             │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                  EXECUTION ENGINE                        │
│  click · type · navigate · scroll · extract · upload    │
│           (deterministic — zero AI in here)              │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                    OBSERVER AI                           │
│    State · What changed · Blockers · Next hint          │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                 VERIFICATION LAYER                       │
│   URL changed? · Expected element appeared? · Success?  │
│               Failed? → Recovery Agent                   │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                  MEMORY SYSTEM                           │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  User Memory │  │  Site Memory │  │ Skill Memory │  │
│  │              │  │              │  │              │  │
│  │ · Prefs      │  │ · KG graphs  │  │ · Successes  │  │
│  │ · Resume     │  │ · Flows      │  │ · Failures   │  │
│  │ · Accounts   │  │ · Selectors  │  │ · Repairs    │  │
│  │ · Blocklist  │  │ · Patterns   │  │ · Timing     │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## Memory Layers

### User Memory (persistent, private)
```json
{
  "user": {
    "name": "Sanjeev",
    "preferred_salary": "100k+",
    "preferred_locations": ["Remote"],
    "resume": "resume_v3.pdf",
    "companies_to_avoid": ["Oracle", "Infosys"],
    "accounts": {
      "linkedin": { "logged_in": true, "last_seen": "2025-05-30" },
      "gmail": { "logged_in": true }
    }
  }
}
```
**Who reads it:** Planner, Research Agent.
**Who does NOT read it:** Executor, Observer, Verification Layer.

### Site Memory (grows over time — the moat)
```json
{
  "linkedin.com": {
    "mapped_at": "2025-05-20",
    "apply_flow": ["search", "click_job", "easy_apply", "fill_form", "submit"],
    "known_popups": ["Sign in to apply", "Profile incomplete"],
    "popup_dismissals": { "Sign in to apply": "close_modal_btn" },
    "selector_repairs": {
      "apply_btn": { "original": "Apply Now", "current": "Easy Apply", "repaired_at": "2025-05-28" }
    }
  }
}
```
**Who writes it:** Exploration Agent, Recovery Agent, Learning Loop.
**Who reads it:** Planner, Executor (for known selectors).

### Skill Memory (execution history)
```json
{
  "skill_id": "linkedin_easy_apply",
  "runs": 47,
  "success_rate": 0.89,
  "avg_duration_ms": 12400,
  "failure_causes": ["CAPTCHA", "profile_incomplete", "application_limit"],
  "last_repair": "2025-05-28"
}
```

---

## Verification — Every Action, No Exceptions

```
Action executed
    ↓
Check: Did URL change as expected?
Check: Did expected element appear?
Check: Did expected text appear on page?
Check: Did DOM element count change meaningfully?
    ↓
All pass → Continue
Any fail → Recovery Agent
```

**Verification spec (per action type):**

| Action | Success Signal |
|---|---|
| `navigate` | URL matches target |
| `click` (button) | URL changed OR modal appeared OR DOM changed |
| `type` | Input element contains typed text |
| `press_enter` | URL changed OR results appeared |
| `scroll` | New elements entered viewport |
| `submit_form` | Confirmation message OR URL changed to success page |

---

## Structured Outputs — Enforced Everywhere

**The AI outputs ONE of these. Nothing else.**

```typescript
// Planner output
type PlannerOutput = {
  goal_id: string;
  confidence: number;          // 0-1, below 0.7 → ask user
  steps: PlanStep[];
  requires_info?: string[];    // questions to ask user before starting
}

// Observer output  
type ObserverOutput = {
  state: string;               // machine-readable state name
  what_changed: string;        // human-readable summary
  blockers: string[];          // ["login_required", "captcha", "popup"]
  confidence: number;
  next_hint: string;           // suggestion for planner
}

// Recovery output
type RecoveryOutput = {
  recovery_action: ActionType;
  target_text?: string;
  target_id?: string;
  reasoning: string;
  graph_update?: object;       // what to store in KG
  confidence: number;
}

// Execution Engine input (deterministic, never from AI directly)
type ExecutionAction = {
  action: 'click' | 'type' | 'navigate' | 'press_enter' | 'scroll' | 'extract';
  target_id?: string;          // element ID from UI mapper
  text?: string;
  url?: string;
}
```

---

## Event-Driven Workflows

Operator is reactive, not just scheduled.

```json
{
  "trigger": {
    "type": "page_change",
    "url_pattern": "linkedin.com/jobs",
    "condition": "new_job_matching",
    "criteria": { "keywords": ["AI", "remote"], "salary_min": "100k" }
  },
  "workflow": "auto_apply_job",
  "enabled": true
}
```

```json
{
  "trigger": {
    "type": "email_received",
    "from_pattern": "*@ycombinator.com",
    "subject_contains": ["interview", "application"]
  },
  "workflow": "classify_and_draft_reply"
}
```

```json
{
  "trigger": {
    "type": "schedule",
    "cron": "0 9 * * 1-5"
  },
  "workflow": "check_competitors_and_report"
}
```

---

## Long-Running Workflow State

Every workflow is resumable. No workflow ever "crashes" — it pauses.

```json
{
  "workflow_id": "find_investors_travana",
  "status": "running",
  "started_at": "2025-05-31T08:00:00Z",
  "progress": {
    "percent": 67,
    "companies_checked": 1200,
    "investors_found": 43,
    "current_step": "extract_contact_info",
    "last_checkpoint": "2025-05-31T14:23:00Z"
  },
  "resume_from": "company_index_1201"
}
```

If Operator is killed mid-task, it picks up at `last_checkpoint`. Always.

---

## The Skill Registry

Skills are APIs. Not prompts.

```json
{
  "id": "linkedin_easy_apply",
  "name": "LinkedIn Easy Apply",
  "description": "Applies to a job using LinkedIn's Easy Apply flow",
  "inputs": {
    "job_url": "string",
    "resume_path": "string"
  },
  "outputs": {
    "applied": "boolean",
    "application_id": "string?"
  },
  "requirements": ["linkedin_logged_in", "profile_complete"],
  "success_conditions": ["URL contains /apply/success", "Confirmation text visible"],
  "failure_conditions": ["CAPTCHA appeared", "Application limit reached"],
  "known_sites": ["linkedin.com"],
  "avg_duration_ms": 12400,
  "success_rate": 0.89
}
```

A 3B model with 10,000 skills like this will absolutely destroy a 70B model with no skills. Skills are the product. The model is just the router.

---

## Parallel Execution

Research and data extraction are parallelized. Execution is sequential (one browser).

```
Research 100 companies
    ↓
Spawn 10 research workers (Promise.all)
    ↓
Each processes 10 companies
    ↓
Results merged
    ↓
Ranked and returned

Time: 10x faster than serial
```

Browser automation stays sequential — one action at a time, verified before proceeding.

---

## Confidence Scores

Every AI output includes a confidence score. Low confidence = ask user.

```
confidence > 0.85  →  proceed automatically
confidence 0.60-0.85  →  proceed with logging
confidence < 0.60  →  pause and ask user
```

This prevents the agent from hallucinating its way through a task. If it's not sure, it asks. That's the right behaviour.

---

## The Moat

| Component | Why It Compounds |
|---|---|
| **Site Knowledge Graphs** | Every site visited gets mapped. Knowledge accumulates permanently. |
| **Skill Library** | Every skill added expands what every future workflow can do. |
| **Repair Records** | Every self-healing event makes the system more reliable for everyone. |
| **Execution History** | The system learns what works on which sites, in which conditions. |
| **User Memory** | The more the user uses it, the more personalised it gets. |

None of this resets between sessions. All of it compounds. That's the moat.

---

## What This Is Not

- **Not an LLM wrapper.** The LLM plans and observes. Deterministic code acts.
- **Not a screenshot agent.** Structured DOM graphs, not pixel matching.
- **Not prompt-dependent.** Skills work the same regardless of how you phrase the goal.
- **Not fragile.** Every failure triggers recovery. Every recovery improves the system.

---

## Current Implementation Status

| Component | File | Status |
|---|---|---|
| Intent Classifier | `intent-classifier.js` | ✅ Done |
| Planner AI | `manager-agent.js` | ✅ Done |
| Execution Engine | `main.js` (execute-action) | ✅ Done |
| UI Mapper / Indexer | `indexer.js` | ✅ Done |
| DOM Pruner | `dom-pruner.js` | ✅ Done |
| Observer AI | `llm-bridge.js` (observer role) | 🔧 Partial — merged with planner |
| Verification Layer | `renderer.js` | 🔧 Partial — LLM-based only |
| Recovery Agent | — | ❌ Not built |
| Exploration Agent | — | ❌ Not built |
| Research Agent | `research-agent.js` | 🔧 Partial |
| Skill Registry | `skills/_registry.js` | ✅ Basic |
| Knowledge Graph | `knowledge-graph.js` | ✅ Basic |
| Episodic Memory | `memory.js` | ✅ Done |
| Scheduler / Events | — | ❌ Not built |
| Long-running workflow state | — | ❌ Not built |
| Confidence scores | — | ❌ Not built |
| Parallel execution | — | ❌ Not built |

---

*This document is the architectural contract for Operator OS. Every new feature, every refactor, every decision should be measured against it. If it violates the separation of Brain / Hands / Memory / Eyes / Heartbeat — it's wrong.*
