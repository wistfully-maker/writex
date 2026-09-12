# External Visual Skill Adapter

## Input
A file conforming to `templates/visual-brief.yaml`.

## Required behavior
The downstream visual skill may:
- choose its own design language;
- enrich composition;
- select typography;
- generate/edit images.

It may not:
- change character canon;
- expose author-only spoilers;
- invent a different genre promise;
- silently alter title text.

## Output metadata

```yaml
visual_asset:
  asset_id:
  source_project_id:
  source_canon_version:
  source_brief_version:
  skill_used:
  asset_type:
  status: active | stale
```

If project canon changes:
- compare the new canon against visual brief dependencies;
- mark materially inconsistent assets `stale`;
- regenerate only when needed.

This adapter intentionally keeps visual production modular.
