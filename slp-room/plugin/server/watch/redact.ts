/** Blanks credential shapes before text leaves this machine. A courtesy, not a guarantee: tool output is never sent at all. */

const BLANK = "[redacted]";

const SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\b/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi,
];

/** `API_KEY=abc`, `"password": "abc"`, `--token abc`: the name stays, the value goes. */
const NAMED = /((?:^|[\s"'{,(-])[\w.-]*(?:secret|token|passwd|password|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth)[\w.-]*["']?\s*[:=]\s*|--(?:token|password|api-key|secret)[= ])(["']?)([^\s"',})]{6,})\2/gi;

export function redact(text: string): string {
  let out = text;
  for (const shape of SHAPES) out = out.replace(shape, BLANK);
  return out.replace(NAMED, (_all, lead: string, quote: string) => `${lead}${quote}${BLANK}${quote}`);
}

export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactDeep(item)])) as T;
  }
  return value;
}
