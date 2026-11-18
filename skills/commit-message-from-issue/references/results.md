# Numbers from the paper

Source: *Reason Matters: Enhancing the Rationale of Generated Commit Messages
via Issue-Driven Skills* (manuscript under review at ACM TOSEM).

## Dataset

1,200 linked commit-issue samples, 200 per repository:

- Model training: PyTorch, Keras, DeepSpeed
- Storage infrastructure: ClickHouse, Apache Pulsar, Apache RocketMQ

The candidate pool for each sample is the set of issues open at commit time
(capped at 1,000). Keras has a median pool of 213; RocketMQ never exceeds 457.

## Issue identification (Stage 1 + Stage 2)

Averaged over the six repositories, N = 10 survivors:

| backend | MRR | Hit@1 | Recall@10 |
|---|---:|---:|---:|
| Claude-Opus-4.6 | 0.913 | 0.890 | 0.942 |
| Kimi-K2.5 | 0.887 | – | – |
| MiniMax-M2.7 | 0.873 | – | – |

The hardest repository (PyTorch, the largest and most varied pool) still
reaches Hit@1 >= 0.775 on every backend.

Against baselines on a 300-candidate pool (Claude backend): BM25 alone gets MRR
0.308-0.457, BM25 + LLM re-rank 0.634, progressive disclosure 0.875. Most of
the gain comes from letting the LLM do the coarse title scan instead of lexical
matching.

## Commit-message quality (context ablation)

Pooled over 6 repositories x 3 generators, n = 3,600 messages per variant,
0-4 scale.

| variant | What (DeepSeek judge) | Why (DeepSeek judge) | What (GPT judge) | Why (GPT judge) |
|---|---:|---:|---:|---:|
| diff only | 3.780 | 2.547 | 3.856 | 2.909 |
| + retrieved exemplars | 3.903 | 3.752 | 3.840 | 3.757 |
| **+ linked issue** (this skill) | **3.918** | **3.931** | 3.809 | **3.908** |
| full (issue + exemplars) | 3.921 | 3.906 | 3.822 | 3.909 |

Takeaways:

1. What is near the ceiling from the diff alone. The headroom is in Why.
2. The linked issue is the biggest single lever: Why +1.384 under the DeepSeek
   judge.
3. Once the issue is present, adding exemplars does not help further. That is
   why this skill skips exemplar retrieval.

## When retrieval is wrong

In the roughly 10 % of cases where the top-ranked issue was not the gold one,
messages still averaged Why > 3.5. Wrong picks are usually closely related
issues in the same area, which still carry useful context. That is a reason
not to panic about misses, but not a reason to skip the user's confirmation.

## Latency

About 5 LLM calls per commit. Median 66 s on PyTorch with pool = 1,000 and
sequential Stage-1 chunks. This skill runs Stage-1 chunks in parallel
(`CM_PARALLEL`, default 4).
