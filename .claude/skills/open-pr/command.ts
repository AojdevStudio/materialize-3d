/**
 * Finds pull-request writes inside a Bash command, so the gate can check them.
 * Pure: it never reads files or calls gh. The gate resolves file bodies and merge state.
 *
 * Covered: `gh pr create|edit|merge`, and `gh api` POST/PATCH on `repos/O/R/pulls[/N]`
 * and PUT on `repos/O/R/pulls/N/merge`, including inside `ssh host '...'`.
 * Every `gh api graphql` call whose query is not a plain literal that provably neither
 * merges nor writes a PR comes back as a `graphql` command for the gate to refuse.
 * A REST write whose PR number is not literal comes back `unresolved`, for the gate to refuse.
 * Heredoc bodies count as inline text, and so does a file that `cat > f <<EOF` or
 * `tee f <<EOF` writes earlier in the same command, with `>>` and `tee -a` appending.
 * Any other write to a file earlier in the command makes it `changed`, for the gate to refuse.
 *
 * Limit: this is a static read of the command text. `eval "gh ..."` and `gh api "$P"`
 * build the call at run time, so the parser cannot see them. Writes by programs other than
 * shell redirects and `tee` (`sed -i`, `cp`, a script) are not seen either.
 */

export type BodySource =
  | { kind: "inline"; text: string }
  | { kind: "file"; path: string }
  /** The command writes this file before gh reads it, in a way the parser cannot follow. */
  | { kind: "changed"; path: string }
  | { kind: "missing" };

interface Base {
  /** The command segment, for messages. */
  via: string;
  /** Directory the segment runs in: the last `cd` before it, relative to the hook cwd. */
  dir?: string;
  /** Set when the segment runs on another machine over ssh. */
  host?: string;
  /** `owner/name` when the command names it. */
  repo?: string;
}

export type PrCommand =
  | (Base & { kind: "create"; title?: string; draft: boolean; body: BodySource })
  | (Base & { kind: "edit"; title?: string; body?: BodySource })
  /** `pinned`: the command itself names the repo with `-R`, a PR URL, or a literal REST path. */
  | (Base & { kind: "merge"; target?: string; pinned: boolean })
  /** `query` is the GraphQL text, or with `json` the `--input` request whose `query` field holds it. */
  | (Base & { kind: "graphql"; query: BodySource; json: boolean; operationName: boolean })
  /** A REST PR write whose target the command builds at run time, so no check can name the PR. */
  | (Base & { kind: "unresolved"; target: string });

/**
 * What a GraphQL document can do to a PR: merge it, write it (create or update), or
 * `opaque` when shell expansion in the text could turn it into either. Null means neither.
 */
