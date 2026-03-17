// @easykit/csv — Zero-dependency CSV library for Bun
// Parsing, generation, and streaming with full error resilience
// Security: L1-L5 hardened (CSV injection, prototype pollution, memory limits)

// ─── Types ───────────────────────────────────────────────────────────────────

export type QuoteStrategy = "all" | "minimal" | "none";
export type ErrorStrategy = "skip" | "throw" | ((error: Error, rowIndex: number) => void);

export interface CsvOptions {
  /** Field delimiter (default: ",") */
  delimiter?: string;
  /** Use first row as headers, or provide custom header names (default: true) */
  headers?: boolean | string[];
  /** Text encoding (default: "utf-8") */
  encoding?: string;
  /** Quote strategy (default: "minimal") */
  quoting?: QuoteStrategy;
  /** Escape character inside quoted fields (default: '"') */
  escapeChar?: string;
  /** Line terminator (default: "\n") */
  lineTerminator?: string;
  /** Skip empty lines during parsing (default: true) */
  skipEmptyLines?: boolean;
  /** Error handling strategy (default: "throw") */
  onError?: ErrorStrategy;
  /** L1: Sanitize formula-triggering characters in generated output (default: true) */
  sanitizeFormulas?: boolean;
  /** L3: Maximum rows to parse — prevents OOM on huge files (default: 1_000_000) */
  maxRows?: number;
  /** L3: Maximum field length in characters (default: 1_048_576 = 1MB) */
  maxFieldLength?: number;
  /** L3: Maximum fields per row (default: 10_000) */
  maxFields?: number;
  /** L3: Maximum line buffer length in streaming mode (default: 10_485_760 = 10MB) */
  maxLineLength?: number;
}

export interface GenerateOptions extends CsvOptions {}
export interface ParseOptions extends CsvOptions {}

/** Thrown when a security limit is exceeded */
export class CsvLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvLimitError";
  }
}

// ─── Security Constants ──────────────────────────────────────────────────────

/** L1: Characters that trigger formula execution in spreadsheet applications */
const FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r"]);

/** L4: Object keys that could cause prototype pollution */
const DANGEROUS_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS = {
  delimiter: ",",
  headers: true as boolean | string[],
  encoding: "utf-8",
  quoting: "minimal" as QuoteStrategy,
  escapeChar: '"',
  lineTerminator: "\n",
  skipEmptyLines: true,
  onError: "throw" as ErrorStrategy,
  sanitizeFormulas: true,
  maxRows: 1_000_000,
  maxFieldLength: 1_048_576,
  maxFields: 10_000,
  maxLineLength: 10_485_760,
} satisfies Required<CsvOptions>;

function resolveOptions<T extends CsvOptions>(opts?: T): Required<CsvOptions> {
  return { ...DEFAULTS, ...opts };
}

// ─── Error Handling ──────────────────────────────────────────────────────────

function handleError(strategy: ErrorStrategy, error: Error, rowIndex: number): void {
  if (strategy === "throw") throw error;
  if (typeof strategy === "function") strategy(error, rowIndex);
  // "skip" — silently ignore
}

// ─── Security Helpers ────────────────────────────────────────────────────────

/** L1: Sanitize field value to prevent CSV injection / formula execution */
function sanitizeFormula(value: string): string {
  if (value.length === 0) return value;
  const firstChar = value[0]!;
  if (FORMULA_PREFIXES.has(firstChar)) {
    return "'" + value;
  }
  return value;
}

/** L4: Sanitize header key to prevent prototype pollution */
function sanitizeKey(key: string): string {
  if (DANGEROUS_KEYS.has(key)) {
    return "_" + key;
  }
  return key;
}

// ─── Quoting ─────────────────────────────────────────────────────────────────

