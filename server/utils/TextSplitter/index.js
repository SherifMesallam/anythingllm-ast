/**
 * @typedef {object} DocumentMetadata
 * @property {string} id - eg; "123e4567-e89b-12d3-a456-426614174000"
 * @property {string} url - eg; "file://example.com/index.html"
 * @property {string} title - eg; "example.com/index.html"
 * @property {string} docAuthor - eg; "no author found"
 * @property {string} description - eg; "No description found."
 * @property {string} docSource - eg; "URL link uploaded by the user."
 * @property {string} chunkSource - eg; link://https://example.com
 * @property {string} published - ISO 8601 date string
 * @property {number} wordCount - Number of words in the document
 * @property {string} pageContent - The raw text content of the document
 * @property {number} token_count_estimate - Number of tokens in the document
 */

const path = require('path');
const { RecursiveCharacterTextSplitter } = require("@langchain/textsplitters");
const { isNullOrNaN } = require("../helpers");

// Attempt to require tree-sitter and language grammars
let Parser;
let JavaScript, Php, Css; // Store language modules
try {
  Parser = require('tree-sitter');
  JavaScript = require('tree-sitter-javascript');
  Php = require('tree-sitter-php');
  Css = require('tree-sitter-css');
  // Add others here if needed later: const Html = require('tree-sitter-html'); etc.
} catch (e) {
  console.error("\x1b[31m[ERROR]\x1b[0m Failed to load tree-sitter or required language grammars. AST/TreeSitter chunking disabled.", e);
  Parser = null; // Disable parser if dependencies are missing
}

// Define languages supported by tree-sitter integration
const TREE_SITTER_SUPPORTED_LANGUAGES = Parser ? { // Only define if Parser loaded
  '.js': { language: JavaScript, name: 'javascript' },
  '.jsx': { language: JavaScript, name: 'javascript' }, // Treat JSX as JS
  '.php': { language: Php, name: 'php' },
  '.pcss': { language: Css, name: 'css' }, // Use CSS grammar for PostCSS
  // '.css': { language: Css, name: 'css' },
  // '.html': { language: Html, name: 'html' },
  // '.md': { language: Markdown, name: 'markdown' },
} : {}; // Empty if parser failed to load

// Interface (as comment for JS) for structured chunk output
/*
interface ChunkMetadata {
  sourceType: 'treesitter' | 'treesitter-recursive-fallback' | 'recursive'; // Removed old AST types
  language?: string; // General language field
  nodeType?: string;
  nodeName?: string;
  parentName?: string | null; // Name of the parent class/function
  startLine?: number | null;
  endLine?: number | null;
  isSubChunk?: boolean;
}

interface ChunkWithMetadata {
  text: string;
  metadata: ChunkMetadata;
}
*/

class TextSplitter {
  #splitter;
  #chunkingStrategy;
  #languageInfo; // Store { language: LangModule, name: string }

