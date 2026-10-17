/** Whether text is English, the one language the plugin keeps and sends, whatever language the owner chats in. */

const TYPOGRAPHY = /[µ ·‐-―‘-‟•…←-⇿✓✔✖✗]/g;
const FOREIGN_LETTER = /(?![A-Za-z])\p{L}/u;
const WORD = /[A-Za-z]+/g;
const VIETNAMESE = new Set(
  (
    "khong ko duoc dc nhung cua voi nay thi roi nua chua cung nhu dang vay nhieu phai nguoi viec lam cho " +
    "dung mot nhe thay minh trong truoc neu khi cac tu mai chon nen giu sua xoa het"
  ).split(" "),
);
const UNACCENTED = { least: 2, share: 0.25 };

/** Why a text is not English, or null when it is: a letter outside basic Latin, or Vietnamese typed without accents; letters split from their marks (NFD) are read joined, as a person typed them. */
export function notEnglish(text: string): string | null {
  const plain = text.normalize("NFC").replace(TYPOGRAPHY, " ");
  const letter = plain.match(FOREIGN_LETTER);
  if (letter) return `has the letter "${letter[0]}"`;
  let words = 0;
  let hits = 0;
  for (const [word] of plain.matchAll(WORD)) {
    words += 1;
    if (VIETNAMESE.has(word.toLowerCase())) hits += 1;
  }
  if (hits >= UNACCENTED.least && hits / words >= UNACCENTED.share) return "reads as Vietnamese typed without accents";
  return null;
}

/** The first string inside a value that is not English, with its path and why; null when every string is. */
export function firstNotEnglish(value: unknown, path = ""): { path: string; why: string } | null {
  if (typeof value === "string") {
    const why = notEnglish(value);
    return why ? { path: path || "(text)", why } : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = firstNotEnglish(value[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object")
    for (const [key, inner] of Object.entries(value)) {
      const found = firstNotEnglish(inner, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  return null;
}
