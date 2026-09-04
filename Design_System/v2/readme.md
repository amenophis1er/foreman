# Foreman Design System

Foreman is an autonomous mission runner built on the Claude Agent SDK. You
link a project folder, write a mission, and a **director** agent plans it
into `.foreman/MISSION.md`, delegates implementation to **worker** sessions,
answers or escalates their questions, verifies the result independently, and
reports back — from one browser dashboard, with no terminal. Every run
persists to `~/.foreman/`, so the dashboard is refresh-proof, fully
replayable, and can resume an interrupted mission.

This design system is the visual and behavioural language of that dashboard:
tokens, the component inventory, a click-through recreation of the product,
and page templates for building new surfaces in it.

**Revision 2 (this version) is the UI rehaul the source asked for.** It keeps
the behaviour contract and the gold/violet identity, and changes four things:
a logo, a real icon library (Lucide), a chosen typeface pair (Source Sans 3 +
IBM Plex Mono), and fixes for all ten items of documented UX debt. See
"Debt resolved" near the end.

## What the product is, in its own words

> A foreman runs a crew on a job site. Here the job site is a folder on your
> machine, the crew is Claude agents, and you hand it a mission instead of a
> checklist. — `DESIGN.md`

Three ideas drive every screen:

1. **Folder-linked.** A run is bound to one directory; picking the folder is
   the entire setup. The absolute path is visible on nearly every screen.
2. **The UI is the only I/O surface.** Pick folder → state mission → watch
   live → answer the few things only a human should → get the result.
3. **Cost and consent are first-class.** A budget meter sits in every
   header; tool calls that matter stop and ask. Nothing is hidden from the
   operator — payloads are shown raw.

### Surfaces

There is exactly **one** product surface: the Foreman dashboard (React 19 +
Vite, single committed dark theme). It has two routes — the **fleet** (`#/`)
and a **project view** (`#/p/<projectId>`) that shows either the mission
composer or a run (live or replayed). No marketing site, no docs site, no
mobile app, no light theme. The UI kit in this system recreates all of it.

## Sources

Everything here was read from a mounted local codebase — no Figma file, no
screenshots-only guesswork. The reader of this document is not assumed to
have access; paths are recorded in case they do.

| Source | Path | What it gave |
|---|---|---|
| Foreman codebase | `foreman/` (local mount) | Product truth |
| Design tokens | `foreman/ui/src/design/tokens.css` | Every token value here, verbatim |
| Primitives | `foreman/ui/src/design/ui.tsx` | Button, Card, StatusBadge, BudgetMeter, SectionTitle, Empty, `agentColor` |
| Views | `foreman/ui/src/views/{FleetView,ProjectView,Transcript,RightPanel,AgentTree,FolderPicker}.tsx` | Screen layouts, local view components, all copy |
| Shell | `foreman/ui/src/App.tsx`, `ui/index.html` | Routing and app frame |
| UI inventory & handoff | `foreman/Design_System/README.md` | State-by-state behaviour contract, non-negotiables, known UX debt |
| Product concept | `foreman/DESIGN.md`, `foreman/README.md` | Voice, product story, architecture |
| Domain types | `foreman/src/types.ts` | `RunStatus`, `WorkerStatus`, `ModelChoice`, run/project shapes |
| Screenshots | `foreman/Design_System/screenshots/*.jpg` | Copied to `assets/screenshots/`; used only to confirm the code reading |

**The source ships no logo, icon set, or font file.** All three were added in
this revision at the owner's request; see BRAND, ICONOGRAPHY and Caveats.

---

## CONTENT FUNDAMENTALS

Foreman writes like a competent colleague reporting on machinery — factual,
unhurried, never cheerful. Copy is deliberately short because the screen is
already dense with agent output.

**Person.** Second person for the operator, third person for the machinery.
"Pick the matching location." · "Searching your home folder…" · "No
questions from the director." The product never says "I", and never
personifies itself; the *director* is the thing with intent, and it speaks
in its own transcript entries ("I'll write the mission file first").

