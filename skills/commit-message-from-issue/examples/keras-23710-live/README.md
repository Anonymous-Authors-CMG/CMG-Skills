# Live validation case — keras-team/keras #23710

Unlike `../keras-9585/`, this case was produced with **no fixture**: a fresh
`--depth 50` clone of keras-team/keras, a hand-written fix staged with `git add`,
the repo slug inferred from the `origin` remote, and the 120-issue candidate pool
fetched from the GitHub API at runtime (`GITHUB_TOKEN` set).

- `staged.diff` — what `git diff --cached` produced
- `generated_message.txt` — the resulting commit message (What 4/4, Why 4/4)
- `run.json` — stage-by-stage trace

The change fixes open issue #23710: `OrbaxLazyModule.initialize` resolved
`parent_module.v1` inside a `try` that caught only `ImportError`, so an
`orbax.checkpoint` predating the v1 API let an `AttributeError` escape the
`available` property that every call site treats as a boolean.

Live mode has no gold label, so there is no HIT/MISS verdict — the link was
confirmed by hand. #23709, ranked 2nd, is a sibling bug in the same property in
the same file filed the same day; Stage 2 still ordered the correct one first.
