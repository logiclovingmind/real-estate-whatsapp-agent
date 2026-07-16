// Per-client brochure catalog. Like the rest of the business config, it's
// env-driven: BROCHURES holds a JSON array so each client's projects + PDF
// links are set at deploy time without touching code.
//
//   BROCHURES=[
//     {"project":"Skyline Heights","aliases":["skyline"],
//      "url":"https://.../Skyline-Heights.pdf","filename":"Skyline Heights.pdf"}
//   ]
//
// `url` must be a PUBLIC direct-download PDF link (WhatsApp fetches it itself);
// a Drive "share" link won't work — use a direct/hosted file URL.

let _cache = null;
let _rawSeen;

function load() {
  const raw = process.env.BROCHURES || "";
  // Re-parse if the env var changed (tests set it between cases).
  if (_cache && raw === _rawSeen) return _cache;
  _rawSeen = raw;

  let list = [];
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        list = parsed
          .filter((b) => b && b.project && b.url)
          .map((b) => ({
            project: String(b.project).trim(),
            url: String(b.url).trim(),
            filename: (b.filename || `${b.project}.pdf`).trim(),
            aliases: Array.isArray(b.aliases)
              ? b.aliases.map((a) => String(a).toLowerCase().trim()).filter(Boolean)
              : [],
          }));
      }
    } catch {
      // Malformed BROCHURES: treat as empty rather than crashing the agent.
      list = [];
    }
  }
  _cache = list;
  return _cache;
}

export function listBrochures() {
  return load().map((b) => b.project);
}

// Find a brochure by project name. Matches (in order): exact name, alias,
// then substring either way so "skyline" finds "Skyline Heights" and vice
// versa. Returns null when nothing matches — the caller must NOT invent one.
export function findBrochure(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return null;
  const all = load();

  let hit = all.find((b) => b.project.toLowerCase() === q);
  if (hit) return hit;

  hit = all.find((b) => b.aliases.includes(q));
  if (hit) return hit;

  hit = all.find((b) => {
    const name = b.project.toLowerCase();
    return name.includes(q) || q.includes(name) || b.aliases.some((a) => q.includes(a));
  });
  return hit || null;
}

export default { listBrochures, findBrochure };
