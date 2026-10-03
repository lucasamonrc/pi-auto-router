# pi-auto-router

An **Auto** model for [pi](https://pi.dev). Pick it once in `/model`, and every task goes to the best-fitting model you already have access to.

A small, fast decision model ([Cloudflare Clef](https://blog.cloudflare.com/clef-decision-models/) by default, or [TypeSafe Jev](https://typesafe.ai)) reads your prompt and decides:

- **what kind of work it is**: question, small change, feature, frontend, debugging, architecture, large-context, writing, or your own kinds
- **how hard it is**, which sets the model tier and thinking level
- **whether you asked for a specific model** ("use opus for this", "something cheaper")
- **whether you changed tasks**, so it re-routes only when the kind of work changes

Then it picks a model from **your** catalog: task fit first, then cost.

```
auto: debugging → GPT Sol 6 · high
```

## Install

```bash
pi install git:github.com/lucasamonrc/pi-auto-router
```

Then in pi:

```
/route setup
```

The wizard picks a classifier, logs you in to Cloudflare if needed (browser OAuth, no API token), lets you choose models, and saves the config. Once that's done, select **Auto** in `/model`.

To try it without installing: `pi -e git:github.com/lucasamonrc/pi-auto-router`.

### Requirements

One classifier:

| Classifier | Auth |
|---|---|
| `clef` / `clef-flash` (default) | A Cloudflare account. `/route setup` runs `wrangler login` for you, or set `CLOUDFLARE_API_TOKEN` (Workers AI permission). Workers AI pricing applies. |
| `typesafe/jev-latest`, `openrouter/typesafe/jev-1.13`, … | Any classifier pi supports (TypeSafe, OpenRouter, Workers AI, Vercel AI Gateway, OpenCode). |

You also need some chat models in pi. The router only uses models you have credentials for.

## How it routes

1. **First prompt:** the classifier picks a task kind and complexity, and the router picks a model and thinking level.
2. **Follow-ups:** they stay on the same model so the prompt cache stays warm. Tool calls and retries never switch models.
3. **New kind of work:** if the classifier is ≥70% sure you started a different kind of task, it re-routes and tells you.
4. **You ask for it:** "use opus", "use something stronger", or "re-route" in a prompt is honored, and the choice stays pinned until you change it.
5. **Thinking level:** the level you select on Auto is the baseline. Trivial tasks get one step less, very hard ones one step more.
6. **Safety nets:**
   - If the conversation outgrows a model's context window, it moves to a model with a bigger one.
   - If the classifier is down, it stays on the current model.
   - Compaction summaries go to your largest-context model.

### Choosing a model for a task

Every model gets a **tier** (`light` → `standard` → `strong` → `frontier`) and **strengths**. Well-known families (Claude, GPT, Gemini, Kimi, GLM, DeepSeek, Qwen) come with built-in profiles. Unknown models are placed in a tier by price.

Every task kind has a target tier and preferred strengths. The router picks:
1. models that meet hard constraints (context size, image input);
2. the closest tier, going up before going down;
3. among those, models with the preferred strengths;
4. then the cheapest.

Hard tasks go one tier up, unless that would lose the specialist (e.g. hard debugging stays on your debugging model, with more thinking).

With zero config, the pool is the newest model of each well-known family you can access.

## Commands

| Command | |
|---|---|
| `/route` | Current model, why it was chosen, classifier probabilities |
| `/route setup` | Interactive setup |
| `/route models` | Which model each task kind uses, and the pool |
| `/route test <prompt>` | Classify a prompt without sending it, for tuning |
| `/route reroute` | Re-classify on your next prompt |
| `/route pin <alias>` or `/route opus` | Pin a model |
| `/route auto` | Unpin |
| `/route config` | Show config file locations |

The status line shows the current decision. Pi's footer shows the model each response actually came from.

## Configuration

`/route setup` writes this for you. Files:

- `~/.pi/agent/auto-router.json` (everywhere)
- `.pi/auto-router.json` (per project, merged on top)

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/lucasamonrc/pi-auto-router/main/schema.json",
  "classifier": "clef",                       // "clef-flash", or "typesafe/jev-latest", …
  "pool": [                                   // omit to auto-discover
    "anthropic/claude-opus-4-5",
    "anthropic/claude-sonnet-4-5",
    "openai/gpt-5-mini"
  ],
  "models": {                                 // tune tier/strengths per model
    "openai/gpt-5": { "tier": "strong", "strengths": ["debugging"] }
  },
  "kinds": {
    "frontend": { "model": "opus" },          // always use a model for a kind
    "data_science": {                         // add your own kind
      "desc": "Notebooks, pandas, statistics, plotting",
      "tier": "standard"
    },
    "writing": { "enabled": false }           // remove a built-in kind
  },
  "fallback": "sonnet",                       // classifier down at session start
  "shiftThreshold": 0.7,                      // how sure before re-routing on a task change
  "adjustThinking": true
}
```

See [`schema.json`](schema.json) for every option. Built-in kinds and family profiles are in [`src/config.ts`](src/config.ts) and [`src/catalog.ts`](src/catalog.ts).

### Environment variables

| Variable | |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Use an API token instead of the wrangler login |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account for Clef |
| `AUTO_ROUTER_WRANGLER` | How to run wrangler (default `npx --yes wrangler`, e.g. `pnpm exec wrangler`) |

## Development

```bash
git clone https://github.com/lucasamonrc/pi-auto-router && cd pi-auto-router
npm install
npm run check                 # typecheck + tests
pi -e .                       # run pi with your working copy
```

## License

MIT
