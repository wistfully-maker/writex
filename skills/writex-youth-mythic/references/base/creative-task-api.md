# Creative Task API

WriteX Core is runtime-neutral. An Agent, Skill host, test fake, Codex, or another harness performs creative tasks through `CreativeExecutor.execute()`.

Long-form tasks:

- `longform_book_plan`
- `longform_volume_plan`
- `rolling_horizon_plan`
- `longform_replan`

Single-chapter tasks:

- `emotional_diagnosis`
- `chapter_contract`
- `scene_plan`
- `technique_plan`
- `draft` (three strategy passes)
- `candidate_review` (anonymous)
- `chapter_review`
- `revision_plan`
- `revision`
- `state_diff`

Continuity tasks:

- `continuity_extract`
- `long_range_audit`

The Skill must not replace deterministic validators with prose judgment. It uses the Agent to generate typed outputs, then lets WriteX validate and orchestrate them.
