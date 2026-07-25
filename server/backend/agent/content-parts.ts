/**
 * Provider-neutral message content. Image payloads are kept as base64 so a
 * persisted conversation can be replayed without depending on Cursor's
 * temporary attachment directory.
 */
export type TextContentPart = {
  type: "text";
  text: string;
};

export type ImageContentPart = {
  type: "image";
  mimeType: string;
  dataBase64: string;
  /** Original local path is diagnostic metadata only; requests use base64. */
  path?: string;
};

export type ChatContentPart = TextContentPart | ImageContentPart;

export const ESTIMATED_TOKENS_PER_IMAGE_PART = 1024;

export function textFromContentParts(parts?: ChatContentPart[]): string {
  if (!parts?.length) return "";
  return parts
    .filter((part): part is TextContentPart => part.type === "text")
    .map((part) => part.text)
    .filter(Boolean)
    .join("");
}

export function imagePartsFromContentParts(
  parts?: ChatContentPart[],
): ImageContentPart[] {
  if (!parts?.length) return [];
  return parts.filter((part): part is ImageContentPart => part.type === "image");
}

export function normalizeImageMimeType(value?: string): string {
  const mimeType = String(value || "").trim().toLowerCase();
  if (mimeType === "image/jpg") return "image/jpeg";
  if (/^image\/(jpeg|png|gif|webp)$/.test(mimeType)) return mimeType;
  return "image/png";
}

export function imageDataUrl(part: ImageContentPart): string {
  return `data:${normalizeImageMimeType(part.mimeType)};base64,${part.dataBase64}`;
}