function quoteField(value: string, delimiter: string, quoting: QuoteStrategy, escapeChar: string, lineTerminator: string, sanitize: boolean): string {
  let val = value;

  // L1: Sanitize formula-triggering prefixes
  if (sanitize) {
    val = sanitizeFormula(val);
  }

  if (quoting === "none") return val;

  const needsQuoting =
    quoting === "all" ||
    val.includes(delimiter) ||
    val.includes('"') ||
    val.includes(lineTerminator) ||
    val.includes("\r");

  if (!needsQuoting) return val;

  const escaped = val.replaceAll('"', escapeChar + '"');
  return `"${escaped}"`;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// ─── Generation ──────────────────────────────────────────────────────────────

/**
 * Convert an array of objects to a CSV string.
 */
export function generateCsv(data: Record<string, unknown>[], options?: GenerateOptions): string {
  const opts = resolveOptions(options);
  if (data.length === 0) return "";

  const headers = Array.isArray(opts.headers)
    ? opts.headers
    : opts.headers
      ? Object.keys(data[0]!)
      : null;

  const lines: string[] = [];

  if (headers) {
    lines.push(
      headers
        .map((h) => quoteField(h, opts.delimiter, opts.quoting, opts.escapeChar, opts.lineTerminator, opts.sanitizeFormulas))
        .join(opts.delimiter)
    );
  }

  for (let i = 0; i < data.length; i++) {
    const row = data[i]!;
    try {
      const keys = headers ?? Object.keys(row);
      const values = keys.map((key) => {
        const raw = stringifyValue(row[key]);
        return quoteField(raw, opts.delimiter, opts.quoting, opts.escapeChar, opts.lineTerminator, opts.sanitizeFormulas);
      });
      lines.push(values.join(opts.delimiter));
    } catch (err: unknown) {
      handleError(opts.onError, err instanceof Error ? err : new Error(String(err)), i);
    }
  }

  return lines.join(opts.lineTerminator);
}

/**
 * Convert an iterable or async iterable of objects to a ReadableStream of CSV text.
 */
export function generateCsvStream(
  data: Iterable<Record<string, unknown>> | AsyncIterable<Record<string, unknown>>,
  options?: GenerateOptions
): ReadableStream<string> {
  const opts = resolveOptions(options);

  return new ReadableStream<string>({
    async start(controller) {
      let headersSent = false;
      let headers: string[] | null = null;
      let rowIndex = 0;

      try {
        for await (const row of data as AsyncIterable<Record<string, unknown>>) {
          // Resolve headers from first row if needed
          if (!headersSent) {
            headers = Array.isArray(opts.headers)
              ? opts.headers
              : opts.headers
                ? Object.keys(row)
                : null;

            if (headers) {
              controller.enqueue(
                headers
                  .map((h) => quoteField(h, opts.delimiter, opts.quoting, opts.escapeChar, opts.lineTerminator, opts.sanitizeFormulas))
                  .join(opts.delimiter) + opts.lineTerminator
              );
            }
            headersSent = true;
          }

          try {
            const keys = headers ?? Object.keys(row);
            const values = keys.map((key) => {
              const raw = stringifyValue(row[key]);
              return quoteField(raw, opts.delimiter, opts.quoting, opts.escapeChar, opts.lineTerminator, opts.sanitizeFormulas);
            });
            controller.enqueue(values.join(opts.delimiter) + opts.lineTerminator);
          } catch (err: unknown) {
            handleError(opts.onError, err instanceof Error ? err : new Error(String(err)), rowIndex);
          }
          rowIndex++;
        }
      } catch (err: unknown) {
        controller.error(err instanceof Error ? err : new Error(String(err)));
        return;
      }

      controller.close();
    },
  });
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Detect delimiter from the first line of CSV content.
 */
function detectDelimiter(firstLine: string): string {
  const candidates = [",", ";", "\t", "|"];
  let best = ",";
  let bestCount = 0;

  for (const d of candidates) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }

  return best;
}

/**
 * Parse a single CSV line respecting quoted fields.
 * Returns array of field values.
 * L3: Enforces maxFields and maxFieldLength limits.
 */
function parseLine(line: string, delimiter: string, escapeChar: string, maxFields: number, maxFieldLength: number): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i]!;

    if (inQuotes) {
      if (char === '"') {
        // Check for escaped quote
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        }
        // Check for escape char (if different from quote)
        if (escapeChar !== '"' && i > 0 && line[i - 1] === escapeChar) {
          current += '"';
          i++;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      current += char;
      i++;

      // L3: Field length limit
      if (current.length > maxFieldLength) {
        throw new CsvLimitError(`Field exceeds maximum length of ${maxFieldLength} characters`);
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (char === delimiter || (delimiter.length > 1 && line.substring(i, i + delimiter.length) === delimiter)) {
        fields.push(current);
        current = "";
        i += delimiter.length;

        // L3: Fields per row limit
        if (fields.length > maxFields) {
          throw new CsvLimitError(`Row exceeds maximum of ${maxFields} fields`);
        }
        continue;
      }
      current += char;
      i++;

      // L3: Field length limit
      if (current.length > maxFieldLength) {
        throw new CsvLimitError(`Field exceeds maximum length of ${maxFieldLength} characters`);
      }
    }
  }

  fields.push(current);
  return fields;
}

