const lancedb = require("@lancedb/lancedb");
const { toChunks, getEmbeddingEngineSelection } = require("../../helpers");
const { TextSplitter } = require("../../TextSplitter");
const { SystemSettings } = require("../../../models/systemSettings");
const { storeVectorResult, cachedVectorInformation } = require("../../files");
const { v4: uuidv4 } = require("uuid");
const { sourceIdentifier } = require("../../chats");
const { NativeEmbeddingReranker } = require("../../EmbeddingRerankers/native");

/**
 * LancedDB Client connection object
 * @typedef {import('@lancedb/lancedb').Connection} LanceClient
 */

const LanceDb = {
  uri: `${
    !!process.env.STORAGE_DIR ? `${process.env.STORAGE_DIR}/` : "./storage/"
  }lancedb`,
  name: "LanceDb",

  /** @returns {Promise<{client: LanceClient}>} */
  connect: async function () {
    if (process.env.VECTOR_DB !== "lancedb")
      throw new Error("LanceDB::Invalid ENV settings");

    const client = await lancedb.connect(this.uri);
    return { client };
  },
  distanceToSimilarity: function (distance = null) {
    if (distance === null || typeof distance !== "number") return 0.0;
    if (distance >= 1.0) return 1;
    if (distance < 0) return 1 - Math.abs(distance);
    return 1 - distance;
  },
  heartbeat: async function () {
    await this.connect();
    return { heartbeat: Number(new Date()) };
  },
  tables: async function () {
    const { client } = await this.connect();
    return await client.tableNames();
  },
  totalVectors: async function () {
    const { client } = await this.connect();
    const tables = await client.tableNames();
    let count = 0;
    for (const tableName of tables) {
      const table = await client.openTable(tableName);
      count += await table.countRows();
    }
    return count;
  },
  namespaceCount: async function (_namespace = null) {
    const { client } = await this.connect();
    const exists = await this.namespaceExists(client, _namespace);
    if (!exists) return 0;

    const table = await client.openTable(_namespace);
    return (await table.countRows()) || 0;
  },
  /**
   * Performs a SimilaritySearch + Reranking on a namespace.
   * @param {Object} params - The parameters for the rerankedSimilarityResponse.
   * @param {Object} params.client - The vectorDB client.
   * @param {string} params.namespace - The namespace to search in.
   * @param {string} params.query - The query to search for (plain text).
   * @param {number[]} params.queryVector - The vector of the query.
   * @param {number} params.similarityThreshold - The threshold for similarity.
   * @param {number} params.topN - the number of results to return from this process.
   * @param {string[]} params.filterIdentifiers - The identifiers of the documents to filter out.
   * @returns
   */
  rerankedSimilarityResponse: async function ({
    client,
    namespace,
    query,
    queryVector,
    topN = 4,
    similarityThreshold = 0.25,
    filterIdentifiers = [],
  }) {
    const reranker = new NativeEmbeddingReranker();
    const collection = await client.openTable(namespace);
    const totalEmbeddings = await this.namespaceCount(namespace);
    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    /**
     * For reranking, we want to work with a larger number of results than the topN.
     * This is because the reranker can only rerank the results it it given and we dont auto-expand the results.
     * We want to give the reranker a larger number of results to work with.
     *
     * However, we cannot make this boundless as reranking is expensive and time consuming.
     * So we limit the number of results to a maximum of 50 and a minimum of 10.
     * This is a good balance between the number of results to rerank and the cost of reranking
     * and ensures workspaces with 10K embeddings will still rerank within a reasonable timeframe on base level hardware.
     *
     * Benchmarks:
     * On Intel Mac: 2.6 GHz 6-Core Intel Core i7 - 20 docs reranked in ~5.2 sec
     */
    const searchLimit = Math.max(
      10,
      Math.min(50, Math.ceil(totalEmbeddings * 0.1))
    );
    const vectorSearchResults = await collection
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .limit(searchLimit)
      .toArray();

    await reranker
      .rerank(query, vectorSearchResults, { topK: topN })
      .then((rerankResults) => {
        rerankResults.forEach((item) => {
          if (this.distanceToSimilarity(item._distance) < similarityThreshold)
            return;
          const { vector: _, ...rest } = item;
          if (filterIdentifiers.includes(sourceIdentifier(rest))) {
            console.log(
              "LanceDB: A source was filtered from context as it's parent document is pinned."
            );
            return;
          }
          const score =
            item?.rerank_score || this.distanceToSimilarity(item._distance);

          result.contextTexts.push(rest.text);
          result.sourceDocuments.push({
            ...rest,
            score,
          });
          result.scores.push(score);
        });
      })
      .catch((e) => {
        console.error(e);
        console.error("LanceDB::rerankedSimilarityResponse", e.message);
      });

    return result;
  },

  /**
   * Performs a SimilaritySearch on a give LanceDB namespace.
   * @param {Object} params
   * @param {LanceClient} params.client
   * @param {string} params.namespace
   * @param {number[]} params.queryVector
   * @param {number} params.similarityThreshold
   * @param {number} params.topN
   * @param {string[]} params.filterIdentifiers
   * @returns
   */
  similarityResponse: async function ({
    client,
    namespace,
    queryVector,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
  }) {
    const collection = await client.openTable(namespace);
    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    const response = await collection
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .limit(topN)
      .toArray();

    response.forEach((item) => {
      if (this.distanceToSimilarity(item._distance) < similarityThreshold)
        return;
      const { vector: _, ...rest } = item;
      if (filterIdentifiers.includes(sourceIdentifier(rest))) {
        console.log(
          "LanceDB: A source was filtered from context as it's parent document is pinned."
        );
        return;
      }

      result.contextTexts.push(rest.text);
      result.sourceDocuments.push({
        ...rest,
        score: this.distanceToSimilarity(item._distance),
      });
      result.scores.push(this.distanceToSimilarity(item._distance));
    });

    return result;
  },
  /**
   *
   * @param {LanceClient} client
   * @param {string} namespace
   * @returns
   */
  namespace: async function (client, namespace = null) {
    if (!namespace) throw new Error("No namespace value provided.");
    const collection = await client.openTable(namespace).catch(() => false);
    if (!collection) return null;

    return {
      ...collection,
    };
  },
  /**
   *
   * @param {LanceClient} client
   * @param {number[]} data
   * @param {string} namespace
   * @returns
   */
  updateOrCreateCollection: async function (client, data = [], namespace) {
    const hasNamespace = await this.hasNamespace(namespace);
    if (hasNamespace) {
      const collection = await client.openTable(namespace);
      console.log(`[DEBUG] LanceDB updateOrCreateCollection: Calling collection.add for namespace '${namespace}' with ${data.length} records.`);
      await collection.add(data);
      return true;
    }

    console.log(`[DEBUG] LanceDB updateOrCreateCollection: Calling client.createTable for namespace '${namespace}' with ${data.length} records.`);
    await client.createTable(namespace, data);
    return true;
  },
  hasNamespace: async function (namespace = null) {
    if (!namespace) return false;
    const { client } = await this.connect();
    const exists = await this.namespaceExists(client, namespace);
    return exists;
  },
  /**
   *
   * @param {LanceClient} client
   * @param {string} namespace
   * @returns
   */
  namespaceExists: async function (client, namespace = null) {
    if (!namespace) throw new Error("No namespace value provided.");
    const collections = await client.tableNames();
    return collections.includes(namespace);
  },
  /**
   *
   * @param {LanceClient} client
   * @param {string} namespace
   * @returns
   */
  deleteVectorsInNamespace: async function (client, namespace = null) {
    await client.dropTable(namespace);
    return true;
  },
  deleteDocumentFromNamespace: async function (namespace, docId) {
    const { client } = await this.connect();
    const exists = await this.namespaceExists(client, namespace);
    if (!exists) {
      console.error(
        `LanceDB:deleteDocumentFromNamespace - namespace ${namespace} does not exist.`
      );
      return;
    }

    const { DocumentVectors } = require("../../../models/vectors");
    const table = await client.openTable(namespace);
    const vectorIds = (await DocumentVectors.where({ docId })).map(
      (record) => record.vectorId
    );

    if (vectorIds.length === 0) return;
    await table.delete(`id IN (${vectorIds.map((v) => `'${v}'`).join(",")})`);
    return true;
  },
  addDocumentToNamespace: async function (
    namespace,
    documentData = {},
    fullFilePath = null,
    skipCache = false
  ) {
    const { DocumentVectors } = require("../../../models/vectors");
    try {
      const { pageContent, docId, ...metadata } = documentData;
      if (!pageContent || pageContent.length == 0) return false;

      console.log("Adding new vectorized document into namespace", namespace);
      if (!skipCache) {
        const cacheResult = await cachedVectorInformation(fullFilePath);
        if (cacheResult.exists) {
          const { client } = await this.connect();
          const { chunks } = cacheResult;
          const documentVectors = [];
          const submissions = [];

          for (const chunk of chunks) {
            chunk.forEach((chunk) => {
              const id = uuidv4();
              const { id: _id, ...metadata } = chunk.metadata;
              documentVectors.push({ docId, vectorId: id });
              submissions.push({ id: id, vector: chunk.values, ...metadata });
            });
          }

          await this.updateOrCreateCollection(client, submissions, namespace);
          await DocumentVectors.bulkInsert(documentVectors);
          return { vectorized: true, error: null };
        }
      }

      // If we are here then we are going to embed and store a novel document.
      // We have to do this manually as opposed to using LangChains `xyz.fromDocuments`
      // because we then cannot atomically control our namespace to granularly find/remove documents
      // from vectordb.
      const EmbedderEngine = getEmbeddingEngineSelection();

      const splitterOptions = {
        chunkSize: TextSplitter.determineMaxChunkSize(
          await SystemSettings.getValueOrFallback({ label: "text_splitter_chunk_size" }),
          EmbedderEngine?.embeddingMaxChunkLength
        ),
        chunkOverlap: await SystemSettings.getValueOrFallback(
          { label: "text_splitter_chunk_overlap" },
          20
        ),
        chunkHeaderMeta: TextSplitter.buildHeaderMeta(metadata),
        filename: metadata.title // Pass filename for potential language-specific splitting
      };
      console.log(`LanceDB:addDocumentToNamespace - Initializing TextSplitter with options: ${JSON.stringify(splitterOptions)}`);

      const textSplitter = new TextSplitter(splitterOptions);
      console.log("LanceDB:addDocumentToNamespace - TextSplitter instance created.");

      console.log("LanceDB:addDocumentToNamespace - Calling textSplitter.splitText...");
      const chunksWithMetadata = await textSplitter.splitText(pageContent);
      console.log(`LanceDB:addDocumentToNamespace - Document split into ${chunksWithMetadata.length} chunks.`);

      console.log("Chunks created from document:", chunksWithMetadata.length);
      if (chunksWithMetadata.length === 0) {
         console.log("LanceDB:addDocumentToNamespace - No chunks generated, skipping embedding.");
         return { vectorized: true, error: null }; // Or handle as appropriate
      }

      const documentVectors = [];
      const vectors = [];
      const submissions = [];

      // Extract just the text for embedding
      const textChunksForEmbedding = chunksWithMetadata.map(chunkData => chunkData.text);
      console.log(`LanceDB:addDocumentToNamespace - Embedding ${textChunksForEmbedding.length} text chunks...`);
      const vectorValues = await EmbedderEngine.embedChunks(textChunksForEmbedding);

      if (!!vectorValues && vectorValues.length === chunksWithMetadata.length) {
        console.log(`LanceDB:addDocumentToNamespace - Successfully received ${vectorValues.length} vectors from embedder.`);
        for (const [i, vector] of vectorValues.entries()) {
          const vectorRecord = {
            id: uuidv4(),
            values: vector,
          };

          // Merge original document metadata with chunk-specific AST metadata
          const combinedMetadata = {
             ...metadata, // Original document metadata (title, published, etc.)
             ...chunksWithMetadata[i].metadata, // AST metadata (sourceType, nodeType, etc.)
             text: chunksWithMetadata[i].text, // Still include the text for LangChain compatibility
          };

          // Ensure metadata fields are suitable for LanceDB (e.g., no nested objects if not supported)
          // Simple check for nested objects - adjust as needed for LanceDB limitations
          for (const key in combinedMetadata) {
             if (typeof combinedMetadata[key] === 'object' && combinedMetadata[key] !== null) {
                console.log(`[WARN] LanceDB:addDocumentToNamespace - Converting metadata key ${key} to string as it was an object.`);
                combinedMetadata[key] = JSON.stringify(combinedMetadata[key]);
             } else if (Array.isArray(combinedMetadata[key])) {
                console.log(`[WARN] LanceDB:addDocumentToNamespace - Converting array metadata key ${key} to string.`);
                combinedMetadata[key] = JSON.stringify(combinedMetadata[key]); // Stringify arrays too
             } else if (combinedMetadata[key] === null || combinedMetadata[key] === undefined) {
                delete combinedMetadata[key]; // Remove null values if they cause issues
             }
          }

          // --- Log combined metadata and text chunk --- 
          console.log(`\n--- LanceDB: Processing Chunk ${i + 1}/${vectorValues.length} ---\n` +
                   `Chunk Text Length: ${chunksWithMetadata[i].text.length}\n` +
                   `Combined Metadata:\n${JSON.stringify(combinedMetadata, null, 2)}\n` +
                   `Chunk Text Preview (first 100 chars):\n${chunksWithMetadata[i].text.substring(0, 100)}...\n` +
                   `--- End Chunk Processing ---`);
           // -------------------------------------------

          vectors.push({
              ...vectorRecord,
              metadata: combinedMetadata // Keep separated for potential caching needs
          });

          // Separate text from other metadata for LanceDB submission
          const { text: chunkText, ...otherMetadata } = combinedMetadata;

          // ---
          // Skip chunks with empty text, as LanceDB errors on this.
          if (!chunkText || chunkText.trim().length === 0) {
            console.log(`[WARN] LanceDB: Skipping chunk ${i + 1}/${vectorValues.length} due to empty text content.`);
            continue; // Skip to the next vector
          }
          // ---

          // --- Log metadata before push ---
          console.log(`[DEBUG] LanceDB Preparing submission for chunk ${i + 1}`);
          console.log("[DEBUG] LanceDB chunkText:", JSON.stringify(chunkText.substring(0, 100) + '...')); // Log preview
          console.log("[DEBUG] LanceDB otherMetadata:", JSON.stringify(otherMetadata));
          // --- End Log ---

          // --- Comprehensive check/fix for ALL empty strings in metadata ---
          for (const key in otherMetadata) {
            if (otherMetadata.hasOwnProperty(key) && typeof otherMetadata[key] === 'string' && otherMetadata[key] === "") {
              console.log(`[DEBUG] LanceDB: Replacing empty string in metadata key '${key}' with placeholder '-' for chunk`, i + 1);
              otherMetadata[key] = "-";
            }
          }
          // ----------------------------------------------------------------

          submissions.push({
            id: vectorRecord.id,
            vector: vectorRecord.values,
            text: chunkText, // Use original, non-truncated text for storage
            ...otherMetadata // Spread the rest of the metadata
          });
          documentVectors.push({ docId, vectorId: vectorRecord.id });
        }
      } else {
         const errorMsg = `Could not embed document chunks! Expected ${chunksWithMetadata.length} vectors, but received ${vectorValues?.length || 0}.`;
         console.log(`[ERROR] LanceDB:addDocumentToNamespace - ${errorMsg}`);
        throw new Error(errorMsg);
      }

      if (vectors.length > 0) {
        // Caching logic happens later, prepare DB submission first
        const BATCH_SIZE = 10; // Keep batch size definition
        const totalCount = submissions.length;
        console.log(`LanceDB:addDocumentToNamespace - Total submissions to process: ${totalCount}`);
        const { client } = await this.connect();

        if (totalCount > BATCH_SIZE) {
          // Apply batching only if total count exceeds batch size
          console.log(`LanceDB:addDocumentToNamespace - Submitting ${totalCount} records to LanceDB in batches of ${BATCH_SIZE}...`);
          for (const submissionBatch of toChunks(submissions, BATCH_SIZE)) {
              try {
                  console.log(`LanceDB:addDocumentToNamespace - Writing batch of ${submissionBatch.length} records...`);
                  await this.updateOrCreateCollection(client, submissionBatch, namespace);
                  console.log(`LanceDB:addDocumentToNamespace - Batch written successfully.`);
              } catch (batchError) {
                  console.error(`[ERROR] LanceDB: Failed to write batch! Batch Size: ${submissionBatch.length}`);
                  console.error("[ERROR] LanceDB: Failing batch data:", JSON.stringify(submissionBatch, null, 2));
                  throw batchError; // Re-throw to be caught by outer try/catch
              }
          }
        } else if (totalCount > 0) {
          // If total count is positive but not > BATCH_SIZE, submit all at once
          console.log(`LanceDB:addDocumentToNamespace - Submitting ${totalCount} records to LanceDB in a single batch...`);
          try {
            await this.updateOrCreateCollection(client, submissions, namespace);
            console.log(`LanceDB:addDocumentToNamespace - Single submission successful.`);
          } catch (singleSubmitError) {
            console.error(`[ERROR] LanceDB: Failed to write single submission! Count: ${totalCount}`);
            console.error("[ERROR] LanceDB: Failing submission data:", JSON.stringify(submissions, null, 2));
            throw singleSubmitError; // Re-throw to be caught by outer try/catch
          }
        } else {
            console.log("LanceDB:addDocumentToNamespace - No submissions to write.");
        }

        // Caching logic (happens after successful DB writes)
        const chunksForCache = [];
        for (const chunk of toChunks(vectors, 500)) chunksForCache.push(chunk);
        await storeVectorResult(chunksForCache, fullFilePath);
      }

      // Bulk insert associations after all DB batches are done
      if (documentVectors.length > 0) {
        console.log(`LanceDB:addDocumentToNamespace - Storing ${documentVectors.length} document vector associations.`);
        await DocumentVectors.bulkInsert(documentVectors);
      }

      return { vectorized: true, error: null };
    } catch (e) {
      console.error("addDocumentToNamespace Error:", e.stack || e); // Log stack trace
      // Ensure error message is a string
      const errorMsg = e instanceof Error ? e.message : String(e);
      return { vectorized: false, error: errorMsg };
    }
  },
  performSimilaritySearch: async function ({
    namespace = null,
    input = "",
    LLMConnector = null,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
    rerank = false,
  }) {
    if (!namespace || !input || !LLMConnector)
      throw new Error("Invalid request to performSimilaritySearch.");

    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace))) {
      return {
        contextTexts: [],
        sources: [],
        message: "Invalid query - no documents found for workspace!",
      };
    }

    const queryVector = await LLMConnector.embedTextInput(input);
    const result = rerank
      ? await this.rerankedSimilarityResponse({
          client,
          namespace,
          query: input,
          queryVector,
          similarityThreshold,
          topN,
          filterIdentifiers,
        })
      : await this.similarityResponse({
          client,
          namespace,
          queryVector,
          similarityThreshold,
          topN,
          filterIdentifiers,
        });

    const { contextTexts, sourceDocuments } = result;
    const sources = sourceDocuments.map((metadata, i) => {
      return { metadata: { ...metadata, text: contextTexts[i] } };
    });
    return {
      contextTexts,
      sources: this.curateSources(sources),
      message: false,
    };
  },
  "namespace-stats": async function (reqBody = {}) {
    const { namespace = null } = reqBody;
    if (!namespace) throw new Error("namespace required");
    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace)))
      throw new Error("Namespace by that name does not exist.");
    const stats = await this.namespace(client, namespace);
    return stats
      ? stats
      : { message: "No stats were able to be fetched from DB for namespace" };
  },
  "delete-namespace": async function (reqBody = {}) {
    const { namespace = null } = reqBody;
    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace)))
      throw new Error("Namespace by that name does not exist.");

    await this.deleteVectorsInNamespace(client, namespace);
    return {
      message: `Namespace ${namespace} was deleted.`,
    };
  },
  reset: async function () {
    const { client } = await this.connect();
    const fs = require("fs");
    fs.rm(`${client.uri}`, { recursive: true }, () => null);
    return { reset: true };
  },
  curateSources: function (sources = []) {
    const documents = [];
    for (const source of sources) {
      const { text, vector: _v, _distance: _d, ...rest } = source;
      const metadata = rest.hasOwnProperty("metadata") ? rest.metadata : rest;
      if (Object.keys(metadata).length > 0) {
        documents.push({
          ...metadata,
          ...(text ? { text } : {}),
        });
      }
    }

    return documents;
  },
};

module.exports.LanceDb = LanceDb;
