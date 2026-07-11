# Design: Add Claude Fable 5 System Prompt to Project

## Goal
Integrate the full leaked Claude Fable 5 system prompt into the project's AI instruction files so that the coding agent follows its detailed computer-use, file-handling, search, copyright, and artifact guidelines when working on this codebase.

## Context
- The project is a Next.js app (`btcusd-dashboard`).
- Existing instruction files:
  - `AGENTS.md` — contains Next.js-specific agent rules.
  - `CLAUDE.md` — currently only contains `@AGENTS.md`.
- The full prompt source: `https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-fable-5.md`.

## Design
1. **Create reference file**
   - Path: `.kimchi/docs/claude-fable-5-system-prompt.md`
   - Content: the full prompt, copied verbatim from the user's uploaded file.

2. **Update `CLAUDE.md`**
   - Keep the `@AGENTS.md` reference so Next.js rules remain in effect.
   - Add a directive instructing the model to read and follow `.kimchi/docs/claude-fable-5-system-prompt.md`.
   - Add a short attribution comment noting the source.

## Acceptance Criteria
- `.kimchi/docs/claude-fable-5-system-prompt.md` exists and matches the uploaded file verbatim.
- `CLAUDE.md` references both `AGENTS.md` and the new prompt file.
- No other project code is changed.
