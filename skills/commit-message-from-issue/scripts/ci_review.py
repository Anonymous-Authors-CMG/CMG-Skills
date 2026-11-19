#!/usr/bin/env python3
"""Review a pull / merge request: find the open issue it addresses, check the
link, and post one comment with the suggestion and a squash commit message.

Runs in GitHub Actions, GitLab CI, or locally against any public PR / MR:

  # inside CI: everything comes from the CI environment
  python3 ci_review.py

  # locally, print the comment instead of posting it
  python3 ci_review.py --pr-url https://github.com/owner/repo/pull/123 --dry-run
  python3 ci_review.py --pr-url https://gitlab.com/group/proj/-/merge_requests/45 --dry-run

The comment is updated in place on later runs (it carries a hidden marker), so
re-running on every push never piles up comments. Nothing else is changed: the
PR description, labels and issues are left alone.

Environment
-----------
LLM:       same as the skill (CM_API_KEY / CM_BASE_URL / CM_LLM_MODEL, or CM_LLM_CMD)
GitHub:    GITHUB_TOKEN (pull-requests: write, issues: read)
GitLab:    GITLAB_TOKEN (project access token, `api` scope, Reporter role or higher)
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdil import (  # noqa: E402
    MAX_BODY_CHARS, describe_backend, extract_json_object, llm, load_prompt, log,
    render, truncate_diff,
)
from link_and_write import (  # noqa: E402
    build_issue_report, stage1_coarse, stage2_fine, write_commit_message,
)

MARKER = "<!-- cmg-skills:issue-commit -->"
UA = "cmg-skills-ci"

# Diff sections that carry no rationale and eat the context budget.
NOISE_PATHS = re.compile(
    r"(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock"
    r"|go\.sum|Gemfile\.lock|composer\.lock|uv\.lock)$|\.min\.(js|css)$|(^|/)dist/")

CLOSING = re.compile(
    r"(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|implement(?:s|ed)?)"
    r"\s*:?\s+(?:[\w.-]+/[\w.-]+)?#(\d+)\b")


# ====================================================================== HTTP

def http(method, url, token=None, auth="bearer", body=None, accept=None):
    headers = {"User-Agent": UA}
    if accept:
        headers["Accept"] = accept
    if token:
        if auth == "gitlab":
            headers["PRIVATE-TOKEN"] = token
        else:
            headers["Authorization"] = "Bearer " + token
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8", "replace")
            ctype = resp.headers.get("Content-Type", "")
            return json.loads(raw) if "json" in ctype and raw else raw
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise RuntimeError("%s %s -> HTTP %d: %s" % (method, url, exc.code, detail)) from exc


# ================================================================ platforms

class GitHub:
    kind = "github"
    noun = "PR"

    def __init__(self, repo, number, api=None, token=None):
        self.repo, self.number = repo, int(number)
        self.api = (api or "https://api.github.com").rstrip("/")
        self.token = token
        self.ref = "#"

    def _get(self, path, params=None, accept="application/vnd.github+json"):
        url = "%s/repos/%s%s" % (self.api, self.repo, path)
        if params:
            url += "?" + urllib.parse.urlencode(params)
        return http("GET", url, self.token, accept=accept)

    def change(self):
        pr = self._get("/pulls/%d" % self.number)
        return {
            "title": pr.get("title") or "",
            "body": pr.get("body") or "",
            "draft": bool(pr.get("draft")),
            "author_is_bot": (pr.get("user") or {}).get("type") == "Bot",
            "url": pr.get("html_url"),
            "state": pr.get("state"),
        }

    def diff(self):
        try:
            return self._get("/pulls/%d" % self.number,
                             accept="application/vnd.github.v3.diff")
        except RuntimeError as exc:
            # Very large PRs refuse the diff media type; rebuild from patches.
            log("  full diff unavailable (%s); using per-file patches" % str(exc)[:80])
            parts = []
            for page in range(1, 4):
                files = self._get("/pulls/%d/files" % self.number,
                                  {"per_page": 100, "page": page})
                if not files:
                    break
                for f in files:
                    name = f["filename"]
                    parts.append("diff --git a/%s b/%s\n--- a/%s\n+++ b/%s\n%s\n"
                                 % (name, name, name, name, f.get("patch") or ""))
            return "".join(parts)

    def open_issues(self, limit):
        out, page = [], 1
        while len(out) < limit and page <= 10:
            batch = self._get("/issues", {"state": "open", "sort": "created",
                                          "direction": "desc", "per_page": 100,
                                          "page": page})
            if not batch:
                break
            for it in batch:
                if "pull_request" not in it:
                    out.append(_issue(it["number"], it.get("title"), it.get("body"),
                                      it.get("html_url")))
            page += 1
        return out[:limit]

    def issue(self, number):
        it = self._get("/issues/%d" % number)
        return _issue(it["number"], it.get("title"), it.get("body"), it.get("html_url"))

    def upsert_comment(self, text):
        base = "%s/repos/%s/issues" % (self.api, self.repo)
        for page in range(1, 6):
            comments = http("GET", "%s/%d/comments?per_page=100&page=%d"
                            % (base, self.number, page), self.token)
            if not comments:
                break
            for c in comments:
                if MARKER in (c.get("body") or ""):
                    http("PATCH", "%s/comments/%d" % (base, c["id"]), self.token,
                         body={"body": text})
                    return "updated"
        http("POST", "%s/%d/comments" % (base, self.number), self.token,
             body={"body": text})
        return "created"


class GitLab:
    kind = "gitlab"
    noun = "merge request"

    def __init__(self, project, iid, api=None, token=None):
        self.project = str(project)
        self.pid = urllib.parse.quote(self.project, safe="")
        self.iid = int(iid)
        self.api = (api or "https://gitlab.com/api/v4").rstrip("/")
        self.token = token
        self.ref = "#"

    def _url(self, path, params=None):
        url = "%s/projects/%s%s" % (self.api, self.pid, path)
        if params:
            url += "?" + urllib.parse.urlencode(params)
        return url

    def _get(self, path, params=None):
        return http("GET", self._url(path, params), self.token, auth="gitlab")

    def change(self):
        mr = self._get("/merge_requests/%d" % self.iid)
        return {
            "title": mr.get("title") or "",
            "body": mr.get("description") or "",
            "draft": bool(mr.get("draft") or mr.get("work_in_progress")),
            "author_is_bot": bool((mr.get("author") or {}).get("bot")),
            "url": mr.get("web_url"),
            "state": mr.get("state"),
        }

    def diff(self):
        parts = []
        for page in range(1, 6):
            files = self._get("/merge_requests/%d/diffs" % self.iid,
                              {"per_page": 100, "page": page})
            if not files:
                break
            for f in files:
                parts.append("diff --git a/%s b/%s\n--- a/%s\n+++ b/%s\n%s\n"
                             % (f["old_path"], f["new_path"], f["old_path"],
                                f["new_path"], f.get("diff") or ""))
            if len(files) < 100:
                break
        return "".join(parts)

    def open_issues(self, limit):
        out, page = [], 1
        while len(out) < limit and page <= 10:
            batch = self._get("/issues", {"state": "opened", "order_by": "created_at",
                                          "sort": "desc", "per_page": 100,
                                          "page": page})
            if not batch:
                break
            out += [_issue(it["iid"], it.get("title"), it.get("description"),
                           it.get("web_url")) for it in batch]
            page += 1
        return out[:limit]

    def issue(self, number):
        it = self._get("/issues/%d" % number)
        return _issue(it["iid"], it.get("title"), it.get("description"), it.get("web_url"))

    def upsert_comment(self, text):
        path = "/merge_requests/%d/notes" % self.iid
        for page in range(1, 6):
            notes = self._get(path, {"per_page": 100, "page": page,
                                     "sort": "asc", "order_by": "created_at"})
            if not notes:
                break
            for n in notes:
                if MARKER in (n.get("body") or ""):
                    http("PUT", self._url("%s/%d" % (path, n["id"])), self.token,
                         auth="gitlab", body={"body": text})
                    return "updated"
        http("POST", self._url(path), self.token, auth="gitlab", body={"body": text})
        return "created"


def _issue(number, title, body, url):
    return {"number": int(number), "title": (title or "").strip(),
            "body": (body or "")[:MAX_BODY_CHARS], "url": url}


def platform_from_url(url):
    m = re.match(r"https?://([^/]+)/(.+?)/pull/(\d+)", url)
    if m and "gitlab" not in m.group(1):
        host = m.group(1)
        api = "https://api.github.com" if host == "github.com" else "https://%s/api/v3" % host
        return GitHub(m.group(2), m.group(3), api,
                      os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN"))
    m = re.match(r"https?://([^/]+)/(.+?)/-/merge_requests/(\d+)", url)
    if m:
        return GitLab(m.group(2), m.group(3), "https://%s/api/v4" % m.group(1),
                      os.environ.get("GITLAB_TOKEN"))
    sys.exit("unrecognised PR/MR URL: %s" % url)


def platform_from_ci():
    if os.environ.get("GITHUB_ACTIONS") == "true":
        with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as fh:
            event = json.load(fh)
        pr = event.get("pull_request") or {}
        number = os.environ.get("CMG_PR_NUMBER") or pr.get("number") or \
            (event.get("issue") or {}).get("number")
        if not number:
            return None
        return GitHub(os.environ["GITHUB_REPOSITORY"], number,
                      os.environ.get("GITHUB_API_URL"), os.environ.get("GITHUB_TOKEN"))
    if os.environ.get("GITLAB_CI") == "true":
        iid = os.environ.get("CI_MERGE_REQUEST_IID")
        if not iid:
            return None
        return GitLab(os.environ["CI_PROJECT_ID"], iid, os.environ.get("CI_API_V4_URL"),
                      os.environ.get("GITLAB_TOKEN"))
    return None


# ================================================================== pipeline

def strip_noise(diff):
    sections = re.split(r"(?m)^(?=diff --git )", diff)
    kept, dropped = [], []
    for sec in sections:
        m = re.match(r"diff --git a/(\S+) b/(\S+)", sec)
        if m and NOISE_PATHS.search(m.group(2)):
            dropped.append(m.group(2))
        else:
            kept.append(sec)
    return "".join(kept), dropped


def scrub_refs(text):
    """Remove issue references (used by --ignore-existing-links for testing)."""
    text = CLOSING.sub("", text)
    text = re.sub(r"https?://\S+/(?:-/)?issues/\d+", "", text)
    return re.sub(r"(?<![\w&])#\d+\b", "", text)


def change_context(change, diff, scrub=False):
    body = change["body"].strip()
    if scrub:
        body = scrub_refs(body)
    body = body[:1500]
    head = "PR title: %s\n" % change["title"]
    if body:
        head += "PR description:\n%s\n" % body
    return head + "\n" + diff


def verify(context, issue):
    raw = llm(render(load_prompt("verify_link.txt"), change=context,
                     number=issue["number"], title=issue["title"],
                     body=issue["body"] or "(empty)"))
    data = extract_json_object(raw) or {}
    verdict = str(data.get("verdict", "unrelated")).lower()
    if verdict not in ("fixes", "partial", "unrelated"):
        verdict = "unrelated"
    confidence = str(data.get("confidence", "low")).lower()
    if confidence not in ("high", "medium", "low"):
        confidence = "low"
    return {"verdict": verdict, "confidence": confidence,
            "reason": str(data.get("reason", "")).strip()}


def fix_trailers(message, issue, verdict):
    """Keep exactly one trailer, and only for an accepted issue."""
    lines = [ln for ln in message.rstrip().splitlines()
             if not re.match(r"(?i)^\s*(fixes|closes|resolves|refs)\s+#\d+\s*$", ln)]
    while lines and not lines[-1].strip():
        lines.pop()
    if issue and verdict in ("fixes", "partial", "linked"):
        word = "Refs" if verdict == "partial" else "Fixes"
        lines += ["", "%s #%d" % (word, issue["number"])]
    return "\n".join(lines) + "\n"


CONF_ORDER = {"low": 0, "medium": 1, "high": 2}


def run(platform, args):
    t0 = time.time()
    change = platform.change()
    result = {"platform": platform.kind, "url": change["url"], "backend": describe_backend()}

    if change["state"] not in ("open", "opened") and not args.include_closed:
        return dict(result, status="skipped", why="not open")
    if change["draft"] and not args.include_drafts:
        return dict(result, status="skipped", why="draft")
    if change["author_is_bot"] and not args.include_bots:
        return dict(result, status="skipped", why="opened by a bot")

    raw_diff = platform.diff()
    diff, dropped = strip_noise(raw_diff)
    if not diff.strip():
        return dict(result, status="skipped", why="empty diff")
    diff, truncated = truncate_diff(diff)
    log("diff: %d chars%s, %d noise file(s) dropped"
        % (len(raw_diff), " (truncated)" if truncated else "", len(dropped)))

    existing = [] if args.ignore_existing_links else \
        sorted({int(n) for n in CLOSING.findall(change["body"])})
    context = change_context(change, diff, scrub=args.ignore_existing_links)
    trace, ranked, candidates = [], [], []

    if existing:
        log("description already references %s; using it" % existing)
        issue = platform.issue(existing[0])
        check = {"verdict": "linked", "confidence": "high",
                 "reason": "Referenced in the description."}
        mode = "already-linked"
    else:
        candidates = platform.open_issues(args.pool_size)
        log("candidates: %d open issues" % len(candidates))
        issue, check, mode = None, None, "retrieved"
        if candidates:
            top = stage1_coarse(context, candidates, args.top_n, args.chunk_size, trace)
            ranked = stage2_fine(context, candidates, top, trace)
            by_num = {c["number"]: c for c in candidates}
            # The retriever always returns something; let the checker reject it.
            for n in ranked[:args.verify]:
                c = by_num[n]
                v = verify(context, c)
                log("  verify #%d -> %s / %s" % (n, v["verdict"], v["confidence"]))
                trace.append({"stage": "verify", "issue": n, **v})
                if v["verdict"] != "unrelated" and \
                        CONF_ORDER[v["confidence"]] >= CONF_ORDER[args.min_confidence]:
                    issue, check = c, v
                    break
        if not issue:
            mode = "no-match"

    message = write_commit_message(
        context, build_issue_report([issue], [issue["number"]]) if issue else
        "(no related issue)", trace)
    message = fix_trailers(message, issue, check["verdict"] if check else None)

    by_num = {c["number"]: c for c in candidates}
    others = [by_num[n] for n in ranked if n in by_num and
              (not issue or n != issue["number"])][:4]
    return dict(result, status="ok", mode=mode, issue=issue, check=check,
                others=others, message=message, dropped=dropped,
                elapsed_s=round(time.time() - t0, 1), trace=trace)


# ================================================================== comment

def render_comment(res, platform):
    ref, noun = platform.ref, platform.noun
    issue, check = res.get("issue"), res.get("check")
    out = [MARKER, "### Issue Commit", ""]

    if res["mode"] == "already-linked":
        out += ["This %s already references %s%d, **%s**. Here is a squash commit "
                "message grounded in that issue." % (noun, ref, issue["number"], issue["title"]), ""]
    elif issue:
        strength = {"high": "Strong match", "medium": "Likely match",
                    "low": "Weak match"}[check["confidence"]]
        what = "may only partly address" if check["verdict"] == "partial" else "looks like it addresses"
        out += ["This %s %s **[%s%d](%s) %s**" % (noun, what, ref, issue["number"],
                                                 issue.get("url") or "", issue["title"]),
                "", "> %s · %s" % (strength, check["reason"] or "no reason given"), ""]
        keyword = "Refs" if check["verdict"] == "partial" else "Fixes"
        out += ["If that's right, add `%s %s%d` to the description%s." % (
            keyword, ref, issue["number"],
            "" if keyword == "Refs" else " so the issue closes on merge"), ""]
    else:
        out += ["No open issue clearly matches this change, so the message "
                "below explains the change from the diff alone.", ""]

    out += ["<details open><summary><b>Suggested squash commit message</b></summary>",
            "", "```text", res["message"].rstrip(), "```", "", "</details>", ""]

    if res.get("others"):
        out += ["<details><summary>Other candidates considered</summary>", ""]
        out += ["- %s%d %s" % (ref, c["number"], c["title"]) for c in res["others"]]
        out += ["", "</details>", ""]

    out += ["<sub>Generated by [CMG-Skills](https://github.com/Anonymous-Authors-CMG/CMG-Skills) "
            "in %ss. The issue is found automatically and is wrong about one time in ten, "
            "so please check it. Nothing in this %s was changed.</sub>" % (res["elapsed_s"], noun)]
    return "\n".join(out) + "\n"


def emit_outputs(res, comment):
    out_dir = os.environ.get("CMG_OUTPUT_DIR") or "."
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "cmg-review.json"), "w", encoding="utf-8") as fh:
        json.dump(res, fh, ensure_ascii=False, indent=2)
    if comment:
        with open(os.path.join(out_dir, "cmg-review.md"), "w", encoding="utf-8") as fh:
            fh.write(comment)
    if os.environ.get("GITHUB_STEP_SUMMARY") and comment:
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(comment.replace(MARKER, ""))
    if os.environ.get("GITHUB_OUTPUT"):
        issue, check = res.get("issue") or {}, res.get("check") or {}
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as fh:
            fh.write("status=%s\n" % res.get("status", ""))
            fh.write("issue=%s\n" % (issue.get("number") or ""))
            fh.write("verdict=%s\n" % (check.get("verdict") or ""))
            fh.write("confidence=%s\n" % (check.get("confidence") or ""))
            fh.write("message<<CMG_EOF\n%sCMG_EOF\n" % (res.get("message") or ""))


# ===================================================================== main

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pr-url", help="GitHub PR or GitLab MR URL (default: from CI env)")
    ap.add_argument("--dry-run", action="store_true", help="print the comment, don't post")
    ap.add_argument("--pool-size", type=int, default=int(os.environ.get("CMG_POOL_SIZE", 200)))
    ap.add_argument("--top-n", type=int, default=int(os.environ.get("CMG_TOP_N", 5)))
    ap.add_argument("--chunk-size", type=int, default=int(os.environ.get("CMG_CHUNK_SIZE", 40)))
    ap.add_argument("--verify", type=int, default=int(os.environ.get("CMG_VERIFY", 2)),
                    help="how many top-ranked issues to check before giving up (default 2)")
    ap.add_argument("--min-confidence", choices=["low", "medium", "high"],
                    default=os.environ.get("CMG_MIN_CONFIDENCE", "medium"))
    ap.add_argument("--include-drafts", action="store_true")
    ap.add_argument("--include-bots", action="store_true")
    ap.add_argument("--include-closed", action="store_true")
    ap.add_argument("--ignore-existing-links", action="store_true",
                    help="retrieve even if the description already references an issue "
                         "(for testing the retriever on real PRs)")
    ap.add_argument("--fail-on-error", action="store_true",
                    default=os.environ.get("CMG_FAIL_ON_ERROR") == "true")
    args = ap.parse_args()

    platform = platform_from_url(args.pr_url) if args.pr_url else platform_from_ci()
    if platform is None:
        log("not a pull/merge request event; nothing to do")
        return
    log("llm backend: %s" % describe_backend())

    try:
        res = run(platform, args)
    except Exception as exc:  # noqa: BLE001 - never block a PR on a bot error
        msg = "Issue Commit failed: %s" % str(exc)[:500]
        if os.environ.get("GITHUB_ACTIONS"):
            print("::warning::%s" % msg)
        log(msg)
        emit_outputs({"status": "error", "error": str(exc)}, None)
        sys.exit(1 if args.fail_on_error else 0)

    if res["status"] != "ok":
        log("skipped: %s" % res["why"])
        emit_outputs(res, None)
        return

    comment = render_comment(res, platform)
    emit_outputs(res, comment)
    if args.dry_run:
        print(comment)
        return
    if not platform.token:
        sys.exit("no %s token: set %s, or use --dry-run"
                 % (platform.kind, "GITHUB_TOKEN" if platform.kind == "github" else "GITLAB_TOKEN"))
    try:
        log("comment %s" % platform.upsert_comment(comment))
    except RuntimeError as exc:
        if "HTTP 403" not in str(exc) and "HTTP 404" not in str(exc):
            raise
        # Typical for PRs from forks: the default token is read-only there.
        hint = ("could not comment (%s). For PRs from forks, run the workflow on "
                "`pull_request_target`; the result is in the job summary."
                % str(exc)[:120])
        if os.environ.get("GITHUB_ACTIONS"):
            print("::warning::%s" % hint)
        log(hint)


if __name__ == "__main__":
    main()