export function graphqlRisk(text: string, operationName = false): "merge" | "write" | "opaque" | null {
  if (/\b(mergePullRequest|enablePullRequestAutoMerge)\b/.test(text)) return "merge";
  if (/\b(createPullRequest|updatePullRequest)\b/.test(text)) return "write";
  if (/[$`]/.test(topLevel(text).replace(/\$\w+\s*:/g, ""))) return "opaque";
  // A query cannot write. With operationName set, an expansion could add a mutation as a second operation.
  if (!operationName && !/\bmutation\b/.test(text)) return null;
  const declared = new Set([...text.matchAll(/\$(\w+)\s*:/g)].map((m) => m[1]));
  const undeclared = [...text.matchAll(/\$(\w+)/g)].some((m) => !declared.has(m[1]));
  return /\$\(|`|\$\{|\w\$/.test(text) || undeclared ? "opaque" : null;
}

/**
 * The text outside every `{...}` block, where operation types live. Braces in strings and
 * `#` comments do not count. Comments always count as top-level text, since an expansion
 * in one can end the comment.
 */
function topLevel(text: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const end = text.startsWith('"""', i) ? text.indexOf('"""', i + 3) : -1;
    const str = text.startsWith('"""', i) ? (end < 0 ? text.length : end + 3) : text[i] === '"' ? closeQuote(text, i) : -1;
    if (text[i] === "#") {
      const eol = text.indexOf("\n", i);
      out += text.slice(i, eol < 0 ? text.length : eol);
      i = eol < 0 ? text.length : eol;
    } else if (str >= 0) {
      if (depth === 0) out += text.slice(i, str);
      i = str - 1;
    } else if (text[i] === "{") depth++;
    else if (text[i] === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += text[i];
  }
  return out;
}

/** The index just past the `"` string that opens at `start`. */
function closeQuote(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === '"' || text[i] === "\n") return i + 1;
  }
  return text.length;
}

interface Token {
  text: string;
  op?: boolean;
}

/** Replaces each heredoc with a `__HEREDOC_n__` marker and returns the bodies by index. */
function liftHeredocs(command: string): { rest: string; docs: string[] } {
  const docs: string[] = [];
  const lines = command.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const pending: string[] = [];
    line = line.replace(/<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/g, (_m, _q, tag: string) => {
      pending.push(tag);
      return ` __HEREDOC_${docs.length + pending.length - 1}__ `;
    });
    out.push(line);
    for (const tag of pending) {
      const body: string[] = [];
      while (++i < lines.length && lines[i].replace(/^\t+/, "") !== tag) body.push(lines[i]);
      docs.push(body.join("\n"));
    }
  }
  return { rest: out.join("\n"), docs };
}

function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  const push = () => {
    if (has) tokens.push({ text: cur });
    cur = "";
    has = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && command[i + 1] === "\n") {
      i++;
      push();
    } else if (c === "\\" && i + 1 < command.length) {
      cur += command[++i];
      has = true;
    } else if (c === "(" || c === ")") {
      push();
    } else if ((c === "&" || c === "|") && cur.endsWith(">")) {
      cur += c;
      has = true;
    } else if (c === "\n" || c === ";" || c === "&" || c === "|") {
      push();
      if (command[i + 1] === c && c !== "\n") i++;
      tokens.push({ text: c, op: true });
    } else if (/\s/.test(c)) {
      push();
    } else {
      cur += c;
      has = true;
    }
  }
  push();
  return tokens;
}

function segments(tokens: Token[]): string[][] {
  const out: string[][] = [[]];
  for (const t of tokens) {
    if (t.op) out.push([]);
    else out.at(-1)!.push(t.text);
  }
  return out.filter((s) => s.length > 0);
}

const HEREDOC = /__HEREDOC_(\d+)__/;

/** Reads `--flag value`, `--flag=value`, and the short alias. Returns every value in order. */
function flagValues(args: string[], names: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const n of names) {
      if (a === n && i + 1 < args.length) values.push(args[++i]);
      else if (n.startsWith("--") && a.startsWith(n + "=")) values.push(a.slice(n.length + 1));
    }
  }
  return values;
}

/** Splits the attached short forms gh also reads, `-fX` and `-f=X`, into `-f X`. */
function splitAttached(args: string[], valued: string[]): string[] {
  return args.flatMap((a) => (/^-[A-Za-z]./.test(a) && valued.includes(a.slice(0, 2)) ? [a.slice(0, 2), a.slice(2).replace(/^=/, "")] : [a]));
}

function hasFlag(args: string[], names: string[]): boolean {
  return args.some((a) => names.includes(a) || names.some((n) => n.startsWith("--") && a.startsWith(n + "=") && a.slice(n.length + 1) !== "false"));
}

/** The first non-flag argument after the subcommand, skipping values of flags that take one. */
function positional(args: string[], valued: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (valued.includes(args[i])) i++;
    else if (!args[i].startsWith("-")) return args[i];
  }
  return undefined;
}

interface Ctx {
  docs: string[];
  /** Files written earlier in the command: their text, or null when the parser cannot follow the write. */
  written: Map<string, string | null>;
  dir?: string;
  host?: string;
}

/** The key a path is tracked under, so `./b.md` and `b.md` are one file. */
const fileKey = (path: string): string => path.replace(/^(?:\.\/)+/, "");

