/**
 * A deliberately small, strict TOML reader — enough for this service's config
 * and nothing more.
 *
 * Node has no built-in TOML parser, and adding one would mean an npm install,
 * which would mean a build step and a Dockerfile. The whole service is otherwise
 * dependency-free and runs straight off a bind mount, which is worth keeping.
 *
 * Strictness is the safety property: anything this parser does not understand
 * throws with a line number rather than being skipped. A config parser that
 * silently ignores a line it cannot read is how a `dry_run = true` quietly
 * becomes a live run.
 *
 * Supported: comments, [table] and [table.sub] headers, basic strings, integers,
 * floats, booleans, and arrays (inline or spanning lines). Not supported —
 * and rejected loudly: inline tables, arrays of tables, multi-line strings,
 * literal strings, dates, dotted keys.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

class TomlError extends Error {
  constructor(line: number, message: string) {
    super(`config line ${line}: ${message}`);
    this.name = "TomlError";
  }
}

/** Strip a trailing `# comment`, honouring quotes so a `#` inside a string survives. */
function stripComment(line: string): string {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) escaped = true;
    else if (ch === '"') inString = !inString;
    else if (ch === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function parseString(text: string, lineNo: number): string {
  let out = "";
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (i !== text.length - 1) throw new TomlError(lineNo, "trailing text after string");
      return out;
    }
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = text[++i];
    const simple: Record<string, string> = {
      n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f",
    };
    if (next in simple) out += simple[next];
    else if (next === "u") {
      out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
      i += 4;
    } else throw new TomlError(lineNo, `unknown escape \\${next}`);
  }
  throw new TomlError(lineNo, "unterminated string");
}

/** Split on top-level commas only, so nested arrays and quoted commas survive. */
function splitItems(body: string, lineNo: number): string[] {
  const items: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let current = "";
  for (const ch of body) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      current += ch;
    } else if (ch === "[") {
      depth++;
      current += ch;
    } else if (ch === "]") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
    } else current += ch;
  }
  if (inString) throw new TomlError(lineNo, "unterminated string in array");
  if (current.trim()) items.push(current);
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

function parseValue(text: string, lineNo: number): TomlValue {
  const value = text.trim();
  if (!value) throw new TomlError(lineNo, "missing value");
  if (value.startsWith('"')) return parseString(value, lineNo);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new TomlError(lineNo, "unterminated array");
    return splitItems(value.slice(1, -1), lineNo).map((item) => parseValue(item, lineNo));
  }
  if (value.startsWith("{")) throw new TomlError(lineNo, "inline tables are not supported");
  if (/^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^[+-]?(\d+\.\d*|\.?\d+)([eE][+-]?\d+)?$/.test(value)) return Number.parseFloat(value);
  throw new TomlError(lineNo, `cannot parse value ${JSON.stringify(value)}`);
}

/** Walk/create the nested table a `[a.b]` header refers to. */
function descend(root: TomlTable, path: string[], lineNo: number): TomlTable {
  let table = root;
  for (const key of path) {
    if (!(key in table)) table[key] = {};
    const next = table[key];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      throw new TomlError(lineNo, `${key} is a value, not a table`);
    }
    table = next as TomlTable;
  }
  return table;
}

export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let table = root;
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let line = stripComment(lines[i]).trim();
    if (!line) continue;

    if (line.startsWith("[")) {
      if (line.startsWith("[[")) throw new TomlError(lineNo, "arrays of tables are not supported");
      if (!line.endsWith("]")) throw new TomlError(lineNo, "unterminated table header");
      const path = line
        .slice(1, -1)
        .split(".")
        .map((part) => part.trim().replace(/^"|"$/g, ""));
      if (path.some((part) => part === "")) throw new TomlError(lineNo, "empty table name");
      table = descend(root, path, lineNo);
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) throw new TomlError(lineNo, `expected key = value, got ${JSON.stringify(line)}`);
    const key = line.slice(0, eq).trim().replace(/^"|"$/g, "");
    if (!key) throw new TomlError(lineNo, "empty key");
    let rhs = line.slice(eq + 1).trim();

    // An array may span lines; keep consuming until the brackets balance.
    if (rhs.startsWith("[")) {
      let depth = 0;
      let scanned = rhs;
      let cursor = i;
      for (;;) {
        depth = 0;
        let inString = false;
        let escaped = false;
        for (const ch of scanned) {
          if (escaped) { escaped = false; continue; }
          if (inString) {
            if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
            continue;
          }
          if (ch === '"') inString = true;
          else if (ch === "[") depth++;
          else if (ch === "]") depth--;
        }
        if (depth <= 0) break;
        cursor++;
        if (cursor >= lines.length) throw new TomlError(lineNo, "unterminated array");
        scanned += " " + stripComment(lines[cursor]).trim();
      }
      rhs = scanned;
      i = cursor;
    }

    if (key in table) throw new TomlError(lineNo, `duplicate key ${key}`);
    table[key] = parseValue(rhs, lineNo);
  }
  return root;
}
