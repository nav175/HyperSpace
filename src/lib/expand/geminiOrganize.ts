import type { Node } from "@/types/contracts";

const MODEL =
  process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash";

interface GeminiChild {
  title?: string;
  summary?: string;
  url?: string;
  type?: string;
  id?: number;
}

/**
 * Ask Gemini to pick + clean Wikipedia candidates into Expand children.
 * Returns null when no key / API failure (caller falls back to raw Wikipedia).
 */
export async function organizeWithGemini(
  parent: Node,
  candidates: Node[],
): Promise<Node[] | null> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || !candidates.length) return null;

  const prompt = `You organize knowledge for Hyperspace, a hyperbolic Wikipedia explorer.
Parent concept: "${parent.title}" (id ${parent.id}).
From the candidate pages below, pick the best 5–8 child concepts that expand this topic.
Return ONLY a JSON array of objects with keys: id, title, summary, url, type.
- Keep Wikipedia page ids from candidates when possible.
- type must be "article" or "category".
- summary: 1–2 sentences, plain text.
- Prefer diverse, concrete children over near-duplicates.

Candidates:
${JSON.stringify(
  candidates.map((c) => ({
    id: c.id,
    title: c.title,
    summary: c.summary.slice(0, 240),
    url: c.url,
    type: c.type,
  })),
)}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
          },
        }),
        signal: AbortSignal.timeout(25_000),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return null;

    const parsed = JSON.parse(text) as GeminiChild[] | { children?: GeminiChild[] };
    const list = Array.isArray(parsed) ? parsed : (parsed.children ?? []);
    const byTitle = new Map(
      candidates.map((c) => [c.title.toLowerCase(), c]),
    );
    const depth = parent.depth + 1;
    const out: Node[] = [];

    for (const item of list) {
      if (!item?.title) continue;
      const match = byTitle.get(item.title.toLowerCase());
      const id = Number(item.id) || match?.id;
      if (!id || !Number.isFinite(id)) continue;
      out.push({
        id,
        title: item.title,
        summary:
          (item.summary ?? match?.summary ?? `Related to ${parent.title}.`).slice(
            0,
            600,
          ),
        parentId: parent.id,
        depth,
        url: item.url || match?.url || `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`,
        type: item.type === "category" ? "category" : "article",
      });
      if (out.length >= 8) break;
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}
