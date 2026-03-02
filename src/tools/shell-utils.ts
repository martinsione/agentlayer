/** Escape single quotes for safe shell interpolation inside single-quoted strings. */
export const sq = (s: string) => s.replaceAll("'", "'\\''");
