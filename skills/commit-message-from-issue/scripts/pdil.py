"""Shared helpers for the progressive diff<->issue-link commit-message skill.

Everything here is stdlib-only so the scripts run in any Python 3.9+ without a
virtualenv.

LLM backend resolution (first match wins):

  1. CM_LLM_CMD set            -> that agent CLI, one-shot mode
  2. CM_API_KEY set            -> OpenAI-compatible HTTP API
                                  base URL: CM_BASE_URL (or OPENAI_BASE_URL)
                                  model:    CM_LLM_MODEL (required)
  3. running inside an agent   -> the same agent's CLI
     (CLAUDECODE, CODEX_*, ...)
  4. OPENAI_API_KEY + a model  -> OpenAI-compatible HTTP API
     (CM_LLM_MODEL/OPENAI_MODEL)
  5. first agent CLI on PATH   -> claude, codex, gemini, codebuddy,
                                  cursor-agent, opencode

Run `python3 scripts/pdil.py --check` to see which one was picked.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ---------------------------------------------------------------- LLM backend

LLM_TIMEOUT = int(os.environ.get("CM_LLM_TIMEOUT", "600"))
LLM_RETRIES = int(os.environ.get("CM_LLM_RETRIES", "2"))
LLM_MODEL = os.environ.get("CM_LLM_MODEL", "")  # empty = backend default

# Agent CLIs disagree on how to take a one-shot prompt. Keyed by basename.
#   argv:   how to build the command line
#   clean:  backend-specific output post-processing
ADAPTERS = {
    "claude": {"argv": lambda p, m: (["claude", "-p"]
                                     + (["--model", m] if m else []) + [p])},
    # `codex -p` does not exist; the non-interactive subcommand is `exec`.
    # --skip-git-repo-check so it runs outside a repo too.
    "codex": {"argv": lambda p, m: (["codex", "exec", "--skip-git-repo-check"]
                                    + (["--model", m] if m else []) + [p]),
              "clean": "codex"},
    "gemini": {"argv": lambda p, m: (["gemini"] + (["-m", m] if m else [])
                                     + ["-p", p])},
    "codebuddy": {"argv": lambda p, m: (["codebuddy", "-p", p]
                                        + (["--model", m] if m else []))},
    "cursor-agent": {"argv": lambda p, m: (["cursor-agent", "-p",
                                            "--output-format", "text"]
                                           + (["--model", m] if m else []) + [p])},
    "opencode": {"argv": lambda p, m: (["opencode", "run"]
                                       + (["--model", m] if m else []) + [p])},
}

# Probe order when nothing is configured.
CLI_PROBE_ORDER = ["claude", "codex", "gemini", "codebuddy", "cursor-agent",
                   "opencode"]

# Environment markers set by agents for the commands they spawn, so a skill
# running inside Claude Code calls `claude -p`, inside Codex calls `codex exec`.
HOST_MARKERS = [
    ("CLAUDECODE", "claude"),
    ("CODEX_SANDBOX", "codex"),
    ("CODEX_MANAGED_BY_NPM", "codex"),
    ("GEMINI_CLI", "gemini"),
    ("CODEBUDDY", "codebuddy"),
]


def _resolve_backend():
    """Return (kind, cli_cmd, reason). kind is "cli", "http" or None."""
    cmd = os.environ.get("CM_LLM_CMD", "").strip()
    if cmd:
        return "cli", cmd, "CM_LLM_CMD"
    if os.environ.get("CM_API_KEY"):
        return "http", None, "CM_API_KEY"
    for var, name in HOST_MARKERS:
        if os.environ.get(var) and shutil.which(name):
            return "cli", name, "running inside %s ($%s)" % (name, var)
    # A generic OPENAI_API_KEY is often set for unrelated tools, so only use it
    # when a model was named explicitly as well.
    if os.environ.get("OPENAI_API_KEY") and (os.environ.get("CM_LLM_MODEL")
                                             or os.environ.get("OPENAI_MODEL")):
        return "http", None, "OPENAI_API_KEY + model"
    for name in CLI_PROBE_ORDER:
        if shutil.which(name):
            return "cli", name, "found on PATH"
    return None, None, "nothing configured"


BACKEND, LLM_CMD, BACKEND_REASON = _resolve_backend()

HTTP_BASE_URL = (os.environ.get("CM_BASE_URL") or os.environ.get("OPENAI_BASE_URL")
                 or "https://api.openai.com/v1")
HTTP_API_KEY = os.environ.get("CM_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
if BACKEND == "http" and not LLM_MODEL:
    LLM_MODEL = os.environ.get("OPENAI_MODEL", "")


def describe_backend():
    if BACKEND == "http":
        return "http %s model=%s (%s)" % (_chat_url(), LLM_MODEL or "?", BACKEND_REASON)
    if BACKEND == "cli":
        argv, _ = build_argv("<prompt>")
        return "cli `%s` (%s)" % (" ".join(argv), BACKEND_REASON)
    return "none"


NO_BACKEND_HELP = """no LLM backend found. Pick one:
  export CM_LLM_CMD=claude                 # or codex / gemini / codebuddy / ...
