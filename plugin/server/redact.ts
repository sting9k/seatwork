/** Hides secrets in text before the room keeps it, shows it, or sends it out; SURE patterns match only secrets, LIKELY ones read a word as a value because its name says secret. */

const TOKENS = new RegExp(
  [
    String.raw`\bsk-(?:or-|ant-|proj-)?[A-Za-z0-9_-]{16,}`,
    String.raw`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
    String.raw`\bglpat-[A-Za-z0-9_-]{16,}`,
    String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
    String.raw`\bAIza[0-9A-Za-z_-]{30,}`,
    String.raw`\bya29\.[A-Za-z0-9_-]{20,}`,
    String.raw`\bA(?:KIA|SIA)[0-9A-Z]{16}`,
    String.raw`\bnpm_[A-Za-z0-9]{30,}`,
    String.raw`\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`,
    String.raw`\b(?:hf|gsk|xai)_[A-Za-z0-9]{24,}`,
    String.raw`\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
  ].join("|"),
  "g",
);

const SECRET_NAME = String.raw`[A-Za-z0-9_.-]{0,40}(?:secret|token|passw(?:or)?d|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|signing)[A-Za-z0-9_.-]{0,40}`;

type Replacement = string | ((match: string, ...groups: string[]) => string);

const SURE: [RegExp, Replacement][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "***private key***"],
  [TOKENS, "***"],
  [/(\b[a-z][a-z0-9+.-]{0,64}:\/\/[^\s:@/]{0,500}:)[^\s@/]+@/gi, "$1***@"],
  [/((?:authorization|x-api-key|api-key|cookie)\s*:\s*)(?:bearer\s+|basic\s+|token\s+)?[^\s'"]+/gi, "$1***"],
  [/(\bBearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g, "$1***"],
  [
    /(--?(?:password|passwd|token|api-key|apikey|secret|access-key|secret-key|auth)(?:=|\s+))(?:'[^']*'|"[^"]*"|\S+)/gi,
    "$1***",
  ],
  [/(\b(?:mysql|mysqladmin|mysqldump)\b[^|;&\n]{0,200}?\s-p)(?!\s)\S+/g, "$1***"],
  [/(\bcurl\b[^|;&\n]{0,200}?\s(?:-u|--user)\s+[^\s:]{1,100}:)\S+/g, "$1***"],
  [/(\bsshpass\s+-p\s*)\S+/g, "$1***"],
  [/(_authToken\s*[= ]\s*)\S+/g, "$1***"],
  [
    /(\b(?:[A-Z][A-Z0-9_]{0,120})?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?|_SK|SIGNING)[A-Z0-9_]{0,120}=)(?:'[^']*'|"[^"]*"|\S+)/g,
    "$1***",
  ],
  [
    /(\b[A-Z][A-Z0-9_]{2,120}=)(['"]?)([A-Za-z0-9+/_.=-]{20,})\2/g,
    (match, name, quote, value) => (looksGenerated(value) ? `${name}${quote}***${quote}` : match),
  ],
];

const LIKELY: [RegExp, Replacement][] = [
  [
    new RegExp(
      String.raw`(\b${SECRET_NAME}["']?\s*[:=]\s*)(?:'[^'\n]{4,}'|"[^"\n]{4,}"|(?![\w.]*\()(?!(?:string|number|boolean|null|undefined|true|false|none)\b)[^\s,;'"(){}\[\]&]{6,})`,
      "gi",
    ),
    "$1***",
  ],
  [
    /((?:m[aậ]t\s*kh[aẩ]u|mat\s*khau|password|passwd|pwd)\b[^\n]{0,40}?(?:\s(?:is|l[aà])(?=\s)|\s*[=:])\s*)(?!(?:string|number|boolean|null|undefined|true|false|none)\b)\S+/giu,
    "$1***",
  ],
];

/** The text with every pattern of a list applied, in order. */
function apply(patterns: readonly [RegExp, Replacement][], text: string): string {
  let out = text;
  for (const [pattern, replacement] of patterns)
    out = typeof replacement === "string" ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  return out;
}

/** Whether a value mixes letters and digits the way keys do, rather than reading as a word, a path or a number. */
function looksGenerated(value: string): boolean {
  if (/^[./~]/.test(value) || !/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
  return (/[a-z]/.test(value) && /[A-Z]/.test(value)) || value.length >= 32;
}

/** The text with every secret replaced by stars: right for a record, too wide to judge prose. */
export function redact(text: string): string {
  return apply(LIKELY, apply(SURE, text));
}

/** Whether a sentence holds something only a secret can match; prose about passwords and tokens is not one. */
export function hasSecret(text: string): boolean {
  return apply(SURE, text) !== text;
}
