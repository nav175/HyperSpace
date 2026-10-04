# Hyperspace 2.0

### A living AI knowledge universe

Hyperspace turns complex information into an interactive universe that you can explore by bending space.

Instead of scrolling through folders or zooming into a crowded mind map, users navigate a hyperbolic disk. Selected concepts move into the centre while surrounding branches remain visible, helping users explore details without losing context.

Built for **StormHacks 2026** by **Karn, Navjot and Dilpreet**.

## The Problem

Large knowledge collections are difficult to navigate. Lists hide connections, and traditional node diagrams become crowded as information grows.

We want to make exploring thousands of connected concepts feel intuitive and engaging.

## Our Approach

Hyperspace uses the **Poincaré disk**, a model of hyperbolic geometry, to display hierarchical information.

The focused region expands into the readable centre. Distant branches compress toward the boundary. Clicking a concept transforms the entire map around it.

AI adds semantic search and helps organize new information as users explore.

## Planned Features

- **Hyperbolic navigation:** Explore a knowledge hierarchy with smooth click and drag interactions.
- **Semantic search:** Find concepts using natural language through TiDB vector search.
- **Dynamic expansion:** Grow new branches from a selected topic with Gemini.
- **Source-backed information:** View article summaries and links to their Wikipedia sources.
- **Context-aware labels:** Show more detail around the focused region.
- **Cached exploration:** Load the main universe without waiting for live AI generation.

## Technology

| Component | Planned technology |
|---|---|
| Frontend | Next.js, React and TypeScript |
| Styling | Tailwind CSS |
| Visualization | d3-hypertree |
| Knowledge source | Wikipedia / MediaWiki API |
| AI organization | Google Gemini API |
| Semantic retrieval | TiDB vector search |
| Data storage | TiDB and cached JSON |

## How It Works

### Building the Universe

1. Retrieve real articles and category relationships from Wikipedia.
2. Filter duplicates, maintenance categories and cycles.
3. Build a hierarchy, using Gemini where organization needs help.
4. Generate embeddings and store searchable nodes in TiDB.
5. Render the hierarchy in the hyperbolic interface.

Wikipedia categories form a graph, so the displayed hierarchy is an organized view of the source relationships.

### Searching by Meaning

The user's query is converted into an embedding. TiDB retrieves semantically relevant concepts, and the visualization highlights those regions and moves toward the selected result.

### Growing New Branches

When a user expands a topic, the app retrieves related source material. Gemini helps organize that information into new branches, which appear in the existing universe.

## Keeping It Fast

The main dataset is prepared and cached ahead of time. Ordinary navigation happens in the browser.

Gemini processes groups of concepts rather than making one request per node. Successful expansions are cached for reuse.

The core visualization is designed to remain usable with cached data when external services are unavailable.

## Hackathon Tracks

We are building toward:

- **Huawei Beyond Euclid:** Non-Euclidean geometry forms the foundation of the interface.
- **TiDB x AI Open Build:** Vector search powers semantic navigation.
- **Best Use of Gemini API:** Gemini helps organize and expand the knowledge universe.
- **Best Design:** The interface focuses on fluid motion, readable concepts and spatial exploration.

## Team

- **Karn**
- **Navjot**
- **Dilpreet**

## Project Status

Hyperspace 2.0 is under active development during StormHacks 2026. The features and technology above describe our intended implementation.

## Acknowledgments

Hyperspace builds on existing hyperbolic visualization research and open-source tools, including d3-hypertree.

Knowledge content comes from Wikipedia. Source attribution and applicable content licensing must be preserved.
