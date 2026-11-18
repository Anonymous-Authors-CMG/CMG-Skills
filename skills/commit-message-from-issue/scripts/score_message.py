#!/usr/bin/env python3
"""Score a commit message on What / Why, 0-4, LLM-as-judge.

Uses the same few-shot-CoT rubric as the paper (prompts/judge_what_why.txt), so
scores here are comparable to its context ablation (Table 4, DeepSeek-V4-Pro
judge, n=3600 messages per variant; see references/results.md):

    variant       What    Why
    diff only     3.780   2.547
    + exemplars   3.903   3.752
    + issue       3.918   3.931     <- what this skill does
    full          3.921   3.906

So a message produced by this plugin should land near What>=3.5, Why>=3.5.
Why < 3 means the rationale did not make it into the message — usually the link
stage missed, or the issue body was empty.

Usage
-----
  python3 score_message.py --diff-file staged.diff --message-file msg.txt
  python3 score_message.py --run-file run.json --diff-file staged.diff
  git log -1 --format=%B | python3 score_message.py --diff-file d.diff --message-file -
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pdil import (  # noqa: E402
    describe_backend, extract_json_object, llm, load_prompt, log, render, truncate_diff,
)

DIFF_CAP = 24000  # the judge sees more of the diff than the generator did


def parse_scores(raw):
    """Pull What/Why out of the judge reply; regex fallback for messy JSON."""
    obj = extract_json_object(raw)
    if isinstance(obj, dict) and "What" in obj:
        return _as_int(obj.get("What")), _as_int(obj.get("Why")), obj.get("Reason", "")
    what = re.findall(r'"What"\s*:\s*"?([0-4])', raw)
    why = re.findall(r'"Why"\s*:\s*"?([0-4])', raw)
    reason = re.search(r'"Reason"\s*:\s*"(.*?)"\s*,', raw, re.DOTALL)
    if what and why:
        return int(what[-1]), int(why[-1]), reason.group(1) if reason else ""
    return None, None, ""


def _as_int(value):
    try:
        return int(round(float(value)))
    except Exception:  # noqa: BLE001
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--diff-file", required=True)
    ap.add_argument("--message-file", help="commit message file, or - for stdin")
    ap.add_argument("--run-file", help="run.json from link_and_write.py")
    ap.add_argument("--out", help="write the score record as JSON here")
    args = ap.parse_args()

    if args.message_file == "-":
        message = sys.stdin.read()
    elif args.message_file:
        with open(args.message_file, encoding="utf-8") as fh:
            message = fh.read()
    elif args.run_file:
        with open(args.run_file, encoding="utf-8") as fh:
            message = json.load(fh)["commit_message"]
    else:
        sys.exit("need --message-file or --run-file")

    with open(args.diff_file, encoding="utf-8") as fh:
        diff, _ = truncate_diff(fh.read(), cap=DIFF_CAP)

    log("judging with %s (0-4 What/Why rubric)"
        % describe_backend())
    raw = llm(render(load_prompt("judge_what_why.txt"), diff=diff, message=message))
    what, why, reason = parse_scores(raw)
    if what is None:
        log("could not parse judge output:\n" + raw[:800])
        sys.exit(1)

    print("What: %d/4   Why: %d/4" % (what, why))
    if reason:
        print("\nReason: %s" % reason.strip()[:1200])
    print("\nReference (paper, Table 4): diff-only What 3.780 / Why 2.547  ->  "
          "issue-grounded What 3.918 / Why 3.931")
    if why is not None and why < 3:
        print("\nWhy < 3: the rationale is thin. Check whether the link stage "
              "actually found the right issue (stage2_ranked in run.json).")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump({"what_score": what, "why_score": why, "reason": reason,
                       "judge_backend": describe_backend(), "raw": raw[:4000]},
                      fh, ensure_ascii=False, indent=2)
        log("scores -> %s" % args.out)


if __name__ == "__main__":
    main()
