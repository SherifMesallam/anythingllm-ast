const lancedb = require("@lancedb/lancedb");
const { toChunks, getEmbeddingEngineSelection } = require("../../helpers");
const { TextSplitter } = require("../../TextSplitter");
const { SystemSettings } = require("../../../models/systemSettings");
const { storeVectorResult, cachedVectorInformation } = require("../../files");
const { v4: uuidv4 } = require("uuid");
const { sourceIdentifier } = require("../../chats");
const { NativeEmbeddingReranker } = require("../../EmbeddingRerankers/native");
const arrow = require("apache-arrow");

/**
 * LancedDB Client connection object
 * @typedef {import('@lancedb/lancedb').Connection} LanceClient
 */

// --- BEGIN FORCED DIMENSION (OVERRIDE) ---
let embedderDimension = 3072; // FORCED to text-embedding-3-large dimension
console.warn("**********************************************************************");
console.warn("[WARN] LanceDB: Embedder dimension is FORCED to 3072 (text-embedding-3-large).");
console.warn("         This overrides dynamic detection. Ensure your configured embedder has 3072 dimensions.");
console.warn("**********************************************************************");

// --- END FORCED DIMENSION (OVERRIDE) ---

// Helper function to create loggable submission data (no vectors)
function cleanSubmissionsForLogging(submissions) {
  if (!Array.isArray(submissions)) return submissions; // Safety check
  return submissions.map(item => {
    const { vector, ...rest } = item; // Destructure to remove vector
    return rest; // Return object without the vector
  });
}

// Define the explicit schema including all our metadata fields
const FULL_LANCEDB_SCHEMA = new arrow.Schema([
    new arrow.Field("id", new arrow.Utf8(), false),
    // Use the detected embedderDimension here
    new arrow.Field("vector", new arrow.FixedSizeList(embedderDimension, new arrow.Field("item", new arrow.Float32(), false)), false),
    new arrow.Field("text", new arrow.Utf8(), false),

    // Original Document Metadata (mostly strings, nullable)
    new arrow.Field("url", new arrow.Utf8(), true),
    new arrow.Field("title", new arrow.Utf8(), true),
    new arrow.Field("docAuthor", new arrow.Utf8(), true),
    new arrow.Field("description", new arrow.Utf8(), true),
    new arrow.Field("docSource", new arrow.Utf8(), true),
    new arrow.Field("chunkSource", new arrow.Utf8(), true),
    new arrow.Field("published", new arrow.Utf8(), true),
    new arrow.Field("wordCount", new arrow.Int64(), true),
    new arrow.Field("token_count_estimate", new arrow.Int64(), true),

    // TextSplitter Metadata
    new arrow.Field("filePath", new arrow.Utf8(), true),
    new arrow.Field("featureContext", new arrow.Utf8(), true),
    new arrow.Field("sourceType", new arrow.Utf8(), true),
    new arrow.Field("language", new arrow.Utf8(), true), // Ensure this is included!
    new arrow.Field("startLine", new arrow.Int64(), true),
    new arrow.Field("endLine", new arrow.Int64(), true),
    new arrow.Field("isSubChunk", new arrow.Bool(), true),

    // AST Specific Metadata
    new arrow.Field("nodeType", new arrow.Utf8(), true),
    new arrow.Field("nodeName", new arrow.Utf8(), true),
    new arrow.Field("parentName", new arrow.Utf8(), true),
    new arrow.Field("docComment", new arrow.Utf8(), true),
    new arrow.Field("summary", new arrow.Utf8(), true),
    new arrow.Field("parameters", new arrow.Utf8(), true), // Stored as stringified JSON
    new arrow.Field("returnType", new arrow.Utf8(), true),
    new arrow.Field("returnDescription", new arrow.Utf8(), true),
    new arrow.Field("isDeprecated", new arrow.Bool(), true),
    new arrow.Field("modifiers", new arrow.Utf8(), true), // Stored as stringified JSON
    new arrow.Field("extendsClass", new arrow.Utf8(), true),
    new arrow.Field("implementsInterfaces", new arrow.Utf8(), true), // Stored as stringified JSON
    new arrow.Field("usesTraits", new arrow.Utf8(), true), // Stored as stringified JSON

    // WP Hook Metadata
    new arrow.Field("registersHooks", new arrow.Utf8(), true), // Stringified JSON array: [{hookName, callback, type, priority, acceptedArgs}]
    new arrow.Field("triggersHooks", new arrow.Utf8(), true), // Stringified JSON array: [{hookName, type}]

    // CSS Metadata
    new arrow.Field("selector", new arrow.Utf8(), true),
    new arrow.Field("atRuleName", new arrow.Utf8(), true),
    new arrow.Field("atRuleParams", new arrow.Utf8(), true),
]);