/**
 * Split CSV text into lines, respecting quoted fields that contain newlines.
 */
function splitLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (char === '"') {
      if (inQuotes && i + 1 < text.length && text[i + 1] === '"') {
        current += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && i + 1 < text.length && text[i + 1] === "\n") {
        i++; // skip \r\n
      }
      lines.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines;
}

/**
 * L4: Build a safe row object using Object.create(null) and sanitized keys.
 */
function buildRow(headers: string[], fields: string[]): Record<string, string> {
  const row: Record<string, string> = Object.create(null) as Record<string, string>;

  for (let j = 0; j < headers.length; j++) {
    const key = sanitizeKey(headers[j]!);
    row[key] = fields[j] ?? "";
  }

  // Include extra fields beyond headers
  for (let j = headers.length; j < fields.length; j++) {
    row[String(j)] = fields[j]!;
  }

  return row;
}

/**
 * Parse a CSV string into an array of objects.
 */
export function parseCsv(input: string, options?: ParseOptions): Record<string, string>[] {
  const opts = resolveOptions(options);

  // Strip BOM
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const lines = splitLines(text);

  if (lines.length === 0) return [];

  // Auto-detect delimiter if first line available
  const effectiveDelimiter = opts.delimiter === DEFAULTS.delimiter
    ? detectDelimiter(lines[0]!)
    : opts.delimiter;

  let headers: string[];
  let startIndex: number;

  if (Array.isArray(opts.headers)) {
    headers = opts.headers.map(sanitizeKey);
    startIndex = 0;
  } else if (opts.headers) {
    headers = parseLine(lines[0]!, effectiveDelimiter, opts.escapeChar, opts.maxFields, opts.maxFieldLength)
      .map((h) => sanitizeKey(h.trim()));
    startIndex = 1;
  } else {
    // Generate numeric headers (safe — no prototype pollution risk)
    const firstFields = parseLine(lines[0]!, effectiveDelimiter, opts.escapeChar, opts.maxFields, opts.maxFieldLength);
    headers = firstFields.map((_, i) => String(i));
    startIndex = 0;
  }

  const results: Record<string, string>[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i]!;

    if (opts.skipEmptyLines && line.trim() === "") continue;

    // L3: Row count limit
    if (results.length >= opts.maxRows) {
      handleError(opts.onError, new CsvLimitError(`Exceeded maximum row limit of ${opts.maxRows}`), i);
      break;
    }

    try {
      const fields = parseLine(line, effectiveDelimiter, opts.escapeChar, opts.maxFields, opts.maxFieldLength);
      results.push(buildRow(headers, fields));
    } catch (err: unknown) {
      handleError(opts.onError, err instanceof Error ? err : new Error(String(err)), i);
    }
  }

  return results;
}