**Casing.** Sentence case everywhere. Status words are lowercase single
words (`idle`, `running`, `done`, `error`, `interrupted`). Model names are
bare lowercase (`default`, `opus`, `sonnet`, `haiku`). Section titles are
authored in sentence case (`Approvals`) and uppercased by CSS. Buttons are
sentence case with a real verb: `Start mission`, `Interrupt`, `Allow`,
`Always (run)`, `Deny`, `Answer`, `Select this folder`, `Resume`,
`New mission`, `New folder`, `Unlink`. Icons lead a label; they never replace it.

**Sentence shape.** State the fact, then — after an em dash — the next step
or the reason. This is the house pattern:

- "No projects linked yet — link a folder to give the director a job site."
- "No missions yet — open to compose one."
- "Browsers hide dropped folders' full paths — pick the matching location."
- "No folder named "fleet-alpha" found under your home directory — use the
  folder picker instead."
- "Showing only **worker-1** — click again to clear."
- "The run is waiting on you — 1 approval, 1 question pending."

**Explaining rather than hiding.** When a constraint exists, Foreman names
it. The drop-confirm modal explains that browsers withhold the path. The
approval card shows exactly what the agent wants to run — as a diff when it
edits a file, as the payload otherwise — and the transcript's tool chips fold
the same information rather than hiding it. The plan board offers `raw doc`. `README.md` even says the dollar figures are notional.

**Coaching copy is load-bearing.** The composer placeholder is the product's
one piece of instruction and should be reproduced verbatim:

> Describe the mission…
>
> Say what "done" looks like, name constraints, and flag any decision the
> director should ask you about before implementing.

**Consequences live in tooltips**, not helper text: "Unlink project (run
history is kept)" · "Model for workers (implementation). Pick sonnet or
haiku to cut cost." · "Restore the director's session and continue this
mission".

**Vocabulary.** *mission* (not task/job), *run* (one execution of a
mission), *project* (a linked folder), *fleet* (all projects), *director* /
*worker* (never "agent one"), *approval* (not permission prompt),
*question* (not prompt), *plan* (the MISSION.md checklist), *budget* and
*cost* (never "spend" or "usage"), *interrupt* (not stop/cancel),
*resume*, *replay*, *link* / *unlink* a project.

**Emoji.** None. The folder and bell that used to be emoji are Lucide icons.

**Templates.** Mission templates (Bug fix · Add tests · Refactor · Audit)
follow one skeleton: *what* on the first line, then `Done when:`,
`Constraints:`, `Ask me before:`. Slots the operator must fill are written
in `<angle brackets>`.

**Confirmations** are a question, a consequence, and the verb again:
"Unlink Alpha?" — "Foreman stops tracking this folder. Run history and its
.foreman/ files stay on disk; you can link it again later." — `Unlink`.

**Errors.** Server messages are shown as written, with an error icon, beside
the control that caused them. No apology, no dismissal timer, no toast.

**Numbers.** Cost always as `$1.24 / $5` — two decimals spent, none on the
cap. Timestamps 24-hour `HH:MM:SS` in the transcript, `Sep 3, 12:16 AM` in
run history. Session ids truncated to 8 characters, in mono.

---

## VISUAL FOUNDATIONS

**Overall.** A dense, flat instrument panel — dark by default, with a warm
light theme. Four surface planes, one hairline, one accent metal (gold), a
humanist sans and a mono, no shadows, no gradients, no imagery, almost no
motion. It should read as a tool that runs overnight, not a product that
wants your attention.

**Color.** Dark is `:root`; `[data-theme="light"]` on `<html>` re-maps every
surface and ink token and darkens identity/status hues to hold contrast
(gold `#c98f1f`, violet `#6f57d6`, good `#1f8f3a`, critical `#c8323a` on a
warm `#ecebe6` app surface). Components never branch on theme; they only
read tokens.
Surfaces: `--bg-app` `#121417` → `--bg-panel` `#1a1d22` (headers, rails,
modals) → `--bg-card` `#22262d` (cards, inputs) → `--bg-inset` `#14161a`
(wells, payloads, meter tracks — darker than the app itself). Hairlines
`--line` `#2d323b`, `--line-strong` `#3a4048` (inputs, modal edges).
Ink: `--ink-0` `#e8e6df` (a warm off-white, not pure white), `--ink-1`
`#a7afb9`, `--ink-2` `#6d7683`.
Identity: `--brand` `#e8b04b` gold is Foreman, the director, and primary
actions. Workers are violet — a six-hue ramp `--agent-worker-1…6`
(`#9c86e8 #7f9ff0 #c48be0 #b3a6f2 #7a72d8 #d19ac8`) assigned by worker index,
so `worker-3` is the same color in every run. Fixed assignments, never a
cycling palette.
Status: `--status-good` `#3fb950`, `--status-warning` `#fab219`,
`--status-serious` `#ec835a`, `--status-critical` `#e5484d` (good and
critical were lifted slightly from the source for legibility on `--bg-card`).
**Text never wears identity or status color** — the two deliberate
exceptions are the `Director asks:` heading and approval card titles.

