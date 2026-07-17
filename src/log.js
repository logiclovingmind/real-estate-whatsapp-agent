// Lightweight structured logger — no dependencies. Emits one JSON line per
// event to stdout (info/debug) or stderr (warn/error) so Render/any host that
// captures process output gets a searchable trail. Set LOG_LEVEL to one of
// error|warn|info|debug (default info) to control verbosity.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const threshold = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

function emit(level, event, fields) {
  if (LEVELS[level] > threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  error: (event, fields = {}) => emit("error", event, fields),
  warn: (event, fields = {}) => emit("warn", event, fields),
  info: (event, fields = {}) => emit("info", event, fields),
  debug: (event, fields = {}) => emit("debug", event, fields),
};

export default log;
