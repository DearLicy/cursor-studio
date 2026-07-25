# Protocol fixtures

Stage 0 golden fixtures for Cursor Studio reverse-proxy / protocol work.

## Run

```bash
npm run smoke:fixtures
```

Also keep running:

```bash
npm run smoke:proto
npm run smoke:connect
npm run smoke:stream
```

## Layout

- `manifest.json` — case index
- `*.input.json` / `*.expect.json` — paired cases
- static JSON templates for stage 1 mapping work

Do not commit real API keys. Fixture keys are placeholders only.