**Type.** `--font-ui: "Source Sans 3"` (400/500/600) — a humanist sans with
open apertures that reads at 12–13px and does not look like a default — and
`--font-mono: "IBM Plex Mono"` (400/500), loaded from Google Fonts via
`tokens/fonts.css` with system stacks as fallback. Five sizes: 11 / 12 / 13
(base) / 15 / 18px, line-height 1.45 (1.55 in the composer). Weights 400,
500, 600; the wordmark and `--fs-xl` carry `-0.01em` tracking. The only uppercase is the 11px 0.08em-tracked
section title. Mono is semantic, not decorative: it marks machine truth —
absolute paths, session ids, tool payloads, raw markdown.

**Spacing.** A 4px scale that stops at 24 (`4 / 8 / 12 / 16 / 24`). Card
padding 12px, project card padding 16px, page padding 24px. Rows are 6–7px
vertical. The density is intentional: an operator watches several agents at
once.

**Layout.** Three tiers, decided by `LayoutTier.use(ref)` on the view's own width.
*Wide* (≥1180): `250px 1fr 340px` — run + crew rail, transcript, needs-you
rail. *Medium* (900–1179): `1fr 320px` — the left rail collapses and the
crew becomes a chip strip above the transcript. *Narrow* (<900): one column
with segmented tabs Crew / Transcript / Needs you, the pending count on the
tab. Composer: `250px 1fr` with a 720px-max centred form; below 900 the
history folds under it. Fleet: `repeat(auto-fill, minmax(300px, 1fr))`,
16px gap, 1200px max. Only the transcript and rails scroll, independently;
the transcript auto-scrolls while pinned to the bottom and unpins when the
user scrolls up more than 60px.

**Backgrounds.** Flat fills only. No images, no full-bleed photography, no
illustration, no pattern, no texture, no noise, no gradients — including in
the empty states. The only non-opaque surfaces in the entire product are the
6% gold wash behind the drag-to-link overlay and the 55% black modal scrim.
There is no backdrop blur anywhere.

**Borders and depth.** Every surface is bounded by a 1px hairline; depth
comes from the four planes, never from shadow. **There is no shadow token
because there are no shadows** — the sole `box-shadow` in the codebase is
the focus ring. A 3px left border on a card is not decoration, it is
identity or severity: gold = director, violet = worker, red = error.

**Corner radii.** 6px for buttons, inputs, rows, transcript cards, and
wells; 10px for project cards, modals, and the mission textarea; a 999px
pill for status badges, agent dots, and the meter track. Nothing is fully
square, nothing is very round.

**Hover.** Rows and list items lift from transparent to `--bg-hover`;
neutral buttons keep their fill and lift their border to `--ink-2`; the gold
primary brightens ~8%; outline buttons take a 14% wash of their own color;
ghost text goes `--ink-2` → `--ink-1`; project and link cards lift their
border to `--line-strong` / `--ink-2`. Always a color step, 120ms, never a
transform.

**Press.** Neutral surfaces drop to `--bg-inset`, the gold primary darkens
~6%, outline buttons deepen their wash to 22%. Nothing scales, shrinks, or
lifts.

**Selected.** A row goes to `--bg-card` with a `--line-strong` border —
selection reads as one step up the surface stack, matching hover's
direction so the two never conflict.

**Focus.** One ring for everything: `0 0 0 2px var(--bg-app), 0 0 0 4px
var(--brand)` — a 2px gap in the app color, then 4px of gold, on
`:focus-visible` only.

**Disabled.** `opacity: 0.5`, cursor default, **label preserved**. Progress
is a changed label (`⟳ Resuming…`) or a muted line of text (`Searching your
home folder…`). There are no spinners and no skeletons.