function inlineOrFile(value: string, ctx: Ctx, stdinDoc?: string): BodySource {
  const doc = value.match(HEREDOC);
  if (doc) return { kind: "inline", text: ctx.docs[Number(doc[1])] ?? "" };
  if (value === "-") return stdinDoc !== undefined ? { kind: "inline", text: stdinDoc } : { kind: "missing" };
  const written = ctx.written.get(fileKey(value));
  if (written === null) return { kind: "changed", path: value };
  if (written !== undefined) return { kind: "inline", text: written };
  return { kind: "file", path: value };
}

/** A `--body` or `body=` value is the text itself, unless it holds a heredoc or reads a file. */
function inlineText(value: string, ctx: Ctx): BodySource {
  const doc = value.match(HEREDOC);
  if (doc) return { kind: "inline", text: ctx.docs[Number(doc[1])] ?? "" };
  const file = value.trim().match(/^\$\(\s*(?:cat\s+|<\s*)([^\s)]+)\s*\)$/);
  if (file) return inlineOrFile(file[1], ctx);
  return { kind: "inline", text: value };
}

function segmentDoc(seg: string[], ctx: Ctx): string | undefined {
  for (const t of seg) {
    const m = t.match(HEREDOC);
    if (m) return ctx.docs[Number(m[1])];
  }
  return undefined;
}

const GH_VALUED = ["-R", "--repo", "-t", "--title", "-b", "--body", "-F", "--body-file", "-B", "--base", "-H", "--head", "-a", "--assignee", "-l", "--label", "-m", "--milestone", "-p", "--project", "-r", "--reviewer", "-T", "--template", "--subject", "--attach", "--add-label", "--remove-label"];

function ghPr(seg: string[], ctx: Ctx): PrCommand | null {
  const i = seg.indexOf("pr");
  const verb = seg[i + 1];
  const args = splitAttached(seg.slice(i + 2), GH_VALUED);
  const base = { via: seg.join(" ").slice(0, 120), dir: ctx.dir, host: ctx.host, repo: flagValues(args, ["-R", "--repo"]).at(-1) };
  const stdinDoc = segmentDoc(seg, ctx);
  const body = (): BodySource | undefined => {
    const file = flagValues(args, ["-F", "--body-file"]).at(-1);
    if (file !== undefined) return inlineOrFile(file, ctx, stdinDoc);
    const text = flagValues(args, ["-b", "--body"]).at(-1);
    if (text !== undefined) return inlineText(text, ctx);
    return undefined;
  };
  const title = flagValues(args, ["-t", "--title"]).at(-1);
  if (verb === "create" || verb === "new") {
    return { ...base, kind: "create", title, draft: hasFlag(args, ["-d", "--draft"]), body: body() ?? { kind: "missing" } };
  }
  if (verb === "edit") {
    const b = body();
    if (b === undefined && title === undefined) return null;
    return { ...base, kind: "edit", title, body: b };
  }
  if (verb === "merge") {
    const target = positional(args, GH_VALUED);
    return { ...base, kind: "merge", target, pinned: base.repo !== undefined || /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(target ?? "") };
  }
  return null;
}

/**
 * The query of a `gh api graphql` call. The last `query=` wins, as in gh, and `-F query=@f`
 * and `--input f` read a file. A query in a shell variable, or any field whose key is not
 * literal, is missing, because the parser cannot read it.
 */
