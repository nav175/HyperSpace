// Step 2: crawl Wikipedia's category tree into nodes.json (the README contract shape).
//   npm run ingest                                # ~2,500 nodes under "Artificial intelligence"
//   npm run ingest -- --max-nodes 1250            # Gate B fallback: half the universe
//   npm run ingest -- --extra "Robotics,Ethics"   # choose which branches get grafted onto the root
// Wikipedia responses are cached in .cache/, so re-running after tuning the filters takes seconds.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    root: { type: 'string', default: 'Artificial intelligence' },
    // Wikipedia files these outside Category:Artificial intelligence, but the demo needs them.
    extra: { type: 'string', default: 'Machine learning,Computer vision,Natural language processing,Robotics' },
    depth: { type: 'string', default: '4' },
    'max-nodes': { type: 'string', default: '2500' },
    'max-categories': { type: 'string', default: '400' },
    branches: { type: 'string', default: '14' },
    subcats: { type: 'string', default: '10' },
    articles: { type: 'string', default: '12' },
    out: { type: 'string' },
    fresh: { type: 'boolean', default: false },
  },
});
const MAX_DEPTH = Number(opts.depth);
const MAX_NODES = Number(opts['max-nodes']);
const MAX_CATEGORIES = Number(opts['max-categories']);
const BRANCHES = Number(opts.branches); // the root's own subcategories kept, on top of --extra
const SUBCATS_PER_CATEGORY = Number(opts.subcats);
const ARTICLES_PER_CATEGORY = Number(opts.articles);
const OUT = opts.out ? resolve(opts.out) : fileURLToPath(new URL('data/nodes.json', import.meta.url));

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
// Wikimedia asks API clients for a descriptive User-Agent with a way to reach them.
const USER_AGENT = 'HyperspaceStormHacks/0.1 (https://github.com/nav175/HyperSpace)';
const CACHE_DIR = fileURLToPath(new URL('.cache/wiki/', import.meta.url));

// Maintenance categories, plus groupings of people, organisations, media, places and dates.
const BAD_CATEGORY =
  /\b(stubs?|wikipedia|wikipedians|wikiproject|templates?|articles|pages|redirects|drafts?|portals?|tracking|cleanup|disambiguation|images|files|commons|lists?|people|persons|\w+ists|\w+ians|critics|advocates|pioneers|founders|researchers|scientists|engineers|scholars|companies|businesspeople|entrepreneurs|organi[sz]ations|laboratories|institutes|universities|conferences|journals|publications|books|magazines|awards|competitions|films|television|novels|fiction|fictional|works|literature|created using|video games|comics|characters|songs|albums|events|deaths|by (country|nationality|city|continent|region|year|decade|century))\b/i;
const LIST_TITLE = /^(lists? of|outline of|glossary of|index of|timeline of)\b/i;
const MEDIA_TITLE = /\(([^)]* )?(film|novel|video game|tv series|band|album|song|magazine|journal|book)\)$/i;
// News events: dated titles ("2026 ... shooting") and incident words.
const EVENT_TITLE = /^\d{4}\b|\b(attack|shooting|massacre|killings?|murders?|suicides?|bombing|scandal|strike|lawsuit|protests?|riots?|deaths?)\b/i;
// Short descriptions that mark an article as a person, organisation, work or event rather than a concept.
const DISAMBIGUATION = /referred to by the same term|^disambiguation page|^wikimedia (list|disambiguation)/i;
const MEDIA = /\b(film|movie|novel|book|essay|album|song|video game|magazine|journal|podcast|comic|short story)( by\b|$)|^(book|film|novel)\b|\b(television|tv) (series|show|program)/i;
const DATED =
  /^\d{4}s?\b.*\b(film|movie|novel|book|album|song|single|video game|documentary|television|series|play|attack|shooting|strike|protest|election|scandal|lawsuit|incident|disaster|crash)\b|\b(attack|shooting|massacre|bombing|scandal|lawsuit|protest|riot)\b/i;
