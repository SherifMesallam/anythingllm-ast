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

      if (fileExtension === '.js' || fileExtension === '.jsx') {
        this.log("#setChunkingStrategy: Using AST strategy for JavaScript/JSX.");
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

  // Core AST splitting logic - now returns Promise<ChunkWithMetadata[]>
  async #splitTextWithAST(documentText, language) {
    this.log(`[AST] #splitTextWithAST: Starting AST splitting for ${language}.`);
    // Final array will hold ChunkWithMetadata objects
    let finalChunks /*: ChunkWithMetadata[]*/ = [];
    // Use the chunkSize determined during construction, don't recalculate with hardcoded limit
    const chunkSize = this.config?.chunkSize || 1000; // Use stored config, fallback just in case

    try {
      // Intermediate array holds { text: string, metadata: ChunkMetadata } before size check
      let allPotentialChunks = [];
      let lastProcessedEndOffset = 0;

      if (language === 'js') {
        this.log("[AST] #splitTextWithAST: Attempting to parse JavaScript/JSX...");
        const acorn = await import('acorn');
        const jsx = (await import('acorn-jsx')).default; // Import jsx plugin
        const walk = await import('acorn-walk'); // <-- Re-import acorn-walk

        // Inject the JSX plugin into Acorn
        const ASTParser = acorn.Parser.extend(jsx());
        const ast = ASTParser.parse(documentText, {
          sourceType: "module",
          ecmaVersion: "latest",
          locations: true,
          ranges: true // Essential for start/end offsets
        });

        this.log(`[AST] #splitTextWithAST: Successfully parsed JS/JSX AST. Found ${ast.body?.length || 0} top-level nodes.`);

        // --- REVISED JS AST TRAVERSAL - Using acorn-walk for full coverage + scope ---
        this.log("[AST Walk] Starting AST walk for full coverage...");

        // Define visitor functions
        const visitors = {
            // We'll add visitors for specific node types here
            // Example: FunctionDeclaration, ClassDeclaration, VariableDeclaration, etc.
            // The base visitor will handle traversing into children
        };

        // Define the walker function to handle gaps and node processing
        const processNodeAndGaps = (node, state, type) => {
            // 1. Handle Gap before the node
            if (node.start > state.lastProcessedEndOffset) {
                const gapText = documentText.substring(state.lastProcessedEndOffset, node.start);
                if (gapText.trim()) {
                     this.log(`[AST Walk] Found GAP text (length: ${gapText.length}) before ${type} at ${node.start}`);
                    allPotentialChunks.push({
                        text: gapText,
                        metadata: {
                            sourceType: 'code-segment',
                            language: 'js',
                            filePath: this.config.filename || "",
                            scope: state.currentScope || 'global', // Use scope from state
                            startLine: this.#getLineNumber(documentText, state.lastProcessedEndOffset), // Approximate line number
                            endLine: node.loc ? node.loc.start.line -1 : this.#getLineNumber(documentText, node.start), // Approximate
                            featureContext: this.#featureContext || ""
                        }
                    });
                }
                // Update offset even if gap was whitespace
                state.lastProcessedEndOffset = node.start;
            }

            // 2. Process the Node itself
            const nodeText = documentText.substring(node.start, node.end);
            let chunkMetadata = {}; // Initialize metadata object
            let isPrimaryStructure = false;

            // Determine if it's a primary structure we want detailed metadata for
            if (type === 'FunctionDeclaration' || type === 'ClassDeclaration' || type === 'MethodDefinition' || 
                (type === 'VariableDeclarator' && node.init && (node.init.type === 'FunctionExpression' || node.init.type === 'ArrowFunctionExpression')))
            {
                isPrimaryStructure = true;
            }

            if (isPrimaryStructure) {
                 this.log(`[AST Walk] Processing PRIMARY Node: ${type} (Name: ${node.id?.name || node.key?.name || 'N/A'}), Scope: ${state.currentScope || 'global'}, Range: ${node.start}-${node.end}`);
                let nodeName = null;
                let actualNodeType = type;
                let extendsClassName = null;

                // Extract Name and specific type details
                if (type === 'FunctionDeclaration') {
                    nodeName = node.id?.name || 'anonymous_function';
                } else if (type === 'ClassDeclaration') {
                    nodeName = node.id?.name || 'anonymous_class';
                    if (node.superClass) {
                        extendsClassName = node.superClass.name || documentText.substring(node.superClass.start, node.superClass.end);
                    }
                } else if (type === 'MethodDefinition') {
                    nodeName = node.key?.name || 'anonymous_method';
                    // Modifiers like static, async could be extracted from `node` properties if needed
                } else if (type === 'VariableDeclarator') { // Must be the function case due to isPrimaryStructure check
                    nodeName = node.id?.name || 'anonymous_variable_function';
                    actualNodeType = node.init.type;
                }

                chunkMetadata = {
                    sourceType: 'ast',
                    language: 'js',
                    filePath: this.config.filename || "",
                    nodeType: actualNodeType,
                    nodeName: nodeName || "",
                    scope: state.currentScope || 'global',
                    startLine: node.loc ? node.loc.start.line : this.#getLineNumber(documentText, node.start),
                    endLine: node.loc ? node.loc.end.line : this.#getLineNumber(documentText, node.end),
                    // JSDoc/detailed metadata fields - initialized empty for now
                    docComment: "",
                    summary: "",
                    parameters: [],
                    returnType: "",
                    returnDescription: "",
                    isDeprecated: false,
                    modifiers: {}, // TODO: Populate if needed
                    extendsClass: extendsClassName || "",
                    featureContext: this.#featureContext || ""
                };

            } else {
                // Handle other node types as generic code segments
                 this.log(`[AST Walk] Processing OTHER Node: ${type}, Scope: ${state.currentScope || 'global'}, Range: ${node.start}-${node.end}`);
                 chunkMetadata = {
                     sourceType: 'code-segment',
                     language: 'js',
                     filePath: this.config.filename || "",
                     nodeType: type,
                     nodeName: null, // Not applicable or generic
                     scope: state.currentScope || 'global',
                     startLine: node.loc ? node.loc.start.line : this.#getLineNumber(documentText, node.start),
                     endLine: node.loc ? node.loc.end.line : this.#getLineNumber(documentText, node.end),
                     featureContext: this.#featureContext || ""
                 };
            }

            // Add the created chunk to potential chunks if text is not empty
            if (nodeText.trim()) {
                 allPotentialChunks.push({ text: nodeText, metadata: chunkMetadata });
            } else {
                 this.log(`[AST Walk] Skipping Node ${type} - Extracted text is empty.`);
            }
            // --- Node Processing Logic END ---

            // 3. Update last processed offset to the end of the current node
            state.lastProcessedEndOffset = node.end;

            // 4. Define the next state for children (Update scope if needed)
            let nextState = { ...state };
            let isScopeDefiningNode = false;
             if (type === 'FunctionDeclaration' || type === 'FunctionExpression' || type === 'ArrowFunctionExpression') {
                 const funcName = node.id?.name || (type === 'ArrowFunctionExpression' ? 'arrow_func' : 'anonymous_func');
                 nextState.currentScope = `${state.currentScope || 'global'} > function:${funcName}`;
                 isScopeDefiningNode = true;
             } else if (type === 'ClassDeclaration' || type === 'ClassExpression') {
                 const className = node.id?.name || 'anonymous_class';
                 nextState.currentScope = `${state.currentScope || 'global'} > class:${className}`;
                 isScopeDefiningNode = true;
             } else if (type === 'MethodDefinition') {
                 const methodName = node.key?.name || 'anonymous_method';
                 // Scope should already be inside a class here
                 nextState.currentScope = `${state.currentScope || 'global'} > method:${methodName}`;
                 isScopeDefiningNode = true;
             }

            // 5. Continue walk: Call base visitor for the node type to process children
            // Pass the potentially updated state (nextState)
            walk.base[type](node, nextState, processNodeAndGaps); // Essential: Use the base visitor
        };


        // Start the walk from the root AST node
        this.log("[AST Walk] Initiating recursive walk...");
        walk.recursive(ast, { lastProcessedEndOffset: 0, currentScope: 'global' }, processNodeAndGaps);
        this.log("[AST Walk] Recursive walk finished.");

        // Handle any trailing code after the last processed node
        if (lastProcessedEndOffset < documentText.length) {
            const trailingText = documentText.substring(lastProcessedEndOffset);
            if (trailingText.trim()) {
                 this.log(`[AST Walk] Found TRAILING text (length: ${trailingText.length}) after last node.`);
                 allPotentialChunks.push({
                    text: trailingText,
                    metadata: {
                        sourceType: 'code-segment',
                        language: 'js',
                        filePath: this.config.filename || "",
                        scope: 'global', // Trailing code is likely global scope
                        startLine: this.#getLineNumber(documentText, lastProcessedEndOffset), // Approximate
                        endLine: this.#getLineNumber(documentText, documentText.length), // Approximate
                        featureContext: this.#featureContext || ""
                    }
                 });
            }
        }

        this.log(`[AST Walk] Finished walk and gap analysis. ${allPotentialChunks.length} potential chunks identified (including gaps and all nodes).`);
        // --- END REVISED JS AST TRAVERSAL ---

        // The rest of the logic (checking chunk sizes, recursive fallback for large chunks)
        // will now operate on `allPotentialChunks` instead of `astNodesToChunk`

        // (Keep the existing PHP and CSS blocks below)

      } else if (language === 'php') {
        this.log("[AST] #splitTextWithAST: Attempting to parse PHP...");
        const { Engine } = await import('php-parser');
        const parser = new Engine({
          parser: { locations: true, extractDoc: true },
          ast: { withPositions: true },
        });
        const ast = parser.parseCode(documentText);
        this.log(`[AST] #splitTextWithAST: Successfully parsed PHP AST. Found ${ast.children?.length || 0} top-level nodes.`);

        ast.children.forEach((node, index) => {
          this.log(`[AST] #splitTextWithAST: Processing PHP AST node ${index + 1}/${ast.children.length} - Kind: ${node.kind}`);

          // --- BEGIN HOOK DETECTION --- 
          let isHookCall = false;
          if (node.kind === 'expressionstatement' && node.expression.kind === 'call') {
            const call = node.expression;
            if (call.what.kind === 'name') {
              const funcName = call.what.name;
              const nodeStartLine = node.loc?.start?.line || null;
              const nodeEndLine = node.loc?.end?.line || null;
              const nodeText = this.#getCodeFromRange(documentText, node.loc?.start?.offset, node.loc?.end?.offset);
              let hookMetadata = {
                  sourceType: 'ast',
                  language: 'php',
                  filePath: this.config.filename || "",
                  startLine: nodeStartLine,
                  endLine: nodeEndLine,
                  featureContext: this.#featureContext || "", // Add feature context
                  registersHooks: [], // Initialize as empty array
                  triggersHooks: [], // Initialize as empty array
              };

              if (['add_action', 'add_filter'].includes(funcName)) {
                  isHookCall = true;
                  hookMetadata.nodeType = 'hookRegistration';
                  const hookName = call.arguments[0]?.value || 'unknown_hook'; // Arg 0: Hook name (string literal)
                  // Use #getCodeFromRange for the callback argument node
                  const callbackNode = call.arguments[1];
                  const callback = callbackNode ? this.#getCodeFromRange(documentText, callbackNode.loc?.start?.offset, callbackNode.loc?.end?.offset) : 'unknown_callback';
                  const priority = call.arguments[2]?.value || 10; // Arg 2: Priority
                  const acceptedArgs = call.arguments[3]?.value || 1; // Arg 3: Accepted Args
                  hookMetadata.registersHooks.push({ 
                      hookName, 
                      callback, 
                      type: funcName === 'add_action' ? 'action' : 'filter', 
                      priority, 
                      acceptedArgs 
                  });
                  this.log(`[AST] Detected Hook Registration: ${funcName}('${hookName}')`);
                  allPotentialChunks.push({ text: nodeText, metadata: hookMetadata });
              } else if (['do_action', 'apply_filters'].includes(funcName)) {
                  isHookCall = true;
                  hookMetadata.nodeType = 'hookTrigger';
                  const hookName = call.arguments[0]?.value || 'unknown_hook'; // Arg 0: Hook name
                   hookMetadata.triggersHooks.push({ 
                      hookName, 
                      type: funcName === 'do_action' ? 'action' : 'filter'
                  });
                  this.log(`[AST] Detected Hook Trigger: ${funcName}('${hookName}')`);
                  allPotentialChunks.push({ text: nodeText, metadata: hookMetadata });
              }
            }
          }

          if (isHookCall) return; // Skip generic processing if it was a hook call
          // --- END HOOK DETECTION --- 

          // Check for Class or Trait context first
          if (node.kind === 'class' || node.kind === 'trait') {
            const parentClassName = node.name?.name || (typeof node.name === 'string' ? node.name : null);
            this.log(`[AST] #splitTextWithAST: Entering PHP ${node.kind} context: ${parentClassName}`);
            // Add the class/trait definition itself
            this.#addPhpNodeToChunks(node, documentText, allPotentialChunks, null);

            // Iterate through body for methods
            if (node.body) {
              node.body.forEach(bodyNode => {
                if (bodyNode.kind === 'method') {
                  this.#addPhpNodeToChunks(bodyNode, documentText, allPotentialChunks, parentClassName);
                }
                 // Can add handling for properties (propertystatement) if needed
              });
            }
             // After processing class body, continue to next top-level node
            return; // Skips the generic processing below for this class/trait node
          }

          // Process other top-level nodes (functions, namespaces, statements)
          this.#addPhpNodeToChunks(node, documentText, allPotentialChunks, null);
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
                allPotentialChunks.push({ text, metadata });
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
                allPotentialChunks.push({ text, metadata });
              }
            } else {
                 this.log(`[AST] Helper: Skipping CSS AtRule (@${node.name}) - No source location info.`);
            }
          }
          // We are not iterating Declarations (prop: value) individually for now
          // Add other node types like comments if needed later
        });
      }

      this.log(`[AST] #splitTextWithAST: Processing ${allPotentialChunks.length} potential chunks (incl. segments) against chunkSize: ${chunkSize}`);

      // Process the gathered allPotentialChunks
      for (const potentialChunk of allPotentialChunks) {
        // Check if text exists and is not just whitespace before processing
        if (!potentialChunk.text || !potentialChunk.text.trim()) {
            this.log(`[AST] #splitTextWithAST: Skipping empty or whitespace-only potential chunk.`);
            continue;
        }

        this.log(`[AST] #splitTextWithAST: Processing potential chunk (Type: ${potentialChunk.metadata.nodeType || potentialChunk.metadata.sourceType}, Scope: ${potentialChunk.metadata.scope}, Lines: ${potentialChunk.metadata.startLine}-${potentialChunk.metadata.endLine}), length ${potentialChunk.text.length}.`);
        if (potentialChunk.text.length > chunkSize) {
          // Determine a more specific fallback type based on the original chunk's sourceType
          const fallbackSourceType = potentialChunk.metadata.sourceType === 'code-segment'
              ? 'code-segment-recursive-fallback'
              : 'ast-recursive-fallback'; // Assume others are AST nodes initially

          this.log(`\x1b[33m[AST] [WARN]\x1b[0m Chunk (Type: ${potentialChunk.metadata.nodeType || potentialChunk.metadata.sourceType}, Scope: ${potentialChunk.metadata.scope}, Lines: ${potentialChunk.metadata.startLine}-${potentialChunk.metadata.endLine}) for ${language} exceeds chunkSize (${potentialChunk.text.length}/${chunkSize}). Falling back to recursive splitting for this specific chunk.`);
          const recursiveSplitter = this.#getRecursiveSplitter();
          const subChunks = await recursiveSplitter.splitText(potentialChunk.text);
          this.log(`[AST] #splitTextWithAST: Recursive fallback generated ${subChunks.length} sub-chunks.`);
          // Wrap sub-chunks in metadata structure
          subChunks.forEach(subChunkText => {
            if (subChunkText.trim()) { // Ensure sub-chunk is not just whitespace
              finalChunks.push({
                text: subChunkText,
                metadata: {
                  ...potentialChunk.metadata, // Inherit original metadata (like scope, nodeType etc.)
                  featureContext: this.#featureContext, // Ensure feature context
                  sourceType: fallbackSourceType, // Mark as recursive fallback
                  isSubChunk: true, // Mark as sub-chunk
                  // Overwrite line numbers as they are now relative to the sub-chunk
                  startLine: 0,
                  endLine: 0,
                  // Keep original nodeType, nodeName, scope etc. from potentialChunk.metadata
                }
              });
            }
          });
        } else {
          this.log(`[AST] #splitTextWithAST: Potential chunk (Type: ${potentialChunk.metadata.nodeType || potentialChunk.metadata.sourceType}, Scope: ${potentialChunk.metadata.scope}, Lines: ${potentialChunk.metadata.startLine}-${potentialChunk.metadata.endLine}) is within size limit. Adding directly.`);
          // Add feature context to the existing metadata before pushing
          potentialChunk.metadata.featureContext = this.#featureContext;
           // Add filePath
           potentialChunk.metadata.filePath = this.config.filename || "";
          finalChunks.push(potentialChunk); // Push the whole { text, metadata } object
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

  // Helper to get approximate line number from character offset
  #getLineNumber(text, offset) {
      if (offset < 0 || offset > text.length) return 0;
      // Count newline characters before the offset
      const lines = text.substring(0, offset).split('\\n');
      return lines.length; // 1-based line number
  }

  // Helper to get code snippet from start/end positions
  #getCodeFromRange(text, start, end) {
    if (start === undefined || end === undefined) return "";
    return text.substring(start, end);
  }

  // Helper to add PHP node chunk with metadata
  #addPhpNodeToChunks(node, documentText, chunkArray, parentName = null) {
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

      // Existing DocBlock Parsing logic
      if (node.leadingComments && node.leadingComments.length > 0) {
        // ... (rest of DocBlock parsing, assigning to initialized variables) ...
      }

      // Existing Signature Parameter logic
      if (node.params && Array.isArray(node.params)) {
        // ... (assigns to initialized signatureParams) ...
      }

      // Existing Signature Return Type logic
      if (node.returnType) {
        // ... (assigns to initialized signatureReturnType) ...
      }

      // Existing Class/Trait detail logic
      if (['class', 'interface', 'trait'].includes(node.kind)) {
        // ... (assigns to initialized extendsClassName, implementsInterfaces, usesTraits) ...
      }

      // Existing Modifier logic
      if (['class', 'interface', 'trait', 'method', 'property', 'classconstant'].includes(node.kind) && node.flags !== undefined) {
        // ... (populates initialized modifiers object) ...
      }

      // Existing Metadata Consolidation logic
      const finalParameters = signatureParams.map(sigParam => {
        // ... (uses initialized variables) ...
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

  // Helper to add CSS node chunk with metadata
  #addCssNodeToChunks(node, documentText, chunkArray) {
     // ... rest of #addCssNodeToChunks logic remains unchanged ...
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
}

module.exports.TextSplitter = TextSplitter;
