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
const doctrine = require('doctrine'); // For parsing JSDoc comments
const postcss = require('postcss'); // <-- Import postcss
const babelParser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

function isNullOrNaN(value) {
  if (value === null) return true;
  return isNaN(value);
}

// Interface (as comment for JS) for structured chunk output
/*
interface ChunkMetadata {
  sourceType: 'ast' | 'ast-recursive-fallback' | 'recursive';
  language?: 'js' | 'php';
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
  #featureContext;

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
    this.#chunkingStrategy = this.#setChunkingStrategy(config);
    this.#featureContext = this.#determineFeatureContext(config.filename);
    this.log(`Constructor: Determined chunking strategy: ${this.#chunkingStrategy}`);
    this.log(`Constructor: Determined feature context: ${this.#featureContext}`);
    this.#splitter = null;
  }

  log(text, ...args) {
    console.log(`\x1b[35m[TextSplitter]\x1b[0m ${text}`, ...args);
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
        `\x1b[43m[WARN]\x1b[0m Text splitter chunk length of ${prefValue} exceeds embedder model max of ${embedderLimit}. Will use ${embedderLimit}.`
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
    // Use language-specific AST splitter if filename and extension are available
    if (config.filename) {
      const fileExtension = path.extname(config.filename).toLowerCase();
      this.log(`#setChunkingStrategy: Filename detected (${config.filename}), attempting language-specific strategy for extension ${fileExtension}.`);

      if (fileExtension === '.js') {
        this.log("#setChunkingStrategy: Using AST strategy for JavaScript.");
        return 'ast-js';
      } else if (fileExtension === '.php') {
        this.log("#setChunkingStrategy: Using AST strategy for PHP.");
        return 'ast-php';
      } else if (fileExtension === '.css') {
        this.log("#setChunkingStrategy: Using AST strategy for CSS.");
        return 'ast-css';
      } else {
        this.log(`#setChunkingStrategy: No specific AST strategy for extension ${fileExtension}, using recursive.`);
        return 'recursive';
      }
    } else {
      this.log("#setChunkingStrategy: No filename provided, using recursive strategy.");
      return 'recursive';
    }
  }

  #getRecursiveSplitter() {
    if (this.#splitter && this.#chunkingStrategy === 'recursive') {
      return this.#splitter;
    }

    const chunkOptions = {
      chunkSize: isNaN(this.config?.chunkSize) ? 1_000 : Number(this.config.chunkSize),
      chunkOverlap: isNaN(this.config?.chunkOverlap) ? 20 : Number(this.config.chunkOverlap),
    };
    this.log("#getRecursiveSplitter: Creating new RecursiveCharacterTextSplitter instance.");
    this.#splitter = new RecursiveCharacterTextSplitter(chunkOptions);
    return this.#splitter;
  }

  // Helper to process a single PHP AST node (used in forEach)
  #processPhpNode(node, index, documentText, astNodesToChunk) {
    this.log(`[AST Process PHP] Processing PHP AST node ${index + 1} - Kind: ${node.kind}`);

    // --- Hook Detection --- 
    let isHookCall = false;
    if (node.kind === 'expressionstatement' && node.expression.kind === 'call') {
      const call = node.expression;
      if (call.what.kind === 'name') {
        const funcName = call.what.name;
        const nodeStartLine = node.loc?.start?.line || null;
        const nodeEndLine = node.loc?.end?.line || null;
        const nodeText = this.getCodeFromRange(documentText, node.loc?.start?.offset, node.loc?.end?.offset);
        let hookMetadata = {
            sourceType: 'ast',
            language: 'php',
            filePath: this.config.filename || "",
            startLine: nodeStartLine,
            endLine: nodeEndLine,
            featureContext: this.#featureContext || "",
            registersHooks: [],
            triggersHooks: [],
        };

        if (['add_action', 'add_filter'].includes(funcName)) {
            isHookCall = true;
            hookMetadata.nodeType = 'hookRegistration';
            const hookNameArg = call.arguments[0];
            const hookName = hookNameArg?.kind === 'string' ? hookNameArg.value :
                             (hookNameArg ? this.getCodeFromRange(documentText, hookNameArg.loc?.start?.offset, hookNameArg.loc?.end?.offset) : 'unknown_hook');
            const callbackNode = call.arguments[1];
            const callback = callbackNode ? this.getCodeFromRange(documentText, callbackNode.loc?.start?.offset, callbackNode.loc?.end?.offset) : 'unknown_callback';
            const priority = call.arguments[2]?.value ?? 10;
            const acceptedArgs = call.arguments[3]?.value ?? 1;
            hookMetadata.registersHooks.push({ hookName, callback, type: funcName === 'add_action' ? 'action' : 'filter', priority, acceptedArgs });
            this.log(`[AST Process PHP] Detected Hook Registration: ${funcName}('${hookName}')`);
            astNodesToChunk.push({ text: nodeText, metadata: hookMetadata });
        } else if (['do_action', 'apply_filters'].includes(funcName)) {
            isHookCall = true;
            hookMetadata.nodeType = 'hookTrigger';
            const hookNameArg = call.arguments[0];
            const hookName = hookNameArg?.kind === 'string' ? hookNameArg.value :
                             (hookNameArg ? this.getCodeFromRange(documentText, hookNameArg.loc?.start?.offset, hookNameArg.loc?.end?.offset) : 'unknown_hook');
            hookMetadata.triggersHooks.push({ hookName, type: funcName === 'do_action' ? 'action' : 'filter' });
            this.log(`[AST Process PHP] Detected Hook Trigger: ${funcName}('${hookName}')`);
            astNodesToChunk.push({ text: nodeText, metadata: hookMetadata });
        }
      }
    }
    if (isHookCall) return; // Don't process further if it was a hook call

    // --- Class/Trait/Method Handling --- 
    if (node.kind === 'class' || node.kind === 'trait') {
      const parentClassName = node.name?.name || (typeof node.name === 'string' ? node.name : null);
      this.log(`[AST Process PHP] Entering PHP ${node.kind} context: ${parentClassName}`);
      this.#addPhpNodeToChunks(node, documentText, astNodesToChunk, null);
      if (node.body) {
        node.body.forEach(bodyNode => { // Assuming forEach is safe here as #addPhpNodeToChunks is bound
          if (bodyNode.kind === 'method') {
            this.#addPhpNodeToChunks(bodyNode, documentText, astNodesToChunk, parentClassName);
          }
        });
      }
      return; // Don't process class/trait node generically after handling its body
    }

    // --- Generic Node Handling --- 
    this.#addPhpNodeToChunks(node, documentText, astNodesToChunk, null);
  }

  // Core AST splitting logic - now returns Promise<ChunkWithMetadata[]>
  async #splitTextWithAST(documentText, language) {
    this.log(`[AST] #splitTextWithAST: Starting AST splitting for ${language}.`);
    // Final array will hold ChunkWithMetadata objects
    let finalChunks /*: ChunkWithMetadata[]*/ = [];
    // Use the chunkSize determined during construction, don't recalculate with hardcoded limit
    const chunkSize = this.config?.chunkSize || 1000; // Use stored config, fallback just in case

    try {
      // Intermediate array holds { text: string, metadata: ChunkMetadata } before size check
      let astNodesToChunk /*: ChunkWithMetadata[] */ = [];

      if (language === 'js') {
        this.log("[AST Babel] #splitTextWithAST: Attempting to parse JavaScript/JSX with Babel...");
        // Remove dynamic imports, use require at top of file
        // const babelParser = await import('@babel/parser');
        // const traverse = (await import('@babel/traverse')).default; 

        // Array to hold potential chunks
        let allPotentialChunks = [];
        let lastProcessedEndOffset = 0;

        try {
            // Use the required babelParser
            const ast = babelParser.parse(documentText, {
          sourceType: "module",
              tokens: false, // Don't need tokens for this
              plugins: [
                "jsx", // Enable JSX
                // Add other plugins if needed (e.g., 'typescript', 'decorators-legacy', 'classProperties')
              ],
              // Attach comments to AST nodes
              attachComment: true,
              errorRecovery: true, // Attempt to parse even with minor errors
        });

            this.log(`[AST Babel] Parsed successfully. Walking AST with @babel/traverse...`);

            traverse(ast, {
                 enter: (path) => { // `path` provides context (node, parent, scope, etc.)
                    const node = path.node;
                    const type = node.type; // Node type (e.g., 'FunctionDeclaration')

                    // --- Log entry for *every* node ---
                    this.log(`[AST Babel ENTER] Visiting ${type}. Start: ${node.start}, End: ${node.end}, Current Offset: ${lastProcessedEndOffset}`);

                    // Skip root Program node or nodes without location info
                    if (type === 'Program' || !node.start || !node.end) {
                        this.log(`[AST Babel ENTER] Skipping node.`);
                        return;
                    }

                    // Update offset based on the *start* of the current node we are processing
                    // Only update if the node truly starts after the last one ended, 
                    // preventing issues with nested traversals potentially moving the offset backward.
                    if (node.start > lastProcessedEndOffset) {
                       this.log(`[AST Babel Offset] Updating offset based on node start: ${lastProcessedEndOffset} -> ${node.start}`);
                       lastProcessedEndOffset = node.start;
                    }

                    // --- 2. Process the Node itself --- 
                    const nodeText = documentText.substring(node.start, node.end);
                    let isPrimaryStructure = false;
                    const currentScope = this.getBabelScopeString(path);

                    // Log node details before processing
                    this.log(`[AST Babel Node] Processing ${type}. Scope: ${currentScope}. Text length: ${nodeText.length}. Range ${node.start}-${node.end}`);

                    // Determine if it's a primary structure
                    if (type === 'FunctionDeclaration' || type === 'ClassDeclaration' || type === 'FunctionExpression' || type === 'ArrowFunctionExpression' || type === 'ClassMethod' || type === 'ObjectMethod') {
                         // Refined logic: Check if parent is Program or if it's a method
                         // Or if it's a function/arrow assigned potentially at top level (parent is VariableDeclarator whose parent is Program)
                         if (path.parentPath?.isProgram() || 
                             type === 'ClassMethod' || 
                             type === 'ObjectMethod' ||
                             ((type === 'FunctionExpression' || type === 'ArrowFunctionExpression') && path.parentPath?.isVariableDeclarator() && path.parentPath.parentPath?.isProgram()))
                         {
                             isPrimaryStructure = true;
                         }
                    }

                    // --- ONLY create chunks for PRIMARY structures --- 
                    if (isPrimaryStructure) {
                        const nodeName = this.getBabelNodeName(node);
                        this.log(`[AST Babel Walk] Identified as PRIMARY Node: ${type} (Name: ${nodeName || 'N/A'}) - Creating Chunk.`);
                        let jsdocMeta = this.parseBabelJsDoc(node, documentText);
                        const chunkMetadata = {
                            sourceType: 'ast',
                            language: 'js',
                            filePath: this.config.filename || "",
                            nodeType: type,
                            nodeName: nodeName || "",
                            scope: currentScope,
                            startLine: node.loc ? node.loc.start.line : this.getLineNumber(documentText, node.start),
                            endLine: node.loc ? node.loc.end.line : this.getLineNumber(documentText, node.end),
                            docComment: jsdocMeta.docComment,
                            summary: jsdocMeta.summary,
                            parameters: jsdocMeta.parameters,
                            returnType: jsdocMeta.returnInfo.type,
                            returnDescription: jsdocMeta.returnInfo.description,
                            isDeprecated: jsdocMeta.isDeprecated,
                            modifiers: {}, // Modifiers might need specific babel logic if required
                            extendsClass: this.getBabelExtends(node, documentText),
                            featureContext: this.#featureContext || ""
                        };

                        if (nodeText.trim()) {
                           allPotentialChunks.push({ text: nodeText, metadata: chunkMetadata });
                           this.log(`[AST Babel Chunk] Added chunk for PRIMARY ${type}. Total potential chunks: ${allPotentialChunks.length}`);
                        } else {
                           this.log(`[AST Babel Walk] Skipping PRIMARY Node ${type} - Extracted text is empty.`);
                        }
                    } else {
                        // --- [REMOVED] No chunk creation for non-primary nodes --- 
                        this.log(`[AST Babel Walk] Identified as OTHER Node: ${type}. Skipping chunk creation.`);
                    }

                    // --- 3. Update last processed offset based on the *end* of the current node --- 
                    // Only update if the node truly ends after the current offset
                    if (node.end > lastProcessedEndOffset) {
                       this.log(`[AST Babel Offset] Updating offset after node processing: ${lastProcessedEndOffset} -> ${node.end}`);
                       lastProcessedEndOffset = node.end;
                    } else {
                       // This warning might still appear if traversal order is unexpected, but less critical now
                       this.log(`[AST Babel Offset] [WARN] Node end (${node.end}) did not advance offset (${lastProcessedEndOffset}).`);
                    }
                }
            });

            // Add logging right after traversal completes
            this.log(`[AST Babel] After traverse, allPotentialChunks count: ${allPotentialChunks.length}`);
            if (allPotentialChunks.length > 0) {
              this.log(`[AST Babel] Sample potential chunk metadata:`, JSON.stringify(allPotentialChunks[0].metadata, null, 2));
            }

            // --> Assign the results back to the main array used later <--
            astNodesToChunk = allPotentialChunks;

            this.log("[AST Babel] Traverse finished.");

            // --- Handle Trailing Code ---
            if (lastProcessedEndOffset < documentText.length) {
                const trailingText = documentText.substring(lastProcessedEndOffset);
                if (trailingText.trim()) {
                    this.log(`[AST Babel Walk] Found TRAILING text (length: ${trailingText.length}) after last node.`);
                    astNodesToChunk.push({
                        text: trailingText,
                        metadata: {
                            sourceType: 'code-segment',
                            language: 'js',
                            filePath: this.config.filename || "",
                            scope: 'global',
                            startLine: this.getLineNumber(documentText, lastProcessedEndOffset),
                            endLine: this.getLineNumber(documentText, documentText.length),
                            featureContext: this.#featureContext || ""
                        }
                    });
                }
            }
            this.log(`[AST Babel] Finished walk and gap analysis. ${astNodesToChunk.length} potential chunks identified.`);

        } catch (e) {
            // Log Babel parsing/traversal errors
            this.log(`\x1b[31m[AST Babel] [ERROR]\x1b[0m Failed during Babel parsing/traversal for JS: ${e.message}. Stack: ${e.stack}. Falling back to recursive splitting.`);
            // Fallback to recursive if Babel fails
            const recursiveSplitter = this.#getRecursiveSplitter();
            const textChunks = await recursiveSplitter.splitText(documentText);
            finalChunks = textChunks.map(chunk => ({
                text: chunk,
                metadata: { sourceType: 'recursive', startLine: 0, endLine: 0, featureContext: this.#featureContext || "", filePath: this.config.filename || "" }
            }));
            // Skip the size processing loop below if we fell back
            astNodesToChunk = []; // Prevent entering the size check loop
        }

      } else if (language === 'php') {
        this.log("[AST] #splitTextWithAST: Attempting to parse PHP...");
        const { Engine } = await import('php-parser');
        const parser = new Engine({
          parser: { locations: true, extractDoc: true },
          ast: { withPositions: true },
        });
        const ast = parser.parseCode(documentText);
        this.log(`[AST] #splitTextWithAST: Successfully parsed PHP AST. Found ${ast.children?.length || 0} top-level nodes.`);

        // Use forEach with an arrow function to ensure correct `this` and pass arguments explicitly
        ast.children.forEach((node, index) => {
          this.#processPhpNode(node, index, documentText, astNodesToChunk);
        });

      } else if (language === 'css') { // <-- Add CSS block
        this.log("[AST] #splitTextWithAST: Attempting to parse CSS with PostCSS...");
        const ast = postcss.parse(documentText, { from: this.config.filename || 'unknown.css' });
        this.log(`[AST] #splitTextWithAST: Successfully parsed CSS AST. Found ${ast.nodes?.length || 0} top-level nodes.`);

        ast.walk(node => {
          // Process Rules (e.g., .class { ... })
          if (node.type === 'rule') {
            this.log(`[AST] #splitTextWithAST: Processing CSS Rule: ${node.selector}`);
            if (node.source?.start && node.source?.end) {
              const startLine = node.source.start.line;
              const endLine = node.source.end.line;
              // Extract text directly from node.toString() for accuracy including selector and braces
              const text = node.toString(); 
              const metadata = {
                sourceType: 'ast',
                language: 'css',
                filePath: this.config.filename || "",
                nodeType: 'rule',
                selector: node.selector || "",
                startLine: startLine,
                endLine: endLine,
                // featureContext added later
              };
              // --- BEGIN ADDED LOGGING ---
              this.log(`[AST] Helper: Final Chunk Metadata (CSS Rule ${metadata.selector}):`, JSON.stringify(metadata, null, 2));
              // --- END ADDED LOGGING ---
              if (text.trim()) {
                astNodesToChunk.push({ text, metadata });
              }
            } else {
                 this.log(`[AST] Helper: Skipping CSS Rule (Selector: ${node.selector}) - No source location info.`);
            }
          }
          // Process At-Rules (e.g., @media { ... })
          else if (node.type === 'atrule') {
            this.log(`[AST] #splitTextWithAST: Processing CSS AtRule: @${node.name} ${node.params}`);
             if (node.source?.start && node.source?.end) {
              const startLine = node.source.start.line;
              const endLine = node.source.end.line;
              // Extract text directly from node.toString() for accuracy
              const text = node.toString(); 
              const metadata = {
                sourceType: 'ast',
                language: 'css',
                filePath: this.config.filename || "",
                nodeType: 'atRule',
                atRuleName: node.name || "",
                atRuleParams: node.params || "",
                startLine: startLine,
                endLine: endLine,
                // featureContext added later
              };
              // --- BEGIN ADDED LOGGING ---
              this.log(`[AST] Helper: Final Chunk Metadata (CSS AtRule @${metadata.atRuleName}):`, JSON.stringify(metadata, null, 2));
              // --- END ADDED LOGGING ---
              if (text.trim()) {
                astNodesToChunk.push({ text, metadata });
              }
            } else {
                 this.log(`[AST] Helper: Skipping CSS AtRule (@${node.name}) - No source location info.`);
            }
          }
          // We are not iterating Declarations (prop: value) individually for now
          // Add other node types like comments if needed later
        });
      }

      this.log(`[AST] #splitTextWithAST: Identified ${astNodesToChunk.length} potential chunks from AST traversal for ${language}.`);
      this.log(`[AST] #splitTextWithAST: Now checking potential chunks against chunkSize: ${chunkSize}`);

      // Process potential chunks for size limits
      for (const chunkInfo of astNodesToChunk) { // chunkInfo is now { text, metadata }
        this.log(`[AST] #splitTextWithAST: Processing potential chunk (Type: ${chunkInfo.metadata.nodeType}, Lines: ${chunkInfo.metadata.startLine}-${chunkInfo.metadata.endLine}), length ${chunkInfo.text.length}.`);
        if (chunkInfo.text.length > chunkSize) {
          this.log(`\x1b[33m[AST] [WARN]\x1b[0m AST chunk (lines ${chunkInfo.metadata.startLine}-${chunkInfo.metadata.endLine}) for ${language} exceeds chunkSize (${chunkInfo.text.length}/${chunkSize}). Falling back to recursive splitting for this specific chunk.`);
          const recursiveSplitter = this.#getRecursiveSplitter();
          const subChunks = await recursiveSplitter.splitText(chunkInfo.text);
          this.log(`[AST] #splitTextWithAST: Recursive fallback generated ${subChunks.length} sub-chunks for oversized AST node.`);
          // Wrap sub-chunks in metadata structure
          subChunks.forEach(subChunkText => {
            if (subChunkText.trim()) { // Ensure sub-chunk is not just whitespace
              finalChunks.push({
                text: subChunkText,
                metadata: {
                  ...chunkInfo.metadata,
                  featureContext: this.#featureContext,
                  sourceType: 'ast-recursive-fallback',
                  isSubChunk: true,
                  filePath: this.config.filename || ""
                }
              });
            }
          });
        } else {
          this.log(`[AST] #splitTextWithAST: AST chunk (lines ${chunkInfo.metadata.startLine}-${chunkInfo.metadata.endLine}) is within size limit. Adding directly.`);
          // Add feature context to the existing metadata before pushing
          chunkInfo.metadata.featureContext = this.#featureContext;
          finalChunks.push(chunkInfo); // Push the whole { text, metadata } object
        }
      }

    } catch (e) {
      this.log(`\x1b[31m[AST] [ERROR]\x1b[0m Failed during AST parsing/splitting for ${language}: ${e.message}. Stack: ${e.stack}. Falling back to recursive splitting for the ENTIRE document.`);
      const recursiveSplitter = this.#getRecursiveSplitter();
      const textChunks = await recursiveSplitter.splitText(documentText);
      this.log(`[AST] #splitTextWithAST: Recursive fallback for entire document generated ${textChunks.length} chunks.`);
      // Wrap recursive string chunks into the standard object format
      textChunks.forEach(chunk => {
        finalChunks.push({
          text: chunk,
          metadata: {
            sourceType: 'recursive',
            startLine: 0,
            endLine: 0,
            featureContext: this.#featureContext || "",
            filePath: this.config.filename || ""
          }
        });
      });
    }

    this.log(`[AST] #splitTextWithAST: Finished AST splitting process for ${language}. Total final chunks generated: ${finalChunks.length}.`);
    const header = this.stringifyHeader(); // Get metadata header string

    if (!header) {
      // Return chunks with metadata as-is if no header
      return finalChunks.filter(chunkObject => !!chunkObject.text.trim());
      }

    // Prepend header to each non-empty chunk's text property if header exists
    return finalChunks
      .filter(chunkObject => !!chunkObject.text.trim())
      .map(chunkObject => ({
          ...chunkObject,
          text: `${header}${chunkObject.text}` // Prepend header to text
      }));
  }

  // Helper to add PHP node chunk with metadata
  #addPhpNodeToChunks(node, documentText, chunkArray, parentName) {
    // --- BEGIN Initializations ---
    let docComment = "";
    let summary = "";
    let docParams = []; 
    let docReturnType = null; 
    let isDeprecated = false;
    let signatureParams = []; 
    let signatureReturnType = ""; 
    let extendsClassName = "";
    let implementsInterfaces = [];
    let usesTraits = [];
    let modifiers = {}; 
    let nodeName = "";
    // --- END Initializations ---

    if (node?.loc && node.loc.start?.offset !== undefined && node.loc.end?.offset !== undefined) {
      const start = node.loc.start.offset;
      const end = node.loc.end.offset;
      const text = documentText.substring(start, end);
      const startLine = node.loc.start.line;
      const endLine = node.loc.end.line;

      // Existing name extraction logic
      if (node.name) {
        nodeName = typeof node.name === 'string' ? node.name : node.name.name; // Assign to initialized variable
      }

      // --- Re-implement DocBlock Parsing ---
      if (node.leadingComments && node.leadingComments.length > 0) {
        // Find the last block comment directly preceding the node
        // php-parser puts comments directly associated with a node here.
        const potentialDocComment = node.leadingComments[node.leadingComments.length - 1];
        if (potentialDocComment && potentialDocComment.kind === 'commentblock' && potentialDocComment.value.startsWith('/**')) {
          docComment = potentialDocComment.value; // Store the raw comment text
          this.log(`[AST] Helper: Found potential PHP DocBlock for ${nodeName || node.kind}`);
          try {
              const parsedDoc = doctrine.parse(docComment, { 
                  unwrap: false, // Keep /** */ for raw storage if needed, parsing works anyway
                  sloppy: true, 
                  tags: null 
              });
              summary = parsedDoc.description || "";
              // Initialize docParams here before the loop
              docParams = []; 
              docReturnType = null; // Initialize return type object

              parsedDoc.tags.forEach(tag => {
                  switch (tag.title) {
                      case 'param':
                          docParams.push({
                              name: tag.name || "",
                              type: tag.type ? doctrine.type.stringify(tag.type) : "",
                              description: tag.description || ""
                          });
                          break;
                      case 'return':
                          docReturnType = {
                              type: tag.type ? doctrine.type.stringify(tag.type) : "",
                              description: tag.description || ""
                          };
                          break;
                      case 'deprecated':
                          isDeprecated = true;
                          break;
                      // Add other tags as needed
                  }
              });
               this.log(`[AST] Helper: Parsed PHP DocBlock - ${docParams.length} params, ${docReturnType ? 'return specified' : 'no return'}`);
          } catch (e) {
              this.log(`\x1b[33m[AST] Helper [WARN]\x1b[0m Failed to parse PHP DocBlock comment for ${nodeName || node.kind}: ${e.message}`);
          }
        }
        }
      // --- End Re-implement DocBlock Parsing ---

      // --- Re-implement Signature Parameter logic ---
      signatureParams = []; // Ensure initialization
      if (node.params && Array.isArray(node.params)) {
          node.params.forEach(param => {
              let paramType = "";
              if (param.type) {
                  if (typeof param.type === 'string') { // Simple type hint like "string"
                     paramType = param.type;
                  } else if (param.type.kind === 'name') { // Object type hint like new Request()
                     paramType = param.type.name;
                  } else if (param.type.kind === 'nullabletype') { // Nullable type like ?string
                     paramType = `?${param.type.name}`;
                  } else {
                     paramType = param.type.kind; // Fallback for other kinds (union, intersection)
                  }
              }
              signatureParams.push({
                  name: param.name?.name || (typeof param.name === 'string' ? param.name : ''),
                  type: paramType,
                  byRef: param.byref || false,
                  isVariadic: param.variadic || false,
                  // Default value requires inspecting param.value, omitted for simplicity now
              });
          });
           this.log(`[AST] Helper: Parsed ${signatureParams.length} PHP signature parameters.`);
      }
      // --- End Re-implement Signature Parameter logic ---

      // --- Re-implement Signature Return Type logic ---
      signatureReturnType = ""; // Ensure initialization
      if (node.returnType) {
          if (typeof node.returnType === 'string') {
              signatureReturnType = node.returnType;
          } else if (node.returnType.kind === 'name') {
              signatureReturnType = node.returnType.name;
          } else if (node.returnType.kind === 'nullabletype') {
              signatureReturnType = `?${node.returnType.name}`;
          } else {
             signatureReturnType = node.returnType.kind;
          }
          this.log(`[AST] Helper: Parsed PHP signature return type: ${signatureReturnType}`);
      }
      // --- End Re-implement Signature Return Type logic ---

      // --- Re-implement Class/Trait detail logic ---
      extendsClassName = ""; // Ensure initialization
      implementsInterfaces = [];
      usesTraits = [];
      if (['class', 'interface', 'trait'].includes(node.kind)) {
          if (node.extends) {
             extendsClassName = node.extends.name || "";
          }
          if (node.implements && Array.isArray(node.implements)) {
             implementsInterfaces = node.implements.map(impl => impl.name || "");
          }
          if (node.body && Array.isArray(node.body)) {
             usesTraits = node.body
                .filter(stmt => stmt.kind === 'usetrait')
                .flatMap(stmt => stmt.traits.map(trait => trait.name || ""));
          }
           this.log(`[AST] Helper: Parsed PHP class details - Extends: ${extendsClassName || 'N/A'}, Implements: ${implementsInterfaces.join(', ') || 'N/A'}, Uses: ${usesTraits.join(', ') || 'N/A'}`);
        }
      // --- End Re-implement Class/Trait detail logic ---

      // --- Re-implement Modifier logic ---
      modifiers = {}; // Ensure initialization
      if (['class', 'interface', 'trait', 'method', 'property', 'classconstant'].includes(node.kind) && node.flags !== undefined) {
          modifiers = {
              isFinal: (node.flags & 1) !== 0 || (node.flags & 4) !== 0, // abstract & final are mutually exclusive, final takes precedence (flag 4) over abstract (flag 1)
              isAbstract: (node.flags & 1) !== 0 && !(node.flags & 4), // Must be abstract (1) and not final (4)
              isStatic: (node.flags & 16) !== 0,
              visibility: (node.flags & 2) !== 0 ? 'public' : ((node.flags & 4) !== 0 ? 'protected' : ((node.flags & 8) !== 0 ? 'private' : 'public')) // Default to public if no flag
              // Note: Visibility flags for PHP are complex (public=2, protected=4, private=8), using simplified logic here
          };
           this.log(`[AST] Helper: Parsed PHP modifiers: ${JSON.stringify(modifiers)}`);
      }
      // --- End Re-implement Modifier logic ---

      // Metadata Consolidation logic
      const finalParameters = signatureParams.map(sigParam => {
        const docParam = docParams.find(dp => dp.name === sigParam.name);
        return {
            name: sigParam.name,
            type: sigParam.type || docParam?.type || "", // Prefer signature type
            description: docParam?.description || "", // Only from DocBlock
            byRef: sigParam.byRef,
            isVariadic: sigParam.isVariadic
        };
      });
      // Add any params found only in DocBlock (e.g., @param $unusedVar)
      docParams.forEach(docParam => {
          if (!finalParameters.some(fp => fp.name === docParam.name)) {
              finalParameters.push({
                  name: docParam.name,
                  type: docParam.type || "",
                  description: docParam.description || "",
                  byRef: false, // Cannot determine from DocBlock only
                  isVariadic: false // Cannot determine from DocBlock only
              });
          }
      });

      const finalReturnType = signatureReturnType || docReturnType?.type || "";
      const finalReturnDescription = docReturnType?.description || "";

      // Assemble the final metadata object using initialized/populated variables
      const chunkMetadata = {
        sourceType: 'ast',
        language: 'php',
        filePath: this.config.filename || "",
        nodeType: node.kind || "",
        nodeName: nodeName || "",
        parentName: parentName || "",
        startLine: startLine,
        endLine: endLine,
        docComment: docComment || "",
        summary: summary || "",
        parameters: finalParameters.length > 0 ? finalParameters : [],
        returnType: finalReturnType,
        returnDescription: finalReturnDescription,
        isDeprecated: isDeprecated,
        modifiers: Object.keys(modifiers).length > 0 ? modifiers : {},
        extendsClass: extendsClassName || "",
        implementsInterfaces: implementsInterfaces.length > 0 ? implementsInterfaces : [],
        usesTraits: usesTraits.length > 0 ? usesTraits : [],
      };

      // --- BEGIN ADDED LOGGING ---
      this.log(`[AST] Helper: Final Chunk Metadata (PHP Node ${nodeName || node.kind}):`, JSON.stringify(chunkMetadata, null, 2));
      // --- END ADDED LOGGING ---

      this.log(`[AST] Helper: Identified PHP Node (Kind: ${node.kind}, Name: ${nodeName}, Parent: ${parentName}, Lines: ${startLine}-${endLine})`);
      if (text.trim()) {
        this.log(`[AST] Helper: Extracted PHP text snippet (length: ${text.length}). Adding to potential chunks.`);
        chunkArray.push({ text, metadata: chunkMetadata });
      }
    } else {
      this.log(`[AST] Helper: Skipping PHP Node (Kind: ${node?.kind}) - No location/offset info.`);
    }
  }

  // New private method to determine feature context from filename/path
  #determineFeatureContext(filename = null) {
    if (!filename || typeof filename !== 'string') {
      this.log("#determineFeatureContext: No filename provided, cannot determine feature context.");
      return "";
    }

    // Normalize path separators for consistency
    const normalizedPath = filename.replace(/\\/g, '/');
    // Remove potential leading slashes for consistent splitting
    const cleanedPath = normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath;
    const parts = cleanedPath.split('/');

    this.log(`#determineFeatureContext: Analyzing path parts: [${parts.join(', ')}]`);

    // Pattern 1: Check for /includes/<feature_name>/...
    const includesIndex = parts.indexOf('includes');
    if (includesIndex !== -1) {
      if (includesIndex + 1 < parts.length) {
        // Check if the next part is not the filename itself (meaning it's a directory)
        if (includesIndex + 2 < parts.length) {
          const featureName = parts[includesIndex + 1];
          this.log(`#determineFeatureContext: Found 'includes' pattern. Feature context: "${featureName}"`);
          return featureName;
        } else {
          // File is directly inside /includes/ (e.g., includes/init.php)
          this.log(`#determineFeatureContext: File directly within 'includes'. Assigning 'core'.`);
          return 'core';
        }
      } else {
        // Edge case: path ends with /includes/
        this.log(`#determineFeatureContext: Path ends with 'includes'. Assigning 'core'.`);
        return 'core';
      }
    }

    // Pattern 2: Check for /assets/src/<feature_name>/...
    const assetsIndex = parts.indexOf('assets');
    if (assetsIndex !== -1 && assetsIndex + 1 < parts.length && parts[assetsIndex + 1] === 'src') {
      // Check if there is a segment *after* 'src'
      if (assetsIndex + 2 < parts.length) {
         // Check if the next part is not the filename itself (meaning it's a directory)
         if (assetsIndex + 3 < parts.length) {
            const featureName = parts[assetsIndex + 2];
            this.log(`#determineFeatureContext: Found 'assets/src' pattern. Feature context: "${featureName}"`);
            return featureName;
         } else {
             // File is directly inside /assets/src/ (e.g., assets/src/main.js)
             this.log(`#determineFeatureContext: File directly within 'assets/src'. Assigning 'core'.`);
             return 'core'; // Assign 'core' for files directly in assets/src
         }
      } else {
          // Edge case: path ends with /assets/src/
          this.log(`#determineFeatureContext: Path ends with 'assets/src'. Assigning 'core'.`);
          return 'core';
      }
    }

    // If neither pattern matched
    this.log(`#determineFeatureContext: No feature pattern matched for path "${normalizedPath}". No feature context.`);
    return "";
  }

  // Main method to split text - now returns Promise<ChunkWithMetadata[]>
  async splitText(documentText) {
    this.log(`splitText: Method entered. Strategy: ${this.#chunkingStrategy}`);
    let chunksWithMetadata /*: ChunkWithMetadata[]*/ = [];

    // Dispatch based on strategy
    if (this.#chunkingStrategy === 'ast-js') {
      chunksWithMetadata = await this.#splitTextWithAST(documentText, 'js');
    } else if (this.#chunkingStrategy === 'ast-php') {
      chunksWithMetadata = await this.#splitTextWithAST(documentText, 'php');
    } else if (this.#chunkingStrategy === 'ast-css') {
      chunksWithMetadata = await this.#splitTextWithAST(documentText, 'css');
    } else { // Default to recursive
      const splitter = this.#getRecursiveSplitter();
      this.log("splitText: Using recursive splitter.");
      const textChunks = await splitter.splitText(documentText);
      // Wrap recursive string chunks into the standard object format
      chunksWithMetadata = textChunks.map(chunk => ({
        text: chunk,
        metadata: {
            sourceType: 'recursive',
            startLine: 0,
            endLine: 0,
            featureContext: this.#featureContext || "",
            filePath: this.config.filename || ""
        }
      }));
    }

    this.log(`splitText: Successfully generated ${chunksWithMetadata.length} chunks with metadata using ${this.#chunkingStrategy} strategy.`);
    const header = this.stringifyHeader(); // Get metadata header string

    if (!header) {
      // Return chunks with metadata as-is if no header
      return chunksWithMetadata.filter(chunkObject => !!chunkObject.text.trim());
    }

    // Prepend header to each non-empty chunk's text property if header exists
    return chunksWithMetadata
      .filter(chunkObject => !!chunkObject.text.trim())
      .map(chunkObject => ({
          ...chunkObject,
          text: `${header}${chunkObject.text}` // Prepend header to text
      }));
  }

  // Helper to get code snippet from start/end positions
  getCodeFromRange(text, start, end) {
    if (start === undefined || end === undefined) return "";
    return text.substring(start, end);
  }

  // Add helper methods for Babel processing (can be placed before #splitTextWithAST or after other helpers)
  getBabelScopeString(path) {
    let scope = 'global';
    try {
      path.findParent((parentPath) => {
        const parentNode = parentPath.node;
        let parentName = 'anonymous';
        if (parentNode.type === 'FunctionDeclaration' || parentNode.type === 'FunctionExpression' || parentNode.type === 'ArrowFunctionExpression') {
          parentName = parentNode.id?.name || (parentNode.key?.name) || (parentNode.type === 'ArrowFunctionExpression' ? 'arrow_func' : 'anonymous_func');
          scope = `function:${parentName} > ${scope}`;
        } else if (parentNode.type === 'ClassDeclaration' || parentNode.type === 'ClassExpression') {
          parentName = parentNode.id?.name || 'anonymous_class';
          scope = `class:${parentName} > ${scope}`;
        } else if (parentNode.type === 'ClassMethod' || parentNode.type === 'ObjectMethod') {
          parentName = parentNode.key?.name || 'anonymous_method';
          scope = `method:${parentName} > ${scope}`;
        }
        // Stop traversal if we hit the Program node (top level)
        return parentPath.isProgram();
      });
    } catch(e) {
      this.log(`[AST Babel Scope] Error determining scope: ${e.message}`);
    }
    return scope.replace(/ > global$/, ''); // Clean up trailing global
  }

  getBabelNodeName(node) {
    if (node.id?.name) return node.id.name; // FunctionDeclaration, ClassDeclaration
    if (node.key?.name) return node.key.name; // ClassMethod, ObjectMethod
    // Could add checks for VariableDeclarator names if needed, but handled by scope
    return null;
  }

  getBabelExtends(node, documentText) {
    if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.superClass) {
        // Babel often represents superclass names simply
        if (node.superClass.type === 'Identifier') {
            return node.superClass.name;
        }
        // Fallback: extract text if it's more complex
        if (node.superClass.start && node.superClass.end) {
             return documentText.substring(node.superClass.start, node.superClass.end);
        }
    }
    return "";
  }

  parseBabelJsDoc(node, documentText) {
    let result = {
        docComment: "", summary: "", parameters: [], 
        returnInfo: { type: "", description: "" }, isDeprecated: false
    };
    if (!node.leadingComments || node.leadingComments.length === 0 || !documentText) return result;

    // Find the last block comment ending right before the node
    let relevantComment = null;
    let minDistance = Infinity;
    for (const comment of node.leadingComments) {
      if (comment.type === 'CommentBlock' && comment.end < node.start) {
         const distance = node.start - comment.end;
         const interveningText = documentText.substring(comment.end, node.start);
         if (interveningText.trim() === '' && distance < minDistance) {
            if (comment.value.startsWith('*')) { // Check if it looks like JSDoc
               relevantComment = comment;
               minDistance = distance;
            }
         }
      }
    }

    if (!relevantComment) return result;

    result.docComment = `/*${relevantComment.value}*/`;
    try {
        const parsedDoc = doctrine.parse(result.docComment, { 
            unwrap: true, sloppy: true, tags: null, lineNumbers: true 
        });
        result.summary = parsedDoc.description || "";
        parsedDoc.tags.forEach(tag => {
            switch (tag.title) {
                case 'param': case 'parameter': case 'arg': case 'argument':
                    result.parameters.push({ name: tag.name || "", type: tag.type ? doctrine.type.stringify(tag.type) : "", description: tag.description || "" });
                    break;
                case 'return': case 'returns':
                    result.returnInfo.type = tag.type ? doctrine.type.stringify(tag.type) : "";
                    result.returnInfo.description = tag.description || "";
                    break;
                case 'deprecated':
                    result.isDeprecated = true;
                    break;
            }
        });
        this.log(`[AST Babel JSDoc] Parsed successfully for node ${this.getBabelNodeName(node)}.`);
    } catch (e) {
        this.log(`\x1b[33m[AST Babel JSDoc] [WARN]\x1b[0m Failed to parse comment: ${e.message}`);
    }
    return result;
  }

  getLineNumber(text, offset) {
    const lines = text.split('\n');
    let lineNumber = 1;
    let currentOffset = 0;
    for (const line of lines) {
      currentOffset += line.length + 1; // +1 for the newline character
      if (currentOffset > offset) {
        return lineNumber;
      }
      lineNumber++;
    }
    return lines.length; // 1-based line number
  }
}

module.exports.TextSplitter = TextSplitter;
