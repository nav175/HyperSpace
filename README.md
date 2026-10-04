# Hyperspace

### Explore knowledge by bending space

Hyperspace turns 5,635 Wikipedia topics about artificial intelligence into a universe you explore on a **Poincaré disk**. Click any topic and the whole map transforms around it: what you focus on grows into the readable centre while every other branch stays in view, compressed toward the rim.

Built for **StormHacks 2026** by **Karn, Navjot and Dilpreet**.

## The problem

Large knowledge collections are hard to navigate. Lists hide how ideas connect, and node diagrams turn into hairballs once they grow past a few hundred nodes.

## Our approach

In hyperbolic space the room available grows exponentially with distance from the centre, just as a tree's node count grows with depth. So the whole hierarchy fits in one view, with the focus large and its context small, instead of zooming in and losing your place.

## Features

- **Hyperbolic navigation.** Click a topic and it glides to the centre along a Möbius transformation; edges are geodesics. Drag or scroll to move through the plane. Click empty space to zoom into it, and pinch or use + and − to zoom.
- **Field lens.** Hovering the disk opens a lens around the cursor. Topics spread apart (most near the crowded rim), the field under the cursor lights up in its colour with its name and size, and its topics' names populate around the cursor.
- **A map that keeps growing.** When you come to rest on a topic with no branches yet, an edge of the map, Gemini grows it automatically. Toggle this with A.
- **Search by meaning.** Type a topic or describe it ("robots that look like people"). TiDB runs vector and full-text search side by side, and results are ranked by meaning with bonuses for keyword and title matches. Enter frames every match at once; the rest of the map fades back.
- **Ask Hyperspace.** Ask a question ("What is the difference between machine learning and deep learning?"). TiDB finds the relevant topics, and Gemini answers from their summaries only, citing each one. Citations are clickable, and the cited topics light up on the map.
- **Grow with Gemini.** On any topic, Gemini picks related Wikipedia pages to grow as new branches and says why each belongs. Branches grow out along geodesics, can be grown again, and are cached in TiDB.
- **How are these connected?** Pick two topics. The camera travels the path between them, and Gemini explains the link.
- **Geometry lens (G).** Rings of equal hyperbolic distance show why the edge has so much room. Hovering a topic draws rings around it and reports how far it is from the centre.
- **Flat view.** The same tree in flat space, with the same angles and evenly spaced rings, crowds at the edge. That makes the case for hyperbolic space in one click.
- **Listen.** Topic cards, answers and connections can be read aloud with ElevenLabs. This needs a key; without one the buttons don't appear.
- **Shareable links.** The address bar follows the topic you're on (`?topic=<id>`), so any view can be shared or bookmarked.
- **Opening.** Each time the page loads, the universe unfolds from its centre: every topic flies out along its geodesic, nearest first, while the rim draws itself. For demos, `?intro` adds opening titles in front of it; they wait at a play button until you press Space (Esc skips them).
- **Also:** light and dark themes (T) and a presentation mode (P). The map itself is a static file, so it works offline; search falls back to keyword matching when the API is unreachable.

## Running it

Requires Node.js 20.12 or newer.

```bash
npm install
cp .env.example .env.local   # then fill in the keys
npm run dev                  # http://localhost:3000
```