function graphqlQuery(args: string[], seg: string[], ctx: Ctx): { query: BodySource; json: boolean } {
  let query: { query: BodySource; json: boolean } = { query: { kind: "missing" }, json: false };
  let unreadable = false;
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].startsWith("--") && args[i].includes("=") ? [args[i].slice(0, args[i].indexOf("=")), args[i].slice(args[i].indexOf("=") + 1)] : [args[i], undefined];
    if (!["-f", "--raw-field", "-F", "--field", "--input"].includes(flag)) continue;
    const value = inline ?? args[++i];
    if (value === undefined) break;
    if (flag === "--input") query = { query: inlineOrFile(value, ctx, segmentDoc(seg, ctx)), json: true };
    else if (!/^\w+(\[\w*\])*=/.test(value)) unreadable = true;
    else if (value.startsWith("query=")) {
      const v = value.slice("query=".length);
      const source = /^-F$|^--field$/.test(flag) && v.startsWith("@") ? inlineOrFile(v.slice(1), ctx, segmentDoc(seg, ctx)) : inlineText(v, ctx);
      query = { query: source.kind === "inline" && /^\$\{?\w+\}?$/.test(source.text.trim()) ? { kind: "missing" } : source, json: false };
    }
  }
  return unreadable ? { query: { kind: "missing" }, json: false } : query;
}

