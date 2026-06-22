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
By default it installs `@diffpal/diffpal@0.1.37`, the tested CLI release paired
with this extension. Set `diffpalVersion` only when you need to override that
default rollout.

## Behavior

`DiffPalReview@1` is a pull request validation task. When `base` and `head` are
not set explicitly, the task reads Azure PR variables, fetches the target branch,
computes `git merge-base <target> <source>`, and reviews that range. Keep
`fetchDepth: 0` on checkout so the merge-base can be computed reliably.

The task also validates optional path inputs before invoking DiffPal. Azure may
resolve unset `filePath` inputs to the workspace directory; those implicit
defaults are ignored, and explicit invalid paths fail with task-level messages.

Set `explain: true` to print the resolved PR id, branches, commits, merge-base,
base/head, and redacted CLI arguments before the review starts.

Set `debug: true` to pass `--debug` to DiffPal and enable provider/runtime
diagnostics. This is separate from Azure `System.Debug`.

With `feedback: review`, DiffPal publishes Azure threads
for all findings. Blocking findings stay active; non-blocking findings are
published as closed immediately. Findings without canonical file/line mapping to
current PR changes are skipped instead of publishing a broken file thread.

## Examples

### Minimal PR validation

```yaml
steps:
  - checkout: self
    fetchDepth: 0

  - task: UseNode@1
    inputs:
      version: "22.x"

  - script: npm install --global @openai/codex@0.139.0 @normahq/codex-acp-bridge@1.6.3
    displayName: Install Codex provider

  - script: printf '%s' "$OPENAI_API_KEY" | codex login --with-api-key
    displayName: Authenticate Codex
    env:
      OPENAI_API_KEY: $(OPENAI_API_KEY)

  - task: DiffPalReview@1
    displayName: DiffPal review
    inputs:
      diffpalVersion: 0.1.37
      profile: ci
      feedback: review
    env:
      OPENAI_API_KEY: $(OPENAI_API_KEY)
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

When blocking findings are present, the task fails with a human-readable gate
message and preserves the non-zero DiffPal exit code for pipeline control.
Transient provider failures, including empty or invalid structured review
responses after retries, also fail with a human-readable task message while
preserving DiffPal's exit code.

### Blocking gate

```yaml
steps:
  - checkout: self
    fetchDepth: 0

  - task: DiffPalReview@1
    displayName: DiffPal blocking review
    inputs:
      profile: ci
      feedback: review
      gate: true
      blockOn: high
    env:
      OPENAI_API_KEY: $(OPENAI_API_KEY)
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

### Copilot auth

```yaml
steps:
  - checkout: self
    fetchDepth: 0

  - task: UseNode@1
    inputs:
      version: "22.x"

  - script: npm install --global @normahq/codex-acp-bridge@1.6.3
    displayName: Install Copilot bridge

  - task: DiffPalReview@1
    displayName: DiffPal review with Copilot
    inputs:
      profile: ci
      feedback: review
    env:
      GITHUB_TOKEN: $(GITHUB_TOKEN)
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

### Coexist with another review engine

```yaml
steps:
  - checkout: self
    fetchDepth: 0

  - script: ./run-existing-review.sh
    displayName: Existing review engine

  - task: DiffPalReview@1
    displayName: DiffPal summary-only review
    inputs:
      profile: ci
      feedback: summary
      gate: false
    env:
      OPENAI_API_KEY: $(OPENAI_API_KEY)
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

### Explicit base/head fallback

Use explicit revisions only when you need to override the task's PR merge-base
resolution.

```yaml
steps:
  - checkout: self
    fetchDepth: 0

  - bash: |
      git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main
      echo "##vso[task.setvariable variable=DIFFPAL_BASE]$(git merge-base origin/main "$BUILD_SOURCEVERSION")"
    displayName: Resolve DiffPal base

  - task: DiffPalReview@1
    displayName: DiffPal review
    inputs:
      profile: ci
      base: $(DIFFPAL_BASE)
      head: $(Build.SourceVersion)
      explain: true
    env:
      OPENAI_API_KEY: $(OPENAI_API_KEY)
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
```

More CI examples live in the main DiffPal repo:
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
task release:set-version VERSION=0.1.39 TASK_VERSION=1.6.15
```

Publish uses the `release.yml` workflow and requires `AZURE_DEVOPS_EXT_PAT` in the `azure-devops-marketplace` GitHub Environment.

## License

MIT. Copyright 2026 Alexey Samoylov and DiffPal contributors.
