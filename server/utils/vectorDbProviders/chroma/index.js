const { ChromaClient } = require("chromadb");
const { TextSplitter } = require("../../TextSplitter");
const { SystemSettings } = require("../../../models/systemSettings");
const { storeVectorResult, cachedVectorInformation } = require("../../files");
const { v4: uuidv4 } = require("uuid");
const { toChunks, getEmbeddingEngineSelection } = require("../../helpers");
const { parseAuthHeader } = require("../../http");
const { sourceIdentifier } = require("../../chats");
const COLLECTION_REGEX = new RegExp(
  /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)(?=^[a-zA-Z0-9][a-zA-Z0-9_-]{1,61}[a-zA-Z0-9]$).{3,63}$/
);

const Chroma = {
  name: "Chroma",
  // Chroma DB has specific requirements for collection names:
  // (1) Must contain 3-63 characters
  // (2) Must start and end with an alphanumeric character
  // (3) Can only contain alphanumeric characters, underscores, or hyphens
  // (4) Cannot contain two consecutive periods (..)
  // (5) Cannot be a valid IPv4 address
  // We need to enforce these rules by normalizing the collection names
  // before communicating with the Chroma DB.
  normalize: function (inputString) {
    if (COLLECTION_REGEX.test(inputString)) return inputString;
    let normalized = inputString.replace(/[^a-zA-Z0-9_-]/g, "-");

    // Replace consecutive periods with a single period (if any)
    normalized = normalized.replace(/\.\.+/g, ".");

    // Ensure the name doesn't start with a non-alphanumeric character
    if (normalized[0] && !/^[a-zA-Z0-9]$/.test(normalized[0])) {
      normalized = "anythingllm-" + normalized.slice(1);
    }

    // Ensure the name doesn't end with a non-alphanumeric character
    if (
      normalized[normalized.length - 1] &&
      !/^[a-zA-Z0-9]$/.test(normalized[normalized.length - 1])
    ) {
      normalized = normalized.slice(0, -1);
    }

    // Ensure the length is between 3 and 63 characters
    if (normalized.length < 3) {
      normalized = `anythingllm-${normalized}`;
    } else if (normalized.length > 63) {
      // Recheck the norm'd name if sliced since its ending can still be invalid.
      normalized = this.normalize(normalized.slice(0, 63));
    }

    // Ensure the name is not an IPv4 address
    if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
      normalized = "-" + normalized.slice(1);
    }

    return normalized;
  },
  connect: async function () {
    if (process.env.VECTOR_DB !== "chroma")
      throw new Error("Chroma::Invalid ENV settings");

    const client = new ChromaClient({
      path: process.env.CHROMA_ENDPOINT, // if not set will fallback to localhost:8000
      ...(!!process.env.CHROMA_API_HEADER && !!process.env.CHROMA_API_KEY
        ? {
            fetchOptions: {
              headers: parseAuthHeader(
                process.env.CHROMA_API_HEADER || "X-Api-Key",
                process.env.CHROMA_API_KEY
              ),
            },
          }
        : {}),
    });

    const isAlive = await client.heartbeat();
    if (!isAlive)
      throw new Error(
        "ChromaDB::Invalid Heartbeat received - is the instance online?"
      );
    return { client };
  },
  heartbeat: async function () {
    const { client } = await this.connect();
    return { heartbeat: await client.heartbeat() };
  },
  totalVectors: async function () {
    const { client } = await this.connect();
    const collections = await client.listCollections();
    var totalVectors = 0;
    for (const collectionObj of collections) {
      const collection = await client
        .getCollection({ name: collectionObj.name })
        .catch(() => null);
      if (!collection) continue;
      totalVectors += await collection.count();
    }
    return totalVectors;
  },
  distanceToSimilarity: function (distance = null) {
    if (distance === null || typeof distance !== "number") return 0.0;
    if (distance >= 1.0) return 1;
    if (distance < 0) return 1 - Math.abs(distance);
    return 1 - distance;
  },
  namespaceCount: async function (_namespace = null) {
    const { client } = await this.connect();
    const namespace = await this.namespace(client, this.normalize(_namespace));
    return namespace?.vectorCount || 0;
  },
  similarityResponse: async function ({
    client,
    namespace,
    queryVector,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
  }) {
    const collection = await client.getCollection({
      name: this.normalize(namespace),
    });
    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    const response = await collection.query({
      queryEmbeddings: queryVector,
      nResults: topN,
    });

    response.ids[0].forEach((_, i) => {
      const similarity = this.distanceToSimilarity(response.distances[0][i]);
      if (similarity < similarityThreshold) return;

      if (
        filterIdentifiers.includes(sourceIdentifier(response.metadatas[0][i]))
      ) {
        console.log(
          "Chroma: A source was filtered from context as it's parent document is pinned."
        );
        return;
      }

      result.contextTexts.push(response.documents[0][i]);
      result.sourceDocuments.push(response.metadatas[0][i]);
      result.scores.push(similarity);
    });

    return result;
  },
  namespace: async function (client, namespace = null) {
    if (!namespace) throw new Error("No namespace value provided.");
    const collection = await client
      .getCollection({ name: this.normalize(namespace) })
      .catch(() => null);
    if (!collection) return null;

    return {
      ...collection,
      vectorCount: await collection.count(),
    };
  },
  hasNamespace: async function (namespace = null) {
    if (!namespace) return false;
    const { client } = await this.connect();
    return await this.namespaceExists(client, this.normalize(namespace));
  },
  namespaceExists: async function (client, namespace = null) {
    if (!namespace) throw new Error("No namespace value provided.");
    const collection = await client
      .getCollection({ name: this.normalize(namespace) })
      .catch((e) => {
        console.error("ChromaDB::namespaceExists", e.message);
        return null;
      });
    return !!collection;
  },
  deleteVectorsInNamespace: async function (client, namespace = null) {
    await client.deleteCollection({ name: this.normalize(namespace) });
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
      if (skipCache) {
        const cacheResult = await cachedVectorInformation(fullFilePath);
        if (cacheResult.exists) {
          const { client } = await this.connect();
          const collection = await client.getOrCreateCollection({
            name: this.normalize(namespace),
            // returns [-1, 1] unit vector
            metadata: { "hnsw:space": "cosine" },
          });
          const { chunks } = cacheResult;
          const documentVectors = [];

          for (const chunk of chunks) {
            const submission = {
              ids: [],
              embeddings: [],
              metadatas: [],
              documents: [],
            };

            // Before sending to Chroma and saving the records to our db
            // we need to assign the id of each chunk that is stored in the cached file.
            chunk.forEach((chunk) => {
              const id = uuidv4();
              const { id: _id, ...metadata } = chunk.metadata;
              documentVectors.push({ docId, vectorId: id });
              submission.ids.push(id);
              submission.embeddings.push(chunk.values);
              submission.metadatas.push(metadata);
              submission.documents.push(metadata.text);
            });

            const additionResult = await collection.add(submission);
            if (!additionResult)
              throw new Error("Error embedding into ChromaDB", additionResult);
          }

          await DocumentVectors.bulkInsert(documentVectors);
          return { vectorized: true, error: null };
        }
      }

      // If we are here then we are going to embed and store a novel document.
      // We have to do this manually as opposed to using LangChains `Chroma.fromDocuments`
      // because we then cannot atomically control our namespace to granularly find/remove documents
      // from vectordb.
      const EmbedderEngine = getEmbeddingEngineSelection();
      const textSplitter = new TextSplitter({
        chunkSize: TextSplitter.determineMaxChunkSize(
          await SystemSettings.getValueOrFallback({
            label: "text_splitter_chunk_size",
          }),
          EmbedderEngine?.embeddingMaxChunkLength
        ),
        chunkOverlap: await SystemSettings.getValueOrFallback(
          { label: "text_splitter_chunk_overlap" },
          20
        ),
        chunkHeaderMeta: TextSplitter.buildHeaderMeta(metadata),
        filename: metadata.title
      });

      // Now receives an array of { text: string, metadata: object }
      const chunksWithMetadata = await textSplitter.splitText(pageContent);

      console.log(`ChromaDB:addDocumentToNamespace - Document split into ${chunksWithMetadata.length} chunks.`);
      if (chunksWithMetadata.length === 0) {
         console.log("ChromaDB:addDocumentToNamespace - No chunks generated, skipping embedding.");
         return { vectorized: true, error: null };
      }

      const documentVectors = [];
      const vectors = [];

      // Extract just the text for embedding
      const textChunksForEmbedding = chunksWithMetadata.map(chunkData => chunkData.text);
      console.log(`ChromaDB:addDocumentToNamespace - Embedding ${textChunksForEmbedding.length} text chunks...`);
      const vectorValues = await EmbedderEngine.embedChunks(textChunksForEmbedding);

      const submission = {
        ids: [],
        embeddings: [],
        metadatas: [],
        documents: [], // Chroma uses this field specifically for the text content
      };

      if (!!vectorValues && vectorValues.length === chunksWithMetadata.length) {
        console.log(`ChromaDB:addDocumentToNamespace - Successfully received ${vectorValues.length} vectors from embedder.`);
        for (const [i, vector] of vectorValues.entries()) {
          // Generate ID for this chunk
          const vectorId = uuidv4();

          // Merge original document metadata with chunk-specific AST metadata
          // Exclude the raw text chunk itself from the metadata payload for Chroma
          const { text: _t, ...astMetadata } = chunksWithMetadata[i].metadata;
          const combinedMetadata = {
             ...metadata, // Original document metadata (title, published, etc.) - might contain non-primitives initially
             ...astMetadata, // AST metadata (sourceType, nodeType, etc.)
          };

          // --- Sanitize metadata specifically for Chroma --- 
          const sanitizedMetadata = {};
          for (const key in combinedMetadata) {
            const value = combinedMetadata[key];
            if (value === null || value === undefined) {
              continue; // Skip null/undefined values
            } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
              sanitizedMetadata[key] = value; // Keep primitives
            } else {
              // Convert anything else (objects, arrays) to string
              try {
                 sanitizedMetadata[key] = JSON.stringify(value);
                 console.log(`[WARN] ChromaDB: Stringified metadata key '${key}' for Chroma.`);
              } catch (e) {
                 console.log(`[WARN] ChromaDB: Could not stringify metadata key '${key}', skipping.`);
              }
            }
          }
          // -------------------------------------------------

          // Log combined metadata and text chunk (optional)
          // console.log(`\n--- ChromaDB: Processing Chunk ${i + 1}/${vectorValues.length} ---\n` +
          //                 `Chunk Text Length: ${chunksWithMetadata[i].text.length}\n` +
          //                 `Combined Metadata:\n${JSON.stringify(combinedMetadata, null, 2)}\n` +
          //                 `Chunk Text Preview (first 100 chars):\n${chunksWithMetadata[i].text.substring(0, 100)}...\n` +
          //                 `--- End Chunk Processing ---`);

          // Prepare submission for Chroma Add
          submission.ids.push(vectorId);
          submission.embeddings.push(vector);
          submission.metadatas.push(sanitizedMetadata); // Use sanitized metadata
          submission.documents.push(chunksWithMetadata[i].text); // Use original text for Chroma's document field

          // Prepare data for cache (needs text in metadata)
          vectors.push({
            id: vectorId,
            values: vector,
            metadata: { ...sanitizedMetadata, text: chunksWithMetadata[i].text }
          });

          // Prepare data for internal document vector mapping
          documentVectors.push({ docId, vectorId: vectorId });
        }
      } else {
        const errorMsg = `Could not embed document chunks! Expected ${chunksWithMetadata.length} vectors, but received ${vectorValues?.length || 0}.`;
        console.error(`[ERROR] ChromaDB:addDocumentToNamespace - ${errorMsg}`);
        throw new Error(errorMsg);
      }

      const { client } = await this.connect();
      const collection = await client.getOrCreateCollection({
        name: this.normalize(namespace),
        metadata: { "hnsw:space": "cosine" },
      });

      if (vectors.length > 0) {
        const chunks = [];
        console.log("Inserting vectorized chunks into Chroma collection.");
        for (const chunk of toChunks(vectors, 500)) chunks.push(chunk);

        // Log the final submission object payload right before sending
        // console.log("[DEBUG] ChromaDB submission payload:", JSON.stringify(submission, null, 2));

        try {
          await collection.add(submission);
          console.log(
            `Successfully added ${submission.ids.length} vectors to collection ${this.normalize(namespace)}`
          );
        } catch (error) {
          console.error("Error adding to ChromaDB:", error);
          throw new Error(`Error embedding into ChromaDB: ${error.message}`);
        }

        await storeVectorResult(chunks, fullFilePath);
      }

      await DocumentVectors.bulkInsert(documentVectors);
      return { vectorized: true, error: null };
    } catch (e) {
      console.error("addDocumentToNamespace", e.message);
      return { vectorized: false, error: e.message };
    }
  },
  deleteDocumentFromNamespace: async function (namespace, docId) {
    const { DocumentVectors } = require("../../../models/vectors");
    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace))) return;
    const collection = await client.getCollection({
      name: this.normalize(namespace),
    });

    const knownDocuments = await DocumentVectors.where({ docId });
    if (knownDocuments.length === 0) return;

    const vectorIds = knownDocuments.map((doc) => doc.vectorId);
    await collection.delete({ ids: vectorIds });

    const indexes = knownDocuments.map((doc) => doc.id);
    await DocumentVectors.deleteIds(indexes);
    return true;
  },
  performSimilaritySearch: async function ({
    namespace = null,
    input = "",
    LLMConnector = null,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
  }) {
    if (!namespace || !input || !LLMConnector)
      throw new Error("Invalid request to performSimilaritySearch.");

    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, this.normalize(namespace)))) {
      return {
        contextTexts: [],
        sources: [],
        message: "Invalid query - no documents found for workspace!",
      };
    }

    const queryVector = await LLMConnector.embedTextInput(input);
    const { contextTexts, sourceDocuments, scores } =
      await this.similarityResponse({
        client,
        namespace,
        queryVector,
        similarityThreshold,
        topN,
        filterIdentifiers,
      });

    const sources = sourceDocuments.map((metadata, i) => ({
      metadata: {
        ...metadata,
        text: contextTexts[i],
        score: scores?.[i] || null,
      },
    }));

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
    if (!(await this.namespaceExists(client, this.normalize(namespace))))
      throw new Error("Namespace by that name does not exist.");
    const stats = await this.namespace(client, this.normalize(namespace));
    return stats
      ? stats
      : { message: "No stats were able to be fetched from DB for namespace" };
  },
  "delete-namespace": async function (reqBody = {}) {
    const { namespace = null } = reqBody;
    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, this.normalize(namespace))))
      throw new Error("Namespace by that name does not exist.");

    const details = await this.namespace(client, this.normalize(namespace));
    await this.deleteVectorsInNamespace(client, this.normalize(namespace));
    return {
      message: `Namespace ${namespace} was deleted along with ${details?.vectorCount} vectors.`,
    };
  },
  reset: async function () {
    const { client } = await this.connect();
    await client.reset();
    return { reset: true };
  },
  curateSources: function (sources = []) {
    const documents = [];
    for (const source of sources) {
      const { metadata = {} } = source;
      if (Object.keys(metadata).length > 0) {
        documents.push({
          ...metadata,
          ...(source.hasOwnProperty("pageContent")
            ? { text: source.pageContent }
            : {}),
        });
      }
    }

    return documents;
  },
};

module.exports.Chroma = Chroma;
