import { baseUrl, type Config } from "./config.js";

/**
 * GDPR Compliance Content Sanitization.
 *
 * Every tool result is passed through a local PII token-classification model
 * (bardsai/eu-pii-anonimization-multilang, run in-process from its ONNX weights
 * via transformers.js) before it is handed to the LLM. Detected spans are
 * replaced with a numbered placeholder naming the entity type, e.g.
 * "[PERSON_NAME_1]". Numbers are stable for the life of the server process, so
 * the same value gets the same placeholder in every tool result.
 * Nothing is sent to a third party — the model runs on this machine.
 *
 * Two safety nets cover what the model misses: well-defined formats (emails,
 * IBANs, IPs, international phone numbers) are also matched by pattern, and any
 * value detected once is redacted everywhere else in the same result — so a
 * requester name recognized in its own field is also removed from comment text.
 *
 * The sanitizer fails closed: if the model can't be loaded, tools return an
 * error instead of unredacted data.
 */

/**
 * Window length, including <s> and </s>. XLM-R accepts 512, but the model's
 * training length isn't documented; 256 keeps inputs close to typical NER
 * training data and measured no slower.
 */
const MAX_SEQ_TOKENS = 256;
const MAX_CONTENT_TOKENS = MAX_SEQ_TOKENS - 2;
/**
 * Sequences per forward pass. Quantized weights use dynamic activation scales
 * computed over the whole batch, so batching would make one text's redaction
 * depend on its neighbours — they run one sequence at a time instead.
 */
const batchSize = (dtype: string) => (dtype === "fp32" || dtype === "fp16" ? 8 : 1);

/** Timestamps like 2024-05-01T12:34:56Z — Zendesk metadata, never PII. */
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const WORD_CHAR = /[\p{L}\p{N}]/u;
/** Joiners a redaction is widened across when flanked by letters/digits: "jean-luc", "a.b@c.de". */
const CONNECTOR = /[.@+\-']/;
/** Punctuation a token can carry ("78)," or "(tel") that isn't part of the value. */
const LEADING_PUNCT = /[(\[{<"'«„“]/;
const TRAILING_PUNCT = /[)\]}>"'»“”,.;:!?]/;
/** Separators allowed between two same-type spans that are merged into one placeholder. */
const MERGEABLE_GAP = /^[\s.\-@_+/()]{0,3}$/;
/** Types too generic to redact everywhere they appear as plain words. */
const NO_PROPAGATE = new Set(["PERSON_ATTRIBUTE", "PERSON_ROLE_OR_TITLE", "FINANCIAL_AMOUNT"]);

/** Formats matched by pattern in addition to the model, named with the model's labels. */
const PATTERNS: Array<{ type: string; re: RegExp; valid?: (m: string) => boolean }> = [
  { type: "EMAIL_ADDRESS", re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu },
  {
    type: "BANK_ACCOUNT_IDENTIFIER",
    re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
    valid: ibanChecksumOk,
  },
  {
    type: "IP_ADDRESS",
    // Not after "version"/"v" — "version 10.2.3.4" is a version number.
    re: /(?<!\b(?:[vV]|[vV]er\.?|[vV]ersion)\s?)(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.]*\d)/g,
  },
  {
    type: "PAYMENT_CARD",
    re: /(?<![\d-])\d(?:[ -]?\d){12,18}(?![\d-])/g,
    valid: luhnOk,
  },
  {
    type: "PHONE_NUMBER",
    re: /(?<![\w+])\+\d{1,3}(?:[ .\-/]?\(?\d+\)?){2,6}(?!\w)/g,
    valid: (m) => (m.match(/\d/g)?.length ?? 0) >= 8,
  },
];

export class SanitizationUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "GDPR Compliance Content Sanitization is enabled but the PII model could " +
        `not be loaded (${cause instanceof Error ? cause.message : String(cause)}). ` +
        "No data was returned. Fix the model download (see ZENDESK_GDPR_MODEL_DIR), " +
        "or set ZENDESK_GDPR_SANITIZATION=false to disable sanitization."
    );
    this.name = "SanitizationUnavailableError";
  }
}

/** Map with insertion-order eviction once `max` entries are exceeded. */
class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly max: number) {
    super();
  }
  override set(key: K, value: V): this {
    if (this.has(key)) this.delete(key);
    super.set(key, value);
    if (this.size > this.max) this.delete(this.keys().next().value as K);
    return this;
  }
}

