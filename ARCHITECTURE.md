# Operator OS Architecture

## Core Philosophy
Operator OS is a local operating system for automation, not just a browser agent. Websites, desktop apps, APIs, files, and terminals are all treated as different execution environments (plugins). The architecture is general enough that the exact same action graph can drive any environment.

The biggest problem in automation is not intelligence; it is **Observation**. The browser sees nested `<div>` and `<svg>` tags, but humans see actionable semantic objects. Operator OS bridges this gap.

---

## The Universal UI Mapper (The Moat)

The centerpiece of Operator OS is not skill recording; it is the **Universal UI Mapper**. It continuously explores apps, labels elements, learns relationships, and generates a persistent **Site Knowledge Graph**.

### Site Knowledge Graphs
Instead of recording brittle step-by-step workflows, Operator OS builds application knowledge.
When you visit a new site, the OS spends time indexing:
1. **Pages** (e.g., Jobs, Feed, Messaging)
2. **Elements** (Assigns IDs like `BTN_001`, `INP_002`)
3. **Relationships** (e.g., `Jobs -> Apply Button`)

### Human-Taught Semantics
The OS maps the structure, and the user teaches the semantics.
*Operator*: "What is BTN_003?"
*User*: "Apply button"

This creates a persistent, reusable graph for the site. The 3B model (Operator Engine) just says "use the Apply action on this job" and the runtime knows exactly what that means.

### Self-Healing & Robust Storage
Traditional selectors (XPath/CSS) break instantly. Operator OS stores rich semantic elements:
```yaml
element:
  name: Apply
  role: button
  text: Apply Now
  parent: Job Card
  page: Job Search
  nearby:
    - Save Job
  actions:
    - click
```
If a site redesigns, the system searches the graph, finds a similar element based on these heuristics, updates the map, and self-heals without user intervention.

---

## The Three Layers

### Layer 1: Primitive Actions & Multi-Layer Interaction
Primitives are universal, deterministic building blocks with **no AI** involved.
Crucially, primitives are not single shots. They are **Fallback Chains**.
If Operator Engine requests a `click`, Layer 1 attempts a multi-layer strategy:
1. DOM click
2. Javascript click
3. Playwright click
4. Hover then click
5. Scroll then click
6. Coordinate click
7. Vision click

If one fails, it moves to the next.

### Layer 2: Application Knowledge & Skills
With a mapped site, skills become tiny semantic references rather than mechanical macros.
```yaml
name: apply_job
steps:
  - open_job
  - apply
```
The runtime resolves these against the Site Knowledge Graph.

### Layer 3: Operator Engine (3B Model)
The cognitive layer powered by `Operator-engine-3b.gguf`. Because the Universal UI Mapper handles observation and the Knowledge Graph handles location, the model's job is ridiculously easy: reason about logical actions, not DOM traversal.

---

## System Architecture

```text
Prompt
  ↓
Planner (Operator Engine)
  ↓
Action Graph (while, if, execute)
  ↓
Execution Engine (Fallback Chains)
  ↓
Execution Environment
  ↓
Observation Engine (Universal UI Mapper / Site Graph)
  ↓
Planner
```
