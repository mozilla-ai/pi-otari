# Contributing to Pi Otari

## Requirements

- Node.js 22.19.0 or newer
- npm
- [Pi](https://pi.dev) 0.81.0 or newer, installed and available as `pi`
- An Otari API key for local integration testing

## Set up the repository

```bash
git clone https://github.com/mozilla-ai/pi-otari.git
cd pi-otari
npm ci
```

`npm ci` installs the exact dependency versions recorded in `package-lock.json`. Use `npm install` only when intentionally changing dependencies or updating the lockfile. Pi core packages stay pinned in `devDependencies` for tests but must use `"*"` in `peerDependencies`; host-version compatibility is enforced by the extension's runtime check.

## Validate changes

Run the complete local validation suite before opening a pull request:

```bash
npm run check
```

This checks formatting, lint rules, TypeScript types, and the test suite.

## Test the extension locally

Load the extension directly from the repository:

```bash
pi -e ./src/index.ts
```

Then run `/login otari` and enter a disposable test key in Pi's secret authentication prompt. The prompt is separate from chat; never paste a credential into a normal conversation message. For deterministic noninteractive testing, continue to use:

```bash
OTARI_API_KEY=tk_example pi -e ./src/index.ts
```

If the npm package is already installed, disable it temporarily with `pi config`, or pass `--no-extensions` so only the explicit `-e` path loads; otherwise Pi loads both the published and local copies.

To test against self-hosted Otari, set the base URL for the same command. The value must include the gateway's API prefix, `/api/v1` for Otari 0.6.0 and newer:

```bash
OTARI_API_KEY=your_otari_key \
OTARI_BASE_URL=https://otari.example.com/api/v1 \
pi -e ./src/index.ts
```

NOTE: `pi --list-models otari` only prints Pi's cached catalog. To exercise discovery, open `/model` in the interactive session. To exercise inference without discovery, pass a selector through `OTARI_MODELS` and run one prompt in print mode:

```bash
OTARI_MODELS=<model id> pi --no-extensions -e ./src/index.ts --no-session -p \
  --model "otari/<model id>" "Reply with exactly: ok"
```


## Check compatibility with a live gateway

`npm run test:live` runs the extension against a real Otari gateway and stops at the first failing stage, printing the gateway's own reason where there is one. It sends two requests to the model list and two completions capped at the output bound. Run it before requesting review when a change touches discovery, the provider, streaming, or URL handling; the offline suite behind `npm run check` needs no credentials and is what CI runs.

The stages, in order:

1. **configuration**: the variables below are read, with the token and URL going through the extension's own configuration parser, so a URL the extension would reject fails here with its reason.
2. **extension loads in a Pi session**: Pi loads `src/index.ts` by path, the way `pi -e` does, into a session whose state lives in temporary directories. Fails when the extension registers no provider.
3. **model discovery through the extension**: Pi refreshes the Otari catalog over the network. Fails with the extension's own diagnostic, or when the configured model is missing from the list, naming the current selector when the same model is listed under another prefix. Also reports which capability fields Otari returned for the model and what Pi registered.
4. **non-streaming completion**: one plain request outside Pi. Otari's reason for a rejection travels in a `detail` field that Pi's client does not display, so this stage shows it.
5. **streaming completion through Pi**: one prompt through Pi's agent loop, the extension's stream wrapper, and pi-ai's streaming client, with the model's output capped at the configured bound. Fails on an error reply, a truncated reply, or more than one request for the prompt.

| Variable | Default | Description |
|---|---|---|
| `OTARI_LIVE_TEST_TOKEN` | required | API key for the gateway under test. Use a disposable key. |
| `OTARI_LIVE_TEST_MODEL` | required | A selector that gateway lists. Prefer an instruct model: reasoning models spend the output cap before producing text. |
| `OTARI_LIVE_TEST_BASE_URL` | `https://api.otari.ai/api/v1` | Gateway URL including its API prefix. |
| `OTARI_LIVE_TEST_MAX_TOKENS` | `8` | Output cap for both completions. |
| `OTARI_LIVE_TEST_REASONING` | unset | One of `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Otari does not yet mark models as reasoning-capable, so the run marks the selected model itself and sends the level. Raise the output cap alongside it. |

Against hosted Otari:

```bash
OTARI_LIVE_TEST_TOKEN=your_otari_key \
OTARI_LIVE_TEST_MODEL=nebius:Qwen/Qwen3-30B-A3B-Instruct-2507 \
npm run test:live
```

Against a gateway on your machine, with a reasoning model:

```bash
OTARI_LIVE_TEST_TOKEN=your_local_key \
OTARI_LIVE_TEST_BASE_URL=http://localhost:8000/api/v1 \
OTARI_LIVE_TEST_MODEL=llamafile:qwen3.8-flash-next-reasoner \
OTARI_LIVE_TEST_REASONING=low \
OTARI_LIVE_TEST_MAX_TOKENS=512 \
npm run test:live
```

The script removes every `OTARI_*` variable from its own environment and sets the live token and URL before Pi loads the extension, so the `OTARI_*` variables in your shell do not affect the run. Nothing under `~/.pi` is read or written.

## Change dependencies

Use `npm install` when adding, removing, or upgrading dependencies, and commit both `package.json` and `package-lock.json` when they change. Run `npm run check` after updating dependencies.

## Open a pull request

- Keep changes focused on one concern.
- Do not commit API keys or other credentials.
- Include tests or documentation when behavior changes.
- For a change to discovery, the provider, streaming, or URL handling, run `npm run test:live` against hosted Otari, and against a self-hosted gateway if you have one, and paste its `ok -` lines in the pull request description.
- Confirm the `Validate package` GitHub Actions job passes.

## Release a version

Releases are published to npm through GitHub Actions and npm trusted publishing.

1. Update `package.json` and `package-lock.json` together:

   ```bash
   npm version <version> --no-git-tag-version
   ```

2. Open and merge the version pull request after CI passes.
3. Publish a GitHub Release whose tag exactly matches `v<version>`.
4. Verify the `Publish to npm` workflow succeeds.
5. Verify the published version and distribution tags:

   ```bash
   npm view @mozilla-ai/pi-otari version dist-tags --json
   ```

Publishing the GitHub Release triggers the npm workflow; pushing a tag alone does not. Stable releases publish with the npm tag `latest`, while GitHub prereleases publish with `next`. Do not run `npm publish` manually for normal releases.
