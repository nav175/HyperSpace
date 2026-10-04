// POST /api/expand {nodeId, depth?} → { parentId, children: [Node], model }.
// Grows new branches under a topic: Wikipedia supplies candidate pages, the ingest filters drop
// people, companies, places and the like, and Gemini picks the ones that belong under the topic and
// says why. Gemini's picks are cached in TiDB (the `expansions` table), so repeat Expands are instant.
import { datasetVersion, getNode } from './api.mjs';
import { pool } from './db.mjs';
import { geminiJson } from './gemini.mjs';

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT = 'HyperspaceStormHacks/0.1 (https://github.com/nav175/HyperSpace)';
const MAX_CHILDREN = 8;
const MAX_CANDIDATES = 120; // keeps the Gemini prompt small
// Bump when the way children are chosen changes: cached rows from older code are then ignored
// (and replaced on the next Expand) rather than served.
const CACHE_TAG = 'v4';

export async function expandNode(nodeId, { depth = 1 } = {}) {
  const id = Number(nodeId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const cached = await cachedExpansion(id).catch(() => null);
  if (cached) return cached;

  // Nodes from nodes.json are in TiDB; nodes that Expand grew are looked up on Wikipedia by page id.
  const parent = (await getNode(id).catch(() => null)) ?? (await wikiNode(id, depth));
  if (!parent) return null;

  const candidates = await candidatesFor(parent);
  const known = await knownIn(candidates).catch(() => new Set());
  const fresh = candidates.filter((c) => !known.has(c.id) && !known.has(normalize(c.title)));
  const chosen = fresh.length ? await chooseWithGemini(parent, fresh) : null;
  // Without Gemini (no key, or every model down): categories first, then the most developed articles.
  const picks =
    chosen?.picks ??
    [...fresh]
      .sort((a, b) => Number(b.category) - Number(a.category) || b.length - a.length)
      .slice(0, MAX_CHILDREN)
      .map((candidate) => ({ candidate, reason: '' }));

  const children = await toNodes(parent, picks);
  const model = chosen?.model ?? 'wikipedia-ranked';
  // Only Gemini's picks are cached, so a fallback answer doesn't outlive a Gemini outage.
  if (chosen && children.length) await saveCached(id, children, model).catch(() => {});
  return { parentId: id, children, model };
}

// ── Cache ──────────────────────────────────────────────────────────────────────────────────

async function cachedExpansion(id) {
  const [[row]] = await pool().query(
    'SELECT children, model FROM expansions WHERE node_id = ? AND dataset_version = ? AND model LIKE ?',
    [id, await datasetVersion(), `%#${CACHE_TAG}`]
  );
  if (!row) return null;
  const children = typeof row.children === 'string' ? JSON.parse(row.children) : row.children;
  return { parentId: id, children, model: row.model.replace(/#.*$/, '') };
}

async function saveCached(id, children, model) {
  await pool().query('REPLACE INTO expansions (node_id, dataset_version, children, model) VALUES (?, ?, ?, ?)', [
    id,
    await datasetVersion(),
    JSON.stringify(children),
    `${model}#${CACHE_TAG}`,
  ]);
}

// Ids and normalized titles of candidates the universe already has.
async function knownIn(candidates) {
  if (!candidates.length) return new Set();
  const [rows] = await pool().query('SELECT id, title FROM nodes WHERE id IN (?) OR title IN (?)', [
    candidates.map((c) => c.id),
    candidates.map((c) => c.title),
  ]);
  return new Set(rows.flatMap((row) => [Number(row.id), normalize(row.title)]));
}

// ── Wikipedia ──────────────────────────────────────────────────────────────────────────────

async function wiki(params) {
  const url = `${WIKI_API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
  return res.json();
}

const pages = async (params) => (await wiki({ action: 'query', ...params })).query?.pages ?? [];

async function wikiNode(pageid, depth) {
  const [page] = await pages({ pageids: String(pageid), prop: 'info|description|extracts', exintro: '1', explaintext: '1', exsentences: '2' }).catch(() => []);
  if (!page || page.missing || (page.ns !== 0 && page.ns !== 14)) return null;
  const title = page.title.replace(/^Category:/, '');
  return {
    id: page.pageid,
    title,
    summary: tidy(page.extract) || page.description || title,
    parentId: null,
    depth,
    url: wikiUrl(page.title),
    type: page.ns === 14 ? 'category' : 'article',
  };
}

// Categories: their member pages and subcategories. Articles: the links in the intro and "See also",
// their closest related topics, topped up with "more like this" search when the article is short.
async function candidatesFor(parent) {
  const seen = new Set();
  const out = [];
  const consider = (page) => {
    if (!page.pageid || page.missing || seen.has(page.pageid)) return;
    seen.add(page.pageid);
    if ((page.ns !== 0 && page.ns !== 14) || page.pageprops?.disambiguation !== undefined) return;
    const category = page.ns === 14;
    const title = page.title.replace(/^Category:/, '');
    if (normalize(title) === normalize(parent.title)) return;
    if (category ? BAD_CATEGORY.test(title) : rejectReason(title, page.description)) return;
    out.push({ id: page.pageid, title, description: page.description ?? '', category, length: page.length ?? 0 });
  };

  if (parent.type === 'category') {
    (await pages({
      generator: 'categorymembers',
      gcmtitle: `Category:${parent.title}`,
      gcmnamespace: '0|14',
      gcmlimit: '200',
      prop: 'description|info|pageprops',
      ppprop: 'disambiguation',
    })).forEach(consider);
    // Members arrive alphabetically: subcategories first, then the most developed articles.
    return out.sort((a, b) => Number(b.category) - Number(a.category) || b.length - a.length);
  }

  (await describe(await introAndSeeAlso(parent.id))).forEach(consider);
  if (out.length < 10) {
    const similar = await wiki({ action: 'query', list: 'search', srsearch: `morelike:${parent.title}`, srnamespace: '0', srlimit: '15' })
      .then((data) => (data.query?.search ?? []).map((hit) => hit.title))
      .catch(() => []);
    (await describe(similar)).forEach(consider);
  }
  return out;
}

async function introAndSeeAlso(pageid) {
  const parse = (extra) => wiki({ action: 'parse', pageid: String(pageid), ...extra }).then((data) => data.parse ?? {});
  const { sections = [] } = await parse({ prop: 'sections' });
  const wanted = ['0', ...sections.filter((s) => /^see also$/i.test(s.line)).map((s) => s.index)];
  const parsed = await Promise.all(wanted.map((section) => parse({ prop: 'links', section })));
  return [...new Set(parsed.flatMap((p) => (p.links ?? []).filter((l) => l.ns === 0 && l.exists).map((l) => l.title)))];
}

async function describe(titles) {
  const out = [];
  for (let i = 0; i < titles.length; i += 50) {
    out.push(
      ...(await pages({ titles: titles.slice(i, i + 50).join('|'), redirects: '1', prop: 'description|info|pageprops', ppprop: 'disambiguation' }))
    );
  }
  return out;
}

async function toNodes(parent, picks) {
  const articleIds = picks.filter(({ candidate }) => !candidate.category).map(({ candidate }) => candidate.id);
  const extracts = new Map();
  if (articleIds.length) {
    const found = await pages({ pageids: articleIds.join('|'), prop: 'extracts', exintro: '1', explaintext: '1', exsentences: '2', exlimit: '20' }).catch(() => []);
    for (const page of found) if (tidy(page.extract)) extracts.set(page.pageid, tidy(page.extract));
  }
  return picks.map(({ candidate: c, reason }) => ({
    id: c.id,
    title: c.title,
    summary: (extracts.get(c.id) || (c.description && `${c.title}: ${c.description}.`) || `Topics in ${c.title}.`).slice(0, 600),
    parentId: parent.id,
    depth: parent.depth + 1,
    url: wikiUrl(c.category ? `Category:${c.title}` : c.title),
    type: c.category ? 'category' : 'article',
    ...(reason ? { reason } : {}),
  }));
}

// ── Gemini ─────────────────────────────────────────────────────────────────────────────────

async function chooseWithGemini(parent, candidates) {
  const shortlist = candidates.slice(0, MAX_CANDIDATES);
  const prompt = `You curate Hyperspace, a map of knowledge about artificial intelligence built from Wikipedia.
The reader is expanding the topic "${parent.title}" (${parent.type}): ${String(parent.summary).slice(0, 300)}

Choose up to ${MAX_CHILDREN} candidates that belong under this topic: its subtopics, techniques, components, applications or closely related concepts that a curious reader would want to explore next.

Rules:
- Use only ids from the candidate list.
- Skip people, companies, organisations, places, publications, events, unrelated products, lists, and pages that are only loosely connected (a country, a language, a job title, a generic field like "Mathematics").
- Skip pages much broader than the topic itself.
- Prefer a varied set over near-duplicates.
- Fewer is fine. Return an empty list if nothing fits.
- For each pick, give a short reason (under 15 words) saying how it relates to "${parent.title}".

Candidates (id, title, Wikipedia description):
${shortlist.map((c) => `${c.id}\t${c.title}${c.category ? ' (category)' : ''}\t${c.description}`).join('\n')}

Respond with JSON: {"children": [{"id": <candidate id>, "reason": "<short reason>"}]}`;

  const answer = await geminiJson(prompt);
  if (!answer) return null;
  const list = Array.isArray(answer.data) ? answer.data : (answer.data?.children ?? []);
  const byId = new Map(shortlist.map((c) => [c.id, c]));
  const picks = [];
  for (const item of list) {
    // Only ids from the candidate list count, so Gemini can't invent a page.
    const candidate = byId.get(Number(item?.id));
    if (!candidate || picks.some((p) => p.candidate === candidate)) continue;
    picks.push({ candidate, reason: String(item.reason ?? '').trim().slice(0, 140) });
    if (picks.length >= MAX_CHILDREN) break;
  }
  return { picks, model: answer.model };
}

// ── Filters (ported from ingest.mjs, plus places and citation pages, which show up in article links) ──

const BAD_CATEGORY =
  /\b(stubs?|wikipedia|wikipedians|wikiproject|templates?|articles|pages|redirects|drafts?|portals?|tracking|cleanup|disambiguation|images|files|commons|lists?|people|persons|\w+ists|\w+ians|critics|advocates|pioneers|founders|researchers|scientists|engineers|scholars|companies|businesspeople|entrepreneurs|organi[sz]ations|laboratories|institutes|universities|conferences|journals|publications|books|magazines|awards|competitions|films|television|novels|fiction|fictional|works|literature|created using|video games|comics|characters|songs|albums|events|deaths|by (country|nationality|city|continent|region|year|decade|century))\b/i;
const LIST_TITLE = /^(lists? of|outline of|glossary of|index of|timeline of)\b/i;
const CITATION = /^(digital object identifier|bibcode|pubmed( central)?|semantic scholar|isbn|issn|arxiv|jstor|oclc|s2cid|wayback machine|wikidata|wikimedia commons)$/i;
const DISAMBIGUATION = /referred to by the same term|^disambiguation page|^wikimedia (list|disambiguation)/i;
const MEDIA_TITLE = /\(([^)]* )?(film|novel|video game|tv series|band|album|song|magazine|journal|book)\)$/i;
const MEDIA =
  /\b(film|movie|novel|book|essay|album|song|video game|magazine|journal|newspaper|podcast|comic|short story|news (and media )?website)( by\b|$)|^(book|film|novel)\b|\b(television|tv) (series|show|program)/i;
const EVENT_TITLE = /^\d{4}\b|\b(attack|shooting|massacre|killings?|murders?|suicides?|bombing|scandal|strike|lawsuit|protests?|riots?|deaths?|war|awards?)\b/i;
const DATED =
  /^\d{4}s?\b.*\b(film|movie|novel|book|album|song|single|video game|documentary|television|series|play|attack|shooting|strike|protest|election|scandal|lawsuit|incident|disaster|crash)\b|\b(attack|shooting|massacre|bombing|scandal|lawsuit|protest|riot|armed conflict|war)\b/i;
const ORGANISATION =
  /\b(company|corporation|startup|subsidiary|non-?profit|not-for-profit|laboratory|institute|university|think tank|agency|non-governmental)\b|\b(secondary|high|primary|boarding|private|public|business|law|medical) school\b|\b(school|college) in\b|^organi[sz]ation$/i;
const PERSON =
  /\(born\b|\b(born|died) (in )?\d{4}|\b(computer scientist|scientist|researcher|engineer|entrepreneur|businessman|businesswoman|businessperson|professor|psychologist|philosopher|mathematician|economist|author|writer|journalist|editor|actor|actress|politician|executive|investor|inventor|neuroscientist|statistician|physicist|roboticist|linguist|programmer|activist|artist|singer|songwriter|musician|rapper|filmmaker|youtuber|biohacker|chairman|chairwoman|ceo|founder|president|prime minister|minister|pope|senator|governor|mayor|head of|director of)\b/i;
const LIFESPAN = /\((\d{4})\s*[–-]\s*(\d{4})\)/;
const PLACE =
  /\b(city|town|village|county|country|state|province|region|municipality|capital|island|district|neighbou?rhood) (in|of)\b|^(country|sovereign state|currency)\b|\bcurrency of\b/i;

function rejectReason(title, description = '') {
  if (LIST_TITLE.test(title) || CITATION.test(title) || DISAMBIGUATION.test(description)) return 'meta';
  if (MEDIA_TITLE.test(title) || MEDIA.test(description)) return 'media';
  if (EVENT_TITLE.test(title) || DATED.test(description)) return 'event';
  if (ORGANISATION.test(description)) return 'organisation';
  // A year range only marks a person when it spans a lifetime, unlike a model's "(2024–2026)".
  const lifespan = description.match(LIFESPAN);
  if (PERSON.test(description) || (lifespan && lifespan[2] - lifespan[1] >= 20)) return 'person';
  if (PLACE.test(description)) return 'place';
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────

function normalize(title) {
  return String(title).replace(/^Category:/i, '').toLowerCase().replace(/[-_–]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function tidy(text) {
  return String(text ?? '').replace(/\(\s*[,;]?\s*\)/g, '').replace(/\s+/g, ' ').replace(/\s+([.,;])/g, '$1').trim();
}

function wikiUrl(title) {
  const path = encodeURIComponent(title.replaceAll(' ', '_')).replace(/%2F/g, '/').replace(/%3A/g, ':');
  return `https://en.wikipedia.org/wiki/${path}`;
}
