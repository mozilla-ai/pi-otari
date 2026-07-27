<p align="center">
  <a href="https://pi.dev"><img src="assets/pi-logo.svg" alt="Pi" height="66"></a>
  <img src="assets/heart.svg" alt="loves" height="48">
  <a href="https://otari.ai"><img src="assets/otari-logo.svg" alt="Otari" height="64"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mozilla-ai/pi-otari"><img src="https://img.shields.io/npm/v/%40mozilla-ai%2Fpi-otari" alt="npm version"></a>
  <a href="https://github.com/mozilla-ai/pi-otari/actions/workflows/ci.yml"><img src="https://github.com/mozilla-ai/pi-otari/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
</p>

Route [Pi](https://pi.dev) model requests through [Otari](https://otari.ai) for usage tracking, budgets, traces, routing, and provider-key management.

## Requirements

- [Pi](https://pi.dev) installed and available as `pi`
- Node.js 22.19.0 or newer
- An Otari workspace API key
- At least one upstream provider and model enabled in your Otari workspace

## Install and use

1. Install the extension from npm:

   ```bash
   pi install npm:@mozilla-ai/pi-otari
   ```

2. Export your Otari workspace API key in the shell where you run Pi:

   ```bash
   export OTARI_API_KEY=tk_example
   ```

   Keep the key out of source control. Use your shell's secure configuration or a secret manager if you want it available in future terminal sessions.

3. Start Pi:

   ```bash
   pi
   ```

4. Make Otari models available in Pi:

   - Run `/scoped-models`.
   - Search for `otari`.
   - Enable the models you want to use.
   - Press <kbd>Ctrl</kbd>+<kbd>S</kbd> to save the scope.

5. Run `/model` and select one of the enabled `otari` models.

6. Send a prompt normally. No Otari-specific slash command is required. When an Otari model is selected, Pi's status area shows `Otari → <model-id>`.

Pi sends requests for the selected provider to `https://api.otari.ai/v1/chat/completions`. Local Pi tools continue to run according to your Pi configuration.

To inspect the Otari models available to Pi from a shell, run:

```bash
pi --list-models otari
```

### Update or remove

```bash
pi update npm:@mozilla-ai/pi-otari
pi remove npm:@mozilla-ai/pi-otari
```

## Model discovery

On startup and `/reload`, the extension tries `GET ${OTARI_BASE_URL}/models`. Standalone and self-hosted Otari support this now. Hosted Otari currently falls back to its public managed `mzai` catalog and will automatically use workspace-scoped `/models` when that endpoint becomes available.

If no models are found, provide one or more Otari selectors and reload:

```bash
export OTARI_MODELS="anthropic:claude-sonnet-5,mzai:moonshotai/Kimi-K3"
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

- **No Otari models in `/model`:** run `/scoped-models`, search for `otari`, enable models, and press <kbd>Ctrl</kbd>+<kbd>S</kbd>. If no models are available there, set `OTARI_MODELS` and run `/reload`.
- **401/403:** regenerate or re-export `OTARI_API_KEY` and confirm workspace access.
- **Unknown model:** the selected provider or model is not enabled in your Otari workspace. Enable it in Otari, or select a different Otari model in Pi.
- **Model returns 404 "not found on the provider":** the hosted managed catalog lists priced models that may not all be deployed. Pick another model.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, testing, dependency updates, and release instructions.

## License

Apache-2.0
