# meat

Abridge a code diff into a **reading diff**.

Humans need to review agent-written code in critical systems.
But models are good now. You don't need to review for style or nil-checks
or imports. You need to review concepts, algorithm choices, architecture.

So meat uses a model to reduce a diff to the important parts.
It shows you the meat.

Install with:

```
go install meat.dev/cmd/meat@latest
```

Run with `meat` to review the latest commit.
It takes git-looking parameters to pick commits to review.

It takes a while to process a commit for reading.
So I suggest you have an agent build `meat` into your devtools so that
it pre-processes it.

Very large diffs are split at file and hunk boundaries and abridged
chunk by chunk (up to a few MB), so one huge commit still produces a
single merged reading diff — it just takes proportionally longer.

## pi extension

This repo is one of those devtools. It is a pi package: the agent gets a
`meat` tool, and you get a `/meat` command.

```
pi install npm:pi-meat
```

The tool takes a commit, a range, `-staged`, the working tree, or a diff
from the agent's context, and returns the reading diff. `/meat [target]`
(default `HEAD`) drops the reading diff into the session as context, so
the agent works from the meat instead of the raw diff.

If `meat` is not on your `PATH` the extension builds it once from the Go
source bundled in the package (needs Go installed) and caches the binary
in `~/.cache/pi-meat`. Set `MEAT_BIN` to use a specific binary.

Inside pi, meat uses the model currently selected in that session, including
its resolved API key or OAuth credentials, custom headers, provider settings,
and thinking level. The standalone CLI continues to use `OPENAI_API_KEY` /
`ANTHROPIC_API_KEY`, `MEAT_MODEL`, and the matching base-URL variables.
