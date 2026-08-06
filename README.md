<p align="center">
  <a href="https://pi.dev"><img src="assets/pi-logo.svg" alt="Pi" height="66"></a>
  <img src="assets/heart.svg" alt="loves" height="48">
  <a href="https://otari.ai"><img src="assets/otari-logo.svg" alt="Otari" height="64"></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mozilla-ai/pi-otari"><img src="https://img.shields.io/npm/v/%40mozilla-ai%2Fpi-otari" alt="npm version"></a>
  <a href="https://github.com/mozilla-ai/pi-otari/actions/workflows/ci.yml"><img src="https://github.com/mozilla-ai/pi-otari/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
</p>

[Pi](https://pi.dev) is a minimal, extensible terminal coding harness, while [Otari](https://otari.ai) is an AI control plane and gateway for routing model requests, managing provider credentials, and tracking usage, budgets, and traces. This extension connects them so Pi can use Otari-managed models.

## Demo

![Pi Otari extension demo](assets/pi-otari-extension-demo.gif)

## Requirements

- [Pi](https://pi.dev) 0.81.0 or newer, installed and available as `pi` (older versions can install the package but the extension will remain disabled and show an upgrade message)
- Node.js 22.19.0 or newer
- An Otari workspace API key
- At least one upstream provider and model enabled in your Otari workspace

## Install and use

1. Install the extension from npm:

   ```bash
   pi install npm:@mozilla-ai/pi-otari
   ```

2. Start Pi:

   ```bash
   pi
   ```

3. Run `/login otari` and enter your Otari workspace API key in Pi's secret authentication prompt. This is API-key authentication, not OAuth: the prompt is separate from chat, so the key is not added to model context or sent to an LLM.

   Pi stores the credential in `~/.pi/agent/auth.json`, a plaintext file created with user-only permissions (`0600`). Keep that file out of source control and untrusted backups. Run `/logout otari` to remove the stored credential.

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

After login and during provider refresh, the extension uses authenticated, workspace-scoped model discovery. Hosted Otari queries `GET https://api.otari.ai/api/v1/models`; custom and self-hosted installations query `GET ${OTARI_BASE_URL}/models`. Only models available through providers enabled for the authenticated workspace are registered. If the hosted endpoint responds with `404` or `405`, the extension safely falls back to the public managed `mzai` catalog without sending the workspace token.

If no models are found, provide one or more explicit Otari selectors before starting or restarting Pi:

```bash
export OTARI_MODELS="anthropic:claude-sonnet-5,mistral:mistral-medium-3-5" # optional fallback or additional selectors
pi
```

These selectors are unverified until the first request. Otari must have the corresponding provider and model enabled for the workspace.

## Reasoning levels

Models that Otari discovery marks as reasoning-capable expose Pi's `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` reasoning levels. Models without that capability use Pi's conservative non-reasoning default. The extension forwards the selected level unchanged. Pi's default remains `medium` unless the user configures or selects another level.

Otari discovery does not yet provide each model's supported reasoning levels, so the levels exposed for a reasoning model are optimistic: an upstream model may reject a level it does not support. The extension preserves that error without silently retrying at a different level or without reasoning. When the upstream error reports supported values, they appear in Pi's error message.

## Non-interactive authentication

For CI, containers, and other noninteractive environments, provide the API key through `OTARI_API_KEY`:

```bash
OTARI_API_KEY=tk_example pi
```

A key stored through `/login otari` takes precedence over `OTARI_API_KEY`. Running `/logout otari` removes the stored key, but Pi will continue using `OTARI_API_KEY` if it is set.

## Self-hosted Otari

```bash
export OTARI_BASE_URL=https://otari.example.com/v1
pi
```

Then run `/login otari`. For noninteractive use, set both `OTARI_BASE_URL` and `OTARI_API_KEY`.

HTTP is accepted only for loopback development endpoints.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OTARI_API_KEY` | none | Workspace token or standalone key fallback when no stored credential exists |
| `OTARI_BASE_URL` | `https://api.otari.ai/v1` | OpenAI-compatible base URL |
| `OTARI_DISCOVERY_TIMEOUT_MS` | `5000` | Discovery timeout from 1000 to 30000 ms |
| `OTARI_MODELS` | none | Conditional fallback or additional model selectors |

## Privacy and security

Model requests using `otari/*` pass through Otari and the selected upstream provider. The extension does not maintain its own credential file. When you use `/login otari`, Pi stores the API key in `~/.pi/agent/auth.json`; when you use `OTARI_API_KEY`, the key remains environment-provided. The extension stores no prompts, responses, tool content, or telemetry. Pi persists provider model metadata in its native model store. Discovery rejects redirects and never sends a token to the public managed-catalog fallback.

## Troubleshooting

- **“pi-otari requires Pi 0.81.0 or newer”:** run `pi update`, then restart Pi. The package uses wildcard Pi peer dependencies, as required for Pi packages, and checks host compatibility at runtime instead of installing a second copy of Pi.
- **No Otari models in `/model`:** run `/scoped-models`, search for `otari`, enable models, and press <kbd>Ctrl</kbd>+<kbd>S</kbd>. If no models are available there, set `OTARI_MODELS` before starting or restarting Pi.
- **Missing credentials:** run `/login otari`, or set `OTARI_API_KEY` before starting or restarting Pi.
- **401/403:** run `/login otari` with a valid replacement key, or update `OTARI_API_KEY` when no stored credential exists and restart Pi; then confirm workspace access.
- **Unknown model:** the selected provider or model is not enabled in your Otari workspace. Enable it in Otari, refresh the provider, or select a different Otari model in Pi.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, testing, dependency updates, and release instructions.

## License

Apache-2.0
