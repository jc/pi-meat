# Three landing-page demos for Meat

Fresh runs on **August 2, 2026** using `gpt-5.6-sol`, `-no-cache`, and
upstream repository context. The canonical checked-in outputs were produced by
Meat commit `85fd905c4957203dcae7be146de745d5f93fbac3` with rubric hash
`3c17e8412d288ebc`. Three earlier exploratory runs used commit
`38d6b8f832030c7da90e4138452540788cadecf2` with rubric hash
`e6866ffaafb898ce`; because the model-visible surfaces differ, treat those as
cross-revision robustness observations rather than identical reruns.
[`runs.json`](runs.json) contains every full response, stderr timing/token line,
input SHA-256, model, flags, executable commit, and per-run rubric hash.
Run `python3 verify.py` to recount all metrics, verify JSON/diff identity, check
repeat-run retention, and confirm the standalone viewer's embedded data.

These are the three strongest website examples I found after mining famous Go,
Python, and Rust projects and then testing the finalists with real Meat runs.
All three inputs are below 25 **changed rows** and all three canonical outputs
retain exactly two changed rows: one old line and one new line.

> “Lines” below means changed source rows, excluding diff metadata and context.
> The full unified diffs are 76–117 physical rows because they deliberately show
> repeated hunks and files—the noise Meat removes.

## Recommendation

| language | project / commit | input | Meat | changed rows elided | why it works immediately |
|---|---|---:|---:|---:|---|
| Go | `golang/go` `0b6ea6bb04e4` | 16 rows, 8 hunks | **2 rows, 1 hunk** | 87.5% | Eight DNS error paths make the same correction. |
| Python | `huggingface/transformers` `cb0adddc36827` | 18 rows, 9 files | **2 rows, 1 file** | 88.9% | One modular source fix fans out into eight generated model files. |
| Rust | `helix-editor/helix` `e7874bc69c05` | 22 rows, 11 hunks | **2 rows, 1 hunk** | 90.9% | Eight LSP fan-outs make the same concurrency choice. |

The exact original diffs, canonical Meat outputs, and JSON responses are beside
this file. `viewer.html` gives you a side-by-side version suitable for adapting
into the website; `data.js` embeds the six diffs so the viewer works directly
from `file://` as well as over HTTP.

## Go — the most instantly understandable

**Project:** Go standard library  
**Commit:** `0b6ea6bb04e49e5eba614d39bb1334c87fff4f62`  
**Date:** August 19, 2023  
**Subject:** `net: return "cannot unmarshal" error while parsing DNS messages`

Eight separate DNS response parsing branches contain the same incorrect error
text. Meat keeps one representative correction and drops seven repetitions.

```diff
-                       Err:    "cannot marshal DNS message",
+                       Err:    errCannotUnmarshalDNSMessage.Error(),
```

**Landing-page copy:**

> **Eight error paths. One correction.**  
> Meat turns 16 changed lines across 8 hunks into the only 2 lines you need.

**Metrics:** 16 → 2 changed rows; 76 → 10 physical rows; 2,895 → 458 bytes.
All four recorded evaluation runs across the two Meat revisions above retained
2/16 changed rows.

Files: [`go.original.diff`](go.original.diff) ·
[`go.meat.diff`](go.meat.diff) · [`go.meat.json`](go.meat.json)

## Python — the best generated-code demo

**Project:** Hugging Face Transformers  
**Commit:** `cb0adddc36827c1a662211c069f05e75fd1ff27c`  
**Date:** April 22, 2026  
**Subject:** `fix(DSV3): parity between native DeepseekV3MoE and remote official implementation (#45441)`

The real change is in `modular_deepseek_v3.py`: masked experts receive
negative infinity so they cannot win top-k selection against negative unmasked
scores. Eight `modeling_*.py` files repeat the exact edit and explicitly identify
themselves as generated. Meat removes every generated copy.

```diff
-        scores_for_choice = router_logits_for_choice.masked_fill(~score_mask.bool(), 0.0)
+        scores_for_choice = router_logits_for_choice.masked_fill(~score_mask.bool(), float("-inf"))
```

**Landing-page copy:**

> **Nine files changed. One file worth reading.**  
> Meat keeps the modular source fix and removes eight generated copies.

**Metrics:** 18 → 2 changed rows; 117 → 11 physical rows; 7,812 → 774
bytes. All four recorded evaluation runs across the two Meat revisions above
retained 2/18 changed rows.

Files: [`python.original.diff`](python.original.diff) ·
[`python.meat.diff`](python.meat.diff) ·
[`python.meat.json`](python.meat.json)

## Rust — the best cross-hunk repetition demo

**Project:** Helix editor  
**Commit:** `e7874bc69c0549fe87e863c4b4f6a5c2fccffca7`  
**Date:** March 29, 2026  
**Subject:** `chore(helix-term): LSP unordered fanout requests (#15543)`

Helix changes LSP fan-out aggregation from ordered to unordered futures in eight
call sites across commands, document colors, and document links. Meat hides the
imports and ten repetitive hunks, leaving one concurrency decision.

```diff
-    let mut futures: FuturesOrdered<_> = doc
+    let mut futures: FuturesUnordered<_> = doc
```

**Landing-page copy:**

> **Eleven hunks. One concurrency choice.**  
> Meat shows that LSP responses are now handled as they complete—and nothing
> else.

**Metrics:** 22 → 2 changed rows; 106 → 13 physical rows; 5,090 → 546
bytes. Across four recorded evaluation runs spanning the two Meat revisions,
Meat retained 2 rows three times and 4 rows once; the checked-in canonical
result is the 2-row output.

Files: [`rust.original.diff`](rust.original.diff) ·
[`rust.meat.diff`](rust.meat.diff) · [`rust.meat.json`](rust.meat.json)

## Suggested page order

1. **Go first.** It needs no domain explanation: marshal vs. unmarshal is obvious.
2. **Python second.** It demonstrates the stronger claim that Meat understands
   source-of-truth versus generated output, not merely repeated text.
3. **Rust third.** It shows a real behavioral choice repeated across a codebase,
   with import churn removed automatically.

A good animation is: show the full original for 1–1.5 seconds, collapse repeated
hunks/files, then leave the two-line result and one-sentence summary. Keep changed
rows as the large metric; physical-row and byte reductions can be secondary.

## Finalists I would not put on the landing page

- CPython's `secs` → `sec` timeit commit looked perfect statically, but current
  Meat retained 10/32 changed rows.
- Tokio's `src`/`dst` → `original`/`link` rename retained 10/42 rows.
- Cargo's warning-snapshot elision retained 4/40 rows—good, but it needs snapshot
  wildcard context and misses the requested 1–3-row target.
- Wasmtime's exhaustive heap-type match retained 12–14/36 rows because the
  explicit variants are legitimate semantic evidence.

Those rejections are useful evidence that these recommendations are based on
actual Meat output, not merely on diffs that looked repetitive to a script.
