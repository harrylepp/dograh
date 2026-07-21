# Dograh - Project Overview

Dograh is a voice AI platform for building and deploying conversational AI agents with telephony and WebRTC support.

## Project Structure

```
dograh/
├── api/              # Backend - FastAPI application
├── ui/               # Frontend - Next.js application
├── scripts/          # Helper scripts for local development
├── docs/             # Mintlify documentation
├── pipecat/          # Pipecat framework (git submodule)
├── docker-compose.yaml       # Production/OSS deployment
├── docker-compose-local.yaml # Local development services
```

## Tech Stack

- **Backend**: Python with FastAPI
- **Frontend**: Next.js 15 with React 19, TypeScript, Tailwind CSS
- **Database**: PostgreSQL with SQLAlchemy (async)
- **Cache/Queue**: Redis with ARQ for background tasks
- **Storage**: MinIO (S3-compatible) for audio files

## Local Development

Contributor setup and service startup are documented in `docs/contribution/setup.mdx`.

## Environment Configuration

- `api/.env` - Backend environment variables. Source this when running repo-owned backend scripts against the dev DB (e.g. `python -m scripts.dump_docs_openapi`).
- `api/.env.test` - Test-only environment variables. Source this when running pytest so tests hit the test DB and never the dev/prod credentials in `api/.env`.
- `ui/.env` - Frontend environment variables

Typical invocation:

```bash
# Tests
source venv/bin/activate && set -a && source api/.env.test && set +a && python -m pytest api/tests/...

# Backend scripts
source venv/bin/activate && set -a && source api/.env && set +a && python -m scripts.dump_docs_openapi
```

## Codebase Knowledge Graph (graphify)

A persistent knowledge graph of this repo lives in `graphify-out/`. Use it for codebase questions instead of reading files end-to-end - one query answers what would otherwise cost many file reads and follow-up questions.

**Scope**: full repo minus the `pipecat/` submodule. 11,745 nodes, 27,689 edges, 596 communities, 26 hyperedges. Built from 1,034 code files (AST, deterministic, free) + 216 docs (semantic, subagent-extracted). 74 images and 6 audio fixtures are not yet in the graph - add with `graphify --update` if needed.

**When to use it** (preferred over ad-hoc file reading):
- "How does X work?" / "What calls Y?" / "Trace the data flow through Z"
- "What's the relationship between A and B?"
- Finding cross-module connections, god nodes, import cycles

**Commands** (run from repo root):
```bash
graphify query "how does campaign orchestration connect to telephony providers?"  # BFS, broad context
graphify query "..." --dfs          # trace a specific path
graphify query "..." --budget 1500  # cap answer tokens
graphify path "WorkflowGraph" "TwilioProvider"   # shortest path between two concepts
graphify explain "PipecatEngine"    # plain-language explanation of a node
```

**Refresh after code changes**:
```bash
graphify --update          # incremental - re-extract only new/changed files
graphify --cluster-only    # rerun clustering on existing graph
```

Outputs: `graphify-out/graph.html` (interactive, community-aggregated), `graphify-out/GRAPH_REPORT.md` (audit report with god nodes, surprising connections, suggested questions), `graphify-out/graph.json` (raw data).

Core abstractions (god nodes): `BaseModel`, `UserModel`, `HTTPException`, `PipecatEngine`, `WorkflowGraph`, `cn()`, `UserConfigurationValidator`, `ServiceProviders`, `WorkflowRunMode`, `ReactFlowDTO`.
