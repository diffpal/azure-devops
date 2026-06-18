# DiffPal Azure DevOps Extension

Azure DevOps Marketplace extension and pipeline task for DiffPal, the
open-source, provider-agnostic AI review system for pull requests.

This repository gives Azure Pipelines teams a Marketplace task for the same
portable DiffPal review workflow used by the CLI and GitHub Action. The review
engine stays in the main DiffPal CLI package; this repo carries the Azure task,
VSIX packaging, and Marketplace release flow.

- Marketplace item: https://marketplace.visualstudio.com/items?itemName=diffpal.diffpal
- Main DiffPal CLI repo: <https://github.com/diffpal/diffpal>
- CLI package: <https://www.npmjs.com/package/@diffpal/diffpal>
- GitHub Action wrapper: <https://github.com/diffpal/action>

## Tasks

- `DiffPalReview@1` - production task
- `DiffPalReviewDev@1` - private development task

The task installs `@diffpal/diffpal` by default and runs `diffpal review ado`.
Bring the provider recipe you want to use; the Azure review flow stays the same.

## Example

```yaml
steps:
  - checkout: self
    fetchDepth: 0

  - task: NodeTool@0
    inputs:
      versionSpec: "22.x"

  - script: npm install --global @openai/codex@0.139.0 @normahq/codex-acp-bridge@1.6.3
    displayName: Install Codex provider

  - script: printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key
    displayName: Authenticate Codex
    env:
      OPENAI_API_KEY: $(OPENAI_API_KEY)

  - task: DiffPalReview@1
    displayName: DiffPal review
    inputs:
      diffpalVersion: latest
      profile: ci
      feedback: balanced
      gate: true
    env:
      OPENAI_API_KEY: $(OPENAI_API_KEY)
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

Full CI examples live in the main DiffPal repo:
<https://github.com/diffpal/diffpal/tree/main/examples/ci/azure-pipelines>

## Development

```bash
npm ci
npm run smoke
npm run package:prod
npm run package:dev
```

VSIX files are written to `dist/`.

## Release

Set versions before tagging:

```bash
task release:set-version VERSION=0.1.19
```

Publish uses the `release.yml` workflow and requires `AZURE_DEVOPS_EXT_PAT` in the `azure-devops-marketplace` GitHub Environment.

## License

MIT. Copyright 2026 Alexey Samoylov and DiffPal contributors.
