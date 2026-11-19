# PR and MR bot

The same method, run on every pull request instead of on your laptop.

When a PR opens, the bot reads its diff, searches the repository's open issues
the same two-stage way the skill does, and posts **one comment**:

- which open issue the PR seems to address, with the evidence, so the author
  can add `Fixes #n` before merging;
- a squash commit message that explains why, ready to paste into the merge box.

It does not edit the PR, add labels, or close anything. Re-runs update the same
comment instead of adding new ones.

## Why run it in CI

- **Waiting is free.** A full search takes 30 to 60 seconds. In a terminal that
  is annoying; in CI nobody is watching.
- **Squash merges throw the reason away.** Many projects merge with the PR
  title as the commit message. The bot gives you a better one.
- **Links get missed.** Maintainers often see a PR that fixes an issue nobody
  linked, so the issue stays open forever. The bot points it out.

## What the comment looks like

A real run on [keras-team/keras#24152](https://github.com/keras-team/keras/pull/24152),
with its `Fixes` line hidden from the bot so it had to find the issue itself
among 153 open ones:

> ### Issue Commit
>
> This PR looks like it addresses **[#24080](https://github.com/keras-team/keras/issues/24080)
> `keras.ops.roll` rejects tensor `shift`/`axis` on the TensorFlow backend**
>
> > Strong match · The issue reports that `ops.roll` on the TensorFlow backend
> > raises ValueError when `shift` or `axis` is a tensor and `axis` is given,
> > because `to_tuple_or_list` rejects tensors. The PR changes that same `roll`
> > function [...] and adds tests for the issue's exact repro.
>
> If that's right, add `Fixes #24080` to the description so the issue closes on merge.
>
> <details open><summary><b>Suggested squash commit message</b></summary>
>
> ```text
> fix: accept tensor shift/axis in ops.roll on TensorFlow backend
>
> On the TensorFlow backend, keras.ops.roll raised a ValueError whenever
> `axis` was given and `shift` or `axis` was a tf.Tensor [...]
>
> Fixes #24080
> ```
> </details>

That was the right issue. It took 43 seconds.

## It says so when there is no match

The retrieval step always returns *some* issue, even for a PR that has nothing
to do with any of them. So the bot checks its top picks one more time against
the diff and drops anything it can't tie to a concrete function, error or
behaviour.

| PR | Correct issue | What the bot said |
|---|---|---|
| [keras#24152](https://github.com/keras-team/keras/pull/24152) | #24080 | #24080, strong match |
| [keras#24251](https://github.com/keras-team/keras/pull/24251) | #24248 | #24248, strong match |
| [keras#24228](https://github.com/keras-team/keras/pull/24228) (CI config, no issue) | none | "No open issue clearly matches" |
| [gitlab-org/cli!4485](https://gitlab.com/gitlab-org/cli/-/merge_requests/4485) | #7865 | #7865, strong match |
| [gitlab-org/cli!4486](https://gitlab.com/gitlab-org/cli/-/merge_requests/4486) | #7887 | #7887, strong match |

Five PRs is a smoke test, not a benchmark. The paper's numbers (Hit@1 0.890)
come from 1,200 samples.

If the PR description already says `Fixes #n` or `Closes #n`, the bot skips
the search and just writes the commit message from that issue.

---

## GitHub Actions

**1.** Add repository secrets (Settings → Secrets and variables → Actions):

| Secret | Example |
|---|---|
| `CMG_API_KEY` | your API key |
| `CMG_MODEL` | `gpt-4.1-mini`, `deepseek-chat`, ... |
| `CMG_BASE_URL` | only if not OpenAI, e.g. `https://api.deepseek.com` |

**2.** Add `.github/workflows/issue-commit.yml`
([copy from here](../examples/github/issue-commit.yml)):

```yaml
name: Issue Commit
on:
  pull_request:
    types: [opened, ready_for_review, reopened]

permissions:
  contents: read
  issues: read
  pull-requests: write

jobs:
  suggest:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: Anonymous-Authors-CMG/CMG-Skills@v1
        with:
          api-key: ${{ secrets.CMG_API_KEY }}
          base-url: ${{ secrets.CMG_BASE_URL || 'https://api.openai.com/v1' }}
          model: ${{ secrets.CMG_MODEL }}
```

No checkout step is needed: the bot reads everything through the API.

### Inputs

| Input | Default | |
|---|---|---|
| `api-key` | *required* | OpenAI-compatible API key |
| `model` | *required* | model name |
| `base-url` | `https://api.openai.com/v1` | API base URL |
| `github-token` | `github.token` | needs `pull-requests: write`, `issues: read` |
| `pool-size` | `200` | open issues to consider, newest first |
| `min-confidence` | `medium` | `low` / `medium` / `high`; below this, no issue is suggested |
| `include-drafts` | `false` | also run on draft PRs |
| `dry-run` | `false` | write to the job summary only, no comment |
| `fail-on-error` | `false` | by default an error only warns and never blocks the PR |
| `pr-number` | | for `workflow_dispatch` or other non-PR events |

### Outputs

`status` (`ok` / `skipped` / `error`), `issue`, `verdict`
(`fixes` / `partial` / `linked`), `confidence`, `message`. For example, to add
a label when a likely issue is found:

```yaml
      - id: cmg
        uses: Anonymous-Authors-CMG/CMG-Skills@v1
        with: { api-key: ..., model: ... }
      - if: steps.cmg.outputs.issue != '' && steps.cmg.outputs.verdict == 'fixes'
        run: gh pr edit ${{ github.event.pull_request.number }} --add-label has-issue
        env: { GH_TOKEN: ${{ github.token }} }
```

### PRs from forks

On `pull_request`, PRs from forks get a read-only token and no secrets, so the
bot can't run. The usual fix is `pull_request_target`, which runs in the base
repository's context. That is safe here because this action never checks out
or runs the PR's code; it only reads the diff through the API. Don't add an
`actions/checkout` of the PR head to that workflow.

```yaml
on:
  pull_request_target:
    types: [opened, ready_for_review, reopened]
```

---

## GitLab CI

**1.** Create a project access token: Settings → Access tokens, role
**Reporter**, scope **api**.

**2.** Add CI/CD variables (Settings → CI/CD → Variables, tick *Mask*):

| Variable | Example |
|---|---|
| `CM_API_KEY` | your API key |
| `CM_LLM_MODEL` | `gpt-4.1-mini`, `deepseek-chat`, ... |
| `CM_BASE_URL` | only if not OpenAI |
| `GITLAB_TOKEN` | the project access token |

If the variables are *Protected*, they only reach pipelines on protected
branches, and MR pipelines from feature branches won't see them. Leave
*Protected* off, or protect the source branches.

**3.** Include the template in `.gitlab-ci.yml`:

```yaml
include:
  - remote: https://raw.githubusercontent.com/Anonymous-Authors-CMG/CMG-Skills/v1/ci/gitlab-ci.yml
```

That adds a job `issue-commit` in the `test` stage that runs only on merge
request pipelines, is `allow_failure: true`, and saves its result as an
artifact in `cmg/`. Override anything in your own file:

```yaml
issue-commit:
  stage: review
  variables:
    CMG_POOL_SIZE: "400"
    CMG_MIN_CONFIDENCE: high
```

Self-managed GitLab works the same; the API URL comes from `CI_API_V4_URL`. If
your runners can't reach github.com, mirror this repository internally and set
`CMG_REPO` to the mirror's clone URL.

---

## Try it without installing anything

Run it against any public PR or MR and print the comment instead of posting:

```bash
export CM_API_KEY=... CM_BASE_URL=... CM_LLM_MODEL=...
export GITHUB_TOKEN=...          # optional, avoids the 60 req/h limit

python3 skills/commit-message-from-issue/scripts/ci_review.py \
  --pr-url https://github.com/keras-team/keras/pull/24152 \
  --ignore-existing-links --dry-run
```

`--ignore-existing-links` hides the PR's own `Fixes #n` from the bot, which is
how the table above was produced. Any agent CLI works here too, e.g.
`CM_LLM_CMD=claude`.

## Cost

About 6 to 9 LLM calls per PR: `ceil(pool / 40)` short title-only calls, one
merge, one re-rank over five issue bodies, one or two checks, one message. With
a 200-issue pool that is roughly 60k to 100k input tokens. With `gpt-4.1-mini`
or `deepseek-chat` that's around one US cent per PR.

The default trigger (`opened`, `ready_for_review`, `reopened`) runs once per
PR. Adding `synchronize` reruns on every push, which keeps the message current
but costs more.

## What it sends where

- **To your model API:** the PR title, description (first 1,500 characters),
  diff (lock files and minified files dropped, capped at 12,000 characters),
  and the titles of open issues plus the bodies of at most five.
- **To GitHub or GitLab:** read the PR and issues, write one comment.

Nothing else. The diff is read through the API, so the PR's code is never
checked out or run.