**Motion.** Three animations exist. `.pulse` (opacity 1 ↔ 0.55, 1600ms
ease-in-out, infinite) on the needs-you strip, attention-bar bell, and the
timeline's live edge; a 300ms width transition on the budget and plan fills. Modals do not animate in or out. Nothing slides,
bounces, springs, or fades. Hover/press transitions are 120ms ease-in-out.

**Imagery.** None. No photography or illustration. If a design needs a
visual, it uses the logo mark, type, a hairline, or a surface step.

**Diffs.** Tool payloads that change files render as line diffs: `−` rows on
`--diff-del-bg` (12% critical), `+` rows on `--diff-add-bg` (12% good),
mono 11px, capped with an "N more lines" note. Raw is one click away.

**Timeline.** One lane per agent on `--bg-inset`, a 35%-opacity identity bar
for the active span, ticks per event (prose tall, tool short, error red), a
pulsing good-green edge while live.

**Data display.** Cost figures use tabular numerals so headers do not
jitter. Long paths are ellipsized from the right with the full value in a
`title`. Mission text is clamped to two lines on fleet cards and to one line
with an ellipsis in run history. Tool payloads are never truncated, only
capped in height with their own scroll.

**Protection.** No protection gradients, no capsules over imagery — there is
no imagery to protect against. Text on the gold fill uses `--brand-ink`
(`#14161a` dark, `#ffffff` light), the only ink allowed on brand.

### Non-negotiables (from the source handoff, §6)

1. Status is never color alone — glyph **and** label, always.
2. Identity colors follow the entity and stay fixed per role; they are never
   cycled or reassigned.
3. Text wears ink tokens, not identity or status colors (two named
   exceptions above).
4. All values go through tokens; no raw hex in components.
5. The behavioural contract (routes, states, actions per state) is the spec;
   visuals may change, behaviour may not.

---

## BRAND

**Logo.** `assets/logo.svg` (color) and `assets/logo-mono.svg` (currentColor).
The mark is an F built from three rounded bars on a 32-unit grid: gold stem
and top arm (the director), violet middle arm (the crew, reaching into the
work). Minimum 16px; clear space equal to the stem width; flat surfaces only.
The lockup is the mark beside the word "Foreman" in Source Sans 3 600 with
`-0.01em` tracking, optionally followed by the muted tagline
`mission control`. Rendered in code by `Logo` / `LogoMark`.

**Wordmark rule.** The word is never set in another face, never all-caps,
never colored gold as text (the mark carries the gold).

---

## ICONOGRAPHY

**Icon library: Lucide** (`lucide@0.460.0`, UMD from unpkg), 1.75px
stroke, round caps, 12 / 14 / 16 / 20px. Every icon goes through the `Icon`
component and its semantic map `ICONS` (`components/core/Icon.jsx`), so call
sites say *what* an icon means (`running`, `needsYou`, `Bash`), not what it
looks like. No emoji, no Unicode glyphs, no filled or two-tone variants, no
second icon set.

| Meaning | Lucide | Color |
|---|---|---|
| idle · running · done · error · interrupted | Circle · Activity · Check · X · Pause | status token |
| disconnected · read-only · needs you | WifiOff · History · Bell | serious · warning · warning |
| 70% budget / caution · 90% budget | TriangleAlert · OctagonAlert | warning / serious · critical |
| approval · director asks · orchestration tool | ShieldCheck · MessageCircleQuestion · Bot | brand |
| resume · back · add · parent · unlink | RotateCw · ArrowLeft · Plus · CornerLeftUp · Unlink | inherits ink |
| folder · crew · timeline · transcript · raw | Folder · Users · Clock · AlignLeft · Braces | inherits ink |
| theme | Sun / Moon | inherits ink |
| Write · Edit · Read · Bash · Grep · Glob | FilePen · FilePenLine · FileText · Terminal · Search · FolderSearch | inherits ink |
| spawn_worker · message_worker · ask_human | UserPlus · MessageSquare · MessageCircleQuestion | brand (chip) |

Rules: status icons wear the status color and always sit beside the status
word; every other icon inherits text color. Icon-only controls exist only as
`IconButton` and must carry a `label`. Add new meanings to `ICONS`, never
inline a Lucide name in a screen.

