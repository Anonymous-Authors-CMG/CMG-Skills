#!/usr/bin/env python3
"""Build an offline test case from a real merged GitHub PR.

Reconstructs what the developer would have faced at commit time:
  - staged.diff      the PR's diff
  - candidates.json  open issues as of the merge commit, plus the gold issue

This is how examples/keras-9585 was produced. Use it to regenerate that fixture
or to build new ones for any public repo.

Requires GITHUB_TOKEN (the unauthenticated limit of 60 req/h is too low).

Usage
-----
  export GITHUB_TOKEN=ghp_...
  python3 fetch_case.py --repo keras-team/keras --pr 9585 \\
                        --gold 9538 --pool-size 60 --out-dir ../examples/keras-9585
"""
import argparse
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdil import MAX_BODY_CHARS, GITHUB_API, gh_get, log  # noqa: E402


def fetch_diff(repo, pr):
    url = "%s/repos/%s/pulls/%d" % (GITHUB_API, repo, pr)
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github.v3.diff",
        "User-Agent": "commit-message-from-issue-plugin",
    })
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read().decode("utf-8", "replace")


def fetch_pool(repo, before, limit, exclude_pr):
    """Issues that were still open when `before` happened, newest first.

    GitHub has no "open as of date" filter, so approximate it the way the paper's
    benchmark does: take issues created before the commit, and drop the ones that had
    already been closed by then.
    """
    out, page = [], 1
    while len(out) < limit and page <= 15:
        batch = gh_get("/repos/%s/issues" % repo, {
            "state": "all", "sort": "created", "direction": "desc",
            "per_page": 100, "page": page,
        })
        if not batch:
            break
        for item in batch:
            if "pull_request" in item or item["number"] == exclude_pr:
                continue
            if item["created_at"] >= before:
                continue
            closed = item.get("closed_at")
            if closed and closed < before:
                continue  # already closed before the commit
            out.append({
                "number": item["number"],
                "title": item.get("title") or "",
                "body": (item.get("body") or "")[:MAX_BODY_CHARS],
            })
            if len(out) >= limit:
                break
        page += 1
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True)
    ap.add_argument("--pr", type=int, required=True)
    ap.add_argument("--gold", type=int, nargs="*", default=[],
                    help="issue number(s) this PR fixes, for scoring the link")
    ap.add_argument("--pool-size", type=int, default=60)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    if not (os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")):
        log("warning: no GITHUB_TOKEN; you will likely hit the 60 req/h limit")

    pr = gh_get("/repos/%s/pulls/%d" % (args.repo, args.pr))
    merged_at = pr.get("merged_at") or pr["created_at"]
    log("PR #%d %r merged %s" % (args.pr, pr["title"][:60], merged_at))

    diff = fetch_diff(args.repo, args.pr)
    log("diff: %d chars" % len(diff))

    pool = fetch_pool(args.repo, merged_at, args.pool_size, args.pr)
    log("pool: %d issues open as of merge" % len(pool))

    # the gold issue must be present or the case is unscoreable
    have = {c["number"] for c in pool}
    for g in args.gold:
        if g in have:
            continue
        issue = gh_get("/repos/%s/issues/%d" % (args.repo, g))
        pool.append({"number": g, "title": issue.get("title") or "",
                     "body": (issue.get("body") or "")[:MAX_BODY_CHARS]})
        log("  injected gold issue #%d (was outside the sampled window)" % g)
    pool.sort(key=lambda c: c["number"])

    os.makedirs(args.out_dir, exist_ok=True)
    with open(os.path.join(args.out_dir, "staged.diff"), "w", encoding="utf-8") as fh:
        fh.write(diff)
    with open(os.path.join(args.out_dir, "candidates.json"), "w", encoding="utf-8") as fh:
        json.dump({
            "repo": args.repo,
            "pr_number": args.pr,
            "pr_title": pr["title"],
            "commit_datetime": merged_at,
            "gold_issue_numbers": args.gold,
            "candidate_pool": pool,
        }, fh, ensure_ascii=False, indent=2)
    log("wrote %s/{staged.diff,candidates.json}" % args.out_dir)


if __name__ == "__main__":
    main()
