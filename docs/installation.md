# Installation

## Install from GitHub

```bash
pi install git@github.com:UnicornGlade/pi-analyst-worker-orchestrator.git
```

## Install by package name

After the package is published to npm:

```bash
pi install pi-analyst-worker-orchestrator
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
