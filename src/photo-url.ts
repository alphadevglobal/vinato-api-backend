/**
 * Label photos travel as links, never inside the JSON: a stored photo (a base64
 * data URL in catalog_wines.images) is served by GET /wines/:id/photo, with a
 * version in the link so phones cache it for good. The SQL sends only
 * "photo:<version>" for a stored photo (photoRefSql), never the photo itself.
 */
export const PUBLIC_API_URL = (process.env.PUBLIC_API_URL ?? "https://vinato-api-backend-eta.vercel.app").replace(/\/+$/, "");

/** SQL: the photo reference of images->index: a remote link as it is, or "photo:<version>" for a stored photo. */
export function photoRefSql(index: number, column = "images") {
  const raw = `CASE WHEN jsonb_typeof(${column}) = 'array' AND jsonb_array_length(${column}) > ${index} THEN
      CASE WHEN jsonb_typeof(${column}->${index}) = 'string' THEN ${column}->>${index} ELSE COALESCE(${column}->${index}->>'url', ${column}->${index}->>'image_url') END END`;
  return `(CASE WHEN (${raw}) LIKE 'data:%' THEN 'photo:' || left(md5(${raw}), 12) ELSE (${raw}) END)`;
}

/** The link the app loads: remote links stay; "photo:<version>" becomes this API's photo route. */
export function photoUrl(wineId: string, ref: unknown, index = 0) {
  if (typeof ref !== "string" || !ref) return null;
  if (ref.startsWith("photo:")) return `${PUBLIC_API_URL}/wines/${encodeURIComponent(wineId)}/photo?i=${index}&v=${ref.slice(6)}`;
  // Never send a stored photo inline, even if a caller missed photoRefSql.
  if (ref.startsWith("data:")) return null;
  return ref;
}