| Variable | Used for |
|---|---|
| `TIDB_HOST`, `TIDB_PORT`, `TIDB_USER`, `TIDB_PASSWORD`, `TIDB_DATABASE` | Search, Ask, node details and the Grow cache ([TiDB Cloud Starter](https://tidbcloud.com)) |
| `GEMINI_API_KEY` | Grow, Connect and Ask ([Google AI Studio](https://aistudio.google.com/apikey)) |
| `GEMINI_MODEL` | Optional; tried before the built-in model list |
| `ELEVENLABS_API_KEY` | Optional; Listen buttons ([ElevenLabs](https://elevenlabs.io/app/settings/api-keys)) |

## How it works

```
Wikipedia ─► pipeline/ingest.mjs ─► nodes.json ─► pipeline/load.mjs + embed.mjs ─► TiDB
                                        │           (full-text index, VECTOR(1024), expansions cache)
                                        ▼                                  ▲
                         Next.js app: canvas Poincaré disk                 │
                         components/universe/Universe.ts      /api/search, /api/ask, /api/node
                                        │                                  │
                                        └─ /api/expand, /api/connect, /api/ask ─► Gemini
```

**Data.** `pipeline/ingest.mjs` crawls Wikipedia's category graph breadth-first from *Category:Artificial intelligence*, so each page keeps its shallowest parent and cycles are broken. It filters out people, organisations, media, events, lists and maintenance categories, and skips the branches and pages listed in [`pipeline/data/excluded.json`](pipeline/data/excluded.json): places where the category graph drifts into medicine, codecs, file formats or product catalogues, reviewed by hand. It then prunes by article length: 363 categories and 5,272 articles across 29 fields, up to 6 levels deep. `load.mjs` writes them to TiDB with root-to-node paths. `embed.mjs` fills a `VECTOR(1024)` column inside TiDB with its built-in `EMBED_TEXT` model, embedding each topic with its breadcrumb so short titles keep their context.

**Layout and rendering.** [`geometry.ts`](components/universe/geometry.ts) lays the tree out in the Poincaré disk (Lamping and Rao): each node fans its children inside a wedge of its own local frame, sized by subtree weight. Recentering applies the disk automorphism z ↦ (z − a) / (1 − āz), and flights follow geodesics. [`Universe.ts`](components/universe/Universe.ts) draws everything on a canvas: edges as circular arcs that meet the rim at right angles, labels placed by available room, and growth animated along geodesics. It only redraws when something changes.

**Search** ([`pipeline/lib/api.mjs`](pipeline/lib/api.mjs)). The full-text (BM25) and vector legs run in parallel. Each candidate is scored by cosine similarity, plus 0.12 × its BM25 relative to the best keyword hit, plus a title-match bonus. Ranking by meaning first keeps filler words from winning.

**Gemini** ([`gemini.mjs`](pipeline/lib/gemini.mjs), [`expand.mjs`](pipeline/lib/expand.mjs), [`connect.mjs`](pipeline/lib/connect.mjs), [`ask.mjs`](pipeline/lib/ask.mjs)). Every call asks for strict JSON and validates it. Grow may only choose from real Wikipedia candidates, and Ask may only cite the topics TiDB retrieved. Models are tried in turn, since model ids get retired and the newest one is often busy.

## API

| Endpoint | Request | Response |
|---|---|---|
| `POST /api/search` | `{ query }` | `{ matches: [{ id, title, score, path }], focusNodeId }` |
| `POST /api/ask` | `{ question }` | `{ answer, sources: [{ id, title }], model }` |
| `POST /api/expand` | `{ nodeId, depth? }` | `{ parentId, children: [Node + reason], model }` |
| `POST /api/connect` | `{ from, to, path }` | `{ explanation, model }` |
| `GET /api/node/:id` | | `Node` + `path` (root → node) |
| `GET, POST /api/speak` | `{ text }` | `{ enabled }` / `audio/mpeg` |

`Node` is `{ id, title, summary, parentId, depth, url, type }`. Ids are Wikipedia page ids.

## Data pipeline

```bash
cd pipeline && npm install
npm run check    # TiDB connection, vector + full-text support, Gemini key
npm run ingest   # Wikipedia → data/nodes.json
npm run load     # nodes.json → TiDB
npm run embed    # fill embeddings inside TiDB
npm test         # data, search and API checks
```

The pipeline reads `.env.local` at the repo root. `npm run dev` and `npm run build` copy `pipeline/data/nodes.json` to `public/nodes.json`.

## Hackathon tracks

- **Huawei Beyond Euclid:** the interface is non-Euclidean throughout: Poincaré layout, Möbius recentering, geodesic edges and flights, and a geometry lens that explains them.
- **TiDB x AI Open Build:** hybrid vector and full-text search, embeddings computed inside TiDB, retrieval for Ask, and the Grow cache.
- **Best Use of Gemini API:** Gemini grows the map, explains connections and answers questions, each grounded in Wikipedia.
- **Best Design:** fluid motion, readable labels, light and dark themes, and spatial exploration.

## Team

- **Karn**
- **Navjot**
- **Dilpreet**

## Acknowledgments

The hyperbolic tree layout follows Lamping and Rao's hyperbolic browser.

Topic summaries come from [Wikipedia](https://en.wikipedia.org), available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Each topic links back to its source article.
