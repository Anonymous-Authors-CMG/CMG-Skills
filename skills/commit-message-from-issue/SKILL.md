---
name: commit-message-from-issue
description: >
  Write a commit message that explains both What changed and Why, by first
  finding the open GitHub issue the staged change addresses. Use when the user
  is about to commit, asks you to write or improve a commit message, runs
  `git commit`, or says their commit messages lack rationale. Uses a two-stage
  progressive-disclosure retrieval (titles first, then bodies of a few
  survivors) so a pool of hundreds of issues fits in a handful of small LLM
  calls, then grounds the "Why" in the linked issue. Includes a 0-4 What/Why
  self-score.
license: MIT
metadata:
  paper: "Reason Matters: Enhancing the Rationale of Generated Commit Messages via Issue-Driven Skills"
---

# Commit message from the linked issue

A diff tells you **what** changed. It rarely tells you **why**: the symptom a
user hit, the root cause, why this fix and not another. That rationale usually
lives in the issue tracker.

On 1,200 real commit-issue pairs, adding the linked issue to the prompt moved
the Why score from **2.547 to 3.931** (0-4 scale), while What stayed near the
ceiling either way. Finding the right issue is the lever; restating the diff is
not. Details: `references/results.md`.

All paths below are relative to the directory containing this `SKILL.md`
(call it `<skill-dir>`). Run the scripts **from the user's repository root**,
because they read `git diff --cached` and the `origin` remote from the current
directory.

## Workflow

1. **Check there is something staged.** `git diff --cached --stat`. If empty,
   the script falls back to the unstaged diff; tell the user which one you used.

2. **Link and write.**

   ```bash
   python3 <skill-dir>/scripts/link_and_write.py \
     --out /tmp/cm_run.json --message-out /tmp/cm_msg.txt
   ```

   - `--repo owner/name` is inferred from `origin` (github.com only). Pass it
     explicitly for forks, or when `origin` points elsewhere.
   - Open issues come from the GitHub API. Without `GITHUB_TOKEN` the limit is
     60 requests/hour, which is enough for a few runs; tell the user to set it
     if you hit a 403.
   - Expect roughly 20-80 s. It makes `ceil(pool/chunk) + 2` to `+ 3` LLM calls.

3. **Score it (optional but recommended).**

   ```bash
   git diff --cached > /tmp/cm_staged.diff
   python3 <skill-dir>/scripts/score_message.py \
     --diff-file /tmp/cm_staged.diff --message-file /tmp/cm_msg.txt
   ```

   Target What >= 3.5 and Why >= 3.5. See "Reading a low score" below.

4. **Show the user** the linked issue (number + title, from the script output or
   `linked_titles` in `/tmp/cm_run.json`), the message, and the scores.
   Ask them to confirm the link. **Do not run `git commit` unless they ask.**

## Choosing the LLM backend

The scripts need an LLM. Resolution order (first match wins):

| # | condition | backend used |
|---|---|---|
| 1 | `CM_LLM_CMD` is set | that agent CLI in one-shot mode |
| 2 | `CM_API_KEY` is set | OpenAI-compatible HTTP API at `CM_BASE_URL`, model `CM_LLM_MODEL` |
| 3 | running inside an agent (`CLAUDECODE`, `CODEX_SANDBOX`, `GEMINI_CLI`, ...) | that same agent's CLI |
| 4 | `OPENAI_API_KEY` **and** `CM_LLM_MODEL`/`OPENAI_MODEL` are set | OpenAI-compatible HTTP API |
| 5 | otherwise | first of `claude`, `codex`, `gemini`, `codebuddy`, `cursor-agent`, `opencode` on `PATH` |

Check what will be used, and that it answers, before a long run:

```bash
python3 <skill-dir>/scripts/pdil.py --check
```

How each CLI is invoked (handled by `ADAPTERS` in `scripts/pdil.py`):

| `CM_LLM_CMD` | invocation |
|---|---|
| `claude` | `claude -p [--model M] <prompt>` |
| `codex` | `codex exec --skip-git-repo-check [--model M] <prompt>` (stdin closed, transcript stripped) |
| `gemini` | `gemini [-m M] -p <prompt>` |
| `codebuddy` | `codebuddy -p <prompt> [--model M]` |
| `cursor-agent` | `cursor-agent -p --output-format text [--model M] <prompt>` |
| `opencode` | `opencode run [--model M] <prompt>` |
| anything else | `<cmd> -p <prompt> [--model M]` |

