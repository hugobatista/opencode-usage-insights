/**
 * Text hygiene for everything that reaches a terminal.
 *
 * Some of what the plugin displays is not written by the user: a gateway names
 * its own endpoint in a response header, a model writes a session title, an
 * NDJSON export can come from anywhere. A control character in any of those is
 * interpreted by the terminal that renders it (title changes, cursor moves,
 * colours), so every such string is stripped of control characters before it
 * is stored or drawn.
 *
 * The rule is deliberately blunt: drop C0 controls, DEL and the C1 block, keep
 * everything else (the text is otherwise arbitrary Unicode), and cap the
 * length so a hostile value cannot bloat the database or the frame. Layout is
 * never touched: whitespace is preserved, because callers build indentation
 * into the strings they truncate.
 */

/** Longest value kept by default: a title, an id or a path, not a document. */
export const TEXT_LIMIT = 512

/**
 * Strip control characters and cap the length. Newlines and tabs go too: a
 * line is one line, and the renderers lay out their own spacing.
 */
export function sanitizeText(value: string, limit = TEXT_LIMIT): string {
  if (limit <= 0) return ""
  let cleaned = ""
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue
    cleaned += character
    if (cleaned.length >= limit) break
  }
  return cleaned
}

/** `sanitizeText` without the layout, for a stored label: trimmed as well. */
export function sanitizeLabel(value: string, limit = TEXT_LIMIT): string {
  return sanitizeText(value, limit).trim()
}

/**
 * A single identifier token: the shape a gateway endpoint, a model id or a
 * provider id has. Used to validate values that become identities in the
 * database, so a header cannot inject anything into a grouping key.
 */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/

export function isToken(value: string, limit = 64): boolean {
  return value.length > 0 && value.length <= limit && TOKEN.test(value)
}

/** The lowercase form of a token identity, so the same endpoint groups once. */
export function normalizeToken(value: string, limit = 64): string | undefined {
  const trimmed = value.trim().toLowerCase()
  return isToken(trimmed, limit) ? trimmed : undefined
}
