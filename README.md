<p align="center">
  <a href="https://pi.dev"><img src="assets/pi-logo.svg" alt="Pi" height="66"></a>
  <img src="assets/heart.svg" alt="loves" height="48">
  <a href="https://otari.ai"><img src="assets/otari-logo.svg" alt="Otari" height="64"></a>
</p>

Route [Pi](https://pi.dev) model requests through [Otari](https://otari.ai) for usage tracking, budgets, traces, routing, and provider-key management.

## Install

```bash
pi install npm:pi-otari
export OTARI_API_KEY=tk_example
pi
```

> **Note:** Otari models do not appear in `/model` until you run `/scoped-models`, search for `otari`, enable the models you want, and press Ctrl+S to save the scope.

Then open Pi's built-in `/model` selector and choose one of the enabled Otari models. No Otari-specific slash command is required. Pi sends requests for that selected provider to `https://api.otari.ai/v1/chat/completions`; local Pi tools continue to run according to your Pi configuration.

## Model discovery

On startup and `/reload`, the extension tries `GET ${OTARI_BASE_URL}/models`. Standalone and self-hosted Otari support this now. Hosted Otari currently falls back to its public managed `mzai` catalog and will automatically use workspace-scoped `/models` when that endpoint becomes available.

If no models are found, provide one or more Otari selectors and reload:

```bash
export OTARI_MODELS="anthropic:claude-sonnet-4-6,mzai:moonshotai/Kimi-K2.6"
```

These selectors are unverified until the first request. Otari must have the corresponding provider and model enabled for the workspace.

## Self-hosted Otari

```bash
export OTARI_API_KEY=your_otari_key
export OTARI_BASE_URL=https://otari.example.com/v1
pi
```

HTTP is accepted only for loopback development endpoints.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OTARI_API_KEY` | none | Workspace token or standalone key |
| `OTARI_BASE_URL` | `https://api.otari.ai/v1` | OpenAI-compatible base URL |
| `OTARI_DISCOVERY_TIMEOUT_MS` | `5000` | Discovery timeout from 1000 to 30000 ms |
| `OTARI_MODELS` | none | Conditional fallback or additional model selectors |

## Privacy and security

Model requests using `otari/*` pass through Otari and the selected upstream provider. The extension stores no token, prompts, responses, tool content, or telemetry. It stores only a user-readable model metadata cache under Pi's agent directory. Discovery rejects redirects and never sends a token to the public managed-catalog fallback.

## Troubleshooting

- **No Otari models in `/model`:** set `OTARI_MODELS`, then run `/reload`.
- **401/403:** regenerate or re-export `OTARI_API_KEY` and confirm workspace access.
- **Unknown model:** use an Otari selector enabled for the workspace.
- **Model returns 404 "not found on the provider":** the hosted managed catalog lists priced models that may not all be deployed. Pick another model.
- **Stale list:** run `/reload`; discovery runs on every extension load.
- **Local cost differs from Otari:** Otari is authoritative when discovery metadata is incomplete.

## Development

```bash
npm install
npm run check
pi -e ./src/index.ts
```

## License

Apache-2.0