or an OpenAI-compatible API:
  export CM_API_KEY=sk-...
  export CM_BASE_URL=https://api.deepseek.com   # any /v1-style endpoint
  export CM_LLM_MODEL=deepseek-chat"""


def build_argv(prompt):
    """Build the argv for the configured CLI backend, falling back to `-p`."""
    base = os.path.basename(LLM_CMD or "")
    spec = ADAPTERS.get(base)
    if spec:
        argv = spec["argv"](prompt, LLM_MODEL)
        argv[0] = LLM_CMD  # honour an absolute path in CM_LLM_CMD
        return argv, spec.get("clean")
    argv = [LLM_CMD, "-p", prompt]
    if LLM_MODEL:
        argv += ["--model", LLM_MODEL]
    return argv, None


def _chat_url():
    url = HTTP_BASE_URL.rstrip("/")
    return url if url.endswith("/chat/completions") else url + "/chat/completions"


def _call_http(prompt, timeout):
    if not LLM_MODEL:
        raise RuntimeError("HTTP backend needs a model: export CM_LLM_MODEL=...")
    body = json.dumps({
        "model": LLM_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
    }).encode("utf-8")
    req = urllib.request.Request(_chat_url(), data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + HTTP_API_KEY,
        "User-Agent": "commit-message-from-issue-skill",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise RuntimeError("HTTP %d from %s: %s" % (exc.code, _chat_url(), detail)) from exc
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError("unexpected response: %s" % str(data)[:300]) from exc


def _call_cli(prompt, timeout):
    argv, flavour = build_argv(prompt)
    proc = subprocess.run(
        argv, capture_output=True, text=True,
        # Several CLIs (codex) block waiting on stdin when it is a tty.
        stdin=subprocess.DEVNULL,
        timeout=timeout,
    )
    if proc.returncode != 0:
        # Some CLIs (claude: "Not logged in") report errors on stdout.
        detail = (proc.stderr.strip() or proc.stdout.strip())[:300]
        raise RuntimeError("%s exit %d: %s (log in to that CLI, or pick another "
                           "backend with CM_LLM_CMD / CM_API_KEY)"
                           % (LLM_CMD, proc.returncode, detail))
    return strip_cli_noise(proc.stdout, flavour)


def llm(prompt, timeout=None, retries=None):
    """Send one prompt to the resolved backend and return the answer text."""
    if BACKEND is None:
        raise RuntimeError(NO_BACKEND_HELP)
    call = _call_http if BACKEND == "http" else _call_cli
    last = None
    for attempt in range(1 + (LLM_RETRIES if retries is None else retries)):
        try:
            out = call(prompt, timeout or LLM_TIMEOUT)
            if not out.strip():
                raise RuntimeError("backend returned empty output")
            return out.strip()
        except Exception as exc:  # noqa: BLE001 - retry on anything
            last = exc
            log("  llm call failed (attempt %d): %s" % (attempt, str(exc)[:200]))
            time.sleep(min(2 ** attempt, 8))
    raise last


def strip_cli_noise(text, flavour=None):
    """Drop banners / ANSI codes / transcript scaffolding around the answer."""
    text = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", text)
    if flavour == "codex":
        text = _strip_codex_transcript(text)
    lines = [
        ln for ln in text.splitlines()
        if not re.match(r"^\s*(Update available|Run \w+ update|npm notice"
                        r"|Reading additional input)", ln)
    ]
    return "\n".join(lines).strip()


def _strip_codex_transcript(text):
    """Extract the assistant turn from `codex exec` transcript output.

    codex prints a session header, then `user`/`codex` turn markers, then a
    `tokens used` footer. Keep only what follows the last `codex` marker.
    """
    lines = text.splitlines()
    starts = [i for i, ln in enumerate(lines) if ln.strip() == "codex"]
    if starts:
        lines = lines[starts[-1] + 1:]
    for i, ln in enumerate(lines):
        if re.match(r"^\s*tokens used\b", ln):
            lines = lines[:i]
            break
    return "\n".join(lines)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- parsing

def extract_int_list(text):
    """Pull a list of issue numbers out of a messy LLM reply.

    Tolerates code fences, `#123`, quoted numbers, and prose around the array;
    falls back to regex-scraping integers when JSON parsing fails.
    """
    if not text:
        return []
    cleaned = re.sub(r"```[a-zA-Z]*\n?|\n?```", "", text)
    for match in re.finditer(r"\[[^\[\]]*\]", cleaned, re.DOTALL):
        chunk = match.group(0)
        try:
            arr = json.loads(chunk)
        except Exception:  # noqa: BLE001
            arr = None
        if isinstance(arr, list):
            nums = []
            for item in arr:
                if isinstance(item, int):
                    nums.append(item)
                elif isinstance(item, str) and item.strip().lstrip("#").isdigit():
                    nums.append(int(item.strip().lstrip("#")))
            if nums:
                return nums
        nums = [int(x) for x in re.findall(r"#?(\d{2,})", chunk)]
        if nums:
            return nums
    return ([int(x) for x in re.findall(r"#(\d{2,})", cleaned)]
            or [int(x) for x in re.findall(r"\b(\d{3,})\b", cleaned)])


def extract_json_object(text):
    """Return the first balanced JSON object in text, or None."""
    if not text:
        return None
    cleaned = re.sub(r"```[a-zA-Z]*\n?|\n?```", "", text)
    start = cleaned.find("{")
    while start >= 0:
        depth, in_str, esc = 0, False, False
        for i in range(start, len(cleaned)):
            ch = cleaned[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            elif ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(cleaned[start:i + 1])
                    except Exception:  # noqa: BLE001
                        break
        start = cleaned.find("{", start + 1)
    return None


# ---------------------------------------------------------------- formatting

MAX_DIFF_CHARS = int(os.environ.get("CM_MAX_DIFF_CHARS", "12000"))
MAX_TITLE_CHARS = 200
MAX_BODY_CHARS = 2000


def truncate_diff(diff, cap=None):
    """Head+tail truncation: keeps the first hunks and the last hunks visible."""
    cap = cap or MAX_DIFF_CHARS
    if len(diff) <= cap:
        return diff, False
    head = diff[: int(cap * 0.7)]
    tail = diff[-int(cap * 0.3):]
    return head + "\n...[DIFF TRUNCATED]...\n" + tail, True


def fmt_titles(candidates):
    """Stage 1 view: one line per candidate, title only."""
    return "\n".join(
        "#%s | %s" % (
            c["number"],
            str(c.get("title", "")).replace("\n", " ").strip()[:MAX_TITLE_CHARS],
        )
        for c in candidates
    )


def fmt_full(candidates):
    """Stage 2 view: title plus (truncated) body per candidate."""
    parts = []
    for c in candidates:
        title = str(c.get("title", "")).replace("\n", " ").strip()[:MAX_TITLE_CHARS]
        body = (c.get("body") or "").strip()[:MAX_BODY_CHARS]
        parts.append("ISSUE #%s\nTITLE: %s\nBODY: %s\n" % (c["number"], title, body))
    return "\n---\n".join(parts)


def load_prompt(name):
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(os.path.dirname(here), "prompts", name)
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def render(template, **fields):
    """str.format with placeholder-only substitution.

    Diffs and issue bodies are full of `{` and `}`; str.format would choke on
    them, so substitute via sentinels instead.
    """
    out = template
    for i, key in enumerate(fields):
        out = out.replace("{%s}" % key, "\x00%d\x00" % i)
    for i, key in enumerate(fields):
        out = out.replace("\x00%d\x00" % i, str(fields[key]))
    return out


# ---------------------------------------------------------------- GitHub API

GITHUB_API = "https://api.github.com"


def gh_get(path, params=None):
    url = GITHUB_API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "commit-message-from-issue-skill",
    })
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:300]
        if exc.code in (403, 429):
            raise RuntimeError(
                "GitHub API rate-limited (%d). Set GITHUB_TOKEN to raise the "
                "limit from 60 to 5000 req/h. %s" % (exc.code, body)
            ) from exc
        raise RuntimeError("GitHub API %d for %s: %s" % (exc.code, path, body)) from exc


def fetch_open_issues(repo, limit=200, before=None):
    """Fetch open issues (PRs excluded), newest first, up to `limit`.

    `before` is an ISO timestamp; issues created after it are dropped so the
    candidate pool matches what a developer could have seen at commit time.
    """
    out = []
    page = 1
    while len(out) < limit and page <= 10:
        batch = gh_get("/repos/%s/issues" % repo, {
            "state": "open", "sort": "created", "direction": "desc",
            "per_page": 100, "page": page,
        })
        if not batch:
            break
        for item in batch:
            if "pull_request" in item:
                continue
            if before and item["created_at"] > before:
                continue
            out.append({
                "number": item["number"],
                "title": item.get("title") or "",
                "body": (item.get("body") or "")[:MAX_BODY_CHARS],
            })
            if len(out) >= limit:
                break
        page += 1
    return out


# ---------------------------------------------------------------- self-check

if __name__ == "__main__":
    if "--check" not in sys.argv:
        sys.exit("usage: python3 pdil.py --check")
    print("backend: %s" % describe_backend())
    if BACKEND is None:
        sys.exit(NO_BACKEND_HELP)
    started = time.time()
    reply = llm("Reply with exactly this JSON and nothing else: [1, 2, 3]", retries=0)
    print("reply:   %r (%.1fs)" % (reply[:80], time.time() - started))
    print("parsed:  %s" % extract_int_list(reply))
    print("github:  %s" % ("token set" if (os.environ.get("GITHUB_TOKEN")
                                           or os.environ.get("GH_TOKEN"))
                           else "no token (60 req/h limit)"))
