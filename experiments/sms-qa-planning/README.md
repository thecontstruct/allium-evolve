# SMS Q&A Feature Planning Experiment

## Metadata

| Field | Value |
|-------|-------|
| Date | 2026-02-22 |
| Experiment ID | sms-qa-planning-001 |
| Planning Model | claude-4.6-opus-high-thinking (inherited) |
| Evaluation Model | gpt-5.3-codex |
| Iterations per condition | 3 |
| Total iterations | 6 |

## Hypothesis

Adding Allium behavioral specifications as context to an LLM planning task improves plan quality compared to providing only source code context. Specifically, we expect improvements in domain model accuracy, edge case coverage, consistency with existing patterns, and ambiguity surfacing.

**Counter-hypothesis:** modern frontier models are capable enough to extract the same understanding from raw code, making the structured spec redundant.

## Methodology

### Feature Planned

SMS Q&A with Knowledge Base — extending an existing SMS feedback system to support question-answering derived from a tenant-managed knowledge base with vector search. Full specification in [feature-spec.md](./feature-spec.md).

### Conditions

| Condition | Context Provided | Iterations |
|-----------|-----------------|------------|
| **WITHOUT specs** | Codebase structure, schema definitions, code patterns, package exports | 3 |
| **WITH specs** | Same as above + full Allium behavioral specification (1,884 lines, 79KB) | 3 |

### Controls

- Identical feature specification across all iterations
- Identical codebase context (except spec addition for WITH condition)
- Same model for all planning iterations (claude-4.6-opus-high-thinking)
- Same prompt structure and instructions
- Each iteration is independent (no shared context between runs)
- All agents wrote plans directly to files (no intermediary truncation)
- WITHOUT agents were told not to read any files
- WITH agents were instructed to read only the Allium spec file

### Blind Evaluation Protocol

Plans were assigned randomized identifiers before evaluation. The evaluator (GPT 5.3 Codex) received plans stripped of condition labels.

**Blind Mapping:**

| Blind ID | Condition | Plan Size |
|----------|-----------|-----------|
| Plan-Alpha | WITHOUT-1 | 979 lines / 47KB |
| Plan-Beta | WITH-2 | 1,027 lines / 45KB |
| Plan-Gamma | WITHOUT-3 | 698 lines / 33KB |
| Plan-Delta | WITH-1 | 938 lines / 41KB |
| Plan-Epsilon | WITHOUT-2 | 634 lines / 30KB |
| Plan-Zeta | WITH-3 | 1,096 lines / 47KB |

### Evaluation Criteria

Each plan scored 1-5 on seven dimensions by GPT 5.3 Codex (blind).

---

## Results

### Aggregate Scores

| Blind ID | Condition | Domain | Edge | Pattern | Scope | Ambiguity | Action | Halluc | **Total** |
|----------|-----------|--------|------|---------|-------|-----------|--------|--------|-----------|
| Plan-Alpha | WITHOUT-1 | 4 | 5 | 3 | 4 | 5 | 5 | 3 | **29** |
| Plan-Epsilon | WITHOUT-2 | 4 | 5 | 3 | 4 | 5 | 5 | 2 | **28** |
| Plan-Gamma | WITHOUT-3 | 4 | 5 | 3 | 4 | 5 | 5 | 3 | **29** |
| | **WITHOUT avg** | **4.0** | **5.0** | **3.0** | **4.0** | **5.0** | **5.0** | **2.67** | **28.67** |
| Plan-Delta | WITH-1 | 4 | 5 | 3 | 4 | 5 | 5 | 2 | **28** |
| Plan-Beta | WITH-2 | 4 | 5 | 3 | 4 | 5 | 5 | 2 | **28** |
| Plan-Zeta | WITH-3 | 4 | 4 | 3 | 4 | 5 | 4 | 3 | **27** |
| | **WITH avg** | **4.0** | **4.67** | **3.0** | **4.0** | **5.0** | **4.67** | **2.33** | **27.67** |

### Per-Dimension Comparison

| Dimension | WITHOUT avg | WITH avg | Delta |
|-----------|-------------|----------|-------|
| Domain Model Accuracy | 4.0 | 4.0 | 0 |
| Edge Case Coverage | 5.0 | 4.67 | -0.33 |
| Pattern Consistency | 3.0 | 3.0 | 0 |
| Scope Precision | 4.0 | 4.0 | 0 |
| Ambiguity Surfacing | 5.0 | 5.0 | 0 |
| Actionability | 5.0 | 4.67 | -0.33 |
| Hallucination Rate | 2.67 | 2.33 | -0.33 |
| **Total** | **28.67** | **27.67** | **-1.0** |

### Variance

| Condition | Min | Max | Range | Std Dev |
|-----------|-----|-----|-------|---------|
| WITHOUT | 28 | 29 | 1 | 0.58 |
| WITH | 27 | 28 | 1 | 0.58 |

---

## Analysis

### Primary Finding: No Meaningful Difference

The Allium behavioral specification did not measurably improve plan quality in this experiment. The WITHOUT condition averaged 28.67/35 vs 27.67/35 for WITH — a 1-point difference that favors the control group, well within noise for N=3.

Five of seven dimensions scored identically across conditions. The slight edge for WITHOUT came from Plan-Zeta (WITH-3) scoring lower on Edge Case Coverage and Actionability — a single outlier in a small sample.

### What Was the Same