// --- BEGIN MINIMAL SCHEMA FOR TESTING ---
const MINIMAL_LANCEDB_SCHEMA = new arrow.Schema([
    new arrow.Field("id", new arrow.Utf8(), false),
    new arrow.Field("vector", new arrow.FixedSizeList(embedderDimension, new arrow.Field("item", new arrow.Float32(), false)), false),
    new arrow.Field("text", new arrow.Utf8(), false),
]);
// --- END MINIMAL SCHEMA FOR TESTING ---

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
    const METADATA_FIELDS_TO_SELECT = [
        'id', 'text', 'url', 'title', 'docAuthor', 'description', 'docSource',
        'chunkSource', 'published', 'wordCount', 'token_count_estimate',
        'filePath', 'featureContext', 'sourceType', 'language', 'startLine', 'endLine',
        'nodeType', 'nodeName', 'parentName', 'docComment', 'summary', 'parameters',
        'returnType', 'returnDescription', 'isDeprecated', 'modifiers', 'extendsClass',
        'implementsInterfaces', 'usesTraits', 'registersHooks', 'triggersHooks',
        'selector', 'atRuleName', 'atRuleParams', 'isSubChunk'
        // DO NOT include 'vector', '_vector', '_distance', 'rerank_score' here
    ];
    const vectorSearchResults = await collection
      .vectorSearch(queryVector)
      .select(METADATA_FIELDS_TO_SELECT)
      .distanceType("cosine")
      .limit(searchLimit)
      .toArray();

    await reranker
      .rerank(query, vectorSearchResults, { topK: topN })
      .then((rerankResults) => {
        rerankResults.forEach((item) => {
          const score = item?.rerank_score || this.distanceToSimilarity(item._distance);
          if (score < similarityThreshold) return;

          const { vector: _, _distance, rerank_score, ...rest } = item;

          if (filterIdentifiers.includes(sourceIdentifier(rest))) {
            console.log(
              "LanceDB: A source was filtered from context as it's parent document is pinned."
            );
            return;
          }

          const textContent = rest.text || "";
          if (!textContent) {
             console.log(`[WARN] LanceDB: Reranked item ${rest.id} missing text content, skipping.`);
             return;
          }

          result.contextTexts.push(textContent);
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

    const METADATA_FIELDS_TO_SELECT = [
        'id', 'text', 'url', 'title', 'docAuthor', 'description', 'docSource',
        'chunkSource', 'published', 'wordCount', 'token_count_estimate',
        'filePath', 'featureContext', 'sourceType', 'language', 'startLine', 'endLine',
        'nodeType', 'nodeName', 'parentName', 'docComment', 'summary', 'parameters',
        'returnType', 'returnDescription', 'isDeprecated', 'modifiers', 'extendsClass',
        'implementsInterfaces', 'usesTraits', 'registersHooks', 'triggersHooks',
        'selector', 'atRuleName', 'atRuleParams', 'isSubChunk'
        // DO NOT include 'vector', '_vector', '_distance', 'rerank_score' here
    ];
    const response = await collection
      .vectorSearch(queryVector)
      .select(METADATA_FIELDS_TO_SELECT)
      .distanceType("cosine")
      .limit(topN)
      .toArray();

    response.forEach((item) => {
      const score = this.distanceToSimilarity(item._distance);
      if (score < similarityThreshold) return;

      const { vector: _, _distance, ...rest } = item;

      if (filterIdentifiers.includes(sourceIdentifier(rest))) {
        console.log(
          "LanceDB: A source was filtered from context as it's parent document is pinned."
        );
        return;
      }

      const textContent = rest.text || "";
      if (!textContent) {
         console.log(`[WARN] LanceDB: Similarity item ${rest.id} missing text content, skipping.`);
         return;
      }

      result.contextTexts.push(textContent);
      result.sourceDocuments.push({
        ...rest,
        score,
      });
      result.scores.push(score);
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

    // --- BEGIN BOOLEAN VALUE LOGGING ---
    console.log(`[DEBUG] LanceDB updateOrCreateCollection: Inspecting data for namespace '${namespace}' before write operation (Boolean fields):`);
    data.forEach((record, index) => {
      console.log(`  Record ${index + 1}/${data.length}: isSubChunk=${record.isSubChunk} (type: ${typeof record.isSubChunk}), isDeprecated=${record.isDeprecated} (type: ${typeof record.isDeprecated})`);
    });
    // --- END BOOLEAN VALUE LOGGING ---

    if (hasNamespace) {
      const collection = await client.openTable(namespace);
      console.log(`[DEBUG] LanceDB updateOrCreateCollection: Adding ${data.length} records to existing namespace '${namespace}'.`);
      // When adding, we assume the schema (hopefully FULL) already exists.
      // Data preparation should ensure compatibility with the FULL schema.
      try {
        await collection.add(data);
        console.log(`[DEBUG] LanceDB updateOrCreateCollection: Added records successfully to existing namespace '${namespace}'.`);
      } catch (addError) {
        console.error(`[ERROR] LanceDB: Failed to add records to existing namespace '${namespace}'!`, addError);
        console.error("[ERROR] LanceDB: Failing data for add (vectors excluded):", JSON.stringify(cleanSubmissionsForLogging(data), null, 2));
        throw addError; // Re-throw
      }
      return true;
    }

    // --- REVERT TESTING CHANGE: Use FULL schema for table creation ---
    console.log(`[DEBUG] LanceDB updateOrCreateCollection: Creating table for namespace '${namespace}' with ${data.length} records using FULL explicit schema.`);
    try {
      // Pass the FULL schema when creating the table again
      await client.createTable(namespace, data, { schema: FULL_LANCEDB_SCHEMA, mode: 'create' });
      console.log(`[DEBUG] LanceDB updateOrCreateCollection: Table '${namespace}' created successfully with FULL explicit schema.`);
    } catch (createError) {
      console.error(`[ERROR] LanceDB: Failed to create table '${namespace}' with FULL explicit schema!`, createError);
      // Log data without vectors if creation fails
      console.error("[ERROR] LanceDB: Failing data for createTable (vectors excluded):", JSON.stringify(cleanSubmissionsForLogging(data), null, 2));
      throw createError; // Re-throw
    }
    // --- END REVERT TESTING CHANGE ---
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

      // --- BEGIN LOGGING EMBEDDER LIMIT ---
      const embedderLimit = EmbedderEngine?.embeddingMaxChunkLength;
      console.log(`  [DEBUG] LanceDB:addDocumentToNamespace - Embedder Engine: ${EmbedderEngine?.constructor?.name}`);
      console.log(`  [DEBUG] LanceDB:addDocumentToNamespace - Embedder reported max chunk length: ${embedderLimit} (Type: ${typeof embedderLimit})`);
      // --- END LOGGING EMBEDDER LIMIT ---

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

          // Ensure metadata fields are suitable for LanceDB
          for (const key in combinedMetadata) {
            const fieldSchema = FULL_LANCEDB_SCHEMA.fields.find(f => f.name === key);
            if (!fieldSchema) continue; // Skip keys not in our schema

            const expectedType = fieldSchema.type.toString();
            const currentValue = combinedMetadata[key];
            const currentValueType = typeof currentValue;

            // 1. Stringify objects/arrays if schema expects Utf8 (string)
            if (expectedType === 'Utf8' && (Array.isArray(currentValue) || (currentValueType === 'object' && currentValue !== null))) {
                 console.log(`  [DEBUG] LanceDB:addDocumentToNamespace - Chunk ${i + 1}: Stringifying field '${key}' (type: ${currentValueType}) because schema expects Utf8.`);
                 combinedMetadata[key] = JSON.stringify(currentValue);
            }
            // 2. Convert null/undefined for nullable Utf8 fields to ""
            else if (expectedType === 'Utf8' && fieldSchema.nullable && (currentValue === null || currentValue === undefined)) {
                console.log(`  [DEBUG] LanceDB:addDocumentToNamespace - Chunk ${i + 1}: Converting null/undefined Utf8 field '${key}' to empty string "". Original Type: ${currentValueType}`);
                combinedMetadata[key] = "";
            }
            // 3. Convert null/undefined for nullable Boolean fields to null (Arrow might handle null better than undefined)
            else if (expectedType === 'Bool' && fieldSchema.nullable && currentValue === undefined) {
                console.log(`  [DEBUG] LanceDB:addDocumentToNamespace - Chunk ${i + 1}: Converting undefined Boolean field '${key}' to null.`);
                combinedMetadata[key] = null;
            }
             // 4. Convert null/undefined for nullable Int64 fields to null
            else if (expectedType.startsWith('Int') && fieldSchema.nullable && currentValue === undefined) {
                console.log(`  [DEBUG] LanceDB:addDocumentToNamespace - Chunk ${i + 1}: Converting undefined Int field '${key}' to null.`);
                combinedMetadata[key] = null;
            }

            // 5. Remove any remaining undefined fields (shouldn't happen with above conversions but good safety check)
            if (combinedMetadata[key] === undefined) {
                 console.log(`  [WARN] LanceDB:addDocumentToNamespace - Chunk ${i + 1}: Removing unexpected undefined field '${key}'.`);
                 delete combinedMetadata[key];
            }
          }

          // --- BEGIN ENSURE ALL SCHEMA FIELDS EXIST WITH DEFAULTS ---
          for (const field of FULL_LANCEDB_SCHEMA.fields) {
            const key = field.name;
            // Skip id, vector, text as they are handled separately/are not nullable in the same way
            if (key === 'id' || key === 'vector' || key === 'text') continue;

            if (!(key in combinedMetadata)) {
              if (field.nullable) {
                let defaultValue;
                const fieldTypeStr = field.type.toString();
                if (fieldTypeStr === 'Utf8') {
                  defaultValue = "";
                } else if (fieldTypeStr.startsWith('Int')) { // Covers Int8, Int16, Int32, Int64
                  defaultValue = 0;
                } else if (fieldTypeStr === 'Bool') {
                  defaultValue = false;
                } else {
                  // Should not happen with our current schema, but log just in case
                  console.warn(`  [WARN] LanceDB:addDocumentToNamespace - Chunk ${i + 1}: Missing nullable field '${key}' with unhandled type ${fieldTypeStr}. Setting to null.`);
                  defaultValue = null;
                }

                if (defaultValue !== undefined) { // Add default if we determined one
                  console.log(`  [DEBUG] LanceDB:addDocumentToNamespace - Chunk ${i + 1}: Adding missing nullable field '${key}' with default value: ${JSON.stringify(defaultValue)}`);
                  combinedMetadata[key] = defaultValue;
                }
              } else {
                 // Log if a *non-nullable* field (other than id/vector/text) is missing - indicates schema mismatch or upstream issue
                 console.error(`  [ERROR] LanceDB:addDocumentToNamespace - Chunk ${i + 1}: Non-nullable field '${key}' defined in schema is MISSING from metadata!`);
              }
            }
          }
          // --- END ENSURE ALL SCHEMA FIELDS EXIST WITH DEFAULTS ---

          // ---
          // Skip chunks with empty text, as LanceDB errors on this.
          if (!combinedMetadata.text || combinedMetadata.text.trim().length === 0) {
            console.log(`[WARN] LanceDB: Skipping chunk ${i + 1}/${vectorValues.length} due to empty text content.`);
            continue; // Skip to the next vector
          }
          // ---

          vectors.push({
              ...vectorRecord,
              metadata: combinedMetadata // Keep separated for potential caching needs
          });

          // Separate text from other metadata for LanceDB submission
          const { text: chunkText, ...otherMetadata } = combinedMetadata;

          // Original submission logic:
          submissions.push({
            id: vectorRecord.id,
            vector: vectorRecord.values,
            text: chunkText, // Use original, non-truncated text for storage
            ...otherMetadata, // Spread the rest of the combined metadata
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

        // --- BEGIN LOG SUBMISSIONS BEFORE WRITE ---
        console.log(`[DEBUG] LanceDB:addDocumentToNamespace - Final submissions array before calling updateOrCreateCollection (vectors excluded):`);
        console.log(JSON.stringify(cleanSubmissionsForLogging(submissions), null, 2));
        // --- END LOG SUBMISSIONS BEFORE WRITE ---

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
                  // Log cleaned data without vectors
                  console.error("[ERROR] LanceDB: Failing batch data (vectors excluded):", JSON.stringify(cleanSubmissionsForLogging(submissionBatch), null, 2));
                  throw batchError; // Re-throw
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
            // Log cleaned data without vectors
            console.error("[ERROR] LanceDB: Failing submission data (vectors excluded):", JSON.stringify(cleanSubmissionsForLogging(submissions), null, 2));
            throw singleSubmitError; // Re-throw
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

    // --- BEGIN ADDED SCHEMA LOGGING ---
    try {
        const table = await client.openTable(namespace);
        const currentSchema = await table.schema();
        console.log(`  [DEBUG] LanceDB:performSimilaritySearch - Schema for namespace '${namespace}' before query:`, JSON.stringify(currentSchema, null, 2));
    } catch (schemaError) {
        console.error(`  [ERROR] LanceDB:performSimilaritySearch - Failed to get schema for namespace '${namespace}':`, schemaError);
    }
    // --- END ADDED SCHEMA LOGGING ---

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
    // Original formatting - might already exclude vectors depending on curateSources
    // Let's simplify the mapping to ensure we keep all metadata fields from sourceDocuments
    const sources = sourceDocuments.map((docResult, i) => {
      // docResult is the raw object from LanceDB search (hopefully containing all metadata)
      const metadataToKeep = { ...docResult }; // Clone the result

      // Explicitly delete vector fields if they exist (LanceDB might use 'vector' or '_vector')
      delete metadataToKeep.vector;
      delete metadataToKeep._vector; // Add others if needed
      delete metadataToKeep._distance; // Also remove distance if present
      delete metadataToKeep.rerank_score; // Remove rerank score if present

      // Add the text content
      metadataToKeep.text = contextTexts[i];

      return metadataToKeep; // Return the full object + text
    });

    // --- BEGIN ADDED LOGGING ---
    // This log should now show the full metadata if it was retrieved by LanceDB
    // Add replacer to handle BigInt for logging purposes
    // console.log(`  [DEBUG] LanceDB:performSimilaritySearch - Retrieved sources (metadata only):`,
    //   JSON.stringify(sources, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2)
    // );
    // --- END ADDED LOGGING ---

    return {
      contextTexts,
      // Pass the potentially richer `sources` to curateSources
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
