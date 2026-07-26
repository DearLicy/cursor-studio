/**
 * Stores the completed context-summary explanation that Cursor asks for via
 * AiService/GetThoughtAnnotation. This is deliberately separate from the
 * conversation transcript: the lookup key is the short-lived Bidi request ID,
 * while the transcript is keyed by the durable Cursor conversation ID.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { studioHome } from "../../config/store";

export type ThoughtAnnotation = {
  requestId: string;
  thought: string;
  updatedAt: number;
};

const memory = new Map<string, ThoughtAnnotation>();

function annotationDir(): string {
  return path.join(studioHome(), "history", "thought-annotations");
}

function annotationPath(requestId: string): string {
  const safe = requestId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return path.join(annotationDir(), `${safe}.json`);
}

export async function persistThoughtAnnotation(
  requestId: string,
  thought: string,
): Promise<void> {
  const normalizedRequestId = String(requestId || "").trim();
  const normalizedThought = String(thought || "").trim();
  if (!normalizedRequestId || !normalizedThought) return;

  const record: ThoughtAnnotation = {
    requestId: normalizedRequestId,
    thought: normalizedThought,
    updatedAt: Date.now(),
  };
  const target = annotationPath(normalizedRequestId);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(annotationDir(), { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, "utf8");
  try {
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  memory.set(normalizedRequestId, record);
}

export async function getThoughtAnnotation(
  requestId: string,
): Promise<ThoughtAnnotation | undefined> {
  const normalizedRequestId = String(requestId || "").trim();
  if (!normalizedRequestId) return undefined;

  try {
    const parsed = JSON.parse(
      await fs.readFile(annotationPath(normalizedRequestId), "utf8"),
    ) as Partial<ThoughtAnnotation>;
    if (
      parsed.requestId === normalizedRequestId &&
      typeof parsed.thought === "string" &&
      parsed.thought.trim()
    ) {
      const record: ThoughtAnnotation = {
        requestId: normalizedRequestId,
        thought: parsed.thought.trim(),
        updatedAt: Number(parsed.updatedAt) || 0,
      };
      memory.set(normalizedRequestId, record);
      return record;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      console.warn("[forwarder] ignored unreadable thought annotation");
    }
  }
  return memory.get(normalizedRequestId);
}

export function clearThoughtAnnotationsForTests(): void {
  memory.clear();
}