/**
 * Parse a ReadableStream of CSV data into a ReadableStream of parsed row objects.
 * Handles chunked input correctly — incomplete lines are buffered across chunks.
 */
export function parseCsvStream(
  input: ReadableStream<Uint8Array | string>,
  options?: ParseOptions
): ReadableStream<Record<string, string>> {
  const opts = resolveOptions(options);
  const decoder = new TextDecoder(opts.encoding);

  let buffer = "";
  let headers: string[] | null = null;
  let headersResolved = false;
  let effectiveDelimiter = opts.delimiter;
  let rowIndex = 0;

  return new ReadableStream<Record<string, string>>({
    async start(controller) {
      const reader = input.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            // Process remaining buffer
            if (buffer.trim().length > 0) {
              processLine(buffer, controller);
            }
            controller.close();
            return;
          }

          const chunk = typeof value === "string" ? value : decoder.decode(value, { stream: true });

          // Strip BOM from first chunk
          buffer += rowIndex === 0 && buffer.length === 0 && chunk.charCodeAt(0) === 0xfeff
            ? chunk.slice(1)
            : chunk;

          // L3: Buffer size limit
          if (buffer.length > opts.maxLineLength) {
            handleError(opts.onError, new CsvLimitError(`Line buffer exceeds maximum of ${opts.maxLineLength} characters`), rowIndex);
            buffer = "";
            continue;
          }

          // Process complete lines
          const lines = splitBufferLines();

          for (const line of lines) {
            if (opts.skipEmptyLines && line.trim() === "") continue;

            if (!headersResolved) {
              effectiveDelimiter = opts.delimiter === DEFAULTS.delimiter
                ? detectDelimiter(line)
                : opts.delimiter;

              if (Array.isArray(opts.headers)) {
                headers = opts.headers.map(sanitizeKey);
                processLine(line, controller);
              } else if (opts.headers) {
                headers = parseLine(line, effectiveDelimiter, opts.escapeChar, opts.maxFields, opts.maxFieldLength)
                  .map((h) => sanitizeKey(h.trim()));
              } else {
                const firstFields = parseLine(line, effectiveDelimiter, opts.escapeChar, opts.maxFields, opts.maxFieldLength);
                headers = firstFields.map((_, i) => String(i));
                processLine(line, controller);
              }
              headersResolved = true;
              continue;
            }

            // L3: Row count limit
            if (rowIndex >= opts.maxRows) {
              handleError(opts.onError, new CsvLimitError(`Exceeded maximum row limit of ${opts.maxRows}`), rowIndex);
              controller.close();
              return;
            }

            processLine(line, controller);
          }
        }
      } catch (err: unknown) {
        controller.error(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });

  function splitBufferLines(): string[] {
    const lines: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < buffer.length; i++) {
      const char = buffer[i]!;

      if (char === '"') {
        if (inQuotes && i + 1 < buffer.length && buffer[i + 1] === '"') {
          current += '""';
          i++;
          continue;
        }
        inQuotes = !inQuotes;
        current += char;
        continue;
      }

      if (!inQuotes && (char === "\n" || char === "\r")) {
        if (char === "\r" && i + 1 < buffer.length && buffer[i + 1] === "\n") {
          i++;
        }
        lines.push(current);
        current = "";
        continue;
      }

      current += char;
    }

    // Keep incomplete line in buffer
    buffer = current;
    return lines;
  }

  function processLine(line: string, controller: ReadableStreamDefaultController<Record<string, string>>): void {
    if (!headers) return;

    try {
      const fields = parseLine(line, effectiveDelimiter, opts.escapeChar, opts.maxFields, opts.maxFieldLength);
      controller.enqueue(buildRow(headers, fields));
      rowIndex++;
    } catch (err: unknown) {
      handleError(opts.onError, err instanceof Error ? err : new Error(String(err)), rowIndex);
      rowIndex++;
    }
  }
}
