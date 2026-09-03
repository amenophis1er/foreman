# Foreman — UI Inventory & Design System (handoff for UI rehaul)

This document is the complete inventory of Foreman's current UI: design
tokens, components, every page and state with screenshots, interaction
patterns, and known UX debt. It is written for an agent (or designer)
doing a full visual rehaul. **Behavior described here is the contract;
the visual treatment is yours to reinvent.**

Stack: React 19 + Vite + TypeScript, no CSS framework — all styling is
inline styles referencing CSS custom properties from
`ui/src/design/tokens.css`. Components in `ui/src/design/ui.tsx`, views in
`ui/src/views/`. Single committed dark theme.

---

## 1. Design tokens (current values)

Source of truth: `ui/src/design/tokens.css`. No raw hex in components.

### Surfaces
| Token | Value | Use |
|---|---|---|
| `--bg-app` | `#121417` | App background |
| `--bg-panel` | `#1a1d22` | Side panels, headers |
| `--bg-card` | `#22262d` | Cards, inputs |
| `--bg-inset` | `#14161a` | Code blocks, wells, meters track |
| `--line` | `#2d323b` | Hairline borders |
| `--line-strong` | `#3a4048` | Input borders, emphasis |

### Ink (text never wears identity/status colors)
| Token | Value | Use |
|---|---|---|
| `--ink-0` | `#e8e6df` | Primary text |
| `--ink-1` | `#a7afb9` | Secondary |
| `--ink-2` | `#6d7683` | Muted / labels |

### Identity (fixed assignment, never cycled or reassigned)
| Token | Value | Use |
|---|---|---|
| `--brand` | `#e8b04b` (gold) | Foreman brand, the **director**, primary actions, question/approval accents |
| `--brand-ink` | `#14161a` | Text on brand |
| `--agent-worker` | `#9c86e8` (violet) | **Workers** (all of them share one identity color) |

### Status (CVD-validated set; ALWAYS paired icon + label, never color alone)
| Token | Value | Icon+label today |
|---|---|---|
| `--status-good` | `#0ca30c` | ✓ done, ● running |
| `--status-warning` | `#fab219` | 🔔 needs-you, △ 70% budget, ◷ read-only |
| `--status-serious` | `#ec835a` | ⏸ interrupted, disconnect ⏻ |
| `--status-critical` | `#d03b3b` | ✕ error, ⚠ 90% budget, deny |

### Type & shape
- Fonts: `--font-ui` (system sans), `--font-mono` (tool payloads, paths, session ids)
- Sizes: `--fs-xs` 11 · `--fs-sm` 12 · `--fs-md` 13 (base) · `--fs-lg` 15; line-height 1.45
- Space: 4 / 8 / 12 / 16 / 24 (`--sp-1..5`); radii 6 (`--r-sm`) / 10 (`--r-md`)
- Focus ring: 2px offset ring in `--brand`; `.pulse` keyframe (opacity 1↔.55, 1.6s) for needs-you

## 2. Component inventory (`ui/src/design/ui.tsx`)

| Component | Contract |
|---|---|
| `Button` | variants: default / primary (brand-filled) / good (green outline) / danger (red outline); disabled = 0.5 opacity |
| `Card` | `--bg-card` surface, optional 3px left accent border (agent identity or status) |
| `StatusBadge` | pill with icon + label for idle/running/done/error/interrupted |
| `BudgetMeter` | 4px track + fill; text `$spent / $budget` always visible; fill escalates brand → warning (≥70%) → critical+⚠ (≥90%) |
| `SectionTitle` | 11px uppercase letterspaced muted heading |
| `Empty` | muted one-line empty-state text |
| `agentColor(id)` | director→brand, anything else→worker violet |

Views also define locally: `ProjectCard`, `FolderPicker` (modal), `Composer`,
`ModelSelect`, `RunList`, `AgentTree`, `Transcript` entry, approval card,
question card, `PlanBoard`. A rehaul may promote these into the design system.

## 3. Pages & states (screenshots in ./screenshots)

### 3.1 Fleet home — route `#/`
- **Idle** — `01-fleet-idle.jpg`. Header (brand + "mission control" + ⏻ disconnected indicator when SSE drops). Responsive card grid (`minmax(300px,1fr)`): per project — name, StatusBadge, mono folder path (ellipsized), "No active mission" hint, `unlink` text button (stopPropagation). Dashed "＋ Link a project" card. Empty-state line when no projects.
- **Running + needs-you** — `05-fleet-needs-you.jpg`. Active card gains: warning border, pulsing "🔔 needs you — N approvals, M questions" strip, 2-line-clamped mission text, BudgetMeter. Card click → project view.

### 3.2 Folder picker — modal over any view
- `02-folder-picker.jpg`. Backdrop click closes. Mono gold current path header, scrollable list (⬑ .. parent, 📁 dirs, hidden dirs excluded), footer Cancel / "Select this folder" (primary). Used by Link-a-project.

### 3.3 Project view — route `#/p/<projectId>`
Header always: "← Fleet" back button, project name + mono folder, then (when a run is displayed) StatusBadge + BudgetMeter + contextual actions: **Interrupt** (danger, live running) · **⟳ Resume** (good; only when selected run is interrupted/error, project idle, and a director session exists) · **New mission** (primary; when project idle and a past run is displayed).

