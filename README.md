# @easykit/csv

Zero-dependency CSV library for Bun. Parsing, generation, and streaming support.

## Install

```bash
# via git dependency
bun add github:solar-path/easykit-csv
```

## Usage

```ts
import { generateCsv, parseCsv, generateCsvStream, parseCsvStream } from "@easykit/csv";

// Generate CSV from data
const csv = generateCsv([
  { name: "Alice", age: 30 },
  { name: "Bob", age: 25 },
]);

// Parse CSV string
const data = parseCsv(csv);

// Stream large files
const stream = parseCsvStream(file.stream());
const reader = stream.getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(value); // parsed row object
}

// Generate CSV as stream
const csvStream = generateCsvStream(asyncDataIterator());
```

## API

### `generateCsv(data, options?)`
Converts an array of objects to a CSV string.

### `generateCsvStream(data, options?)`
Converts an iterable/async iterable of objects to a `ReadableStream<string>`.

### `parseCsv(input, options?)`
Parses a CSV string into an array of objects.

### `parseCsvStream(input, options?)`
Parses a `ReadableStream<Uint8Array>` or string stream into a `ReadableStream` of objects.

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `delimiter` | `","` | Field delimiter |
| `headers` | `true` | Use first row as headers, or provide custom header names |
| `encoding` | `"utf-8"` | Input/output encoding |
| `quoting` | `"minimal"` | Quote strategy: `"all"`, `"minimal"`, `"none"` |
| `escapeChar` | `"\""` | Escape character inside quoted fields |
| `lineTerminator` | `"\n"` | Line ending |
| `skipEmptyLines` | `true` | Skip empty lines during parsing |
| `onError` | `"throw"` | Error strategy: `"skip"`, `"throw"`, or `(error, row) => void` |