**Loading.** Pages load the UMD after React; `ds-base.js` does this for
templates. Until it arrives, `Icon` renders a blank box of the right size,
so layout never shifts.

---

## Components

45 exports, grouped by concern. Every component has a `.d.ts` props contract
and a `.prompt.md` usage note beside it; each directory has a `@dsCard` HTML
showing its states.

- **`components/brand/`** — `Logo`, `LogoMark`
- **`components/core/`** — `Button`, `IconButton`, `Icon` (+ `ICONS`), `Tabs`, `Card`, `SectionTitle`, `Empty`, `RichText`
- **`components/forms/`** — `Field`, `TextInput`, `Textarea`, `Switch`, `RichEditor`, `ModelSelect` (+ `ModelSelect.useModels`, `FALLBACK_MODELS`), `AttachmentChip`
- **`components/status/`** — `StatusBadge` (+ `STATUS_META`), `BudgetMeter`, `AgentDot` (+ `AgentColor` / `agentColor`), `NeedsYouStrip`, `AttentionBar`, `Banner`
- **`components/mission/`** — `RunRail`, `AgentRow`, `RunRow`, `CrewStrip`, `RunTimeline`, `TranscriptEntry`, `ToolCall` (+ `DiffView`, `ToolCallUtils.{summarizeTool, parseToolInput}`), `ApprovalCard`, `QuestionCard`, `SteerBar`, `PlanBoard` (+ `ParsePlan`), `Composer` (+ `MISSION_TEMPLATES`)
- **`components/fleet/`** — `ProjectCard`, `LinkProjectCard`
- **`components/overlay/`** — `Modal`, `ModalHeader`, `ModalFooter`, `ConfirmDialog`, `FolderPicker`, `DropConfirmModal` (+ `DropOverlay`)
- **`components/settings/`** — `SettingsModal` (+ `SETTINGS_SECTIONS`, `DEFAULT_SETTINGS`)
- **`components/shell/`** — `AppHeader`, `Rail`, `LayoutTier` (`.use(ref)` — the `useLayoutTier` hook, aliased because only PascalCase exports reach the bundle namespace)

The base inventory comes from the source (`ui/src/design/ui.tsx` plus the
view-local components the handoff names). The additions below exist to fix
the documented debt; each is tied to a numbered item.

### Intentional additions

- `Logo`, `LogoMark`, `Icon`, `IconButton` — brand mark and icon system (owner request).
- `RunRail` — nests crew under the selected run (**debt 1**).
- `RunTimeline` — swimlane view of a run (**debt 2**).
- `ToolCall` / `DiffView` — structured tool chips with diff rendering (**debt 3**).
- `AttentionBar` — in-view "waiting on you" strip; `Tabs` count badge on narrow (**debt 4**).
- Worker ramp `--agent-worker-1…6` in `agentColor` (**debt 5**).
- `[data-theme="light"]` tokens + `AppHeader` theme toggle (**debt 6**).
- `ProjectCard.lastRun` (**debt 7**).
- `ConfirmDialog` (**debt 8**).
- `Composer` templates + localStorage drafts (**debt 9**); editor frame with live-highlighted Write (`RichEditor`) and rendered Preview (`RichText`), quote/code insertion, attachments (`AttachmentChip`), stacked parameter tray; models come from `GET /models` via `ModelSelect.useModels`.
- `LayoutTier.use`, `Tabs`, `CrewStrip` — three responsive tiers (**debt 10**).
- `Field`, `TextInput`, `Textarea`, `ModelSelect`, `Banner`, `AgentDot`, `NeedsYouStrip`, `Modal*`, `DropOverlay`, `AppHeader`, `Rail` — promoted from inline view code so screens compose.
- Hover/press states (120ms color steps) — the source had none.

There is still no Toast, Avatar, Tooltip, or Breadcrumb: Foreman has none.

---

## Debt resolved

The source handoff (§4) listed ten items. All ten are addressed in this revision:

