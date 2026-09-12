# Stage 7G — Ensemble Character Life Engine

## Goal

A believable long-form world contains people whose lives continue when the protagonist is absent.

The goal is not to give every passerby a 3,000-word biography. The goal is to prevent recurring characters from becoming frozen utilities.

The key question is:

> If the protagonist disappeared from this person's life for three months, what would still happen to them?

If the answer is "nothing until the protagonist returns", the character is likely under-designed.

---

## Character tiers

### Tier A — Book-core character
Examples:
- protagonist;
- primary partner / co-lead;
- central antagonist / ideological opponent;
- central family member whose arc spans the book.

Required:
- complete Book Life Arc;
- independent desire;
- independent relationship network;
- offscreen progression;
- own irreversible choices;
- ending state.

### Tier B — Recurring supporting character
Appears across multiple volumes or substantially shapes the protagonist.

Required:
- cross-volume Life Arc;
- job / family / money / ordinary routine;
- at least one meaningful relationship not centered on the protagonist;
- at least one independent conflict;
- offscreen changes;
- ending state.

### Tier C — Volume character
Important for one volume.

Required:
- complete Volume Life Arc;
- pre-plot ordinary life;
- immediate personal goal;
- at least one independent choice;
- post-volume consequence.

### Tier D — Event / scene character
Need not have a long arc.

Still requires:
- what they were doing before the protagonist arrived;
- what they want right now;
- what they fear losing;
- one concrete human detail;
- what changes for them after the event, when relevant.

Tier D must not be promoted into fake complexity just to satisfy a checklist.

---

## CharacterLifeContract

```yaml
character_life:
  character_id:
  tier: A | B | C | D

  social_identity:
  job_or_role:
  economic_reality:
  ordinary_routine:

  personal_goal:
  private_problem:
  shame_or_defense:

  non_protagonist_relationships:
    - person:
      relation:
      current_state:
      unresolved_issue:

  independent_conflict:
  independent_choice_history: []

  life_clock:
    current_state:
    next_offscreen_change:
    trigger:
    expected_window:

  intersection_with_main_plot:
    why_their_life_collides_with_story:

  loss_target:
  growth_or_decline_direction:
  ending_state:
```

---

## Offscreen Life Clock

A recurring character must not freeze during absence.

Examples of valid offscreen change:
- job transfer;
- a child starting school;
- debt pressure;
- relationship repair or deterioration;
- changed living situation;
- injury recovery;
- new ambition;
- moral compromise;
- illness in the family;
- a skill they have been practicing;
- giving up an old dream;
- choosing to leave an organization.

The change does **not** need to become a subplot.

Sometimes one sentence on return is enough:

> He had switched to the day shift three weeks ago because his daughter had started primary school.

The world immediately feels less protagonist-centered.

---

## Remove-Protagonist Test

For Tier A/B/C characters:

> Remove the protagonist from this character's story. Can you still tell a coherent short story about what this person wanted, chose, lost, and became during this period?

PASS:
- the character's life still has direction.

FAIL:
- every event exists only because the protagonist needs information, help, rescue, admiration, or opposition.

This is primarily a quality gate, not an excuse to create unnecessary side plots.

---

## Non-Protagonist Relationship Network

Supporting characters should have relationships with each other.

Examples:
- mentor ↔ old colleague;
- teammate ↔ spouse;
- mother ↔ sister;
- ordinary employee ↔ manager;
- antagonist ↔ subordinate they actually care about.

These relations:
- may occur offscreen;
- may change independently;
- may later affect the protagonist.

A cast becomes an ensemble when relationships form a graph rather than a wheel with the protagonist at the center.

---

## Life Intersection Rule

The main plot should intersect a character's life, not replace it.

Weak:
> The courier exists because the protagonist must save a predicted victim.

Stronger:
> The courier is deciding whether to quit the job, has promised his daughter he will attend her school event, and is hiding debt from his wife. The predicted death crashes into an already moving life.

The plot now threatens a life rather than a function.

---

## Ordinary-life ledger

For Tier A/B characters, track:
- work;
- money;
- home;
- family;
- habits;
- bodily reality;
- friendships;
- minor ambitions;
- unresolved chores / plans.

Not every item enters prose.
The ledger exists so the author can choose specific human details rather than generic "ordinary life".

---

## Ending state

A character's ending is not limited to life/death.

Possible ending states:
- promoted;
- retired;
- divorced;
- reconciled;
- leaves the city;
- begins a small business;
- remains in the same job but with a changed relationship to it;
- has a child;
- refuses the protagonist;
- forgives but does not reunite;
- becomes a mentor;
- dies;
- survives with unresolved cost.

The ending should answer:
> What happened to this person's own life?

---

## Anti-patterns

- tragic backstory as substitute for present life;
- every supporting character having a dead parent;
- every ordinary person secretly important to the conspiracy;
- supporting characters only appearing when the protagonist needs help;
- no offscreen change across hundreds of chapters;
- female side characters existing primarily to validate, judge, heal, or desire the male protagonist;
- a character's family mentioned once solely to increase death stakes;
- "independent life" becoming filler side quests disconnected from the book.

The engine aims for **life density**, not subplot inflation.
