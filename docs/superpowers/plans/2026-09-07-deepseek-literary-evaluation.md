# DeepSeek Literary Evaluation Implementation Plan

**Goal:** Ship a CLI evaluation loop for Flash and Pro: 12 drafts, blind selection, five-dimension diagnostics, configurable scoring and reveal report.
**Architecture:** Extend the gateway with injectable fetch; put evaluation logic in packages/evaluation; CLI delegates to small functions. Persist attempts before requests and keep blind artifacts separate from private records. Existing foundation APIs remain compatible.
**Execution:** One persistent DSH session implements all slices and review corrections. Codex owns Git and final verification. Existing isolated worktree, branch codex/deepseek-literary-evaluation.

## Recovery checkpoint (2026-09-08)

Slices 1/2 and first review corrections persisted before the controller exited. Independent verification: typecheck and 177 tests pass after pnpm relinking. SDK 0.1.2-rc.1 cannot reopen the old named session in a new runtime: turn/end reports a persisted-log ID collision. Preserve the old log; recovery uses session-deepseek-literary-evaluation-v1-sept8 for all remaining work. The SDK initialization timeout is now 60 seconds. Error turn endings must be surfaced by the driver, not reported as idle success. Remaining slices3/4 and durability review remain required before completion.

## Slice 1 — DeepSeek gateway

- [ ] Add packages/model-gateway/src/deepseek.ts and test/deepseek.test.ts; export via index.ts. Extend contracts/model.ts with optional completion state, response ID, cache/reasoning usage; preserve FakeModel compatibility.
- [ ] Inject fetch and environment lookup; allow only Flash/Pro and HTTPS api.deepseek.com by default. POST /chat/completions with system/user messages, stream:false, max_tokens, thinking:{type:'disabled'} by default; optional explicit thinking mode/effort. Never log key, response body from error, or reasoning_content. Abort timeout, redirect:error, no retries.
- [ ] Validate response shape, finite nonnegative usage when supplied; missing usage stays unknown. Record response model/id and finish_reason; length or empty content must not be treated as success. Use sanitized typed errors for auth/rate/server/network/invalid-response.
- [ ] Tests intercept fetch and prove wire mapping, usage, omitted reasoning, missing key before fetch, timeout/auth/429, malformed/empty/truncated response. Run targeted tests and typecheck.

## Slice 2 — Evaluation configuration, fixtures and execution

- [ ] Add packages/evaluation/{package.json,src/contracts.ts,src/config.ts,src/fixtures.ts,src/store.ts,src/runner.ts,src/index.ts}; tests in test/. Dependencies contracts/model-gateway/quality/workspace.
- [ ] Config version 1, exactly Flash and Pro, key env name, max output 4096 default, thinking disabled default, timeout, USD budget and explicit price table with source/date. Validate all external JSON. Default conservative peak rates from official pricing: Flash input miss .44/output 1.32, Pro input miss 1.32/output 3.96 USD/M tokens; cache rates .014/.044. Missing rates block live budget estimation. Budget reserve includes output cap and UTF8 input-byte upper estimate plus framing allowance. Label estimate assumptions, never claim hard billing cap.
- [ ] Versioned original Chinese fixtures: reunion, costly choice, limited-view reveal, and three-step continuity with fixed people/facts/opening. 800–1200 characters each; no imitation prompts. Stable prompts and hashes. Continuation includes only that model's preceding successful text plus fixed brief. Twelve total drafts, diagnostics separate.
- [ ] Commands/functions support init, plan, run dry by default, run live explicit, resume pending and explicit retry failed. Create-only run root; immutable config/fixture hashes; exclusive writer lock; persist attempt/reserved charge before network. On uncertain failure retain reserve; on restart in-flight becomes uncertain and requires explicit retry. Do not regenerate succeeded drafts. Auth stops batch; failures block dependent continuations. Persist safe outputs atomically, no raw response/reasoning/secrets. Track timestamps, config/prompt hash, response ID/model, finish, usage and known/unknown costs.
- [ ] Test exact 12 calls, context isolation, zero dry-run calls, budget exhaustion, auth stop, failed retry preserving success, interrupted reservations, and config mismatch refusal.

## Slice 3 — Blind comparison, ballots, diagnostics and reports

- [ ] Add src/blind.ts,src/ballot.ts,src/diagnose.ts,src/report.ts and tests. Four groups: three independent pairs and one pair of three-part continuations. Randomize per group, persist mapping once, reuse exports. Candidate labels A/B, no provider/model/timing/prices in blind filenames or metadata. Export Markdown plus ballot template.
- [ ] Validate complete ballot with A/B/tie/neither per group and optional reason; bind to run/artifact hashes. Missing/incomplete outputs block blind export. Record ballot before enabling diagnoses/reveal. Never infer vote from automatic scores.
- [ ] Diagnostic model default Flash, configurable Flash/Pro. Eight diagnostics (one per candidate/group), request JSON CandidateEvaluation plus continuityIssues; validate five scores 0–100, nonempty cited evidence verified against source, diagnosis/instruction strings, vetoes. Treat manuscript as untrusted quoted data. Same live gate, reserve accounting and no automatic retry as generation. An invalid diagnostic is recorded as failure, never silently repaired or assigned a zero score.
- [ ] report requires ballot; show human decisions separately, optional validated diagnostics scored through quality with config weights, usage/cost including unknowns, same-vendor judge caveat and small-sample limits. Reweight from persisted scores without API. Without diagnostics report says unavailable and retains human results.
- [ ] Test mapping persistence and no metadata leakage, invalid ballot/early reveal refusal, diagnostic validation/failure, score reweight without calls.

## Slice 4 — CLI and documentation

- [ ] Add apps/cli/src/evaluation.ts registering eval init/plan/run/export/vote/diagnose/report, invoked by program.ts. Use explicit --live and --retry-failed options where relevant, all paths absolute-resolved and validated IDs never used unchecked as paths. Add workspace dependencies and update lock using pnpm install if needed.
- [ ] Add config example and README Chinese usage. Explain 12 draft calls plus 8 diagnostic calls, blind vote sequence, DeepSeek API env setup without exposing keys, optional diagnosis, no automatic retry, checkpoint recovery and pricing assumptions. Explain development DSH credentials are separate from literary API env.
- [ ] Deterministic E2E through fake gateway covers full lifecycle. pnpm typecheck; pnpm test -- --configLoader=runner; git diff --check. CLI help and dry plan smoke. Real literary calls only after estimates and credential readiness; do not fetch secrets from DSH internal storage.

## Review and delivery

Engineering verification completed 2026-09-08: all four slices implemented; Codex independently ran typecheck (exit 0), full suite (25 files / 204 tests passed), git diff --check, CLI init/plan/default dry-run (12 planned, zero gateway calls). Reviews fixed wire parameters, full-body timeout, unknown/cached usage accounting, continuation context, durable reservations/history, stable anonymous mapping and mandatory ballot hashes, diagnostic result integrity/evidence, JSON output and model routing. CLI sample preflight estimates about USD 0.20 for twelve drafts at configured peak prices; diagnoses are separate. Real literary generation, human blind voting, and real diagnostic report remain pending DEEPSEEK_API_KEY configuration and user input. Engineering verification is not evidence of literary quality.

- [ ] Codex reviews all new sources, verifies tests independently and sends consolidated fixes to SAME DSH session.
- [ ] Save capsule, close session, verify lock removed. Commit/push only scoped files. Report engineering completion separately from user literary blind vote completion.