const API_VALUED = ["-X", "--method", "-f", "-F", "--field", "--raw-field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "--hostname", "--cache"];

/** The endpoint gh resolves: no scheme, host, Enterprise `api/v3` prefix, query string, or edge slashes. */
function apiPath(raw: string): string {
  return raw.replace(/^https?:\/\/[^/]+/i, "").replace(/\?.*$/, "").replace(/^\/+|\/+$/g, "").replace(/^api\/(?:v3\/)?/i, "");
}

function ghApi(seg: string[], ctx: Ctx): PrCommand | null {
  const args = splitAttached(seg.slice(seg.indexOf("api") + 1), API_VALUED);
  const raw = positional(args, API_VALUED);
  const path = raw === undefined ? undefined : apiPath(raw);
  if (path?.toLowerCase() === "graphql") {
    const { query, json } = graphqlQuery(args, seg, ctx);
    const operationName = args.some((a) => a.includes("operationName"));
    if (query.kind === "inline" && !json && graphqlRisk(query.text, operationName) === null) return null;
    return { via: seg.join(" ").slice(0, 120), dir: ctx.dir, host: ctx.host, kind: "graphql", query, json, operationName };
  }
  const m = path?.match(/^repos\/([^/]+\/[^/]+)\/pulls(?:\/([^/]+)(\/merge)?)?$/i);
  if (!m) return null;
  const [, repo, number, merge] = m;
  // `pulls/$PR` builds the PR number at run time, so a write there cannot be pinned to a PR.
  const unresolved = number !== undefined && !/^\d+$/.test(number);
  const fields = new Map<string, string>();
  for (const f of flagValues(args, ["-f", "-F", "--field", "--raw-field"])) {
    const eq = f.indexOf("=");
    if (eq > 0) fields.set(f.slice(0, eq), f.slice(eq + 1));
  }
  const method = (flagValues(args, ["-X", "--method"]).at(-1) ?? (fields.size > 0 || hasFlag(args, ["--input"]) ? "POST" : "GET")).toUpperCase();
  const base = { via: seg.join(" ").slice(0, 120), dir: ctx.dir, host: ctx.host, repo };
  const input = flagValues(args, ["--input"]).at(-1);
  const body = (): BodySource | undefined => {
    const raw = fields.get("body");
    if (raw !== undefined) return raw.startsWith("@") ? inlineOrFile(raw.slice(1), ctx, segmentDoc(seg, ctx)) : inlineText(raw, ctx);
    if (input !== undefined) return ctx.written.has(fileKey(input)) ? { kind: "changed", path: input } : { kind: "file", path: `json:${input}` };
    return undefined;
  };
  if (merge) {
    if (method !== "PUT") return null;
    if (unresolved) return { ...base, kind: "unresolved", target: number };
    return { ...base, kind: "merge", target: number, pinned: !repo.includes("{") && !hasFlag(args, ["--hostname"]) };
  }
  if (!number && method === "POST") {
    return { ...base, kind: "create", title: fields.get("title"), draft: fields.get("draft") === "true", body: body() ?? { kind: "missing" } };
  }
  if (number && method === "PATCH") {
    const b = body();
    const title = fields.get("title");
    if (b === undefined && title === undefined) return null;
    if (unresolved) return { ...base, kind: "unresolved", target: number };
    return { ...base, kind: "edit", title, body: b };
  }
  return null;
}

/**
 * Records the files `seg` writes. A `cat` or `tee` that reads only its heredoc writes known
 * text: `>` and plain `tee` replace it, `>>` and `tee -a` append to it. Any other write, or an
 * append to a file whose earlier text is unknown, marks the file null.
 */
function trackWrites(seg: string[], ctx: Ctx): void {
  const targets: { path: string; append: boolean; stdout: boolean }[] = [];
  const args: string[] = [];
  for (let i = 0; i < seg.length; i++) {
    const r = seg[i].match(/^(\d*)(>>|>\|?)(.*)$/);
    if (!r) args.push(seg[i]);
    else if (!r[3].startsWith("&")) {
      const path = r[3] || seg[++i];
      if (path) targets.push({ path, append: r[2] === ">>", stdout: r[1] === "" || r[1] === "1" });
    }
  }
  const cmd = args[0];
  const operands = args.slice(1).filter((a) => !a.startsWith("-") && !HEREDOC.test(a));
  const flags = args.slice(1).filter((a) => a.startsWith("-"));
  if (cmd === "tee") {
    const append = flags.some((f) => f === "--append" || /^-[a-z]*a/.test(f));
    targets.push(...operands.map((path) => ({ path, append, stdout: true })));
  }
  const doc = segmentDoc(seg, ctx);
  const known = doc !== undefined && (cmd === "tee" || (cmd === "cat" && operands.length === 0));
  for (const { path, append, stdout } of targets) {
    const key = fileKey(path);
    const before = append ? ctx.written.get(key) : "";
    ctx.written.set(key, !known || !stdout || typeof before !== "string" ? null : before === "" ? doc : `${before}\n${doc}`);
  }
}

const SSH_VALUED = ["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"];

/** Every pull-request write in `command`, in order. Empty when the command touches no PR. */
export function findPrCommands(command: string): PrCommand[] {
  if (!/\b(pr|api)\b/.test(command)) return [];
  const { rest, docs } = liftHeredocs(command);
  return scan(rest, { docs, written: new Map() });
}

function scan(command: string, ctx: Ctx): PrCommand[] {
  const found: PrCommand[] = [];
  for (let seg of segments(tokenize(command))) {
    for (const t of seg) {
      const inner = t.match(/\$\(([\s\S]*)\)/);
      if (inner && /\bgh\b/.test(inner[1])) found.push(...scan(inner[1], { ...ctx, written: new Map(ctx.written) }));
    }
    while (seg[0] && /^[A-Za-z_]\w*=/.test(seg[0])) seg = seg.slice(1);
    if (/^(?:.*\/)?(?:bash|sh|zsh)$/.test(seg[0] ?? "") && seg[1] === "-c" && seg[2]) {
      found.push(...scan(seg[2], ctx));
      continue;
    }
    if (seg[0] === "cd" && seg[1]) {
      ctx.dir = ctx.dir && !seg[1].startsWith("/") && !seg[1].startsWith("~") ? `${ctx.dir}/${seg[1]}` : seg[1];
      continue;
    }
    // The shell opens redirects before the command runs, so a segment's own writes come first.
    trackWrites(seg, ctx);
    if (seg[0] === "cat" || seg[0] === "tee") continue;
    if (seg[0] === "ssh") {
      let i = 1;
      while (i < seg.length && seg[i].startsWith("-")) i += SSH_VALUED.includes(seg[i]) ? 2 : 1;
      found.push(...scan(seg.slice(i + 1).join(" "), { docs: ctx.docs, written: new Map(), host: seg[i] }));
      continue;
    }
    const gh = seg.findIndex((t) => t === "gh" || t.endsWith("/gh"));
    if (gh < 0) continue;
    const tail = seg.slice(gh);
    const cmd = tail[1] === "pr" ? ghPr(tail, ctx) : tail[1] === "api" ? ghApi(tail, ctx) : null;
    if (cmd) found.push(cmd);
  }
  return found;
}
