# Verified runs

All three runs below use the same offline case and found the right issue.

## The case: keras #9585

`examples/keras-9585/` reconstructs what the developer faced when fixing keras
PR #9585: the staged diff, plus the 60 issues that were open at that moment.
The gold issue is #9538, "Tokenization crashes when split string has more than
one character".

```bash
bash <skill-dir>/examples/run_example.sh
```

| backend | Stage-1 -> Stage-2 ranking | #1 | wall time | What / Why |
|---|---|---|---:|---|
| `claude -p` | `[9538, 7115, 6899, 6950, 7156]` | HIT | ~37 s | 4 / 4 |
| `codex exec` | `[9538, 7115, 6458, 7290, 6899]` | HIT | 57 s | – |
| HTTP, `deepseek-flash` | `[9538, 7115, 6458, 6547, 7290]` | HIT | 76 s | 4 / 4 |

Run records: `expected_run.json`, `run_codex.json`, `run_deepseek-flash.json`.
Only the five Stage-2 survivors ever had their bodies loaded; the other 55
issues cost one title line each.

LLM output is not deterministic. Expect ranks 2-5 and the exact wording to
change between runs. Three runs show the pipeline works; they do not
reproduce the paper's Hit@1, which came from 1,200 samples.

## A live run: keras #23710

`examples/keras-23710-live/` was produced with no fixture at all: a fresh
`git clone --depth 50` of keras-team/keras, a hand-written fix staged with
`git add`, the repo slug read from `origin`, and 120 open issues fetched from
the GitHub API at run time.

```
stage 1: 120 candidates -> 3 chunk(s) of <=40, keeping 8 per chunk
  merging 24 cross-chunk winners -> top 5
stage 2: expanding title+body for 5: [23710, 23709, 23251, 22213, 23553]
linked issue #23710: OrbaxLazyModule.available raises AttributeError
                     instead of returning False
What: 4/4   Why: 4/4
```

#23709, ranked second, is a sibling bug in the same property of the same file,
filed the same day. Stage 2 still put the right one first: the diff touches
`OrbaxLazyModule.initialize`, which is what #23710 is about.

## A throwaway repo to try the agent flow

```bash
bash <skill-dir>/scripts/setup_demo_repo.sh /tmp/demo-keras
cd /tmp/demo-keras
claude      # or codex, gemini, ...
# > I just finished this fix and staged it. Write my commit message.
```

The script builds a git repo with a "before" commit, the #9585 fix already
staged, a cached issue pool in `.commit-msg/candidates.json`, and an
`AGENTS.md` / `CLAUDE.md` telling the agent to use this skill offline.

## Build your own case

```bash
export GITHUB_TOKEN=...
python3 <skill-dir>/scripts/fetch_case.py --repo owner/name --pr 1234 \
  --gold 1200 --pool-size 60 --out-dir my-case
bash <skill-dir>/examples/run_example.sh my-case
```

`fetch_case.py` keeps only issues created before the merge and drops the ones
already closed by then, so the task matches what the developer saw.
