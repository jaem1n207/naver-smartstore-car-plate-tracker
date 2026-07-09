# ADR 0001: Use a Sheets-first worker for MVP

## Context

The operator needs a low-friction way to inspect registered products, extracted vehicle plate numbers, duplicates, and extraction failures.

## Decision

Use a single Node.js worker and Google Sheets as the MVP state and review surface.

## Alternatives Considered

- SQLite plus generated Sheets views: better local state, but adds backup and migration work.
- Postgres-backed service: more scalable, but unnecessary for two stores and a small sync workload.

## Consequences

The implementation must preserve manually editable columns during upsert and keep derived views deterministic.