- **Composer (no active run)** — `03-project-composer.jpg`. 2 columns: left rail RunList (history); center max-720px composer: "New mission" + folder, large textarea (min 180px, guidance placeholder: say what DONE looks like, flag decisions to ask about), row of Budget $ input · Director model select · Workers model select (default/opus/sonnet/haiku) · "Start mission" primary · inline ✕ error.
- **Live run** — `04-project-running-question.jpg` (question card) and `06-project-approval-card.jpg` (approval card). 3 columns 250/1fr/340:
  - **Left rail**: AGENTS (colored dot + id + StatusBadge; director first, workers indented; click = filter transcript, click again clears; "director session <8-char id>" mono footer) then RUNS (history list: 1-line mission, date, $cost, StatusBadge; selected = card background).
  - **Center transcript**: auto-scroll pinned to bottom (unpins when user scrolls up >60px). Entry = Card with meta row (agent dot, `agent · title`, time HH:MM:SS) + body. Kinds: text (agent-accent left border, prose), tool/result (mono 12px, gold ⚙ prefix for foreman MCP tools), system (muted), error (critical accent).
  - **Right rail**: APPROVALS — gold-accent card: `[agent] <title>`, optional △ decisionReason line (serious color), JSON input in inset `pre` (max 150px), buttons Allow / Always (run) / Deny. QUESTIONS — gold-accent card: "Director asks:", question text, textarea, Answer (primary). PLAN — parsed live from `.foreman/MISSION.md` checkboxes: `n/m` counter, ✓ struck-through done items, ○ open items, "raw doc" toggle to full markdown in inset pre (5s poll).
- **Interrupted / error (+ Resume)** — `07-project-interrupted-resume.jpg`. Read-only banner "◷ Viewing a past run (read-only)" under header; error entries in transcript; header shows ✕ error badge, ⟳ Resume, New mission.
- **History replay** — same layout as live, driven by the identical event-replay path; banner shown; approvals/questions sections render empty (cleared on run_finished).

### 3.3b States added after the screenshots (no captures; behavior below)

- **Picker: ＋ New folder** — footer button toggles an inline name input +
  Create (Enter submits); creation navigates into the new folder ready to
  select; validation errors (traversal, hidden names) show inline in
  critical color.
- **Fleet: drag-and-drop linking** — dragging a folder over the fleet shows
  a full-view gold dashed drop overlay ("Drop a folder to link it").
  Dropping opens a confirm modal: since browsers expose only the dropped
  folder's *name*, the server searches `$HOME` and the modal lists candidate
  absolute paths (mono), with searching / no-match states. Picking one links
  and opens the project.
- **Resume button states** — disabled "⟳ Resuming…" while in flight; server
  rejections (409s) surface inline in the project header in critical color.

### 3.4 Global behaviors
- One SSE connection; frames enveloped `{runId, projectId, data}`; fleet polls `/projects` every 3s and eagerly on relevant events.
- Hash routing; refresh-safe (state hydrates by replaying the run's persisted event log through the same reducer as live).
- One active mission per project; starting a second returns 409 shown inline in the composer.

## 4. Known UX debt (fix candidates for the rehaul)

1. **Agents/Runs hierarchy unclear** — the left-rail sections read as siblings; Agents describes the *selected run*. Consider nesting agents under the selected run or labels like "This run's crew" / "Mission history". (User-reported.)
2. No timeline view (golden-eye parity gap); transcript timestamps only.
3. Transcript tool payloads are raw truncated JSON — could be structured (tool chips, collapsible args, diff rendering for Edit/Write).
4. Approval/question cards only live in the right rail — no toast/sound; if the rail is scrolled they can be missed (fleet pulse covers the zoomed-out case only).
5. Worker identity: all workers share one violet; multiple workers are only distinguishable by label.
6. No light theme (single committed dark look; tokens make theming feasible).
7. Fleet cards lack recent-history summary (last mission result/cost) when idle.
8. `unlink` is an unceremonious text button with no confirm.
9. Composer has no mission templates/snippets and no draft persistence.
10. Mobile/narrow layouts unconsidered (3-column grid is fixed-width rails).

## 5. Template opportunities (design ahead of implementation)

The rehaul is welcome to design these now; backend hooks are trivial to add:

- **Mission templates in the composer** — reusable briefs with placeholders
  (e.g. "Bug fix", "Add tests", "Refactor X", "Audit"), each pre-setting
  budget + director/worker models. Suggested shape: a template picker row
  above the textarea; templates stored per-project with global defaults;
  "save current brief as template" affordance. Pairs with a future
  "Trust this run" pre-grant toggle (roadmapped) that templates could carry.
- **Project card templates/presets** — per-project defaults surfaced at link
  time (default budget, models, trusted tools) so the composer opens
  pre-configured.
- **Component templates for the design system itself** — if you introduce a
  component library layer, the primitives in §2 plus the local view
  components (approval card, question card, plan row, run row, drop-confirm
  modal) are the complete set to formalize; nothing else exists.

## 6. Non-negotiables for any rehaul

- Status is never color-alone (icon + label stay).
- Identity colors follow the entity (director gold / workers violet may be
  re-hued, but must stay fixed per role, never cycled).
- Text wears ink tokens, never identity/status colors, except deliberate
  accents (question "Director asks:", approval titles).
- All values through tokens; no hex in components.
- The behavior contract in §3 (routes, states, actions per state) is the
  spec — visuals, layout, and componentization are free to change.
