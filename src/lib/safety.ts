const phoneRegex = /\+?\d{6,15}/g;
const tokenRegex = /(EAAC|EAAE|AIza|sk-[A-Za-z0-9]{20,})[A-Za-z0-9_-]+/g;
const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const htmlRegex = /<script|<iframe|<object|onerror=|javascript:/i;
const urlRegex = /\bhttps?:\/\/[^\s]+/gi;
const jailbreakRegex = /(ignore all previous instructions|system prompt|jailbreak)/i;
const allowedHosts = new Set([
  "wa.me",
  "api.whatsapp.com",
  "cdn.jsdelivr.net",
  "vercel.com",
  "vercel.app"
]);

export function redactSensitive(text: string): string {
  return text
    .replace(phoneRegex, "[redacted-phone]")
    .replace(tokenRegex, "[redacted-token]")
    .replace(emailRegex, "[redacted-email]");
}

export function isUnsafeOutput(text: string): boolean {
  return htmlRegex.test(text) || jailbreakRegex.test(text);
}

export function stripUnsafeOutput(text: string): string {
  if (isUnsafeOutput(text)) {
    return "Maaf, aku mengirimkan jawaban aman tanpa konten berbahaya.";
  }
  // URL policy: keep only if host is allowlisted; otherwise redact
  return text.replace(urlRegex, (url) => {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      if (allowedHosts.has(host)) {
        return url;
      }
    } catch {
      // ignore parse errors
    }
    return "[tautan]";
  });
}