1. **Agents/Runs hierarchy** → `RunRail`: "This run" with the crew nested under it, then "Mission history".
2. **No timeline** → `RunTimeline` strip above the transcript; lanes filter the transcript.
3. **Raw payloads** → `ToolCall` chips: icon + name + summary, expandable to a diff or pretty JSON.
4. **Missable approvals** → `AttentionBar` pinned above the transcript with a Review action; on narrow layouts the Needs-you tab carries a warning count. Still no toasts.
5. **One violet** → six-hue violet ramp, fixed by worker index.
6. **No light theme** → `[data-theme="light"]` tokens; sun/moon toggle in the header; persisted as `foreman:theme`.
7. **Idle cards** → `lastRun` summary: status · date · cost · one-line mission.
8. **Unconfirmed unlink** → `ConfirmDialog` stating what is kept.
9. **No templates/drafts** → four mission templates that pre-set budget and models; drafts autosave per folder.
10. **Narrow layouts** → wide / medium / narrow tiers at 1180 and 900.

---

## Templates

Starting frames for new Foreman surfaces. Each is a Design Component that
loads this system (styles, bundle, Lucide) through a one-line `ds-base.js`.

| Template | File | What it gives |
|---|---|---|
| App Shell | `templates/app-shell/AppShell.dc.html` | Project chrome: header with theme toggle, read-only banner slot, `250 / 1fr / 340` grid with the run rail and labelled centre slot. Tweaks: project name, folder, run status, read-only. |
| Fleet page | `templates/fleet-page/FleetPage.dc.html` | Logo header + project-card grid in all four card states + link tile |
| Mission workspace | `templates/mission-workspace/MissionWorkspace.dc.html` | A complete live mission: run rail, attention bar, timeline, structured transcript, approvals, questions, plan |
| States gallery | `templates/state-gallery/StateGallery.dc.html` | Every state side by side — never-run, running, needs-you, interrupted, error, read-only, empty, three budget thresholds |

---

## Index

| Path | What it is |
|---|---|
| `readme.md` | This document — context, sources, content and visual foundations, brand, iconography, index |
| `SKILL.md` | Agent-Skills front matter so this folder can be used as a Claude Code skill |
| `styles.css` | Global entry point — `@import` lines only |
| `tokens/fonts.css` | Google Fonts import for Source Sans 3 + IBM Plex Mono |
| `tokens/colors.css` | Surfaces, ink, identity + worker ramp, status, washes, diff tints; light theme scope |
| `tokens/typography.css` | Font stacks, five sizes, line-heights, weights, icon sizes |
| `tokens/space-shape.css` | 4px space scale, radii, layout constants + breakpoints, focus ring |
| `tokens/motion.css` | Durations, easing, the `pulse` keyframe |
| `tokens/semantic.css` | Aliases (`--surface-card`, `--text-body`, `--state-error`, …) over the base tokens |
| `tokens/base.css` | Element resets, scrollbars, link colors, focus behaviour |
| `guidelines/*.card.html` | 21 foundation specimen cards (Colors, Type, Spacing, Brand, Motion) |
| `components/<group>/` | The components above, each with `.jsx`, `.d.ts`, `.prompt.md`, plus a group card |
| `ui_kits/foreman-dashboard/` | Click-through recreation of the whole product with all ten fixes — see its README |
| `templates/<slug>/` | The four page templates above |
| `assets/logo.svg`, `assets/logo-mono.svg` | The mark |
| `assets/screenshots/` | The eight product screenshots from the source handoff (pre-rehaul reference) |
| `thumbnail.html` | The system's homepage tile |

## Caveats

- **The logo is new and unreviewed.** It was designed here from the
  director/crew idea, not taken from any existing brand material. Say the
  word and I'll iterate on it.
- **Fonts load from Google Fonts**, not from files in this project. Both are
  open-licensed (OFL); to ship offline, download the woff2 files into
  `assets/fonts/` and swap the `@import` in `tokens/fonts.css` for
  `@font-face` rules.
- **Icons load from unpkg** (`lucide` UMD). Same story: vendor the file
  for offline use.
- **Light theme contrast was checked by eye**, not with a CVD simulator, for
  the darkened status hues. Worth a proper pass.
- **Hover/press states** remain a proposal; the source has none.
- **The debt fixes are design, not shipped code.** The UI kit demonstrates
  them with fake data; the backend hooks (templates per project, draft sync,
  theme preference) are noted in the source handoff as trivial to add.