Both conditions produced plans with:
- **Perfect Domain Model Accuracy (4/4):** All plans correctly identified existing entities (tenant, user, member, location, smsMessage, smsFeedback, smsContact, smsLocationConfig), their relationships, and key patterns. None invented non-existent tables or missed critical existing infrastructure.
- **Strong Ambiguity Surfacing (5/5):** Every plan flagged 8-12 open questions requiring stakeholder input: KB scope (tenant vs location), rate limiting strategy, cost controls, conversation timeout configurability, follow-up feedback handling, document format limits, etc.
- **Consistent Pattern Consistency struggles (3/3):** All plans were penalized for making assumptions about existing module paths, endpoint shapes, or conventions that couldn't be verified from the provided context alone. This is an inherent limitation of planning from summaries rather than reading actual source code.

### What the Spec DID Influence (Qualitative)

While scores were similar, the WITH plans exhibited some qualitative differences:

1. **Longer plans on average** (1,020 lines vs 770 lines). The spec-informed plans tended to include more detailed schema definitions and more explicit lifecycle states. Whether this represents value or verbosity is debatable.

2. **More consistent terminology.** WITH plans used domain terms that matched the spec's vocabulary (e.g., `FeedbackUrgency`, `FeedbackTarget`, `TenantRole`) slightly more consistently than WITHOUT plans, though the evaluator didn't specifically score for this.

3. **Slightly lower Hallucination scores.** Paradoxically, the WITH plans averaged 2.33 vs 2.67 for WITHOUT on hallucination. The evaluator noted that WITH plans made more "overconfident assumptions about existing code structure" — possibly because the spec gave them a sense of certainty that led to more specific (but unverifiable) claims about implementation details.

### Why the Spec Didn't Help More

Several factors likely explain the null result:

1. **The spec is infrastructure-heavy.** ~80% of the 1,884-line Allium spec covers database CLI tooling, Cloud Run deployment, GCP utilities, and storage abstraction. Only ~300 lines cover the SMS/feedback domain that's actually relevant to the planned feature. The signal-to-noise ratio was low.

2. **The codebase context was already strong.** The shared context provided schema definitions, webhook handler flow, classification patterns, auth middleware, and admin API patterns — essentially the same information the spec captures, but in the native format. The spec was redundant rather than additive.

3. **Frontier models extract structure well.** Claude 4.6 Opus is highly capable at inferring domain models, entity relationships, and behavioral patterns from raw code descriptions. The structured spec didn't surface information the model couldn't already derive.

4. **Planning is prompt-driven.** The 11-point planning template was prescriptive enough to guide all plans toward the same structure, reducing the spec's influence on output quality.

### Caveats and Limitations

- **N=3 per condition** provides very low statistical power. A meaningful difference of 1-2 points could be hidden in the noise.
- **Single evaluator model.** GPT 5.3 Codex may have systematic biases. Cross-evaluator validation would strengthen conclusions.
- **Evaluator context was limited.** The evaluator received a summary of the codebase context, not full source code. Its "hallucination" scoring is relative to the summary, not ground truth.
- **Single feature scenario.** Different features (especially those touching more of the spec'd domain) might yield different results.
- **Spec quality matters.** This spec evolved from git history analysis, not elicitation. A hand-crafted spec focused on the SMS domain might perform differently.

---

## Conclusions

1. **The hypothesis is not supported.** Adding the Allium spec did not improve plan quality as measured by our rubric. The counter-hypothesis — that frontier models extract sufficient understanding from code context alone — is consistent with the data.

2. **This does not prove specs are useless.** The experiment tested one specific scenario: feature planning with a capable frontier model. Specs may provide value in other contexts:
   - Onboarding new developers (human or AI) who lack any codebase context
   - Maintaining consistency across many planning sessions over time
   - Catching drift between intended and actual behavior
   - Communication between non-technical stakeholders and implementation teams

3. **Spec relevance matters.** An infrastructure-heavy spec provided minimal benefit for application feature planning. A domain-focused spec might yield different results.

4. **Suggested follow-ups:**
   - Repeat with a domain-focused spec (SMS/feedback behavior only, no infra)
   - Test with a less capable model where the gap between "can extract from code" and "has a spec" might be larger
   - Test implementation (not just planning) — specs may matter more when writing actual code
   - Test with a human evaluator for ground-truth accuracy checking

---

## File Index

### Plans
| File | Condition |
|------|-----------|
| [plans/plan-alpha.md](./plans/plan-alpha.md) | WITHOUT-1 |
| [plans/plan-epsilon.md](./plans/plan-epsilon.md) | WITHOUT-2 |
| [plans/plan-gamma.md](./plans/plan-gamma.md) | WITHOUT-3 |
| [plans/plan-delta.md](./plans/plan-delta.md) | WITH-1 |
| [plans/plan-beta.md](./plans/plan-beta.md) | WITH-2 |
| [plans/plan-zeta.md](./plans/plan-zeta.md) | WITH-3 |

### Evaluations
| File | Plan |
|------|------|
| [evaluations/eval-plan-alpha.md](./evaluations/eval-plan-alpha.md) | Plan-Alpha (WITHOUT-1) |
| [evaluations/eval-plan-beta.md](./evaluations/eval-plan-beta.md) | Plan-Beta (WITH-2) |
| [evaluations/eval-plan-gamma.md](./evaluations/eval-plan-gamma.md) | Plan-Gamma (WITHOUT-3) |
| [evaluations/eval-plan-delta.md](./evaluations/eval-plan-delta.md) | Plan-Delta (WITH-1) |
| [evaluations/eval-plan-epsilon.md](./evaluations/eval-plan-epsilon.md) | Plan-Epsilon (WITHOUT-2) |
| [evaluations/eval-plan-zeta.md](./evaluations/eval-plan-zeta.md) | Plan-Zeta (WITH-3) |

### Other
| File | Description |
|------|-------------|
| [feature-spec.md](./feature-spec.md) | Feature requirements used for all iterations |
| [allium-spec.allium](./allium-spec.allium) | Allium spec provided to WITH condition |
