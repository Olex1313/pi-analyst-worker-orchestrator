# Installation

## Install from npm

After the package is published to npm:

```bash
pi install npm:pi-analyst-worker-orchestrator
```

## Install from GitHub

```bash
pi install git:github.com/UnicornGlade/pi-analyst-worker-orchestrator
```

Pinned to a release tag:

```bash
pi install git:github.com/UnicornGlade/pi-analyst-worker-orchestrator@v0.1.1
```

## Try without installing

```bash
pi -e git:github.com/UnicornGlade/pi-analyst-worker-orchestrator
```

## Local development

From this repository:

```bash
pi -e .
```

The package registers one command:

```text
/analyst-worker
```

## Template installer

To copy optional file-based workflow templates into another project:

```bash
./scripts/install.sh /path/to/project
```

This creates `/path/to/project/ai/` with state, plan, report, review, compaction, and prompt templates.

## npm publication checklist

```bash
npm login
npm publish --access public
```

Then verify:

```bash
pi install npm:pi-analyst-worker-orchestrator
```
