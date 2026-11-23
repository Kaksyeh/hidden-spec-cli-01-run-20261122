# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Kaksyeh/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Kaksyeh/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and mend reads all four to one written specification, finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none. A make.fun bounty entry.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the path of the patch file, relative to the working directory; when it is absent or `-`, the patch is read from standard input. Options: `--format=NAME` (`unified`, `search-replace`, `v4a`, `json`, or `auto`, the default), `--check` (do everything but write), `--strict` (match lines exactly, tier 0 only). See `SPEC.md` in the kit for the full contract.

## Practice score

100/100 practice checks pass (practice score 1000): unified 30/30, search-replace 20/20, V4A 20/20, JSON 15/15, CLI 15/15, measured with the kit's `check.ts` against `program/generator/practice.json`.
