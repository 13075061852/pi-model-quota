---
name: model-quota
description: Operate and troubleshoot the Pi Model Quota extension. Use when the user asks how to view, refresh, or diagnose model quota, balance, subscription reset time, or rate-limit status in Pi.
license: MIT
compatibility: Requires Pi with the pi-model-quota extension from this package enabled.
disable-model-invocation: true
---

# Pi Model Quota

This skill documents the companion extension in this package. The extension—not this skill—runs quota probes and renders the footer.

## Commands

- `/quota` — show detailed quota, authentication mode, source, and reset times.
- `/quota refresh` — immediately refresh the current provider's account quota.
- `/quota debug` — show sanitized diagnostics without credentials or raw response headers.

## Troubleshooting

1. Run `/quota refresh`.
2. If it fails, run `/quota debug` and inspect the provider, authentication mode, credential source, endpoint binding, and sanitized error.
3. Confirm the provider is authenticated with `/login` or its expected API-key environment variable.
4. Confirm `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` are correct when a proxy is required.
5. If the footer says `上游未公开`, the provider did not expose a supported account endpoint or rate-limit response headers; do not infer or fabricate a remaining quota.

## Display semantics

- Subscription quotas show the nearest future reset time when the upstream returns one.
- API-key providers may expose account balance, request/token limits, or no quota information at all.
- Footer colors indicate remaining quota severity; `/quota` contains the complete per-window details.