const ORGANISATION = /\b(company|corporation|startup|subsidiary|non-?profit|not-for-profit|laboratory|institute|university|think tank)\b|^organi[sz]ation$/i;
const PERSON =
  /\(born\b|\b(born|died) (in )?\d{4}|\b(computer scientist|scientist|researcher|engineer|entrepreneur|businessman|businesswoman|businessperson|professor|psychologist|philosopher|mathematician|economist|author|writer|journalist|actor|actress|politician|executive|investor|inventor|neuroscientist|statistician|physicist|roboticist|linguist|programmer|activist|artist|singer|songwriter|musician|rapper|filmmaker|youtuber|biohacker|chairman|chairwoman|ceo|founder|president|prime minister|minister|pope|senator|governor|mayor|head of|director of)\b/i;
const LIFESPAN = /\((\d{4})\s*[–-]\s*(\d{4})\)/;
// Intros that read as a biography or a news report, for people and events the descriptions missed.
// (?:[^.]|(?<=\b[A-Z])\.) is "first-sentence text", where initials like "George W. G. Allen" don't end it.
const BIOGRAPHY =
  /^(?:[^.]|(?<=\b[A-Z])\.){0,200}\(born\b|^(?:[^.]|(?<=\b[A-Z])\.){0,120}\([^()]*\b\d{4}\b[^()]*[–-][^()]*\b\d{4}\)\s+(is|was)\b|^(?:[^.]|(?<=\b[A-Z])\.){2,80}? (is|was) an? (?:[\w-]+ ){0,4}(artist|scientist|engineer|professor|researcher|entrepreneur|businessman|businesswoman|executive|politician|singer|musician|filmmaker|writer|author|activist|designer|inventor|roboticist|philosopher|programmer|developer|biohacker|academic(?= (?:in|at|and|who)\b|,))\b/;
const EVENT_LEAD =
  /^(On|In|From|Between|During|Since)\s+((the )?\d{1,2}(st|nd|rd|th)? )?(January|February|March|April|May|June|July|August|September|October|November|December)\b/;
const DEMO_TOPICS = [
  'Computer vision',
  'Transformer',
  'Large language model',
  'Convolutional neural network',
  'Reinforcement learning',
  'Natural language processing',
  'Generative AI',
  'Humanoid robot',
];

const nodes = new Map(); // page id → node
const visited = new Set(); // page ids already placed; BFS means the shallowest placement wins
const categoryByTitle = new Map(); // lowercase title → category node, to fold in same-named articles
const dropped = { person: 0, organisation: 0, media: 0, event: 0, meta: 0 };
let fetched = 0;
let cached = 0;

mkdirSync(CACHE_DIR, { recursive: true });

// 1. Crawl, breadth first, so every page keeps its shallowest parent and cycles can't recur.
console.log(`Crawling Category:${opts.root} (depth ${MAX_DEPTH}, up to ${MAX_CATEGORIES} categories)`);
const [rootPage] = await queryAll({ titles: `Category:${opts.root}`, prop: 'categoryinfo|info' });
if (!rootPage?.pageid) throw new Error(`Wikipedia has no Category:${opts.root}`);
const root = addNode(rootPage, null, 'category');

let level = [root];
let expanded = 0;
for (let depth = 0; depth < MAX_DEPTH && level.length && expanded < MAX_CATEGORIES; depth++) {
  const next = depth === 0 ? await graftExtras() : [];
  // Biggest categories first, so the category cap trims the smallest ones at the deepest level.
  for (const category of level.sort((a, b) => b.size - a.size)) {
    if (expanded >= MAX_CATEGORIES) break;
    next.push(...(await expand(category)));
    if (++expanded % 25 === 0) console.log(`  ${expanded} categories, ${nodes.size} candidates`);
  }
  level = next;
}

// Fold articles placed before their same-named category turned up (e.g. "Deep learning" under the root).
for (const node of nodes.values()) {
  const owner = node.type === 'article' && categoryByTitle.get(node.title.toLowerCase());
  if (owner && nodes.has(owner.id)) {
    owner.main ??= summarySource(node);
    nodes.delete(node.id);
  }
}

// 2. Intros for every candidate: they become the summaries, and they catch people and news
// events whose short descriptions slipped past the filters above.
console.log(`Fetching intros for ${nodes.size} candidates`);
const sourceOf = (node) => (node.type === 'article' ? node : node.main);
const extracts = await fetchExtracts([...nodes.values()].map(sourceOf).filter(Boolean).map((source) => source.id));
for (const node of [...nodes.values()]) {
  if (node.type !== 'article') continue;
  const intro = extracts.get(node.id) ?? '';
  // With neither an intro nor a description there is nothing to show or to filter on.
  const reason = BIOGRAPHY.test(intro) ? 'person' : EVENT_LEAD.test(intro) ? 'event' : !intro && !node.description ? 'meta' : null;
  if (reason) {
    dropped[reason]++;
    nodes.delete(node.id);
  }
}

// 3. Prune to the most developed topics. Article length stands in for importance: page views
// cost one request per 5 pages and favour whatever is in the news this month.
// Removing a node cascades up through any category it leaves empty.
const childCount = new Map([...nodes.keys()].map((id) => [id, 0]));
for (const node of nodes.values()) {
  if (node.parentId !== null) childCount.set(node.parentId, childCount.get(node.parentId) + 1);
}
for (const node of [...nodes.values()]) {
  if (nodes.has(node.id) && node.type === 'category' && node !== root && childCount.get(node.id) === 0) dissolve(node);
}

const byImportance = (a, b) => b.length - a.length;
const articlesUnder = new Map();
for (const node of nodes.values()) {
  if (node.type !== 'article') continue;
  if (!articlesUnder.has(node.parentId)) articlesUnder.set(node.parentId, []);
  articlesUnder.get(node.parentId).push(node);
}
for (const articles of articlesUnder.values()) {
  for (const extra of articles.sort(byImportance).slice(ARTICLES_PER_CATEGORY)) remove(extra);
}

if (nodes.size > MAX_NODES) {
  const leastImportant = [...nodes.values()].filter((node) => node.type === 'article').sort(byImportance).reverse();
  for (const article of leastImportant) {
    if (nodes.size <= MAX_NODES) break;
    if (nodes.has(article.id)) remove(article);
  }
}

const children = new Map([...nodes.keys()].map((id) => [id, []]));
for (const node of nodes.values()) {
  if (node.parentId === null) continue;
  const parent = nodes.get(node.parentId);
  if (!parent || parent.depth !== node.depth - 1) throw new Error(`Broken tree at ${node.title}`);
  children.get(parent.id).push(node);
}
const score = new Map();
(function total(node) {
  let sum = node.type === 'article' ? node.length : (node.main?.length ?? 0);
  for (const child of children.get(node.id)) sum += total(child);
  score.set(node.id, sum);
  return sum;
})(root);

// 4. Write. A category's summary is the intro of its same-named article when it has one.
const output = [...nodes.values()]
  .sort((a, b) => a.depth - b.depth || score.get(b.id) - score.get(a.id))
  .map((node) => {
    const source = sourceOf(node);
    return {
      id: node.id,
      title: node.title,
      summary: extracts.get(source?.id) || source?.description || topicsSummary(node),
      parentId: node.parentId,
      depth: node.depth,
      url: wikiUrl(source?.title ?? node.wikiTitle),
      type: node.type,
    };
  });

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `[\n${output.map((node) => JSON.stringify(node)).join(',\n')}\n]\n`);
const generatedAt = new Date().toISOString();
const meta = {
  datasetVersion: `wiki-${opts.root.toLowerCase().replace(/\W+/g, '-')}-${generatedAt.slice(0, 16).replace(/\D/g, '')}`,
  root: opts.root,
  extra: opts.extra,
  depth: MAX_DEPTH,
  nodeCount: output.length,
  generatedAt,
};
writeFileSync(OUT.replace(/\.json$/, '.meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

// 5. Report
const categoryCount = output.filter((node) => node.type === 'category').length;
const perDepth = new Map();
for (const node of output) perDepth.set(node.depth, (perDepth.get(node.depth) ?? 0) + 1);
const subtreeSize = (node) => 1 + children.get(node.id).reduce((sum, child) => sum + subtreeSize(child), 0);

console.log(`\nWrote ${relative(process.cwd(), OUT)}: ${output.length} nodes (${categoryCount} categories, ${output.length - categoryCount} articles)`);
console.log(`  by depth:     ${[...perDepth].map(([depth, count]) => `${depth}: ${count}`).join('   ')}`);
console.log(`  summaries:    ${output.filter((node) => node.summary).length} of ${output.length}`);
console.log(`  filtered out: ${Object.entries(dropped).map(([reason, count]) => `${count} ${reason}`).join(', ')}`);
console.log(`  wikipedia:    ${fetched} requests, ${cached} from cache`);

console.log('\nTop-level branches:');
for (const branch of children.get(root.id).sort((a, b) => subtreeSize(b) - subtreeSize(a))) {
  console.log(`  ${String(subtreeSize(branch)).padStart(5)}  ${branch.title}`);
}

console.log('\nDemo topics:');
for (const term of DEMO_TOPICS) {
  const hit = output.find((node) => node.title.toLowerCase().includes(term.toLowerCase()));
  console.log(hit ? `  ✓ ${term}: ${pathTo(nodes.get(hit.id))}` : `  ✗ ${term}: not in the tree`);
}
if (output.length < 1500) {
  console.log(`\n! Only ${output.length} nodes. Try --depth ${MAX_DEPTH + 1} or --max-categories ${MAX_CATEGORIES * 2}.`);
}

async function expand(category) {
  const members = await queryAll({
    generator: 'categorymembers',
    gcmtitle: category.wikiTitle,
    gcmnamespace: '0|14',
    gcmlimit: 'max',
    prop: 'description|categoryinfo|info',
  });
  const subcategories = [];
  // Subcategories first, so an article named like one becomes its summary instead of a duplicate node.
  if (category.depth + 1 < MAX_DEPTH) {
    const keep = members
      .filter((page) => page.ns === 14 && !visited.has(page.pageid) && !BAD_CATEGORY.test(page.title))
      .sort((a, b) => categorySize(b) - categorySize(a))
      .slice(0, category === root ? BRANCHES : SUBCATS_PER_CATEGORY);
    for (const page of keep) subcategories.push(addNode(page, category, 'category'));
  }
  for (const page of members) {
    if (page.ns !== 0 || visited.has(page.pageid)) continue;
    visited.add(page.pageid);
    const owner = categoryByTitle.get(page.title.toLowerCase());
    if (owner) {
      owner.main ??= summarySource(page);
      continue;
    }
    const reason = rejectReason(page);
    if (reason) dropped[reason]++;
    else addNode(page, category, 'article');
  }
  return subcategories;
}

async function graftExtras() {
  const grafted = [];
  for (const name of opts.extra.split(',').map((part) => part.trim()).filter(Boolean)) {
    const [page] = await queryAll({ titles: `Category:${name}`, prop: 'categoryinfo|info' });
    if (!page?.pageid) console.log(`  ! Wikipedia has no Category:${name}, skipping`);
    else if (!visited.has(page.pageid)) grafted.push(addNode(page, root, 'category'));
  }
  return grafted;
}

function addNode(page, parent, type) {
  const node = {
    id: page.pageid,
    title: page.title.replace(/^Category:/, ''),
    wikiTitle: page.title,
    type,
    depth: parent ? parent.depth + 1 : 0,
    parentId: parent ? parent.id : null,
    length: page.length ?? 0,
    description: page.description ?? '',
    size: categorySize(page),
  };
  nodes.set(node.id, node);
  visited.add(node.id);
  if (type === 'category') categoryByTitle.set(node.title.toLowerCase(), node);
  return node;
}

function remove(node) {
  nodes.delete(node.id);
  const parent = nodes.get(node.parentId);
  if (!parent) return;
  const left = childCount.get(parent.id) - 1;
  childCount.set(parent.id, left);
  if (left === 0 && parent !== root) dissolve(parent);
}

// An empty category still stands for its same-named article, if it has one: keep that as a leaf.
function dissolve(category) {
  if (!category.main) return remove(category);
  nodes.delete(category.id);
  const { id, title, length, description } = category.main;
  nodes.set(id, { ...category, id, title, wikiTitle: title, length, description, type: 'article', main: undefined });
}

function rejectReason({ title, description = '' }) {
  if (LIST_TITLE.test(title) || DISAMBIGUATION.test(description)) return 'meta';
  if (MEDIA_TITLE.test(title) || MEDIA.test(description)) return 'media';
  if (EVENT_TITLE.test(title) || DATED.test(description)) return 'event';
  if (ORGANISATION.test(description)) return 'organisation';
  // A year range only marks a person when it spans a lifetime, unlike a model's "(2024–2026)".
  const lifespan = description.match(LIFESPAN);
  if (PERSON.test(description) || (lifespan && lifespan[2] - lifespan[1] >= 20)) return 'person';
  return null;
}

function topicsSummary(node) {
  const top = children
    .get(node.id)
    .sort((a, b) => score.get(b.id) - score.get(a.id))
    .slice(0, 3)
    .map((child) => child.title);
  return top.length ? `Topics in ${node.title}, including ${top.join(', ')}.` : '';
}

function pathTo(node) {
  const titles = [];
  for (let current = node; current; current = nodes.get(current.parentId)) titles.unshift(current.title);
  return titles.join(' › ');
}

async function fetchExtracts(ids) {
  const texts = new Map();
  for (let i = 0; i < ids.length; i += 20) {
    const pages = await queryAll({
      pageids: ids.slice(i, i + 20).join('|'),
      prop: 'extracts',
      exintro: '1',
      explaintext: '1',
      exsentences: '2',
      exlimit: '20',
    });
    for (const page of pages) if (page.extract?.trim()) texts.set(page.pageid, tidy(page.extract));
  }
  return texts;
}

// Follows MediaWiki continuation, merging page props that arrive spread over several responses.
async function queryAll(params) {
  const pages = new Map();
  let next = {};
  do {
    const body = await api({ ...params, ...next });
    for (const page of body.query?.pages ?? []) {
      const key = page.pageid ?? page.title;
      pages.set(key, { ...pages.get(key), ...page });
    }
    next = body.continue ?? null;
  } while (next);
  return [...pages.values()];
}

async function api(params) {
  const url = `${WIKI_API}?${new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', maxlag: '5', ...params })}`;
  const file = `${CACHE_DIR}${createHash('sha1').update(url).digest('hex')}.json`;
  if (!opts.fresh && existsSync(file)) {
    cached++;
    return JSON.parse(readFileSync(file, 'utf8'));
  }
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(2 ** attempt * 1000);
      continue;
    }
    const body = res.ok ? await res.json() : null;
    if (body && !body.error) {
      writeFileSync(file, JSON.stringify(body));
      fetched++;
      return body;
    }
    // Retry only what Wikipedia says is temporary: replication lag, rate limits, server errors.
    const temporary = body?.error?.code === 'maxlag' || res.status === 429 || res.status >= 500;
    if (!temporary) throw new Error(`Wikipedia API: ${body?.error?.info ?? `HTTP ${res.status}`}`);
    await sleep((Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000);
  }
  throw new Error(`Wikipedia kept failing: ${url}`);
}

function summarySource(item) {
  return {
    id: item.pageid ?? item.id,
    title: item.title,
    length: item.length ?? 0,
    description: item.description ?? '',
  };
}

function categorySize(page) {
  return (page.categoryinfo?.pages ?? 0) + (page.categoryinfo?.subcats ?? 0);
}

function tidy(text) {
  return text.replace(/\(\s*[,;]?\s*\)/g, '').replace(/\s+/g, ' ').replace(/\s+([.,;])/g, '$1').trim();
}

function wikiUrl(title) {
  const path = encodeURIComponent(title.replaceAll(' ', '_')).replace(/%2F/g, '/').replace(/%3A/g, ':');
  return `https://en.wikipedia.org/wiki/${path}`;
}
