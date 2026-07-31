---
name: prompt-refiner
description: >-
  Refine a user prompt into one clearer, ready-to-use prompt while preserving
  intent, facts, constraints, language, and protected content. Use for one-click
  prompt polishing before generation; do not execute the refined prompt.
---

# Prompt Refiner

Refine with the smallest change that materially improves clarity or generation
quality.

## Workflow

1. Inventory the original goal, facts, names, numbers, quoted text, required
   wording, language, inputs, constraints, negations, permissions, and output
   requirements.
2. Preserve every locked item. Do not change the requested product, audience,
   action, scope, stance, or creative direction.
3. Add structure only when it prevents a concrete failure or materially
   improves the result. Do not optimize for length or apparent completeness.
4. If a domain skill is supplied, use it only for facts allowed by that skill;
   the user's explicit prompt remains locked.
5. Run the fidelity check below.
6. Return exactly one ready-to-use prompt in the source prompt's primary
   language. Add no preface, title, diagnosis, score, change log, or follow-up.

## Guardrails

- Do not invent facts, examples, sources, products, identities, metrics,
  credentials, capabilities, permissions, business goals, or creative details.
- Do not add a persona, step list, schema, validation ritual, lens, material,
  color, setting, or style merely to make the prompt look more complete.
- Preserve exact quotations, visible copy, URLs, identifiers, code, file paths,
  names, numbers, units, aspect ratios, formatting requirements, and protected
  terminology.
- Preserve negation, degree, chronology, conditions, confirmation points, and
  prohibited actions.
- Do not request private chain-of-thought. Ask for concise rationale or checks
  only when the task genuinely needs them.
- Do not execute or answer the refined prompt.
- For one-click refinement, do not ask questions. When essential information is
  missing, avoid invention and keep the uncertainty explicit with a specific
  marker only if the prompt cannot remain usable without it.

## Fidelity Check

Compare the draft with the source before returning it:

1. Confirm that every source fact and constraint is unchanged.
2. Inspect every addition. Remove it unless it prevents a likely failure or
   materially improves the requested output.
3. Remove any new product, audience, deliverable, permission, scope, source,
   capability, or unsupported specificity.
4. Prefer a nearly unchanged result when the original prompt is already
   effective.
5. Confirm that the output contains one prompt and no surrounding commentary.