  constructor(config = {}) {
    /*
      config can be a ton of things depending on what is required or optional by the specific splitter.
      Non-splitter related keys
      {
        splitByFilename: string, // TODO - Now using 'filename'
      }
      ------
      Default: "RecursiveCharacterTextSplitter"
      Config: {
        chunkSize: number,
        chunkOverlap: number,
        chunkHeaderMeta: object | null, // Gets appended to top of each chunk as metadata
        filename: string | null // <-- Added: Used to determine language for code splitting
      }
      ------
    */
    this.config = config;
    this.log("Constructor: Initializing with config:", config);
    const { strategy, languageInfo } = this.#setChunkingStrategy(config);
    this.#chunkingStrategy = strategy;
    this.#languageInfo = languageInfo; // Store language info object
    this.log(`Constructor: Determined chunking strategy: ${this.#chunkingStrategy}${this.#languageInfo ? ` (${this.#languageInfo.name})` : ''}`);
    this.#splitter = null;
  }

  log(text, ...args) {
    // Added a prefix for easier filtering
    console.log(`\x1b[35m[TextSplitter][0m ${text}`, ...args);
  }

  /**
   *  Does a quick check to determine the text chunk length limit.
   * Embedder models have hard-set limits that cannot be exceeded, just like an LLM context
   * so here we want to allow override of the default 1000, but up to the models maximum, which is
   * sometimes user defined.
   */
  static determineMaxChunkSize(preferred = null, embedderLimit = 1000) {
    const prefValue = isNullOrNaN(preferred)
      ? Number(embedderLimit)
      : Number(preferred);
    const limit = Number(embedderLimit);
    if (prefValue > limit)
      console.log(
        `\x1b[43m[WARN]\x1b[0m Text splitter chunk length of ${prefValue} exceeds embedder model max of ${limit}. Will use ${limit}.`
      );
    return prefValue > limit ? limit : prefValue;
  }

  /**
   *  Creates a string of metadata to be prepended to each chunk.
   * @param {DocumentMetadata} metadata - Metadata to be prepended to each chunk.
   * @returns {{[key: ('title' | 'published' | 'source')]: string}} Object of metadata that will be prepended to each chunk.
   */
  static buildHeaderMeta(metadata = {}) {
    if (!metadata || Object.keys(metadata).length === 0) return null;
    const PLUCK_MAP = {
      title: {
        as: "sourceDocument",
        pluck: (metadata) => {
          return metadata?.title || null;
        },
      },
      published: {
        as: "published",
        pluck: (metadata) => {
          return metadata?.published || null;
        },
      },
      chunkSource: {
        as: "source",
        pluck: (metadata) => {
          const validPrefixes = ["link://", "youtube://"];
          // If the chunkSource is a link or youtube link, we can add the URL
          // as its source in the metadata so the LLM can use it for context.
          // eg prompt: Where did you get this information? -> answer: "from https://example.com"
          if (
            !metadata?.chunkSource || // Exists
            !metadata?.chunkSource.length || // Is not empty
            typeof metadata.chunkSource !== "string" || // Is a string
            !validPrefixes.some(
              (prefix) => metadata.chunkSource.startsWith(prefix) // Has a valid prefix we respect
            )
          )
            return null;

          // We know a prefix is present, so we can split on it and return the rest.
          // If nothing is found, return null and it will not be added to the metadata.
          let source = null;
          for (const prefix of validPrefixes) {
            source = metadata.chunkSource.split(prefix)?.[1] || null;
            if (source) break;
          }

          return source;
        },
      },
    };

    const pluckedData = {};
    Object.entries(PLUCK_MAP).forEach(([key, value]) => {
      if (!(key in metadata)) return; // Skip if the metadata key is not present.
      const pluckedValue = value.pluck(metadata);
      if (!pluckedValue) return; // Skip if the plucked value is null/empty.
      pluckedData[value.as] = pluckedValue;
    });

    return pluckedData;
  }

  /**
   *  Creates a string of metadata to be prepended to each chunk.
   */
  stringifyHeader() {
    if (!this.config.chunkHeaderMeta) return null;
    let content = "";
    Object.entries(this.config.chunkHeaderMeta).map(([key, value]) => {
      if (!key || !value) return;
      content += `${key}: ${value}\n`;
    });

    if (!content) return null;
    return `<document_metadata>\n${content}</document_metadata>\n\n`;
  }

  #setChunkingStrategy(config = {}) {
    this.log("#setChunkingStrategy: Determining strategy for config:", config);
    // Use language-specific tree-sitter splitter if filename and extension are supported
    if (Parser && config.filename) { // Check if Parser loaded
      const fileExtension = path.extname(config.filename).toLowerCase();
      this.log(`#setChunkingStrategy: Checking filename '${config.filename}' with extension '${fileExtension}'...`);
      const languageInfo = TREE_SITTER_SUPPORTED_LANGUAGES[fileExtension]; // Gets { language: LangModule, name: string }

      if (languageInfo) {
        this.log(`#setChunkingStrategy: Match found! Using tree-sitter strategy for language: ${languageInfo.name}.`);
        return { strategy: 'treesitter', languageInfo: languageInfo }; // Return strategy and language info object
      } else {
        this.log(`#setChunkingStrategy: No specific tree-sitter strategy found for extension '${fileExtension}'. Falling back to recursive.`);
        return { strategy: 'recursive', languageInfo: null };
      }
    } else {
      if (!Parser) this.log("#setChunkingStrategy: Tree-sitter parser not loaded.");
      if (!config.filename) this.log("#setChunkingStrategy: No filename provided in config.");
      this.log("#setChunkingStrategy: Falling back to recursive strategy.");
      return { strategy: 'recursive', languageInfo: null };
    }
  }

  #getRecursiveSplitter() {
    if (this.#splitter && this.#chunkingStrategy === 'recursive') {
      this.log("#getRecursiveSplitter: Reusing existing RecursiveCharacterTextSplitter instance.");
      return this.#splitter;
    }

    const chunkOptions = {
      chunkSize: isNaN(this.config?.chunkSize) ? 1_000 : Number(this.config.chunkSize),
      chunkOverlap: isNaN(this.config?.chunkOverlap) ? 20 : Number(this.config.chunkOverlap),
    };
    this.log("#getRecursiveSplitter: Creating new RecursiveCharacterTextSplitter instance with options:", chunkOptions);
    this.#splitter = new RecursiveCharacterTextSplitter(chunkOptions);
    return this.#splitter;
  }

  // Helper to extract node name for common JS/TS patterns
  #extractJsName(node) {
    if (!node) return null;

    // Function Declaration: function foo() {} -> identifier: foo
    if (node.type === 'function_declaration' || node.type === 'class_declaration') {
      return node.childForFieldName('name')?.text || null;
    }
    // Method Definition: class A { foo() {} } -> property_identifier: foo
    if (node.type === 'method_definition') {
      return node.childForFieldName('name')?.text || null;
    }
    // Variable Declarator: const foo = ...; / let foo = ...; / var foo = ...; -> identifier: foo
    if (node.type === 'variable_declarator') {
      return node.childForFieldName('name')?.text || null;
    }
    // Export Statement: export function foo() {} / export class Foo {} / export const foo = ...
    if (node.type === 'export_statement' && node.childCount > 1) {
      // Check the actual declaration node being exported
      const declarationNode = node.child(1); // Usually the declaration follows 'export' keyword
      return this.#extractJsName(declarationNode); // Recurse on the declaration node
    }
    // TODO: Add more patterns as needed (e.g., interfaces, types in TS)
    return null;
  }

