# Droid v2 synthetic golden

This fixture is a sanitized structural copy of a Droid `0.199.0` session. It intentionally contains:

- one `llm_only` context message and five `user_only` Hook messages that must not become conversation content;
- two model calls separated by one `Execute` tool call;
- per-call log usage whose session totals are `input=40601`, `output=203`, and `total=40804` after cache-read and cache-creation tokens are included in input;
- a sibling `.settings.json` aggregate used only to validate the log join.

All identities, paths, prompts, outputs, and request IDs are synthetic.
