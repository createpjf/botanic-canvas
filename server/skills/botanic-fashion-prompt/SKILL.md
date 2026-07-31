---
name: botanic-fashion-prompt
description: >-
  Refine Botanic fashion image-generation prompts with verified garment,
  styling, scene, composition, and lighting knowledge from the Botanic series
  catalog. Use only when the request or structured context explicitly concerns
  apparel, fashion imagery, or a named Botanic clothing series. Do not apply
  apparel assumptions to fragrance or other non-fashion requests.
---

# Botanic Fashion Prompt

Improve a fashion image prompt without changing the requested product, message,
or creative direction. Use this skill together with `prompt-refiner`; let the
general refiner protect intent and let this skill supply only verified domain
details.

## Workflow

1. Inventory the user's exact product, colors, materials, people, actions,
   setting, text, framing, aspect ratio, reference roles, and exclusions.
2. Apply the domain gate. Continue with fashion rules only when the prompt or
   structured context explicitly identifies apparel, fashion imagery, or a
   Botanic clothing series. Otherwise perform only general prompt refinement.
3. Match a series only from an explicit series name. For a matched series, read
   [references/series-catalog.md](references/series-catalog.md) and use only
   relevant facts from that one entry.
4. Add the smallest amount of structure that materially improves generation,
   such as subject, garment, scene, composition, light, or image finish. Omit
   unsupported fields.
5. Compare the result against the inventory and remove every invented,
   conflicting, or merely decorative addition.
6. Return exactly one ready-to-use prompt in the user's primary language. Add
   no explanation, title, score, or change log.

## Hard Boundaries

- Treat the user's explicit requirements as locked. Preserve names, numbers,
  quoted copy, colors, garments, materials, actions, ratios, negations, and
  exclusions.
- Do not infer a series from visual similarity, vague adjectives, or a generic
  request such as “拍得高级一点”. With no explicit series, do not introduce a
  series-specific garment, color, material, prop, or scene.
- Do not mix details from different series.
- Treat `浪漫曼波+牛仔外套` as insufficiently documented. Preserve its name when
  supplied, but add no catalog-derived garment, color, material, styling, or
  scene detail.
- Use reference metadata only. `name` and `role` may describe the intended use;
  `primary` may establish priority. Never claim to see or analyze image content
  from metadata, and never invent an identity, garment, pose, color, or scene.
- Add “五官不变” or an equivalent identity lock only when reference metadata
  explicitly identifies a model/person/identity reference. Do not add it for a
  product, style, or scene reference.
- Preserve user-requested visible words exactly. If the user requests text,
  typography, a slogan, or a caption, do not add `text` to the negative prompt.
  Apply the same conflict check to `logo` and `watermark`.
- Add only a compatible subset of negative terms when it materially prevents a
  likely failure. Never append a stock negative list mechanically.
- Do not claim a fabric, cut, color, lens, location, or production fact unless
  it is supplied by the user, structured context, or the exact matched catalog
  entry.

## Precedence

Resolve compatible inputs in this order:

1. explicit reference-role locks and structured task settings;
2. the user's explicit prompt;
3. the explicitly selected Botanic series;
4. optional Botanic defaults.

If two locked inputs conflict and no safe resolution is explicit, preserve the
user's wording rather than silently choosing a new creative direction.
