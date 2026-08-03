# LE_ETERNALISM

A SillyTavern extension for creating macro variables that are included via contextual analysis. It's about scene analysis and inserting relevant prompts.

<img width="638" height="490" alt="image" src="https://github.com/user-attachments/assets/f2ea98e9-3181-453e-96bf-cc084b3fe40f" />

## Installation

In SillyTavern, open the **Extensions** drawer (cubes icon), click **Install extension**, and enter:

```
https://github.com/um5130384-cmd/LE_ETERNALISM
```

## How it works

The extension adds three steps around your normal SillyTavern generation:

1. **Stage 1 — Scene analysis.** Before the AI replies, a separate request analyzes the scene (chat history + your two analysis prompts). Based on the result, the extension activates the matching macro prompts for this scene.

<img width="607" height="931" alt="ааааа" src="https://github.com/user-attachments/assets/68ef13a7-f49c-47d8-ac29-6f33930b76ab" />

2. **Stage 2 — Generation.** SillyTavern generates normally with your preset. Nothing is replaced or rewritten — your preset keeps working as usual but with enabled or disabled macro prompts.
3. **Stage 3 — Post-processing (optional step)** After the reply is generated, it is sent once more with your formatting prompts, and the polished version replaces the message in chat.

<img width="618" height="603" alt="ggggg" src="https://github.com/user-attachments/assets/87a232c1-eb4b-4714-b5b7-4dd5d48e726f" />

## First-time setup

1. Open **Settings → Extensions → "LE_ETERNALISM"**.
2. Write your **Stage 1** prompts (system prompt 1: analysis commands, system prompt 2: thinking checklist).
3. Add **macro modules** to the library (see below) — e.g. combat rules, sex rules, etc.
4. Write your **Stage 3** prompts (formatting commands + checklist).
5. Send a message and check the log panel at the bottom to see what the extension did.

## Macro library

The library holds named modules ("macros") that Stage 1 can activate.

<img width="1000" height="391" alt="macro editing" src="https://github.com/user-attachments/assets/f9060d9f-cabf-411f-8d6b-687f6456d262" />

Each macro has in editing:

- **Prompt name** — the macro's identifier (just a name for convenience).
- **Variable** — a short name (e.g. `violence`). To place the macro's text into your preset prompt, insert the tag `[[le_violence]]` (using your variable's name) where you want it to appear.
- **Trigger** — a command the analyzer must output for the macro to activate, e.g. `[include: Combat Rules]`. If the trigger is empty, the macro will be active automatically.
- **Prompt** — the text that gets injected when the macro is active.

Select a macro from the **Choose macro...** dropdown to edit or delete it; **+ Add** creates a new one.

## How to insert macro?

Insert in preset prompts registered macro:
`[[le_<variable>]]`

## Settings reference

- **Debug mode** — pauses after Stage 1 to show the analyzer's output; after you confirm, previews of the Stage 2 and Stage 3 requests open before they are sent.
- **Stage 1 — history depth** — how many of the most recent chat messages the analyzer sees (0 = unlimited).
- **Stage 1 / Stage 3 — use a different API/model** — run that stage on its own backend (base URL, API key, model). If enabled, the fields must be filled correctly, otherwise the run is stopped with an error.
- **Post-processing (Stage 3)** — on by default; toggle to disable.
- **Save / Export / Import settings** — export saves everything (except API keys, provider addresses, and models); import restores your settings.

## In-chat features

- After Stage 3, a **clock icon** appears on the latest message (before the ellipsis) — click it to switch between the original and the post-processed version. After refreshing page button will disspear.

## Tips

- For stage 1 and stage 3 I recommend to use Deepseek V4 flash. It works really nice.
- To find errors in your editing look at console of extension.