interface Engine {
  tokenizer: any;
  model: any;
  Tensor: any;
  id2label: Record<string, string>;
  /** Class index of the "O" (not PII) label. */
  outsideId: number;
  padId: number;
  bosId: number;
  eosId: number;
}

/** One token of a text, with its character span in the original string. */
interface Token {
  id: number;
  start: number;
  end: number;
  /** Index of the whitespace-delimited word the token belongs to. */
  word: number;
}

interface Span {
  start: number;
  end: number;
  type: string;
}

export class PiiSanitizer {
  private engine: Promise<Engine> | null = null;
  /** Text → the PII spans detected in it. */
  private readonly detected = new BoundedMap<string, Span[]>(10_000);
  /** Sanitized instance URL → original, so the LLM can hand URLs back to tools. */
  private readonly urlOriginals = new BoundedMap<string, string>(10_000);
  /** Normalized value → its numbered placeholder, e.g. "[PERSON_NAME_3]". */
  private readonly pseudonyms = new BoundedMap<string, string>(50_000);
  /** Last number handed out per entity type. */
  private readonly pseudonymCounts = new Map<string, number>();
  /** Matches every allowlisted term as a whole word, or null if there are none. */
  private readonly allowlist: RegExp | null;

  constructor(private readonly cfg: Config) {
    const terms = [...cfg.gdpr.allowlist]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp);
    this.allowlist = terms.length
      ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.join("|")})(?![\\p{L}\\p{N}])`, "giu")
      : null;
  }

  get enabled(): boolean {
    return this.cfg.gdpr.enabled;
  }

  /**
   * Load (downloading on first use) the tokenizer and model. Concurrent callers
   * share one load; a failed load is retried on the next call.
   */
  load(): Promise<Engine> {
    if (!this.engine) {
      this.engine = this.loadEngine().catch((err) => {
        this.engine = null;
        throw new SanitizationUnavailableError(err);
      });
    }
    return this.engine;
  }

  private async loadEngine(): Promise<Engine> {
    const { AutoTokenizer, AutoModelForTokenClassification, Tensor, env } =
      await import("@huggingface/transformers");
    const { model: modelId, dtype, modelDir } = this.cfg.gdpr;
    env.cacheDir = modelDir;

    const logged = new Map<string, number>();
    const progress_callback = (p: any) => {
      if (p.status !== "progress" || !p.total || p.total < 50_000_000) return;
      const pct = Math.floor(p.progress / 10) * 10;
      if ((logged.get(p.file) ?? -1) >= pct) return;
      logged.set(p.file, pct);
      console.error(
        `[gdpr] loading ${modelId}/${p.file}: ${pct}% of ${Math.round(p.total / 1e6)} MB`
      );
    };

    const tokenizer: any = await AutoTokenizer.from_pretrained(modelId, {
      cache_dir: modelDir,
      progress_callback,
    });
    const model: any = await AutoModelForTokenClassification.from_pretrained(modelId, {
      cache_dir: modelDir,
      dtype: dtype as any,
      device: "cpu",
      progress_callback,
    });
    const id2label: Record<string, string> = model.config.id2label;
    return {
      tokenizer,
      model,
      Tensor,
      id2label,
      outsideId: Number(Object.keys(id2label).find((k) => id2label[k] === "O") ?? 0),
      padId: tokenizer.pad_token_id ?? 1,
      bosId: tokenizer.bos_token_id ?? tokenizer.cls_token_id ?? 0,
      eosId: tokenizer.eos_token_id ?? tokenizer.sep_token_id ?? 2,
    };
  }

  /** Return a deep copy of `data` with PII redacted from every string in it. */
  async sanitize<T>(data: T): Promise<T> {
    if (!this.enabled) return data;
    const texts = new Set<string>();
    this.walk(data, (s) => {
      for (const t of this.textsOf(s)) texts.add(t);
      return s;
    });
    const found = await this.detect([...texts]);

    // Everything detected anywhere in this result is redacted everywhere in it.
    const known = propagationPattern(found);
    const clean = (text: string) => {
      const spans = found.get(text);
      if (!spans) return text;
      const all = known ? [...spans, ...this.allow(text, matchKnown(text, known))] : spans;
      return redact(text, all, (value, type) => this.placeholder(value, type));
    };
    return this.walk(data, (s) => this.rebuild(s, clean)) as T;
  }

  /** Redact PII from a single string. */
  async sanitizeText(text: string): Promise<string> {
    return this.sanitize(text);
  }

  /**
   * Map a URL the LLM got from a sanitized result back to the real one (its
   * query string or filename may have been redacted). Unknown URLs pass through.
   */
  restoreUrl(url: string): string {
    return this.urlOriginals.get(url) ?? url;
  }

  /** "[TYPE_n]", numbered per distinct value, or plain "[TYPE]" with pseudonyms off. */
  private placeholder(value: string, type: string): string {
    if (!this.cfg.gdpr.pseudonyms) return `[${type}]`;
    // "Marie  Dubois", "marie dubois" and "Marie-Dubois" are the same person.
    const key = value.normalize("NFKC").toLowerCase().replace(/[\s_.-]+/g, " ").trim();
    let name = this.pseudonyms.get(key);
    if (!name) {
      const n = (this.pseudonymCounts.get(type) ?? 0) + 1;
      this.pseudonymCounts.set(type, n);
      name = `[${type}_${n}]`;
      this.pseudonyms.set(key, name);
    }
    return name;
  }

  /** Remove the parts of `spans` that cover an allowlisted term. */
  private allow(text: string, spans: Span[]): Span[] {
    if (!this.allowlist || spans.length === 0) return spans;
    const ranges = [...text.matchAll(this.allowlist)].map((m) => [
      m.index!,
      m.index! + m[0].length,
    ]);
    if (ranges.length === 0) return spans;
    const out: Span[] = [];
    for (const s of spans) {
      let pieces = [{ ...s }];
      for (const [a, b] of ranges) {
        pieces = pieces.flatMap((p) =>
          b <= p.start || a >= p.end
            ? [p]
            : [
                { start: p.start, end: a, type: p.type },
                { start: b, end: p.end, type: p.type },
              ]
        );
      }
      for (const p of pieces) {
        while (p.start < p.end && /\s/.test(text[p.start])) p.start++;
        while (p.end > p.start && /\s/.test(text[p.end - 1])) p.end--;
        if (WORD_CHAR.test(text.slice(p.start, p.end))) out.push(p);
      }
    }
    return out;
  }

  /* ----------------------------- traversal ----------------------------- */

  private walk(value: unknown, fn: (s: string) => string): unknown {
    if (typeof value === "string") return fn(value);
    if (Array.isArray(value)) return value.map((v) => this.walk(v, fn));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.walk(v, fn);
      return out;
    }
    return value;
  }

  /** A URL on the configured Zendesk instance — kept usable, only its parts are redacted. */
  private asInstanceUrl(s: string): URL | null {
    if (!this.cfg.subdomain) return null;
    if (!s.startsWith(baseUrl(this.cfg.subdomain) + "/") || /\s/.test(s)) return null;
    try {
      return new URL(s);
    } catch {
      return null;
    }
  }

  /** The texts that need scanning to sanitize string `s`. */
  private textsOf(s: string): string[] {
    const url = this.asInstanceUrl(s);
    if (!url) return needsScan(s) ? [s] : [];
    const parts = [
      ...url.pathname.split("/").map(safeDecode),
      ...url.searchParams.values(),
    ];
    return parts.filter(needsScan);
  }

  /** The sanitized form of `s`, given a function that cleans one scanned text. */
  private rebuild(s: string, clean: (text: string) => string): string {
    const url = this.asInstanceUrl(s);
    if (!url) return clean(s);

    url.pathname = url.pathname
      .split("/")
      .map((seg) => {
        const decoded = safeDecode(seg);
        const out = clean(decoded);
        return out === decoded ? seg : encodeURIComponent(out);
      })
      .join("/");
    for (const [k, v] of [...url.searchParams.entries()]) {
      const out = clean(v);
      if (out !== v) url.searchParams.set(k, out);
    }
    const out = url.toString();
    if (out === new URL(s).toString()) return s;
    this.urlOriginals.set(out, s);
    return out;
  }

  /* ------------------------------ detection ---------------------------- */

  /** PII spans for each text, running the model over the ones not seen before. */
  private async detect(texts: string[]): Promise<Map<string, Span[]>> {
    const found = new Map<string, Span[]>();
    const pending: string[] = [];
    for (const t of texts) {
      const hit = this.detected.get(t);
      if (hit) found.set(t, hit);
      else pending.push(t);
    }
    if (pending.length === 0) return found;
    const engine = await this.load();

    // Split each text into model-sized windows, remembering where each came from.
    const windows: Array<{ text: number; tokens: Token[] }> = [];
    pending.forEach((text, i) => {
      for (const w of splitWindows(this.tokenize(engine, text), text)) {
        windows.push({ text: i, tokens: w });
      }
    });

    // Similar lengths batch together with little padding.
    const order = windows.map((_, i) => i).sort(
      (a, b) => windows[a].tokens.length - windows[b].tokens.length
    );
    const labels: string[][] = new Array(windows.length);
    const size = batchSize(this.cfg.gdpr.dtype);
    for (let i = 0; i < order.length; i += size) {
      const batch = order.slice(i, i + size);
      const out = await this.classify(engine, batch.map((w) => windows[w].tokens));
      batch.forEach((w, j) => (labels[w] = out[j]));
    }

    const spans: Span[][] = pending.map((text) => matchPatterns(text));
    windows.forEach((w, i) => {
      w.tokens.forEach((tok, j) => {
        const label = labels[i][j];
        if (label !== "O") {
          spans[w.text].push({ start: tok.start, end: tok.end, type: label.replace(/^[BIES]-/, "") });
        }
      });
    });

    pending.forEach((text, i) => {
      const kept = this.allow(
        text,
        spans[i]
          .filter((s) => !this.cfg.gdpr.keepEntities.has(s.type))
          .map((s) => widen(text, s))
          .filter((s) => s.end > s.start)
      );
      this.detected.set(text, kept);
      found.set(text, kept);
    });
    return found;
  }

  /**
   * Tokenize word by word. The XLM-R pre-tokenizer splits on whitespace, so this
   * yields the same tokens as tokenizing the whole text, but lets us map every
   * token back to exact character offsets (transformers.js has no offset mapping).
   */
  private tokenize(engine: Engine, text: string): Token[] {
    // Read "john_smith.pdf" as separate words; same length, so offsets still hold.
    const input = text.replace(/_/g, " ");
    const tokens: Token[] = [];
    let word = 0;
    for (const m of input.matchAll(/\S+/g)) {
      const w = m[0];
      const base = m.index!;
      const pieces: string[] = engine.tokenizer.tokenize(w);
      const ids: number[] = engine.tokenizer.convert_tokens_to_ids(pieces);
      let cursor = 0;
      let aligned = true;
      pieces.forEach((piece, k) => {
        const p = piece.replace(/^▁/, "");
        // Normalization (NFKC, <unk>) can make a piece differ from the source;
        // from there on, attribute tokens to the rest of the word.
        if (aligned && !w.startsWith(p, cursor)) aligned = false;
        const start = cursor;
        const end = aligned ? cursor + p.length : w.length;
        if (aligned) cursor = end;
        tokens.push({ id: Number(ids[k]), start: base + start, end: base + end, word });
      });
      word++;
    }
    return tokens;
  }

  /**
   * Label every token in each sequence of one padded batch. A token counts as
   * PII when the model's total probability for the PII labels (1 − P("O"))
   * reaches the configured threshold; it then gets the likeliest PII label.
   */
  private async classify(engine: Engine, seqs: Token[][]): Promise<string[][]> {
    const len = Math.max(...seqs.map((s) => s.length)) + 2;
    const inputIds = new BigInt64Array(seqs.length * len).fill(BigInt(engine.padId));
    const mask = new BigInt64Array(seqs.length * len);
    seqs.forEach((seq, b) => {
      const row = b * len;
      inputIds[row] = BigInt(engine.bosId);
      seq.forEach((t, j) => (inputIds[row + 1 + j] = BigInt(t.id)));
      inputIds[row + 1 + seq.length] = BigInt(engine.eosId);
      mask.fill(1n, row, row + seq.length + 2);
    });

    const { logits } = await engine.model({
      input_ids: new engine.Tensor("int64", inputIds, [seqs.length, len]),
      attention_mask: new engine.Tensor("int64", mask, [seqs.length, len]),
    });
    const data = logits.data as Float32Array;
    const classes = logits.dims[2] as number;
    const { outsideId } = engine;
    const threshold = this.cfg.gdpr.threshold;

    return seqs.map((seq, b) =>
      seq.map((_, j) => {
        const off = (b * len + 1 + j) * classes;
        let max = -Infinity;
        for (let c = 0; c < classes; c++) max = Math.max(max, data[off + c]);
        let sum = 0;
        let best = -1;
        for (let c = 0; c < classes; c++) {
          sum += Math.exp(data[off + c] - max);
          if (c !== outsideId && (best < 0 || data[off + c] > data[off + best])) best = c;
        }
        const pPii = 1 - Math.exp(data[off + outsideId] - max) / sum;
        return pPii >= threshold ? (engine.id2label[best] ?? "O") : "O";
      })
    );
  }
}

/* -------------------------------- helpers -------------------------------- */

/** Strings that can't hold PII (empty, punctuation, timestamps) are left alone. */
function needsScan(s: string): boolean {
  return WORD_CHAR.test(s) && !ISO_DATETIME.test(s);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** mod-97 check, so product codes that merely look like an IBAN are left alone. */
function ibanChecksumOk(iban: string): boolean {
  const s = iban.replace(/ /g, "");
  if (s.length < 15 || s.length > 34) return false;
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) =>
    String(c.charCodeAt(0) - 55)
  );
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1;
}

function matchPatterns(text: string): Span[] {
  const spans: Span[] = [];
  for (const { type, re, valid } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (!valid || valid(m[0])) {
        spans.push({ start: m.index!, end: m.index! + m[0].length, type });
      }
    }
  }
  return spans;
}

function luhnOk(card: string): boolean {
  const digits = card.replace(/\D/g, "");
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1 && (d *= 2) > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Grow a span to cover the whole word it sits in, so no fragment of the value
 * survives, then drop punctuation at its edges so "(… 78)," keeps its brackets.
 */
function widen(text: string, s: Span): Span {
  const inWord = (i: number) =>
    WORD_CHAR.test(text[i]) ||
    (CONNECTOR.test(text[i]) &&
      WORD_CHAR.test(text[i - 1] ?? "") &&
      WORD_CHAR.test(text[i + 1] ?? ""));
  let { start, end } = s;
  while (start > 0 && inWord(start - 1)) start--;
  while (end < text.length && inWord(end)) end++;
  while (start < end && LEADING_PUNCT.test(text[start])) start++;
  while (end > start && TRAILING_PUNCT.test(text[end - 1])) end--;
  return { start, end, type: s.type };
}

/** A regex matching, as whole words, every distinctive value detected in `found`. */
function propagationPattern(
  found: Map<string, Span[]>
): { re: RegExp; types: Map<string, string> } | null {
  const types = new Map<string, string>();
  for (const [text, spans] of found) {
    for (const s of spans) {
      if (NO_PROPAGATE.has(s.type)) continue;
      const value = text.slice(s.start, s.end).trim();
      const distinctive =
        (/\p{L}/u.test(value) && value.length >= 3) ||
        (value.match(/\d/g)?.length ?? 0) >= 6;
      if (distinctive && !types.has(value)) types.set(value, s.type);
    }
  }
  if (types.size === 0) return null;
  const alternatives = [...types.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "gu");
  return { re, types };
}

function matchKnown(text: string, known: { re: RegExp; types: Map<string, string> }): Span[] {
  return [...text.matchAll(known.re)].map((m) => ({
    start: m.index!,
    end: m.index! + m[0].length,
    type: known.types.get(m[0]) ?? "PII",
  }));
}

/**
 * Split a token list into windows of at most MAX_CONTENT_TOKENS, breaking
 * between words (and preferably after a sentence end) so entities stay whole.
 */
function splitWindows(tokens: Token[], text: string): Token[][] {
  const out: Token[][] = [];
  let start = 0;
  while (start < tokens.length) {
    let end = Math.min(start + MAX_CONTENT_TOKENS, tokens.length);
    if (end < tokens.length) {
      const wordBreak = (i: number) => tokens[i].word !== tokens[i - 1].word;
      let cut = -1;
      for (let i = end; i > start + MAX_CONTENT_TOKENS / 2 && cut < 0; i--) {
        if (wordBreak(i) && /[.!?:;]/.test(text[tokens[i - 1].end - 1] ?? "")) cut = i;
      }
      for (let i = end; i > start && cut < 0; i--) if (wordBreak(i)) cut = i;
      if (cut > start) end = cut;
    }
    out.push(tokens.slice(start, end));
    start = end;
  }
  return out;
}

/** Replace the detected spans in `text` with placeholders. */
function redact(
  text: string,
  spans: Span[],
  placeholder: (value: string, type: string) => string
): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: Span[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (
      last &&
      (s.start <= last.end ||
        (s.type === last.type && MERGEABLE_GAP.test(text.slice(last.end, s.start))))
    ) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ ...s });
    }
  }

  let out = "";
  let pos = 0;
  for (const s of merged) {
    out += text.slice(pos, s.start) + placeholder(text.slice(s.start, s.end), s.type);
    pos = s.end;
  }
  return out + text.slice(pos);
}
