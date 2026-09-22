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

Pi sends requests for the selected provider to `${OTARI_BASE_URL}/chat/completions`, which is `https://api.otari.ai/api/v1/chat/completions` for hosted Otari. Local Pi tools continue to run according to your Pi configuration.

To list the Otari models Pi currently knows about from a shell, run:

```bash
pi --list-models otari
```

NOTE: this prints Pi's cached catalog and does not contact Otari; see [Model discovery](#model-discovery) for when the cache is refreshed.

### Update or remove

```bash
pi update npm:@mozilla-ai/pi-otari
pi remove npm:@mozilla-ai/pi-otari
```

## Model discovery

After login and during provider refresh, the extension queries `{OTARI_BASE_URL}/models` (`https://api.otari.ai/api/v1/models` for hosted otari) with the workspace token. Only models available through providers enabled for the authenticated workspace are registered. If the hosted endpoint responds with `404` or `405`, the extension reports that hosted model discovery is unavailable. It does not request a public catalog or substitute models outside the authenticated discovery response.

### The model list is a cache

Otari's catalog is dynamic: workspaces can enable and remove providers and models at any time. Pi stores the last discovered list in `~/.pi/agent/models-store.json` and shows that list until the next refresh. In interactive mode Pi refreshes in the background at startup, after `/login otari`, and whenever you open `/model`. Print mode and `pi --list-models` read the cache only.

The cache belongs to one Otari deployment. Pointing `OTARI_BASE_URL` at a different host, such as switching between hosted and self-hosted Otari, drops the previous deployment's entries, and the list stays empty until the next refresh. Changing only the API prefix on the same host keeps them, since the deployment is the same. Refresh after adding or removing models in Otari: until then, entries from the previous catalog stay listed, and a request to one that no longer exists fails with an error from the gateway.

### Wrong API prefix

If discovery gets `404` from a self-hosted gateway, the extension probes the other well-known API root's public health route, without sending the token, and shows a warning naming the exact `OTARI_BASE_URL` to set. Otari 0.6.0 and newer serve `/api/v1`; older gateways served `/v1`.

If no models are found, provide one or more explicit Otari selectors before starting or restarting Pi:

```bash
export OTARI_MODELS="anthropic:claude-sonnet-5,mistral:mistral-medium-3-5" # optional fallback or additional selectors
pi
```

These selectors are registered as given, and Otari must have the corresponding provider and model enabled for the workspace. When discovery succeeds and its list does not include one of them, the extension warns once, naming the selector and, if the same model is listed under another provider prefix, the current selector to use instead. The entry itself stays registered until you update or remove it in `OTARI_MODELS` and restart Pi.

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
export OTARI_BASE_URL=https://otari.example.com/api/v1
pi
```

`OTARI_BASE_URL` must include the gateway's API prefix, because Pi appends `/chat/completions` and discovery appends `/models` to it. Otari 0.6.0 and newer serve `/api/v1`; gateways older than 0.6.0 served `/v1`. A bare origin such as `https://otari.example.com` is rejected. For a gateway on your own machine, use `http://localhost:8000/api/v1`.

Then run `/login otari`. For noninteractive use, set both `OTARI_BASE_URL` and `OTARI_API_KEY`.

HTTP is accepted only for loopback development endpoints.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `OTARI_API_KEY` | none | Workspace token or standalone key fallback when no stored credential exists |
| `OTARI_BASE_URL` | `https://api.otari.ai/api/v1` | OpenAI-compatible base URL, including the gateway's API prefix |
| `OTARI_DISCOVERY_TIMEOUT_MS` | `5000` | Discovery timeout from 1000 to 30000 ms |
| `OTARI_MODELS` | none | Conditional fallback or additional model selectors |

## Privacy and security

Model requests using `otari/*` pass through Otari and the selected upstream provider. The extension does not maintain its own credential file. When you use `/login otari`, Pi stores the API key in `~/.pi/agent/auth.json`; when you use `OTARI_API_KEY`, the key remains environment-provided. The extension stores no prompts, responses, tool content, or telemetry. Pi persists provider model metadata in its native model store. Discovery rejects redirects and sends the token only to the configured model-discovery endpoint. When discovery returns `404` from a self-hosted gateway, the extension also requests that gateway's public health route on the other API prefix, again without the token.

## Troubleshooting

- **“pi-otari requires Pi 0.81.0 or newer”:** run `pi update`, then restart Pi. The package uses wildcard Pi peer dependencies, as required for Pi packages, and checks host compatibility at runtime instead of installing a second copy of Pi.
- **No Otari models in `/model`:** run `/scoped-models`, search for `otari`, enable models, and press <kbd>Ctrl</kbd>+<kbd>S</kbd>. If no models are available there, set `OTARI_MODELS` before starting or restarting Pi.
- **“Otari returned no models for this workspace”:** discovery succeeded but the workspace has no enabled provider or model. Enable one in Otari, then open `/model` to refresh; until then `/model` lists no Otari models.
- **Missing credentials:** run `/login otari`, or set `OTARI_API_KEY` before starting or restarting Pi.
- **401/403:** Otari rejected the key used for discovery. Run `/login otari` with a valid replacement key, or set `OTARI_API_KEY` and restart Pi; then confirm workspace access. One possible cause is a stale key saved with `/login otari`, which takes precedence over `OTARI_API_KEY`; run `/logout otari` to fall back to the environment variable. The cached model list stays in place until the key is fixed.
- **Unknown model:** the selected provider or model is not enabled in your Otari workspace. Enable it in Otari, refresh the provider, or select a different Otari model in Pi.
- **“Otari at … does not list …”:** that selector is not in the model list Otari returned for the configured URL. Its provider or model was disabled, or the model moved to another provider prefix, as with hosted Otari's retired `mzai:` prefix. Select a current model in `/model`; if the selector comes from `OTARI_MODELS`, update or remove it there.
- **“hosted model discovery is unavailable”:** The hosted `/models` endpoint returned `404` or `405`. No public catalog fallback is supported. Retry discovery when the service is available; if the error persists, contact the Otari service operator.
- **“Otari model discovery returned HTTP 404 … Set OTARI_BASE_URL=…”:** `OTARI_BASE_URL` has the wrong API prefix for that gateway. Set it to the URL shown and restart Pi. Otari 0.6.0 and newer serve `/api/v1`; older gateways served `/v1`.
- **“Could not refresh otari; showing cached models”:** this is Pi's summary. The extension's own warning next to it has the cause and, where possible, the fix.
- **Models listed that no longer exist, or new ones missing:** the list is a cache. Open `/model` to refresh it. See [The model list is a cache](#the-model-list-is-a-cache).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, testing, dependency updates, and release instructions.

## License

Apache-2.0