  // NEW: Method for tree-sitter based splitting
  async #splitTextWithTreeSitter(documentText, languageInfo) {
    const languageName = languageInfo.name;
    const LanguageModule = languageInfo.language;
    this.log(`[TreeSitter] === Starting splitting for ${languageName} ===`);

    let finalChunks /*: ChunkWithMetadata[]*/ = [];
    const chunkSize = TextSplitter.determineMaxChunkSize(this.config?.chunkSize, 1000); // TODO: Make embedder limit dynamic
    let treeSitterNodesToChunk = []; // Intermediate array holds { text, metadata }

    try {
      // 1. Initialize parser
      this.log(`[TreeSitter] Initializing parser for ${languageName}...`);
      const parser = new Parser();
      // Add detailed logging for the language module object
      this.log(`[TreeSitter] Language module object for ${languageName}:`, LanguageModule);
      if (!LanguageModule || typeof LanguageModule !== 'object') {
        this.log(`\x1b[31m[ERROR]\x1b[0m [TreeSitter] Invalid or undefined LanguageModule object for ${languageName}!`);
        throw new Error(`Invalid language object passed for ${languageName}`);
      }
      parser.setLanguage(LanguageModule);
      this.log(`[TreeSitter] Parser initialized successfully.`);

      // 2. Parse the document
      this.log(`[TreeSitter] Parsing document text (length: ${documentText.length})...`);
      const tree = parser.parse(documentText);
      this.log(`[TreeSitter] Document parsed successfully. Root node: ${tree.rootNode.type}`);

      // 3. Define tree-sitter queries based on language
      let queryString = '';
      if (languageName === 'javascript') {
        queryString = `
          [
            (function_declaration) @entity
            (class_declaration) @entity
            (lexical_declaration (variable_declarator)) @entity ; const/let foo = ...
            (variable_declaration (variable_declarator)) @entity ; var foo = ...
            (export_statement) @entity ; Handle exports separately maybe? Or capture underlying declaration
            ; Add JSX elements? ((jsx_element) @entity) ((jsx_self_closing_element) @entity)
            (method_definition) @member ; Class methods - capture separately?
          ]
        `;
      } else if (languageName === 'php') {
        queryString = `
          [
            (namespace_definition) @entity
            (class_declaration) @entity
            (interface_declaration) @entity
            (trait_declaration) @entity
            (function_definition) @entity
            (method_declaration) @member
          ]
        `;
      } else if (languageName === 'css') {
         queryString = `
           [
             (rule_set) @entity
             (at_rule) @entity ; e.g., @media, @keyframes
           ]
         `;
      } else {
        this.log(`[TreeSitter] No specific query defined for language: ${languageName}. Skipping tree-sitter chunking.`);
        throw new Error(`Unsupported language for tree-sitter query: ${languageName}`);
      }

      this.log(`[TreeSitter] Compiling query for ${languageName}:
------ QUERY START ------
${queryString.trim()}
------- QUERY END -------`);
      const query = new Parser.Query(LanguageModule, queryString);
      this.log(`[TreeSitter] Query compiled.`);

      // 5. Execute query and get captures
      this.log(`[TreeSitter] Executing query on root node...`);
      const captures = query.captures(tree.rootNode);
      this.log(`[TreeSitter] Query executed. Found ${captures.length} potential captures.`);


      // 6. Process captures into intermediate chunks with metadata
      this.log(`[TreeSitter] Processing ${captures.length} captures...`);
      let processedCount = 0;
      for (const capture of captures) {
        const node = capture.node;
        const nodeType = node.type;
        const nodeName = this.#extractJsName(node); // Example: Use helper for JS name extraction
        // TODO: Implement similar name extraction helpers for PHP, CSS if needed

        const startLine = node.startPosition.row + 1; // tree-sitter is 0-indexed, convert to 1-indexed
        const endLine = node.endPosition.row + 1;
        const text = node.text; // Get the text content of the captured node

        this.log(`[TreeSitter] Capture ${processedCount + 1}/${captures.length}: Node Type='${nodeType}', Name='${nodeName}', Lines=${startLine}-${endLine}, Text Length=${text.length}`);

        // Basic filtering: Skip very small nodes
        if (text.length < 10 || !text.trim()) {
          this.log(`[TreeSitter] --> Skipping capture ${processedCount + 1}: Text too short or empty.`);
          processedCount++;
          continue;
        }

        const chunkMetadata = {
          sourceType: 'treesitter',
          language: languageName,
          nodeType: nodeType,
          nodeName: nodeName,
          parentName: null, // TODO: Implement parent finding logic if needed
          startLine: startLine,
          endLine: endLine,
        };

        this.log(`[TreeSitter] --> Adding potential chunk ${processedCount + 1} to intermediate list.`);
        treeSitterNodesToChunk.push({ text, metadata: chunkMetadata });
        processedCount++;
      }


      this.log(`[TreeSitter] Finished processing captures. Identified ${treeSitterNodesToChunk.length} potential chunks meeting basic criteria.`);
      this.log(`[TreeSitter] Checking ${treeSitterNodesToChunk.length} potential chunks against chunkSize: ${chunkSize}`);

      // 7. Check intermediate chunks against chunkSize and fallback if needed
      let finalChunkIndex = 0;
      for (const chunkInfo of treeSitterNodesToChunk) {
        const logPrefix = `[TreeSitter] Chunk ${finalChunkIndex + 1} (Type: ${chunkInfo.metadata.nodeType}, Lines: ${chunkInfo.metadata.startLine}-${chunkInfo.metadata.endLine}, Length: ${chunkInfo.text.length})`;
        if (chunkInfo.text.length > chunkSize) {
          this.log(`\x1b[33m[WARN]\x1b[0m ${logPrefix} exceeds chunkSize (${chunkSize}). Falling back to recursive splitting.`);
          const recursiveSplitter = this.#getRecursiveSplitter();
          const subChunkOptions = {
             chunkSize: chunkSize,
             chunkOverlap: isNaN(this.config?.chunkOverlap) ? 20 : Number(this.config.chunkOverlap),
          };
          this.log(`[TreeSitter] --> Recursive fallback options:`, subChunkOptions);
          const subSplitter = new RecursiveCharacterTextSplitter(subChunkOptions);
          const subChunks = await subSplitter.splitText(chunkInfo.text);
          this.log(`[TreeSitter] --> Recursive fallback generated ${subChunks.length} sub-chunks.`);

          let subChunkIndex = 0;
          subChunks.forEach(subChunkText => {
            if (subChunkText.trim()) {
              this.log(`[TreeSitter] --> Adding sub-chunk ${subChunkIndex + 1}/${subChunks.length} (Length: ${subChunkText.length})`);
              finalChunks.push({
                text: subChunkText,
                metadata: { ...chunkInfo.metadata, sourceType: 'treesitter-recursive-fallback', isSubChunk: true }
              });
            }
            subChunkIndex++;
          });
        } else {
           this.log(`${logPrefix} is within size limit. Adding directly.`);
          finalChunks.push(chunkInfo); // Push the whole { text, metadata } object
        }
        finalChunkIndex++;
      }
      this.log(`[TreeSitter] Finished size check. Total chunks before filtering: ${finalChunks.length}`);

    } catch (e) {
      // If tree-sitter failed for *any* reason (parsing, querying, processing)
      this.log(`\x1b[31m[TreeSitter] [ERROR]\x1b[0m Critical failure during tree-sitter processing for ${languageName}. Falling back to recursive splitting for the ENTIRE document. Error: ${e.message}`, e.stack);
      const recursiveSplitter = this.#getRecursiveSplitter();
      this.log(`[TreeSitter] Invoking recursive fallback for entire document...`);
      const textChunks = await recursiveSplitter.splitText(documentText);
      this.log(`[TreeSitter] Recursive fallback generated ${textChunks.length} chunks.`);
      // Reset finalChunks and populate with recursive results
      finalChunks = textChunks.map(chunk => ({
        text: chunk,
        metadata: {
          sourceType: 'recursive',
          language: languageName, // Keep language info if known
          startLine: null,
          endLine: null
        }
      }));
    }

