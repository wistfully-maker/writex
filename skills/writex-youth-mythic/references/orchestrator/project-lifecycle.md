# Stage 8 — Novel Project Orchestrator

## Purpose

A novel is not only prose. A production project needs one source of truth for:

- platform / reader positioning;
- title and hook;
- whole-book architecture;
- volume plans;
- character canon;
- writing;
- synopsis;
- tags;
- editor pitch;
- cover / poster / character visual briefs;
- promotional copy;
- release assets.

The Orchestrator prevents every downstream artifact from re-inventing the novel.

---

## Lifecycle states

```text
IDEA
-> POSITIONED
-> PROJECT_CANON_READY
-> BOOK_ARCHITECTURE_READY
-> HUMAN_ARCHITECTURE_APPROVED
-> DRAFTING
-> VOLUME_REVIEW
-> PUBLICATION_PACKAGE_READY
-> VISUAL_HANDOFF_READY
-> RELEASE_READY
```

No transition to `DRAFTING` before `HUMAN_ARCHITECTURE_APPROVED` unless the user explicitly requests a sample.

---

## 1. Positioning

Create:

```yaml
positioning:
  platform:
  channel:
  audience:
  genre:
  subgenres: []
  target_length:
  update_model:
  primary_reader_promise:
  first_3_chapter_promise:
  first_10_chapter_promise:
  comparable_functional_strengths: []
  avoid:
```

Platform rules and market trends can change. If the user asks for current platform standards, verify them externally before locking metadata.

---

## 2. NovelProjectCanon

This is the project source of truth.

It must contain:

- project identity;
- title status;
- genre / audience;
- one-sentence hook;
- literary core;
- commercial reader promise;
- world rules;
- main cast;
- whole-book architecture;
- protected truths;
- ending contract;
- visual DNA;
- publication positioning.

Once architecture is approved, changes to protected fields require a Replan Proposal.

Use:
`templates/novel-project-canon.yaml`

---

## 3. Whole-book architecture

Run WriteX long-form planning plus enhanced layers.

Required outputs:
- Book opening / development / climax / ending;
- volume blueprints;
- local question and local closure per volume;
- cross-volume promise / foreshadowing graph;
- Reader Question Ledger;
- character-life arcs;
- relationship arcs;
- truth exposure ceilings;
- ending contract;
- current-volume detailed plan;
- architecture audit.

The architecture is the drafting constitution.

---

## 4. Drafting

The Orchestrator does not replace the write-chapter workflow.

It routes approved project state into:
- rolling horizon;
- chapter directive;
- scene plan;
- enhancement bundle;
- candidate drafts;
- review;
- human acceptance.

---

## 5. Publication package

All publication copy is generated from the approved canon.

Do not introduce new canon in a synopsis merely because it sounds more marketable.

Outputs may include:
- final / working title;
- title candidates;
- one-sentence hook;
- short synopsis;
- platform synopsis;
- long project synopsis;
- editor pitch;
- tags / keywords;
- spoiler-safe selling points;
- author/project note when requested.

Use:
`references/orchestrator/publishing-package.md`

---

## 6. Visual handoff

The Orchestrator is **not** a poster/cover renderer.

It creates canonical visual briefs that can be consumed by external visual skills.

The same brief system should support:
- cover;
- launch poster;
- character poster;
- volume poster;
- chapter key visual;
- promotional short-video key art.

Use:
`references/orchestrator/visual-handoff.md`

---

## 7. Asset provenance

Every generated project artifact should state what canon version it was built from.

Example:

```yaml
source:
  project_id: disaster-recovery-station
  canon_version: 1.2
  volume_architecture_version: 1.0
  spoiler_level: public
```

This prevents a cover or synopsis from reflecting an obsolete version of the novel.

---

## 8. Spoiler tiers

The project should distinguish:

### public
Safe for title / cover / platform synopsis.

### marketing_internal
Can reveal first-volume premise but not late-book truths.

### editorial
Can reveal whole-book architecture and ending.

### author_only
Protected secrets, reveal timing, hidden motivations.

Visual and marketing handoffs must declare spoiler tier.
