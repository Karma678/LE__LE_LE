# LE_ETERNALISM

A SillyTavern extension that runs a scene-analysis pipeline in front of your existing roleplay preset and feeds its results into the preset's variables.

## Installation

In SillyTavern, open the **Extensions** drawer (cubes icon), click **Install extension**, and enter:

```
https://github.com/um5130384-cmd/LE_ETERNALISM
```

Alternatively, copy this whole folder into `SillyTavern/public/scripts/extensions/third-party/LE_ETERNALISM` and restart SillyTavern.

## How it works

**Stage 1 — Scene analysis.** When a message is sent (auto-run mode) or the **Run analysis now** button is pressed, the extension sends a request consisting of two separate system messages (*system prompt 1*: analysis commands, *system prompt 2*: thinking checklist) plus the chat history as proper role messages (player messages = `user`, AI messages = `assistant`, speaker name embedded in each message's content; no persona/character card/world info/preset prompts). The AI replies with `[include: Name]` / `[exclude: Name]` directives (comma-separated names allowed).

**Apply variables.** For every prompt-library module that has a **preset variable** configured (e.g. `violence`), the extension:
- replaces the `[[le_<variable>]]` tag (e.g. `[[le_violence]]`) in the final chat-completion prompt with the module's text when the module is active, and removes the tag when inactive — the same injection mechanism as Megumin's `[[main_prompt]]` (hooked at `CHAT_COMPLETION_PROMPT_READY`, immune to ST's macro engine);
- also registers a `{{le_<variable>}}` macro as a fallback where macros resolve, and writes the text to the chat variable.

**Module activation.** A module with a **trigger command** (e.g. `[include: Combat Rules]`, one per line) activates only when that command appears in the Stage 1 output — otherwise its content is empty. Modules without a trigger follow the `[include: ...]` / `[exclude: ...]` directives instead (no directives = all enabled modules active).

**Stage 2 — Generation.** SillyTavern generates normally with your preset (the preset IS Stage 2; the extension does not generate or replace the reply).

**Stage 3 — Post-process (optional, off by default).** If enabled, the generated reply is sent to the formatting AI and the formatted text replaces it in chat.

If no include/exclude directives are found, all enabled library modules are used. `[include: all]` explicitly selects all enabled modules. Excludes always win over includes.

## Settings

All settings are in **Settings → Extensions → "LE Eternalism — RPG Engine"**:

- **Auto-run Stage 1 analysis when a message is sent** — runs the analysis (and variable application) before the preset generates; applies to **Normal**, **Continue**, **Swipe**, and **Regenerate** generations.
- **Debug mode** — pauses after Stage 1 and shows the analysis output plus the parsed directives in a popup; after you accept it, the Stage 2 prompt preview opens automatically before the request is sent (or abort).
- **View last Stage 2 prompt** — displays the fully combined prompt from the last generation (macros resolved).
- **Post-process the generated reply (Stage 3 recheck)** — off by default; formats the generated reply with the Stage 3 prompt.
- **Stage 1 — System prompt 1** (analysis commands) and **Stage 1 — System prompt 2** (thinking checklist).
- **Stage 1 history depth** — how many of the most recent chat messages are sent to the analyzer (0 = unlimited).
- **Stage 3 post-process prompt** — used only when post-processing is enabled.
- **Prompt library** — named modules (name + preset variable + text + enabled) that Stage 1 can include or exclude.

## Notes

- The pipeline re-decides included modules on every message (no persistent scene state yet).
- Carriage returns are stripped from all request content.
- Works with the LE_EMOTIONALISM preset: the "Hyper Violence" module maps to the `violence` variable.
