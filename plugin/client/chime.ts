/** The sound for "something waits on you": two short notes (A5, then E6 held longer) as a WAV, made here so no audio file ships. */

const RATE = 16000;
const NOTES: readonly (readonly [number, number])[] = [
  [880, 0.11],
  [1318.5, 0.22],
];
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += 3) {
    const a = bytes[at];
    const b = bytes[at + 1] ?? 0;
    const c = bytes[at + 2] ?? 0;
    out += ALPHABET[a >> 2] + ALPHABET[((a & 3) << 4) | (b >> 4)];
    out += at + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | (c >> 6)] : "=";
    out += at + 2 < bytes.length ? ALPHABET[c & 63] : "=";
  }
  return out;
}

function wav(): Uint8Array {
  const samples: number[] = [];
  for (const [hz, seconds] of NOTES) {
    const count = Math.round(RATE * seconds);
    for (let n = 0; n < count; n += 1) {
      // each note fades to silence, so neither it nor the file ends on a click
      const fade = (1 - n / count) ** 2;
      samples.push(Math.round(Math.sin((2 * Math.PI * hz * n) / RATE) * fade * 0.35 * 32767));
    }
  }
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, text: string) =>
    [...text].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  // the format block: PCM, mono, 16-bit samples
  tag(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}

let made: { base64: string; mimeType: string } | undefined;

/** The chime as `playAudio` takes it. */
export function chime(): { base64: string; mimeType: string } {
  made ??= { base64: base64(wav()), mimeType: "audio/wav" };
  return made;
}
