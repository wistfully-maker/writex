# Unified Enhanced Ledger Model

This is a logical model. It may be stored as files, typed contracts, or plugin/MCP state later.

## ReaderQuestionLedger

```yaml
reader_question:
  id:
  type: relationship | identity | mystery | aspiration | threat | moral
  question:
  owner_scope: chapter | sequence | volume | book
  state: planted | advanced | narrowed | transformed | answered
  why_reader_cares:
  evidence: []
  payoff_by:
  protected_until:
  next_question:
```

Mystery-type questions add:
- provisional_answer;
- withheld_truth;
- contradiction_plan;
- reveal_consequence.

## CharacterMagnetismLedger

```yaml
character:
  id:
  reader_emotion_targets: []
  silhouette_proven:
  fantasy_value_proven:
  private_deficit:
  power_cannot_solve:
  ordinary_anchors: []
  independent_choices: []
  vulnerability_cracks: []
  recognition:
    wanted_from:
    actually_received_from:
  loss_targets: []
  last_refresh_chapter:
  last_refresh_meaning:
```

## RelationshipLedger extension

```yaml
relationship:
  id:
  public_label:
  private_function:
  a_wants_from_b:
  b_wants_from_a:
  a_offers_b:
  b_offers_a:
  a_misreads_b:
  b_misreads_a:
  mutual_truth:
  asymmetry_axes: []
  boundaries: []
  ordinary_deposit_refs: []
  debts: []
  current_definition:
  next_possible_definition:
  dialogue_permissions:
    teasing_allowed:
    interruption_rights: []
    nicknames: []
    formal_name_triggers: []
    forbidden_topics: []
```

## EmotionalDebtLedger extension

```yaml
debt:
  id:
  debt_type:
  owner:
  counterparty:
  source_event:
  owed_emotion:
  ordinary_deposit_refs: []
  counterfactual_future:
  defense_history: []
  maturity_condition:
  max_deferral:
  carrier_refs: []
  touches: []
  partial_payments: []
  realization:
  residue:
  status: open | touched | partially_paid | transformed | paid
```

## CarrierRegistry

Avoid duplicating motifs / afterimages.

```yaml
carrier:
  id:
  type: object | place | song | routine | phrase | message | absence | role
  first_seed_chapter:
  appearances:
    - chapter:
      meaning:
  current_meaning:
  allowed_functions:
    - motif
    - afterimage
    - ending
  transformation_required: true
```

## StyleHistoryLedger

```yaml
style_history:
  recent_scene_modes: []
  recent_metaphor_domains: []
  recent_ending_forms: []
  retrospective_uses: []
  humor_density_history: []
  character_voice_flags: []
```

This ledger is diagnostic. It must not force artificial variety; it prevents accidental repetition.


## CharacterLifeLedger

```yaml
character_life:
  character_id:
  tier:
  social_identity:
  job_or_role:
  economic_reality:
  ordinary_routine: []
  personal_goal:
  private_problem:
  non_protagonist_relationships: []
  independent_conflict:
  independent_choice_history: []
  life_clock:
    current_state:
    next_offscreen_change:
    expected_window:
  ending_state:
```

## ProjectAssetLedger

```yaml
project_asset:
  asset_id:
  type: synopsis | cover_brief | cover | poster_brief | poster | character_visual | promo_copy
  source_canon_version:
  spoiler_level:
  status: active | stale
  external_skill:
```

Project artifacts must be versioned separately from manuscript canon.
