# LE_ETERNALISM

A SillyTavern extension that turns the chat into an RPG engine driven by a three-stage AI pipeline.

## Installation

In SillyTavern, open the **Extensions** drawer (cubes icon), click **Install extension**, and enter:

```
https://github.com/um5130384-cmd/LE_ETERNALISM
```

Alternatively, copy this whole folder into `SillyTavern/public/scripts/extensions/third-party/LE_ETERNALISM` and restart SillyTavern.

## How it works

When a user message is sent (auto-run mode) or the **Run RPG pipeline** button is pressed, the extension runs:

1. **Stage 1 — Scene analysis.** The request is assembled as: chat context, then *system prompt 1* (analysis commands), then *system prompt 2* (thinking checklist). The AI replies with `[include: Name]` / `[exclude: Name]` directives (comma-separated names allowed).
2. **Stage 2 — Main generation.** The main prompt plus the chat context plus the included prompt modules from the library is sent to the AI, producing the draft reply.
3. **Stage 3 — Formatting.** The draft is sent to the formatting AI together with the post-process prompt. The result is posted to chat as a character reply.

If no include/exclude directives are found, all enabled library modules are used. `[include: all]` explicitly selects all enabled modules. Excludes always win over includes.

## Settings

All prompts are editable in **Settings → Extensions → "LE Eternalism — RPG Engine"**:

- **Auto-run pipeline when a message is sent** — intercepts message generation and runs the pipeline instead.
- **Suppress the default AI reply** — while auto-run is on, normal generation is aborted and the pipeline owns the reply (swipe/regenerate are disabled in this mode; impersonate is unaffected).
- **Stage 1 — System prompt 1** (scene analysis commands) and **Stage 1 — System prompt 2** (thinking checklist) — concatenated after the chat context, in that order.
- **Stage 2** main prompt and **Stage 3** post-process prompt.
- **Prompt library** — named modules (name + text + enabled) that Stage 1 can include or exclude.

## Notes / roadmap

- The pipeline currently re-decides included modules on every message (no persistent scene state yet).
- Group chats post under the last non-user speaker's name.
- Default prompts are placeholders — replace them with the real ones.
