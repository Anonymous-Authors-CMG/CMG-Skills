#!/usr/bin/env python3
"""Progressive-disclosure diff -> issue link -> commit message.

Two-stage retrieval from "Reason Matters: Enhancing the Rationale of Generated
Commit Messages via Issue-Driven Skills":

  Stage 1 (coarse) — only issue TITLES are shown, in chunks, so a pool of
                     hundreds of issues costs a handful of small calls.
  Stage 2 (fine)   — only the Stage-1 survivors get their BODY expanded, and
                     the model re-ranks with full context.

Then the top-ranked issue is injected into the commit-message prompt as the
"Why" source. Ablations in the paper show this is the single biggest
lever on rationale quality (Why 2.547 -> 3.931 on a 0-4 rubric).

Usage
-----
  # from a real working tree with staged changes
  python3 link_and_write.py --repo owner/name

  # fully offline, from a saved fixture
  python3 link_and_write.py --diff-file staged.diff \
                            --candidates-file candidates.json \
                            --out run.json
"""
import argparse
import concurrent.futures
import json
import math
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdil import (  # noqa: E402
    FatalLLMError, describe_backend, extract_int_list, fetch_open_issues, fmt_full, fmt_titles,
    llm, load_prompt, log, render, truncate_diff,
)


def git(*args):
    proc = subprocess.run(["git", *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError("git %s failed: %s" % (" ".join(args), proc.stderr[:300]))
    return proc.stdout


def infer_repo_slug():
    """Parse owner/name out of the origin remote URL."""
    try:
        url = git("remote", "get-url", "origin").strip()
    except Exception:  # noqa: BLE001
        return None
    for prefix in ("git@github.com:", "https://github.com/", "ssh://git@github.com/",
                   "http://github.com/"):
        if url.startswith(prefix):
            slug = url[len(prefix):].rstrip("/")
            return slug[:-4] if slug.endswith(".git") else slug
    return None


# ------------------------------------------------------------------ stage 1

PARALLEL = int(os.environ.get("CM_PARALLEL", "4"))

def stage1_coarse(diff, candidates, top_n, chunk_size, trace):
    """Title-only chunked coarse ranking. Returns the merged Top-N numbers."""
    template = load_prompt("stage1_coarse.txt")
    chunks = [candidates[i:i + chunk_size]
              for i in range(0, len(candidates), chunk_size)]
    per_chunk = max(top_n, math.ceil(top_n * 1.5))
    picked = []

    log("stage 1: %d candidates -> %d chunk(s) of <=%d, keeping %d per chunk"
        % (len(candidates), len(chunks), chunk_size, per_chunk))

    def run_chunk(idx, chunk):
        prompt = render(template, top_n=per_chunk, diff=diff,
                        candidates=fmt_titles(chunk))
        started = time.time()
        try:
            raw = llm(prompt)
            valid = {c["number"] for c in chunk}
            got = [n for n in extract_int_list(raw) if n in valid][:per_chunk]
        except FatalLLMError:
            raise
        except Exception as exc:  # noqa: BLE001
            log("  chunk %d failed: %s" % (idx, str(exc)[:200]))
            raw, got = None, []
        elapsed = round(time.time() - started, 2)
        log("  chunk %d/%d -> %s (%.2fs)" % (idx + 1, len(chunks), got, elapsed))
        return {"stage": 1, "chunk": idx, "chunk_size": len(chunk),
                "picked": got, "elapsed_s": elapsed, "failed": raw is None,
                "raw": (raw or "")[:400]}

    # Chunks are independent, so scan them in parallel (paper, Sec. 6.3).
    workers = max(1, min(PARALLEL, len(chunks)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(lambda a: run_chunk(*a), enumerate(chunks)))
    for item in results:  # keep chunk order for a deterministic merge
        picked.extend(item["picked"])
        trace.append(item)
    if results and all(item["failed"] for item in results):
        raise RuntimeError("every Stage-1 call failed; check the LLM backend "
                           "with `python3 scripts/pdil.py --check`")

    # dedupe, preserving rank order
    seen, merged = set(), []
    for n in picked:
        if n not in seen:
            seen.add(n)
            merged.append(n)

    # a second coarse pass collapses cross-chunk winners down to top_n
    if len(merged) > top_n:
        by_num = {c["number"]: c for c in candidates}
        subset = [by_num[n] for n in merged if n in by_num]
        log("  merging %d cross-chunk winners -> top %d" % (len(merged), top_n))
        prompt = render(template, top_n=top_n, diff=diff,
                        candidates=fmt_titles(subset))
        started = time.time()
        try:
            raw = llm(prompt)
            ranked = [n for n in extract_int_list(raw) if n in seen]
            ranked += [n for n in merged if n not in ranked]
            merged = ranked
            trace.append({"stage": 1, "step": "merge", "ranked": merged[:top_n],
                          "elapsed_s": round(time.time() - started, 2)})
        except Exception as exc:  # noqa: BLE001
            log("  merge rerank failed, keeping chunk order: %s" % str(exc)[:200])

    return merged[:top_n]


# ------------------------------------------------------------------ stage 2

def stage2_fine(diff, candidates, top_nums, trace):
    """Expand only the survivors' bodies and re-rank."""
    by_num = {c["number"]: c for c in candidates}
    subset = [by_num[n] for n in top_nums if n in by_num]
    if not subset:
        return []
    log("stage 2: expanding title+body for %d candidate(s): %s"
        % (len(subset), [c["number"] for c in subset]))

    prompt = render(load_prompt("stage2_fine.txt"), diff=diff,
                    candidates=fmt_full(subset))
    started = time.time()
    given = [c["number"] for c in subset]
    try:
        raw = llm(prompt)
        ranked = [n for n in extract_int_list(raw) if n in set(given)]
        ranked += [n for n in given if n not in ranked]
    except Exception as exc:  # noqa: BLE001
        log("  stage 2 failed, keeping stage-1 order: %s" % str(exc)[:200])
        raw, ranked = "", given
    elapsed = round(time.time() - started, 2)
    trace.append({"stage": 2, "ranked": ranked, "elapsed_s": elapsed,
                  "raw": raw[:400]})
    log("  final ranking: %s (%.2fs)" % (ranked, elapsed))
    return ranked


# ------------------------------------------------------------------ message

def build_issue_report(candidates, numbers):
    by_num = {c["number"]: c for c in candidates}
    parts = []
    for n in numbers:
        c = by_num.get(n)
        if not c:
            continue
        parts.append("Issue #%s: %s\n%s"
                     % (n, (c.get("title") or "").strip(),
                        (c.get("body") or "").strip()))
    return "\n\n".join(parts) if parts else "(no related issue)"


def clean_message(text):
    """Strip code fences and chatty preambles the CLI may wrap around the message."""
    lines = [ln for ln in text.strip().splitlines()
             if not ln.strip().startswith("```")]
    while lines and not lines[0].strip():
        lines.pop(0)
    # drop a leading "Here is the commit message:"-style line
    if lines and lines[0].rstrip().endswith(":") and len(lines[0]) < 80:
        lines.pop(0)
        while lines and not lines[0].strip():
            lines.pop(0)
    return "\n".join(lines).rstrip() + "\n"


def write_commit_message(diff, issue_report, trace):
    prompt = render(load_prompt("commit_message.txt"), diff=diff,
                    type_defs=load_prompt("type_defs.txt"),
                    issue_report=issue_report)
    log("writing commit message (issue-grounded)")
    started = time.time()
    msg = clean_message(llm(prompt))
    trace.append({"stage": "message", "elapsed_s": round(time.time() - started, 2),
                  "chars": len(msg)})
    return msg


# ------------------------------------------------------------------ main

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", help="owner/name; inferred from origin when omitted")
    ap.add_argument("--diff-file", help="read the diff from a file instead of git")
    ap.add_argument("--candidates-file",
                    help="JSON file with candidates (offline mode; skips GitHub)")
    ap.add_argument("--pool-size", type=int, default=120,
                    help="how many open issues to pull as candidates (default 120)")
    ap.add_argument("--top-n", type=int, default=5,
                    help="stage 1 -> stage 2 survivors (default 5)")
    ap.add_argument("--chunk-size", type=int, default=40,
                    help="candidates per coarse chunk (default 40)")
    ap.add_argument("--out", help="write the full run record as JSON here")
    ap.add_argument("--message-out", help="write just the commit message here")
    args = ap.parse_args()

    log("llm backend: %s" % describe_backend())

    # ---- diff
    if args.diff_file:
        with open(args.diff_file, encoding="utf-8") as fh:
            diff_raw = fh.read()
    else:
        diff_raw = git("diff", "--cached")
        if not diff_raw.strip():
            log("no staged changes; falling back to the unstaged working diff")
            diff_raw = git("diff")
        if not diff_raw.strip():
            sys.exit("nothing to describe: no staged or unstaged changes")
    diff, truncated = truncate_diff(diff_raw)
    log("diff: %d chars%s" % (len(diff_raw), " (truncated)" if truncated else ""))

    # ---- candidates
    gold = []
    if args.candidates_file:
        with open(args.candidates_file, encoding="utf-8") as fh:
            payload = json.load(fh)
        if isinstance(payload, list):
            candidates = payload
        else:
            candidates = payload["candidate_pool"]
            gold = payload.get("gold_issue_numbers") or []
        log("candidates: %d loaded from %s" % (len(candidates), args.candidates_file))
    else:
        repo = args.repo or infer_repo_slug()
        if not repo:
            sys.exit("--repo is required (could not infer from git origin)")
        log("fetching open issues from %s ..." % repo)
        candidates = fetch_open_issues(repo, limit=args.pool_size)
        log("candidates: %d open issues" % len(candidates))
    if not candidates:
        sys.exit("candidate pool is empty")

    # ---- pipeline
    trace = []
    t0 = time.time()
    top_nums = stage1_coarse(diff, candidates, args.top_n, args.chunk_size, trace)
    ranked = stage2_fine(diff, candidates, top_nums, trace)
    linked = ranked[:1]
    issue_report = build_issue_report(candidates, linked)
    message = write_commit_message(diff, issue_report, trace)
    total = round(time.time() - t0, 2)

    by_num = {c["number"]: c for c in candidates}
    record = {
        "llm_backend": describe_backend(),
        "diff_chars": len(diff_raw),
        "diff_truncated": truncated,
        "pool_size": len(candidates),
        "top_n": args.top_n,
        "chunk_size": args.chunk_size,
        "stage1_top": top_nums,
        "stage2_ranked": ranked,
        "linked_issues": linked,
        "linked_titles": [by_num[n]["title"] for n in linked if n in by_num],
        "gold_issue_numbers": gold,
        "hit_at_1": (bool(gold) and bool(ranked) and ranked[0] in gold) or None,
        "commit_message": message,
        "total_elapsed_s": total,
        "trace": trace,
    }

    print("\n" + "=" * 72)
    if gold:
        verdict = "HIT" if record["hit_at_1"] else "MISS"
        print("gold issue %s | ranked #1 = %s -> %s"
              % (gold, ranked[0] if ranked else None, verdict))
    for n in linked:
        print("linked issue #%s: %s" % (n, by_num.get(n, {}).get("title", "?")))
    print("=" * 72 + "\n")
    print(message)

    if args.message_out:
        with open(args.message_out, "w", encoding="utf-8") as fh:
            fh.write(message)
        log("commit message -> %s" % args.message_out)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(record, fh, ensure_ascii=False, indent=2)
        log("run record -> %s" % args.out)


if __name__ == "__main__":
    main()
