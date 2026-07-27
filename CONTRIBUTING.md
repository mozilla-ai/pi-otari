# Contributing to Pi Otari

## Requirements

- Node.js 22.19.0 or newer
- npm
- [Pi](https://pi.dev) installed and available as `pi`
- An Otari API key for local integration testing

## Set up the repository

```bash
git clone https://github.com/mozilla-ai/pi-otari.git
cd pi-otari
npm ci
```

`npm ci` installs the exact dependency versions recorded in `package-lock.json`. Use `npm install` only when intentionally changing dependencies or updating the lockfile.

## Validate changes

Run the complete local validation suite before opening a pull request:

```bash
npm run check
```

This checks formatting, lint rules, TypeScript types, and the test suite.

## Test the extension locally

Load the extension directly from the repository:

```bash
OTARI_API_KEY=tk_example pi -e ./src/index.ts
```

If the npm package is already installed, disable it temporarily with `pi config` so Pi does not load both the published and local copies.

To test against self-hosted Otari, set the base URL for the same command:

```bash
OTARI_API_KEY=your_otari_key \
OTARI_BASE_URL=https://otari.example.com/v1 \
pi -e ./src/index.ts
```

## Change dependencies

Use `npm install` when adding, removing, or upgrading dependencies, and commit both `package.json` and `package-lock.json` when they change. Run `npm run check` after updating dependencies.

## Open a pull request

- Keep changes focused on one concern.
- Do not commit API keys or other credentials.
- Include tests or documentation when behavior changes.
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
