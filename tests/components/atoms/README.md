# tests/components/atoms (QA)

Independent QA suite for the atoms layer (T01 tokens, T02 Typography/Link/Badge/Price,
T03 Button/Spinner/Image, T04 Input/Select/FormField/QuantityStepper). Owner: QA.
The colocated tests in `src/components/atoms/**` belong to the implementers; these files
re-check the acceptance criteria adversarially and do not import from those tests.

| File | Covers |
| --- | --- |
| `tokens.qa.test.ts` | T01, rewritten light-only (QA-ATOMS-P3): parses the single `:root` palette of `src/app/globals.css` via `_palette.ts`, asserts light only (`color-scheme: light`, no dark block), recomputes every documented header row (single-line rows parsed generically; tint table and wrapped rows by name) within 0.011, every AA text pair (>= 4.5) and every pair a Phase 3 atom renders, asserts the two documented exceptions (focus ring next to solid fills; accent fills on the dark band) as real sub-3:1 exceptions with their mitigation/remedy, reports undocumented pairs (console only), base layer (focus ring, white ring in `.bg-surface-inverse`, reduced motion), `check:tokens` passes and catches seeded violations. Pins D-T130-3. |
| `typography.qa.test.tsx` | Heading level x size matrix, compile-time level errors, Text. |
| `price.qa.test.tsx` | Valid amounts, invalid amounts/currencies/compare-at (renders nothing, one warning), compare-at lower/equal/higher. |
| `link.qa.test.tsx` | Internal/external/current, rel/target override, `javascript:` href. |
| `badge.qa.test.tsx` | Each tone + icon, children contract. |
| `button.qa.test.tsx` | Button loading/submit/disabled/ref/className, Spinner sizes/label. |
| `image.qa.test.tsx` | Placeholder for empty/null/undefined src, `fill`, `alt=""`, onError swap, lazy/priority, type contract. |
| `form.qa.test.tsx` | Input types/invalid, Select placeholder, FormField aria wiring (exact `aria-describedby`). |
| `quantity-stepper.qa.test.tsx` | Hostile typed input, clamping, min===max, max<min, disabled, keyboard, form Enter, call counts. |
| `phase2-batch2-static.qa.test.tsx` | QA-W0-D2 (P2-D2) Skeleton, ProgressBar, Table, Breadcrumb (SSR + hydrateRoot collapse), Pagination + PaginationSummary (ellipsis invariant over 1..30 pages, 10k pages, NaN). |
| `phase2-batch2-interactive.qa.test.tsx` | QA-W0-D2 Tabs (roving tabindex, orientation, manual/automatic, controlled), Disclosure/Accordion (no-JS markup, name groups), Tooltip (fake timers), SearchField (no-JS form, combobox keyboard, hydration). |
| `phase2-batch2-overlay.qa.test.tsx` | QA-W0-D2 Dialog (Escape/backdrop/alert/scroll lock/focus return/StrictMode), Toast (live regions, queue, timers, pause), cross-cutting source scan of the 11 batch-2 folders. |
| `phase2-batch1.qa.test.tsx` | QA-W0-D1 (P2-D1) Icon (49 names, geometry, title/aria-hidden, type errors), IconButton (variants, pressed, loading, 44px), Rating display (clamp/NaN/half-star/Intl count) + input (radiogroup, FormData, no-JS markup, CSS-only hover). |
| `phase2-batch1-forms.qa.test.tsx` | QA-W0-D1 Checkbox (indeterminate/aria-checked), RadioGroup/Radio (0 and 500 radios, errorText/hint wiring, no-JS posting), Switch (hidden input posting), Textarea (FormField wiring, threshold live region, field-sizing), Rating errorText. |
| `phase2-batch1-misc.qa.test.tsx` | QA-W0-D1 Chip (button/a/span union, sibling remove), Avatar (unicode initials, tone hash, image error), Divider, VisuallyHidden, Notice, cross-cutting source/markup scan of the 12 batch-1 atoms. |
| `phase2-tokens.qa.test.ts` | QA-W0-D1 criterion 13, light-only since Phase 3: Phase 2 pairs (danger/success-hover, rating, switch thumb, accent on tints, skeleton n/a, scrim composite) recomputed and looked up in the header; every MVP/Phase 2 token declared exactly once and mapped; check:tokens. |
| `phase2-atoms-4.contrast.qa.test.ts` | QA-ATOMS-4 item 8, light-only since Phase 3: inverse-band figures (accent fills below 3:1, `inverse` pill and `ring-2 ring-text-inverse` remedies) and decorative `text-border-strong`, recomputed and matched against the header. |
| `phase2-atoms-4.qa.test.tsx` | QA-ATOMS-4 items 1-7, 9. The byte-identical Button class table was regenerated for the Phase 3 pill (`rounded-full`, danger hover fill, `outline`/`inverse`) and is cross-checked against `Button/button-classes.ts`. |
| `phase3-atoms.qa.test.tsx` | QA-ATOMS-P3: Card, CategoryTile, Button quick-add/outline/inverse/shape, Link button parity, Badge tones/emphasis/shape/size/presets, Price superscript (spoken text exactly once), Input/SearchField pill (no-JS, ARIA, Tab order), Chip filled + trailing icon, Rating compact, QuantityStepper pill; source and markup scans (tokens only, 44px, focus, light only). Pins D-T131-1..4. |
| `_palette.ts` | Shared helper (not a test): reads raw values from `globals.css` at test time; contrast, composite, hue and the header-row parser. Test files never write colour values. |

Conventions

- Defect-reproducing tests use `test.failing(...)` so the suite stays green; remove the
  `.failing` once the defect is fixed (the test then fails until you do, by design).
- "Documents behaviour" tests pin current behaviour that is questionable but not a criterion
  violation; they are named as such.
- happy-dom: keyboard activation of buttons is checked as native `<button>` + click; the stepper's
  key handling uses `fireEvent.keyDown` and asserts `defaultPrevented` via its return value.

Run (memory rule: never the full suite): `bun run test --max-rss=1500 tests/components/atoms`
