# AnythingLLM – Headless Code Indexer (WIP)
*A focused fork of the original [Mintplex‑Labs/anything‑llm](https://github.com/Mintplex-Labs/anything-llm) aimed at powering Retrieval‑Augmented Generation for large codebases.*

---

## Project focus

This fork is being **stripped down to a headless service** whose sole job is to:

1. Parse source files into language‑specific **Abstract Syntax Tree (AST) chunks**  
2. Attach metadata capturing relationships between those chunks  
3. Generate embeddings that place code and natural‑language queries in the same vector space  

Everything unrelated to that goal will eventually be removed, but some of the upstream UI & agent features still live in the codebase while work continues.

### Current status

Currently, the core AST chunking for PHP, JavaScript, and CSS is largely complete. Significant progress has also been made on capturing relationship metadata between code chunks and implementing code-tuned embeddings, though these areas are still under active development.

*(Status as of May 2025)*

---

## Quick start

Build the container directly from the **Dockerfile** in the repository root:

```bash
# clone your fork
git clone <this-repo>
cd anything-ast

# build image
docker build -t anythingllm-ast .


# run (example)
mkfir ~/anythingllm
docker run -d \
  --user anythingllm \
  --cap-add CAP_SYS_ADMIN \
  --network bridge \
  --workdir /app \
  -p 3002:3001 \
  --restart no \
  --runtime runc \
  \
  # env vars
  --env CHROME_PATH=/app/chrome-linux/chrome \
  --env PUPPETEER_EXECUTABLE_PATH=/app/chrome-linux/chrome \
  --env PUPPETEER_DOWNLOAD_BASE_URL=https://storage.googleapis.com/chrome-for-testing-public \
  --env PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  --env NODE_ENV=production \
  --env ANYTHING_LLM_RUNTIME=docker \
  --env STORAGE_DIR=/storage \
  --env PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  \
  # volumes
  --volume ~/anythingllm:/storage \
  --volume /Users/sherif/anythingllm/my-codebase:/app/codebase \
  \
  # labels
  --label org.opencontainers.image.ref.name=ubuntu \
  --label org.opencontainers.image.version=22.04 \
  \
  anythingllm:anythingllm-ast
```

The container boots the server and collector; mount a volume to `~/anythingllm` to persist the vector store.

---

## Want the full, feature‑rich version?

If you need the desktop chat UI, agent builder, or multimodal support, grab the original project instead:

<https://github.com/Mintplex-Labs/anything-llm>

---

## License

This fork retains the MIT licence.

© 2025 The maintainers · Original © Mintplex Labs

## Code Understanding and Context Generation

This section details how the system ingests, parses, stores, and utilizes code files to generate context for the Language Models (LLMs).

### 1. Code File Ingestion & Parsing

- **Core Component:** The process begins with the `TextSplitter` utility (`server/utils/TextSplitter/index.js`).
- **AST-Based Parsing:** For supported languages (JavaScript/JSX, PHP, CSS), the `TextSplitter` uses Abstract Syntax Trees (ASTs) to intelligently divide the code into meaningful chunks. This aims to keep related code blocks (like functions, classes, methods, CSS rules) together.
    - **JavaScript/JSX:** Uses `acorn` with `acorn-jsx` and `acorn-walk`.
    - **PHP:** Uses `php-parser`.
    - **CSS:** Uses `css-tree`.
- **Chunking Strategy:** The goal is to create chunks that represent logical units of code, respecting syntax and structure, rather than just splitting by lines or fixed character counts where possible.
- **Fallback:** For unsupported file types, very large files exceeding parsing limits, or files that cause parser errors, a fallback mechanism splits the text based on line count.


### 2. Metadata Generation & Storage

- **Extraction During Parsing:** As the AST is traversed (for supported languages), detailed metadata is extracted for each code chunk.
- **Generated Metadata:** Key metadata points include:
    - `filePath`: Original file path.
    - `language`: Detected language (e.g., `js`, `php`, `css`).
    - `nodeType`: The type of code structure (e.g., `CLASS`, `METHOD`, `FUNCTION`, `VARIABLE`, `RULE`, `AT_RULE`).
    - `nodeName`: The name of the element (e.g., function name, class name, method name, CSS selector).
    - `parentName`: Name of the parent structure (e.g., class containing a method).
    - `startLine`, `endLine`: Line numbers in the original file.
    - `summary`, `docComment`, `parameters`, `returnType`, `returnDescription`: Extracted from DocBlocks/JSDoc comments.
    - `modifiers`: Keywords like `public`, `private`, `static`, `async`, `abstract`, `final` (parsed from AST).
    - `isDeprecated`: Flag from DocBlocks.
    - `featureContext`: An inferred context based on the file path (e.g., plugin/theme name).
    - **PHP Specific:** `registersHooks`, `triggersHooks` (WordPress hooks), `extendsClass`, `implementsInterfaces`, `usesTraits`.
    - **CSS Specific:** `selector`, `atRuleName`, `atRuleParams`.
- **Storage:** All extracted metadata is stored alongside the corresponding text chunk and its vector embedding within the configured vector database (e.g., LanceDB).
    - **LanceDB Schema:** The `FULL_LANCEDB_SCHEMA` defined in `server/utils/vectorDbProviders/lance/index.js` specifies the fields for storing this metadata.

### 3. Vector Embedding

- **What is Embedded:** Crucially, **only the raw text content** of each chunk is sent to the configured embedding engine (e.g., OpenAI, Native Embedder) to generate a vector embedding.
- **Metadata Exclusion:** The extracted metadata itself is *not* included in the content that gets embedded.
- **Storage:** The resulting vector embedding is stored in the vector database record for that chunk, linked via a unique `vectorId`.

### 4. Data Retrieval (RAG - Retrieval-Augmented Generation)

- **Query Embedding:** When a user sends a chat message, the message text is embedded using the same configured embedding engine.
- **Similarity Search:** This query vector is used to perform a similarity search against the vectors stored in the relevant workspace's vector database table (e.g., using `performSimilaritySearch` in `server/utils/vectorDbProviders/lance/index.js`).
- **Top-N Chunks:** The search retrieves the `top N` most semantically similar chunks based on vector distance (e.g., cosine similarity).
- **Reranking (Optional):** If enabled, a reranker (`NativeEmbeddingReranker`) processes the initial search results, re-scoring them based on relevance to the original text query to potentially improve ordering.
- **Retrieved Data:** The process returns the `sourceDocuments` – an array of objects, where each object contains the **full metadata** and the **text content** for the retrieved chunks.

### 5. LLM Context Formatting

- **Provider-Specific Logic:** Each LLM provider (e.g., OpenAI, Gemini, Anthropic found in `server/utils/AiProviders/*`) is responsible for formatting the final prompt.
- **Key Methods:** The `constructPrompt` and `#appendContext` methods within each provider class handle this.
- **Context Construction:**
    1. The `sourceDocuments` (containing text and metadata) retrieved from the vector DB are passed to the provider.
    2. The `#appendContext` method iterates through these documents.
    3. **Metadata Inclusion:** By default, it formats each chunk into a structured string, explicitly listing the relevant metadata fields (Source File, Language, Element Type, Name, Lines, Summary, Parameters, etc.) followed by the code/text content (`--- Context Chunk N --- ... --- Code/Text --- ...`).
    4. **Conditional Metadata (via `[nometa]` flag):** If the user includes `[nometa]` in their chat prompt, the `#appendContext` method detects this flag and generates a *simplified* context, including only the Source File and the Code/Text for each chunk, omitting the other detailed metadata.
    5. The `[nometa]` flag is removed from the user prompt before it's added to the final message list.
- **Prompt Assembly:** The formatted context string (either detailed or simple) is typically appended to the base system prompt.
- **Token Limit Management:** The combined system prompt + context, chat history, and user prompt are processed by the `messageArrayCompressor` helper (`server/utils/helpers/chat/index.js`). This utility intelligently truncates or summarizes the context and chat history (prioritizing the system prompt and user prompt) to ensure the final message array fits within the specific LLM's token limit.
- **Final API Call:** The resulting, potentially compressed, array of messages (system, history, user) is sent to the selected LLM's API.
