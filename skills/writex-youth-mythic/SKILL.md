---
name: writex-youth-mythic
description: "An original-fiction long-form novel/IP production extension of WriteX Base: book architecture, reader drive, character magnetism, relationship tension, type payoff, emotional orchestration, adaptive prose voice, ensemble character life arcs, and project-level publishing/visual handoff."
metadata:
  version: 0.3.0
---

# WriteX Youth-Mythic

This skill extends **WriteX Base**. It does not replace the base literary core, continuity, long-form structure, human acceptance gate, or POV legality.

Its job is to add six commercial-literary layers:

1. Reader Drive — why the reader keeps turning pages.
2. Character Magnetism — why the reader keeps caring about specific people.
3. Relationship Tension — why the reader cares what those people become to one another.
4. Type Pleasure — why mystery, identity, competence, power, and world revelation feel rewarding.
5. Emotional Orchestration — how emotional debt is deposited, deferred, released, and made permanent.
6. Adaptive Prose / Voice — how language changes with POV, scene function, emotion, and book stage.
7. Ensemble Character Life — how major and ordinary supporting characters continue living beyond protagonist utility.
8. Novel Project Orchestrator — how one approved project canon drives book architecture, drafting, platform metadata, synopsis, cover/poster briefs, character visuals, and launch material.


## Project lifecycle

For a new book project, use the **Novel Project Orchestrator** before prose drafting:

idea / platform intent
-> positioning
-> NovelProjectCanon
-> whole-book architecture
-> volume blueprints
-> cross-volume promises / foreshadowing / character-life arcs
-> architecture audit
-> explicit human architecture approval
-> current-volume rolling horizon
-> chapter drafting workflow
-> publication package
-> visual handoff

**No formal novel prose should begin before the whole-book architecture reaches `HUMAN_ARCHITECTURE_APPROVED`, unless the user explicitly asks for an isolated sample.**

Read:
- `references/orchestrator/project-lifecycle.md`
- `references/orchestrator/publishing-package.md`
- `references/orchestrator/visual-handoff.md`

## Ensemble-life rule

Important recurring characters are not allowed to exist only as protagonist functions.

Read:
- `references/enhancement/ensemble-character-life.md`
- `rules/ensemble-character-life-engine.yaml`
- `workflows/character-life-audit.md`


## Originality boundary

This is a mechanism-level research extension, not a named-author imitation prompt.

Never:
- reproduce source-specific characters, organizations, powers, signature bargains, recurring phrases, or scene replicas;
- copy recognizable sentence patterns or distinctive metaphors from the research corpus;
- instruct the model to "write exactly like" a named living author.

Do:
- use general causal mechanisms such as delayed recognition, ordinary-life deposits, relationship need mismatch, costed power payoff, character-specific metaphor, dynamic narrative distance, and afterimage release.

## Priority stack

When layers conflict, obey this order:

1. canon / continuity / POV knowledge legality;
2. explicit human approvals and protected promises;
3. literary core: perennial question, character truth, impossible choice, specific life situation;
4. book / volume / sequence structural closure;
5. character and relationship causality;
6. reader drive and type payoff;
7. emotional timing;
8. prose flourish.

A lower layer must yield to a higher layer.

## Progressive loading

Do **not** load every enhancement module for every chapter.

Read `references/enhancement/router.md`.

At minimum:
- planning a volume/sequence -> Reader Drive;
- designing or refreshing a major character -> Character Magnetism;
- planning a recurring supporting cast / volume guest cast -> Ensemble Character Life;
- relationship-critical scene -> Relationship Tension;
- mystery/identity/ability/world-rule scene -> Type Pleasure;
- grief/loss/major attachment scene -> Emotional Orchestration;
- any prose drafting -> Adaptive Prose, but only the active scene mode;
- project launch / title / synopsis / cover / poster / release material -> Novel Project Orchestrator.

## State-first workflow

For an approved ongoing book, follow the WriteX Base workflow. For a new book, Project Canon and whole-book architecture must be approved first. The drafting order remains:

literary core
-> book plan
-> current volume plan
-> rolling horizon
-> POV-safe continuity context
-> chapter intent
-> chapter contract
-> enhanced drive bundle
-> scene plan
-> prose mode
-> technique plan
-> competitive drafts
-> blind review / revision
-> chapter review
-> proposed state diff
-> ready-for-human-accept
-> explicit human acceptance
-> continuity + enhanced ledgers
-> risk scan / audit

Never write accepted manuscript or canonical ledgers before human acceptance.

## Enhanced chapter shipping gate

A chapter may be `ready-for-human-accept` only if WriteX Base passes and all **activated** enhancement contracts are valid.

Important: enhancement scores never override a Base veto.

Examples:
- a reveal without consequence is not ready;
- a relationship repair with no cost is not ready;
- a major emotional release using an unseeded carrier is not ready;
- a POV voice that suddenly becomes generic poetic narration requires revision;
- a recurring supporting character who appears only to deliver protagonist utility must be revised or intentionally downgraded;
- a cliffhanger cannot substitute for the volume's local closure.

Read:
- `references/enhancement/architecture.md`
- `references/enhancement/router.md`
- `references/enhancement/ledger-model.md`
- `rules/integrated-policy.yaml`
- `rules/risk-taxonomy.yaml`

## Package validation

Run:

```bash
node scripts/validate-package.mjs
```

The integration evaluation is in `evals/limited-after-integration-eval.md`.


## Stage 8 project outputs

The Orchestrator can produce reusable launch artifacts from the **same NovelProjectCanon**:

- title candidates and title rationale;
- one-sentence hook;
- platform synopsis / long synopsis;
- editor / internal story pitch;
- tags and audience statement;
- cover brief;
- character visual briefs;
- volume poster briefs;
- launch copy / short promotional copy;
- release checklist.

These are project artifacts, not replacements for story canon.

When external visual skills are available, pass the generated visual briefs to them through the adapter contract. Do not duplicate a poster or cover skill's internal design system inside this writing skill.
