# @easykit/csv

Shared CSV package — parsing, generation, streaming. Zero npm dependencies, Bun runtime.

## Principles
- Zero npm dependencies — Bun built-in APIs only
- TypeScript strict mode, no `any`, use `unknown` + narrowing
- Error resilience — corrupted rows, encoding issues never crash the process
- Web Streams API for large files
- All parameters via options objects

## API
- `generateCsv(data, options?)` — array of objects → CSV string
- `generateCsvStream(data, options?)` — iterable/async iterable → ReadableStream
- `parseCsv(input, options?)` — CSV string → array of objects
- `parseCsvStream(input, options?)` — ReadableStream → ReadableStream of objects

## Testing
```bash
bun test
```
