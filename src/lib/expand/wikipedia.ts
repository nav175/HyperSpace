import type { Node } from "@/types/contracts";

const UA =
  "HyperspaceStormHacks/2.0 (https://github.com/nav175/HyperSpace; educational)";

interface WikiPage {
  pageid: number;
  title: string;
  extract?: string;
  fullurl?: string;
}

function wikiUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(
    title.replace(/ /g, "_"),
  )}`;
}

async function wikiQuery(params: Record<string, string>): Promise<unknown> {
  const url = new URL("https://en.wikipedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
  return res.json();
}

async function fetchExtracts(pageids: number[]): Promise<Map<number, WikiPage>> {
  const out = new Map<number, WikiPage>();
  if (!pageids.length) return out;
  const data = (await wikiQuery({
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    exsentences: "2",
    inprop: "url",
    pageids: pageids.slice(0, 20).join("|"),
  })) as {
    query?: { pages?: Record<string, WikiPage> };
  };
  for (const page of Object.values(data.query?.pages ?? {})) {
    if (page.pageid && page.title) out.set(page.pageid, page);
  }
  return out;
}

/**
 * Pull related Wikipedia pages for a parent concept.
 * Categories → categorymembers; articles → outgoing links.
 */
export async function fetchWikipediaCandidates(
  parent: Node,
  limit = 12,
): Promise<Node[]> {
  const existingTitles = new Set([parent.title.toLowerCase()]);
  let pageids: number[] = [];

  if (parent.type === "category" || parent.depth <= 1) {
    const catTitle = parent.title.startsWith("Category:")
      ? parent.title
      : `Category:${parent.title}`;
    try {
      const data = (await wikiQuery({
        list: "categorymembers",
        cmtitle: catTitle,
        cmtype: "page|subcat",
        cmlimit: String(Math.min(limit * 2, 30)),
      })) as {
        query?: { categorymembers?: { pageid: number; title: string; ns: number }[] };
      };
      pageids = (data.query?.categorymembers ?? [])
        .filter((m) => !existingTitles.has(m.title.toLowerCase()))
        .map((m) => m.pageid);
    } catch {
      // fall through to search
    }
  }

  if (pageids.length < 4) {
    const data = (await wikiQuery({
      list: "search",
      srsearch: parent.title,
      srnamespace: "0",
      srlimit: String(Math.min(limit * 2, 20)),
    })) as {
      query?: { search?: { pageid: number; title: string }[] };
    };
    const extra = (data.query?.search ?? [])
      .filter((m) => !existingTitles.has(m.title.toLowerCase()))
      .map((m) => m.pageid);
    pageids = [...new Set([...pageids, ...extra])];
  }

  const extracts = await fetchExtracts(pageids.slice(0, limit));
  const depth = parent.depth + 1;
  const children: Node[] = [];

  for (const page of extracts.values()) {
    if (existingTitles.has(page.title.toLowerCase())) continue;
    const isCat = page.title.startsWith("Category:");
    children.push({
      id: page.pageid,
      title: isCat ? page.title.replace(/^Category:/, "") : page.title,
      summary: (page.extract ?? "").slice(0, 600) || `Related to ${parent.title}.`,
      parentId: parent.id,
      depth,
      url: page.fullurl ?? wikiUrl(page.title),
      type: isCat ? "category" : "article",
    });
    if (children.length >= limit) break;
  }

  return children;
}