    const filteredChunks = finalChunks.filter(chunkObject => chunkObject && chunkObject.text && !!chunkObject.text.trim());
    this.log(`[TreeSitter] Finished splitting process for ${languageName}. Total final chunks generated (after filtering): ${filteredChunks.length}.`);
    // Filter empty chunks before returning
    return filteredChunks;
  }


  // Main method to split text
  async splitText(documentText) {
    this.log(`splitText: Method entered. Strategy: ${this.#chunkingStrategy}${this.#languageInfo ? ` (${this.#languageInfo.name})` : ''}`);
    let chunksWithMetadata /*: ChunkWithMetadata[]*/ = [];

    // Dispatch based on strategy
    if (this.#chunkingStrategy === 'treesitter' && this.#languageInfo) {
      this.log(`splitText: Dispatching to #splitTextWithTreeSitter for ${this.#languageInfo.name}.`);
      chunksWithMetadata = await this.#splitTextWithTreeSitter(documentText, this.#languageInfo);
      this.log(`splitText: Received ${chunksWithMetadata.length} chunks from #splitTextWithTreeSitter.`);
    }
    else { // Default to recursive (includes cases where strategy is recursive or tree-sitter failed)
      this.log(`splitText: Dispatching to recursive splitter.`);
      const splitter = this.#getRecursiveSplitter();
      const textChunks = await splitter.splitText(documentText);
      this.log(`splitText: Received ${textChunks.length} raw chunks from recursive splitter.`);
      chunksWithMetadata = textChunks.map(chunk => ({
        text: chunk,
        metadata: {
            sourceType: 'recursive',
            language: this.#languageInfo?.name || null, // Pass language name if known
            startLine: null,
            endLine: null
        }
      }));
      this.log(`splitText: Mapped ${chunksWithMetadata.length} recursive chunks to ChunkWithMetadata format.`);
    }

    // If chunking (tree-sitter or recursive) produced no chunks, return early.
    if (chunksWithMetadata.length === 0) {
       this.log(`splitText: No chunks were generated or survived filtering. Returning empty array.`);
       return [];
    }

    this.log(`splitText: Processing ${chunksWithMetadata.length} chunks before header prepending.`);
    const header = this.stringifyHeader(); // Get metadata header string

    if (!header) {
      this.log(`splitText: No header to prepend.`);
      // Still need to filter empty chunks - this should be redundant now as filtering happens earlier
      const finalFilteredChunks = chunksWithMetadata.filter(chunkObject => chunkObject && chunkObject.text && !!chunkObject.text.trim());
      this.log(`splitText: Returning ${finalFilteredChunks.length} final chunks (no header).`);
      return finalFilteredChunks;
    }

    this.log(`splitText: Prepending header to ${chunksWithMetadata.length} chunks...`);
    // Prepend header to each non-empty chunk's text property if header exists
    const finalChunksWithHeader = chunksWithMetadata
      // Filtering should be redundant here now but keep for safety
      .filter(chunkObject => chunkObject && chunkObject.text && !!chunkObject.text.trim())
      .map(chunkObject => ({
          ...chunkObject,
          text: `${header}${chunkObject.text}` // Prepend header to text
      }));

    this.log(`splitText: Returning ${finalChunksWithHeader.length} final chunks (with header).`);
    return finalChunksWithHeader;
  }
}

module.exports = { TextSplitter };
