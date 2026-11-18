#!/usr/bin/env bash
# Build a throwaway git repo that reproduces the keras #9585 situation: a real
# working tree, a real "before" commit, and real STAGED changes waiting for a
# commit message. The candidate issue pool ships alongside so no GitHub access
# is needed.
#
#   ./scripts/setup_demo_repo.sh /tmp/demo-keras
#   cd /tmp/demo-keras && codex        # then: "write my commit message"
set -euo pipefail

DEST="${1:-/tmp/demo-keras}"
PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"

rm -rf "$DEST"
mkdir -p "$DEST/keras/preprocessing" "$DEST/tests/keras/preprocessing"
cd "$DEST"

git init -q
git config user.email dev@example.com
git config user.name "Demo Dev"
git remote add origin https://github.com/keras-team/keras.git

# ---------------------------------------------------------------- BEFORE state
cat > keras/preprocessing/text.py <<'EOF'
"""Utilities for text input preprocessing."""
from __future__ import absolute_import
from __future__ import division

import string
import sys

if sys.version_info < (3,):
    maketrans = string.maketrans
else:
    maketrans = str.maketrans


def text_to_word_sequence(text,
                          filters='!"#$%&()*+,-./:;<=>?@[\\]^_`{|}~\t\n',
                          lower=True, split=" "):
    """Converts a text to a sequence of words (or tokens).

    # Arguments
        text: Input text (string).
        filters: Sequence of characters to filter out.
        lower: Whether to convert the input to lowercase.
        split: Sentence split marker (string).

    # Returns
        A list of words (or tokens).
    """
    if lower:
        text = text.lower()

    if sys.version_info < (3,) and isinstance(text, unicode):
        translate_map = dict((ord(c), unicode(split)) for c in filters)
    else:
        translate_map = maketrans(filters, split * len(filters))

    text = text.translate(translate_map)
    seq = text.split(split)
    return [i for i in seq if i]
EOF

cat > tests/keras/preprocessing/text_test.py <<'EOF'
# -*- coding: utf-8 -*-
import pytest
from keras.preprocessing.text import text_to_word_sequence


def test_text_to_word_sequence():
    text = 'hello! ? world!'
    assert text_to_word_sequence(text) == ['hello', 'world']


def test_text_to_word_sequence_unicode():
    text = u'ali! veli? kırk dokuz elli'
    assert text_to_word_sequence(text) == [u'ali', u'veli', u'kırk', u'dokuz', u'elli']


if __name__ == '__main__':
    pytest.main([__file__])
EOF

git add -A
git commit -qm "Initial import of text preprocessing utilities"

# ---------------------------------------------------------------- skill wiring
# Committed BEFORE the fix is staged, so `git diff --cached` contains only the
# code change — the scaffolding must not leak into the diff the model sees.
mkdir -p .commit-msg
cp "$PLUGIN/examples/keras-9585/candidates.json" .commit-msg/candidates.json
ln -s "$PLUGIN" .commit-msg/plugin

# Both codex and claude read AGENTS.md / CLAUDE.md from the repo root, so the
# agent discovers the skill without the user having to explain it.
cat > AGENTS.md <<EOF
# Repo instructions

## Writing commit messages

When the user asks for a commit message, do NOT write one from the diff alone.
Run the progressive-disclosure issue-linking skill first — it finds the GitHub
issue this change fixes, which is where the "Why" comes from:

\`\`\`bash
python3 .commit-msg/plugin/scripts/link_and_write.py \\
  --candidates-file .commit-msg/candidates.json \\
  --out /tmp/run.json --message-out /tmp/msg.txt
\`\`\`

(This demo repo ships a cached issue pool in \`.commit-msg/candidates.json\`.
In a normal repo you would drop \`--candidates-file\` and let it fetch live
issues from GitHub, with \`GITHUB_TOKEN\` set.)

Then score what came out, and report both scores to the user:

\`\`\`bash
git diff --cached > /tmp/staged.diff
python3 .commit-msg/plugin/scripts/score_message.py \\
  --diff-file /tmp/staged.diff --message-file /tmp/msg.txt
\`\`\`

Show the user the linked issue title and the message. Do not run \`git commit\`
yourself — the link is right about 9 times in 10, so the user must confirm it.

The full method, tuning knobs and honesty constraints are in
\`.commit-msg/plugin/SKILL.md\`. Read it if anything looks off.
EOF
cp AGENTS.md CLAUDE.md
printf '.commit-msg/plugin\n' > .gitignore
git add -A
git commit -qm "Add commit-message tooling config"

# ---------------------------------------------------------------- AFTER state
# The fix the developer just finished writing. Staged, message not yet written.
python3 - <<'PY'
import io, re
p = 'keras/preprocessing/text.py'
src = io.open(p, encoding='utf-8').read()
old = """    if sys.version_info < (3,) and isinstance(text, unicode):
        translate_map = dict((ord(c), unicode(split)) for c in filters)
    else:
        translate_map = maketrans(filters, split * len(filters))

    text = text.translate(translate_map)
"""
new = """    if sys.version_info < (3,):
        if isinstance(text, unicode):
            translate_map = dict((ord(c), unicode(split)) for c in filters)
            text = text.translate(translate_map)
        elif len(split) == 1:
            translate_map = maketrans(filters, split * len(filters))
            text = text.translate(translate_map)
        else:
            for c in filters:
                text = text.replace(c, split)
    else:
        translate_dict = dict((c, split) for c in filters)
        translate_map = maketrans(translate_dict)
        text = text.translate(translate_map)
"""
assert old in src
io.open(p, 'w', encoding='utf-8').write(src.replace(old, new))

p = 'tests/keras/preprocessing/text_test.py'
src = io.open(p, encoding='utf-8').read()
src = src.replace(
    "def test_text_to_word_sequence_unicode():",
    """def test_text_to_word_sequence_multichar_split():
    text = 'hello!stop?world!'
    assert text_to_word_sequence(text, split='stop') == ['hello', 'world']


def test_text_to_word_sequence_unicode():""")
src = src.replace(
    "if __name__ == '__main__':",
    """def test_text_to_word_sequence_unicode_multichar_split():
    text = u'ali!stopveli?stopkırkstopdokuzstopelli'
    assert text_to_word_sequence(text, split='stop') == [u'ali', u'veli', u'kırk', u'dokuz', u'elli']


if __name__ == '__main__':""")
io.open(p, 'w', encoding='utf-8').write(src)
PY

git add -A

echo
echo "demo repo ready: $DEST"
echo "staged files:"
git diff --cached --stat
echo
echo "next:"
echo "  cd $DEST"
echo "  codex          # then ask: write my commit message"
