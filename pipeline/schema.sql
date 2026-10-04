-- Hyperspace TiDB schema. `npm run load` applies it; `npm run load -- --reset` recreates it.

-- One row per node in data/nodes.json. API responses map these columns onto the README
-- contract { id, title, summary, parentId, depth, url, type }, plus path.
CREATE TABLE IF NOT EXISTS nodes (
  id BIGINT PRIMARY KEY COMMENT 'Wikipedia page id, stable across re-ingests',
  title VARCHAR(512) NOT NULL,
  summary TEXT NOT NULL,
  parent_id BIGINT NULL,
  depth TINYINT NOT NULL,
  url VARCHAR(1024) NOT NULL,
  type VARCHAR(16) NOT NULL COMMENT 'category | article',
  path JSON NOT NULL COMMENT 'ids from the root down to this node, inclusive',
  search_text TEXT NOT NULL COMMENT 'title + summary, for full-text search',
  embed_text TEXT NOT NULL COMMENT 'title, breadcrumb and summary: what gets embedded',
  embedding VECTOR(1024) NULL COMMENT 'EMBED_TEXT(tidbcloud_free/amazon/titan-embed-text-v2, embed_text), filled by npm run embed',
  dataset_version VARCHAR(64) NOT NULL,
  KEY idx_parent (parent_id),
  FULLTEXT INDEX idx_search_text (search_text) WITH PARSER MULTILINGUAL,
  VECTOR INDEX idx_embedding ((VEC_COSINE_DISTANCE(embedding)))
);
