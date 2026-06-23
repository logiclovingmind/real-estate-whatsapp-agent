// Lightweight language/script detection for v1.
// Returns one of: "gu" (Gujarati script), "hi" (Devanagari), "hinglish"
// (Roman Hindi/Hinglish), or "en" (English). Roman-Gujarati collapses into
// hinglish-style handling at the prompt layer; we mainly need script + register.

const GUJARATI_RANGE = /[\u0A80-\u0AFF]/;
const DEVANAGARI_RANGE = /[\u0900-\u097F]/;

// Common Hinglish/Hindi tokens written in Roman script.
const HINGLISH_HINTS = [
  "hai", "haan", "nahi", "nahin", "kya", "kyా", "kaise", "kaisa", "kitna",
  "kitne", "chahiye", "chaiye", "milega", "batao", "bata", "karo", "kar",
  "acha", "accha", "theek", "thik", "ghar", "flat", "lena", "lege", "lunga",
  "dekhna", "dikhao", "paisa", "rupaye", "budget", "area", "bhai", "ji",
  "aap", "tum", "mujhe", "mereko", "apna", "kal", "aaj", "abhi", "kab",
];

// Common Roman-Gujarati tokens (helps bias toward Gujarati register).
const GUJARATI_ROMAN_HINTS = [
  "chhe", "che", "shu", "kem", "tame", "hu", "mane", "joiye", "ketlo",
  "ketli", "ketla", "ghar", "aapo", "batavo", "kal", "aaje", "kyare",
  "rakho", "saru", "saras",
];

function countHits(text, words) {
  const tokens = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if (tokens.length === 0) return 0;
  const set = new Set(tokens);
  let hits = 0;
  for (const w of words) if (set.has(w)) hits++;
  return hits;
}

export function detectLanguage(text = "") {
  const t = String(text).trim();
  if (!t) return "en";

  if (GUJARATI_RANGE.test(t)) return "gu";
  if (DEVANAGARI_RANGE.test(t)) return "hi";

  const guHits = countHits(t, GUJARATI_ROMAN_HINTS);
  const hiHits = countHits(t, HINGLISH_HINTS);

  // Roman-script Gujarati: surface it but still in Roman; we tag as "gu"
  // so the prompt mirrors Gujarati register in Roman.
  if (guHits > hiHits && guHits > 0) return "gu";
  if (hiHits > 0) return "hinglish";

  return "en";
}

// Human-readable label for the system prompt.
export function languageLabel(code) {
  switch (code) {
    case "gu":
      return "Gujarati (reply in Roman Gujarati unless the lead used Gujarati script)";
    case "hi":
      return "Hindi (Devanagari script)";
    case "hinglish":
      return "Hinglish (Roman script Hindi)";
    default:
      return "English";
  }
}
