// Search embeddings come from TiDB Cloud's free hosted model, so TiDB embeds both the nodes and
// each query: no API key and no daily cap. Nodes and queries must always use the same model.
export const EMBED_MODEL = 'tidbcloud_free/amazon/titan-embed-text-v2';
export const EMBED_DIM = 1024;

// Embeds a query once and returns it in TiDB's '[0.1,...]' text form, ready for VEC_COSINE_DISTANCE.
export async function embedQuery(db, text) {
  const [[{ vector }]] = await db.query('SELECT CAST(EMBED_TEXT(?, ?) AS CHAR) AS vector', [EMBED_MODEL, text]);
  return vector;
}