If a CLI fails with "not logged in" or similar, either log in or switch:
`export CM_LLM_CMD=<another>` or set `CM_API_KEY` / `CM_BASE_URL` /
`CM_LLM_MODEL` for a direct API. The HTTP path is also the fastest, because it
does not start a whole agent per call.

Sandboxed agents (e.g. Codex with network disabled) may block both the GitHub
fetch and nested CLI calls. Ask the user to approve network access for this
command, or use the HTTP backend.

Other knobs: `CM_LLM_TIMEOUT` (600 s), `CM_LLM_RETRIES` (2), `CM_PARALLEL`
(4 concurrent Stage-1 chunks), `CM_MAX_DIFF_CHARS` (12000, head 70 % + tail 30 %).

## How the retrieval works

A mature repository has hundreds of open issues. Putting every title and body
into one prompt is too large and too noisy. So:

- **Stage 1 (coarse, titles only).** Split the pool into chunks of
  `--chunk-size` titles, ask for the top `ceil(1.5 * top_n)` per chunk, chunks
  in parallel. One more title-only pass merges the winners down to `--top-n`.
- **Stage 2 (fine, title + body).** Expand only the survivors and re-rank.
- **Write.** The top issue (title + body) goes into the commit-message prompt.

Only a handful of issue bodies are ever read in full.

| flag | default | raise it when |
|---|---|---|
| `--pool-size` | 120 | the repo has many open issues and the fix targets an older one |
| `--chunk-size` | 40 | titles are short; lower it if Stage 1 drops the right issue |
| `--top-n` | 5 | several titles look plausible |

Offline mode (no GitHub): `--diff-file d.diff --candidates-file pool.json`,
where `pool.json` is a list of `{"number", "title", "body"}`.

## What a good message looks like

```
fix: support multi-character split in text_to_word_sequence

Tokenizer can be configured with a multi-character split string, but
text_to_word_sequence called maketrans with split * len(filters),
which only works when split is one character. For split="any",
Python raised "the first two maketrans arguments must have equal
length" during fit_on_texts.

Replace each filter character with the full split string using a
translation dictionary on Python 3. Keep Python 2 compatibility by
using the existing single-character path when possible and falling
back to repeated replace for multi-character splits.

Fixes #9538
```

Rules enforced by `prompts/commit_message.txt`:

- Subject `<type>: <imperative summary>`, <= 72 chars, no trailing period; type
  from `prompts/type_defs.txt` (feat, fix, perf, style, refactor, docs, test,
  ci, build, chore).
- Body wrapped at 72 columns: symptom, root cause, why this fix.
- Do not narrate the diff line by line.
- `Fixes #<n>` only for an issue the retrieval actually returned. Never invent
  an issue number.

## Reading a low score

`score_message.py` uses the same few-shot rubric as the paper
(`prompts/judge_what_why.txt`), so scores are comparable.

- **Why <= 2.** The rationale did not make it in. Look at `stage2_ranked` in
  the run record. If the linked issue is wrong, raise `--pool-size` or
  `--top-n` and rerun. If the issue body was empty, say so instead of inventing
  a motivation.
- **What 4, Why 3.** The motivation is asserted but not shown. Add the concrete
  symptom from the issue.
- **What <= 2.** The subject is vague or describes the wrong change. Re-read
  the diff.

## Honesty constraints

These matter more than the score.

- Retrieval is right about 9 times in 10 (Hit@1 0.890 in the paper), not
  always. **Always show the linked issue and let the user confirm.**
- If nothing convincing is found, write the message without an issue
  reference and tell the user the Why is inferred from the diff alone. A thin
  honest rationale beats a confident invented one.
- If the change only partly addresses the issue, suggest `Refs #n` instead of
  `Fixes #n`, since `Fixes` closes the issue on merge.
- Never commit, push, or edit files on the user's behalf unless asked.

## Files

```
commit-message-from-issue/
├── SKILL.md
├── prompts/              stage1_coarse, stage2_fine, verify_link, commit_message, type_defs, judge_what_why
├── scripts/
│   ├── pdil.py           backend resolution, CLI adapters, HTTP client, parsers, GitHub client
│   ├── link_and_write.py the pipeline
│   ├── score_message.py  0-4 What/Why judge
│   ├── ci_review.py      PR/MR bot for GitHub Actions and GitLab CI (see docs/ci.md)
│   ├── fetch_case.py     build an offline case from a merged PR
│   └── setup_demo_repo.sh  throwaway repo with a fix already staged
├── examples/             keras-9585 (offline fixture), keras-23710-live, run_example.sh
└── references/
    ├── results.md        numbers from the paper
    └── examples.md       verified runs and how to reproduce them
```
