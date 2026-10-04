# **Hyperspace 2.0 — StormHacks Build Plan**

Oct 3, 2026 · @Dilpreet

## **Roles**

Each person owns one workstream end to end. Karn also owns main and merges everyone's work at each gate.

| Person | Workstream | Delivers |
| :---- | :---- | :---- |
| Navjot | Geometry engine | Canvas Poincaré renderer, Möbius recentering, geodesic edges, animations, Euclid toggle |
| Dilpreet | Data \+ TiDB | Ingestion script, nodes.json, TiDB schema, embeddings, hybrid search, /api/search, /api/node |
| Karn | App \+ Gemini \+ pitch | UI shell, /api/expand, demo mode, 3-minute video, Devpost |

If Karn is the stronger canvas and math coder, swap Navjot and Karn. The geometry engine is the make-or-break piece.

## **Contracts (agree in the first 30 minutes)**

Agree on these shapes before anyone codes, so all three can work in parallel on fake data and merge cleanly later.

Node:    { id, title, summary, parentId, depth, url, type }  
Search:  POST /api/search {query}  → { matches:\[{id, title, score, path:\[ids\]}\], focusNodeId }  
Expand:  POST /api/expand {nodeId} → { parentId, children:\[Node\] }  
Node:    GET  /api/node/:id        → Node \+ path:\[ids\]

Renderer (Navjot builds, Karn calls):  
  loadTree(nodes)   flyTo(id)   highlight(ids)  
  addChildren(parentId, nodes)   setMode("hyperbolic" | "euclid")  
  onSelect(callback)  ← fires with the node when the user clicks

- [ ] Contracts agreed and pasted into the repo README  
- [ ] Everyone can run the app locally

## **Timeline**

Times assume a 5:30 PM Saturday start and a 10 AM Sunday deadline (last year's StormHacks ran 10 AM to 10 AM). Confirm the real deadline on Discord and shift every time by the same amount.

### **5:30–6:15 PM · Kickoff**

- [ ] Navjot: canvas page \+ fake 1,000-node tree generator  
- [ ] Dilpreet: TiDB Starter cluster, Gemini API key, shared .env  
- [ ] Karn: repo, Next.js scaffold, Vercel project

### **6:15–10 PM · Checkpoint A: the disk works**

- [ ] Navjot: Poincaré layout, click-to-recenter with Möbius transform \+ eased animation  
- [ ] Navjot: drag to pan, geodesic-arc edges, labels sized by distance from center  
- [ ] Dilpreet: ingestion script → nodes.json (1,500–3,000 AI nodes with summaries). Hard stop 8:30 PM; if Wikipedia is messy, switch to the ACM CCS skeleton  
- [ ] Dilpreet: create TiDB tables and load nodes  
- [ ] Karn: UI shell — search bar, focused-node card (title, summary, source link, Expand), presentation mode, on fake data  
- [ ] Karn: Gemini cleanup prompt returns valid JSON on 3 test topics

### **10 PM–12 AM · Checkpoint B: real data**

- [ ] Navjot: load real nodes.json, performance pass (cull tiny labels and edges near the boundary)  
- [ ] Navjot: Euclid toggle (same tree in a flat layout)  
- [ ] Dilpreet: batch embeddings → TiDB vector column \+ index  
- [ ] Dilpreet: full-text index on title/summary, /api/node/:id  
- [ ] Karn: /api/expand v1 — Wikipedia items for focused node → Gemini cleanup → JSON  
- [ ] Karn \+ Dilpreet: expansions cache table

### **12–3 AM · Checkpoint C: search flies**

- [ ] Navjot: flyTo travels along the path; matching nodes glow  
- [ ] Dilpreet: /api/search — embed query → hybrid TiDB query → matches \+ paths  
- [ ] Karn: wire search bar → API → renderer; save demo-query response for demo mode

### **3–6 AM · Checkpoint D: live expand (stretch)**

- [ ] Navjot: new children grow outward \+ "Mapping new territory…" pulse (nap 4:30–6)  
- [ ] Dilpreet: nap 3–4:30, then demo-mode flag (cached search \+ expand), /api/health, README architecture  
- [ ] Karn: expand end to end through the TiDB cache; cache 2 known-good topics

### **6–8:30 AM · Checkpoint E: demo lock (feature freeze 6:30)**

- [ ] Navjot: visual polish, final performance check on the presentation laptop  
- [ ] Dilpreet: deploy, test link on another laptop \+ phone hotspot, no secrets in GitHub  
- [ ] Karn: nap 6–7:15, then pitch script \+ record 3-minute video in demo mode

## **Gates**

Missing a gate means taking its fallback immediately, not pushing the deadline.

| Gate | By | Done when | If missed |
| :---- | :---- | :---- | :---- |
| A | 10 PM | Clicking any distant node glides it smoothly to the center | Karn stops UI work and pairs with Navjot; nothing else matters until this works |
| B | 12 AM | Real universe loads in a fresh browser and runs smoothly on the presentation laptop | Cut the node count in half |
| C | 3 AM | Demo search works 5 times in a row, including with Wi-Fi off in demo mode | Drop hybrid; use vector-only search |
| D | 6 AM | One live Expand works and its result is cached | Cut live expand from the demo |
| E | 8:30 AM | Video recorded; deployed link works on someone else's laptop | Submit what you have; no new features |

## **Submission (8:30–9:30 AM, all three)**

Submit by 9:15 AM, an hour early, because submission sites jam near the deadline.

- [ ] Project link (GitHub repo \+ deployed URL)  
- [ ] Demo video, 3 minutes or less  
- [ ] Devpost writeup with architecture and how each sponsor tech is used  
- [ ] Opt in: Huawei Challenge \#1 — Beyond Euclid  
- [ ] Opt in: TiDB x AI Open Build  
- [ ] Opt in: \[MLH\] Best Use of Gemini API  
- [ ] Opt in: IATSU Best Design  
- [ ] Opt in: Best Beginner, if at least 2 of the 3 of you are first-time hackers  
- [ ] Opt in: CSSS Legacy, only if someone finished the scavenger hunt  
- [ ] Opt in: Best .Tech Domain, only if you registered one  
- [ ] Rehearse the live pitch 3 times before judging

## **Rules for the night**

- [ ] Merge to main only at gates, then run git tag gate-a, gate-b and so on, so you can roll back if something breaks.  
- [ ] Only one person naps at a time. Karn sleeps last, right before recording.  
- [ ] If you fall behind, cut live expand first, then hybrid search. Keep the Euclid toggle: it's cheap and it's your best proof that the geometry matters.  
- [ ] Record the demo video with the preloaded universe in demo mode, never a cold build.