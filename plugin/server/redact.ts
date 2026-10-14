/** Hides secrets in text before the room keeps it, shows it, or sends it out. */

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "***private key***"],
  [/\b(sk-(?:or-|ant-|proj-)?[A-Za-z0-9_-]{16,})/g, "***"],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "***"],
  [/\b(glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|AKIA[0-9A-Z]{16})/g, "***"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "***"],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, "$1***@"],
  [/((?:authorization|x-api-key|api-key|cookie)\s*:\s*)(?:bearer\s+|basic\s+|token\s+)?[^\s'"]+/gi, "$1***"],
  [
    /(--?(?:password|passwd|token|api-key|apikey|secret|access-key|secret-key|auth)(?:=|\s+))(?:'[^']*'|"[^"]*"|\S+)/gi,
    "$1***",
  ],
  [/(\b(?:mysql|mysqladmin|mysqldump)\b[^|;&\n]*\s-p)(?!\s)\S+/g, "$1***"],
  [
    /(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?)[A-Z0-9_]*=)(?:'[^']*'|"[^"]*"|\S+)/g,
    "$1***",
  ],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
