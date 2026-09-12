# Visual Skill Handoff

## Principle

Visual generation skills should receive a **canonical brief**, not re-read the whole novel and independently invent the brand.

This writing skill does not embed the design logic of cover/poster skills.

Instead it exports:

- project visual DNA;
- subject / character canon;
- composition objective;
- required textual elements;
- spoiler tier;
- prohibited imagery;
- asset purpose.

An external visual skill can then apply its own visual system.

---

## Project Visual Bible

Maintain:

```yaml
visual_bible:
  visual_promise:
  world:
    era:
    city_or_landscape:
    technology_or_magic_language:
  palette_direction:
  lighting_direction:
  texture_materials:
  recurring_symbols: []
  prohibited_cliches: []
  typography_direction:
  realism_level:
  character_render_policy:
```

Do not lock exact colors unless the project genuinely needs them.

---

## CoverBrief

```yaml
cover_brief:
  source_canon_version:
  spoiler_level: public
  platform:
  title:
  subtitle:
  primary_reader_promise:
  focal_subject:
  focal_action_or_state:
  world_signals: []
  recurring_symbols: []
  composition_priority:
  emotional_temperature:
  must_include: []
  must_avoid: []
  text_safe_area:
```

The cover should sell the **first reading promise**, not illustrate the final twist.

---

## CharacterVisualBrief

```yaml
character_visual:
  character_id:
  tier:
  public_identity:
  age:
  silhouette:
  ordinary_life_signals:
  professional_signals:
  emotional_read:
  recurring_objects: []
  relationship_or_world_context:
  forbidden_misreadings: []
  spoiler_level:
```

Example forbidden misreading:
- "Do not render a pragmatic records clerk as an icy aristocratic beauty merely because she is emotionally controlled."

---

## VolumePosterBrief

Each volume can have a poster brief driven by:
- local question;
- local visual motif;
- key environment;
- protected mystery;
- emotional afterimage.

A poster should not spoil the local climax.

---

## Adapter protocol

If an external cover/poster skill is installed:

1. Orchestrator produces the canonical brief.
2. External visual skill consumes the brief.
3. Returned asset metadata is saved with canon version.
4. If canon changes materially, mark old visual assets `stale`.

Possible external skill classes:
- cover skill;
- cinematic editorial poster skill;
- literary poster skill;
- character visual skill;
- promo key-art skill.

The adapter must not require those skills to be bundled inside WriteX.
