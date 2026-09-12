# Unified Enhancement Architecture

## Why this layer exists

WriteX Base answers:

- Is the character psychologically grounded?
- Is the choice genuinely difficult?
- Does the chapter have purpose, cost, and state change?
- Is continuity legal?
- Does the long-form structure progress without premature climax?
- Has a human explicitly accepted the chapter?

The enhanced layer answers six different questions:

| Layer | Question |
|---|---|
| Reader Drive | Why continue reading? |
| Character Magnetism | Why care about this person? |
| Relationship Tension | Why care what these people become to each other? |
| Type Pleasure | Why anticipate a reveal, capability payoff, or larger world? |
| Emotional Orchestration | Why does an event continue hurting after it happens? |
| Adaptive Prose | Why does this scene sound like this POV, at this moment? |
| Ensemble Character Life | Why do supporting characters feel like people with lives beyond protagonist utility? |
| Project Orchestrator | How do architecture, drafting, publishing copy, and visual assets share one canon? |

## Integration principle: one source of truth per concept

### Normality
- `NormalityReservoir` belongs to volume/sequence planning.
- `EmotionalDebt.ordinaryDeposits` references entries from that reservoir.
- Do not maintain a second independent list of the same ordinary scenes.

### Afterimage
One seeded `Carrier` can be used by three layers:
- structure: afterimage ending;
- emotion: afterimage release;
- prose: residual-image ending.

The carrier has one canonical history. Each layer reads it for a different purpose.

### Relationship debt vs emotional debt
A sacrifice can create:
- a `RelationshipDebt`: what A and B now owe / cannot ignore;
- an `EmotionalDebt`: what one person's psyche has not yet faced.

They are linked by IDs, not merged.

### Reader question vs mystery
`ReaderQuestion` is broad:
- relationship;
- identity;
- aspiration;
- danger;
- mystery;
- moral outcome.

`MysteryQuestion` is a subtype with a Reveal Ladder state machine.

### Character loss shadow vs emotional loss shadow
Use one `LossTarget` object:
- Character Magnetism reads it as "what the reader fears this character may lose."
- Emotional Orchestration reads it as the target of a specific debt or counterfactual future.

## Execution priority

When in doubt:

Canon / POV legality
> Human gate
> Literary truth
> Long-form closure
> Character / relationship causality
> Reader drive / type pleasure
> Emotional timing
> Prose beauty

This prevents the system from becoming technique-maximalist.

## Hard Gate vs Quality Gate vs Pattern

### Hard Gate
A contract or invariant that can be checked from explicit state.

Examples:
- reveal must declare consequence;
- repaired relationship must declare paid repair cost;
- afterimage carrier must have prior seed;
- local volume closure before cliffhanger;
- POV cannot receive inaccessible secret;
- accepted manuscript requires human approval.

### Quality Gate
Requires agent judgment and evidence.

Examples:
- enough ordinary life has been accumulated before tragedy;
- metaphor feels owned by POV;
- character magnetism refresh genuinely changes understanding;
- worldbuilding is operational rather than lecture-like;
- emotional release is earned.

### Pattern
Optional recipe. Never mandatory.

Examples:
- false objective;
- romantic oasis with deadline;
- reader-memory alliance;
- role reversion at peak;
- negative-space grief;
- comic deflation -> emotional rebound.

A pattern cannot become a checklist requirement merely because it worked in the research corpus.

## Anti-overfitting rule

For any active chapter:
- activate only modules that have a job in that chapter;
- default max 2 enhancement "foreground" modules in one scene;
- other modules may remain background constraints;
- never force a pattern into a scene to satisfy variety.

The advanced skill should feel *less mechanical* than an overloaded prompt, not more.


## Project / prose separation

The Project Orchestrator owns:
- project lifecycle;
- architecture approval state;
- publication metadata;
- visual briefs.

The writing engine owns:
- story causality;
- character/relationship state;
- prose.

Do not let marketing or visual needs silently rewrite canon.

## Ensemble character integration

Character Magnetism asks:
> Why does the reader care about this person?

Ensemble Character Life asks:
> What is this person's own life doing when the protagonist is not using them?

Both are required for important recurring characters.
