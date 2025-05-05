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
        filename: string | null, // <-- Added: Used to determine language for code splitting
        parseJSXAsSingleChunk: boolean | null // <-- Added: If true, forces recursive splitting for .js/.jsx files (defaults false)
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
        // Check the new config option first
        if (config.parseJSXAsSingleChunk === true) {
          this.log("#setChunkingStrategy: parseJSXAsSingleChunk is true. Using recursive strategy for JS/JSX.");
          return 'recursive';
        } else {
          this.log("#setChunkingStrategy: Using AST strategy for JavaScript/JSX.");
          return 'ast-js';
        }
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
        const jsx = (await import('acorn-jsx')).default; 
        const walk = await import('acorn-walk'); // Need walk again

        // Array to hold comments collected during parsing
        const comments = [];

        // Inject the JSX plugin into Acorn
        const ASTParser = acorn.Parser.extend(jsx());
        const ast = ASTParser.parse(documentText, {
          sourceType: "module",
          ecmaVersion: "latest",
          locations: true,
          ranges: true, // Essential for start/end offsets
          onComment: (isBlock, text, start, end, startLoc, endLoc) => {
              if (isBlock) { 
                  comments.push({ type: 'Block', value: text, start, end, loc: { start: startLoc, end: endLoc } });
              }
          }
        });

        this.log(`[AST] #splitTextWithAST: Successfully parsed JS/JSX AST. Found ${ast.body?.length || 0} top-level nodes. Collected ${comments.length} block comments.`);

        // --- REVISED JS AST TRAVERSAL - Chunk Primary Structures Recursively --- 
        const state = { lastProcessedEndOffset: 0 };
        const visitors = {};

        // Helper to handle JSDoc parsing (copied from previous logic)
        const parseJsDoc = (node, nodeName, nodeType) => {
            let docComment = "";
            let summary = "";
            let parameters = []; 
            let returnInfo = { type: "", description: "" }; 
            let isDeprecated = false;
            let relevantComment = null;
            let minDistance = Infinity;
            for (const comment of comments) {
                if (comment.end < node.start) {
                    const distance = node.start - comment.end;
                    const interveningText = documentText.substring(comment.end, node.start);
                    if (interveningText.trim() === '' && distance < minDistance) {
                        if (comment.value.startsWith('*')) {
                            relevantComment = comment;
                            minDistance = distance;
                        }
                    }
                }
            }
            if (relevantComment) {
                // this.log(`[AST Recurse] Found potential JSDoc comment for ${nodeName || nodeType}`); // Comment out
                // Clean the raw comment value before parsing
                const cleanedValue = relevantComment.value
                    .split('\n')
                    .map(line => line.replace(/^\s*\*?\s?/, '')) // Remove leading whitespace, optional asterisk, optional space
                    .join('\n')
                    .trim(); // Trim start/end whitespace from the final cleaned value
                
                docComment = `/**${cleanedValue}*/`; // Use cleaned value for parsing
                try {
                    const parsedDoc = doctrine.parse(docComment, { unwrap: true, sloppy: true, tags: null, lineNumbers: true });
                    summary = parsedDoc.description || "";
                    parsedDoc.tags.forEach(tag => {
                        switch (tag.title) {
                            case 'param':
                            case 'parameter':
                            case 'arg':
                            case 'argument':
                                parameters.push({ name: tag.name || "", type: tag.type ? doctrine.type.stringify(tag.type) : "", description: tag.description || "" });
                                break;
                            case 'return':
                            case 'returns':
                                returnInfo.type = tag.type ? doctrine.type.stringify(tag.type) : "";
                                returnInfo.description = tag.description || "";
                                break;
                            case 'deprecated':
                                isDeprecated = true;
                                break;
                        }
                    });
                    // this.log(`[AST Recurse] Parsed JSDoc: ${parameters.length} params, ${returnInfo.type ? 'return specified' : 'no return'}`); // Comment out
                } catch (e) {
                    this.log(`\x1b[33m[AST Recurse] [WARN]\x1b[0m Failed to parse JSDoc comment for ${nodeName || nodeType}: ${e.message}`); // Keep WARN
                }
            }
            return { docComment, summary, parameters, returnInfo, isDeprecated };
        };

        // Helper to process a primary node and the gap before it
        const handlePrimaryNode = (node, nodeType, nodeName, scope, extendsClassName = null) => {
            // 1. Handle Gap
            if (node.start > state.lastProcessedEndOffset) {
                const gapText = documentText.substring(state.lastProcessedEndOffset, node.start);
                if (gapText.trim()) {
                     // this.log(`[AST Recurse] Found GAP text (length: ${gapText.length}) before ${nodeType} ${nodeName || ''} at ${node.start}`); // Comment out
                    allPotentialChunks.push({
                        text: gapText,
                        metadata: {
                            sourceType: 'code-segment',
                            language: 'js',
                            filePath: this.config.filename || "",
                            scope: scope, // Scope is determined by the context where the gap occurs
                            startLine: this.#getLineNumber(documentText, state.lastProcessedEndOffset), 
                            endLine: node.loc ? node.loc.start.line -1 : this.#getLineNumber(documentText, node.start), 
                            featureContext: this.#featureContext || ""
                        }
                    });
                }
            }

            // 2. Process Node
            // this.log(`[AST Recurse] Processing PRIMARY Node: ${nodeType} (Name: ${nodeName || 'N/A'}), Scope: ${scope}, Range: ${node.start}-${node.end}`); // Comment out
            const nodeText = documentText.substring(node.start, node.end);
            const jsDocData = parseJsDoc(node, nodeName, nodeType);
            const chunkMetadata = {
                sourceType: 'ast',
                language: 'js',
                filePath: this.config.filename || "",
                nodeType: nodeType,
                nodeName: nodeName || "",
                scope: scope,
                startLine: node.loc ? node.loc.start.line : this.#getLineNumber(documentText, node.start),
                endLine: node.loc ? node.loc.end.line : this.#getLineNumber(documentText, node.end),
                ...jsDocData, // Add parsed JSDoc fields
                modifiers: {}, 
                extendsClass: extendsClassName || "",
                featureContext: this.#featureContext || ""
            };

            if (nodeText.trim()) {
                allPotentialChunks.push({ text: nodeText, metadata: chunkMetadata });
            } else {
                // this.log(`[AST Recurse] Skipping Primary Node ${nodeType} - Extracted text is empty.`); // Comment out
            }

            // 3. Update state
            state.lastProcessedEndOffset = node.end;
        };
        
        // --- Define Visitors --- 
        // We use fullAncestor to easily determine scope, but manually control recursion

        const visitorCallback = (node, st, ancestors, type) => {
            // Determine current scope using ancestors
            let currentScope = 'global';
            for (let i = ancestors.length - 2; i >= 0; i--) {
                const ancestor = ancestors[i];
                let namePart = '', typePart = '';
                if (ancestor.type === 'FunctionDeclaration' || ancestor.type === 'FunctionExpression' || ancestor.type === 'ArrowFunctionExpression') {
                    typePart = 'function';
                    namePart = ancestor.id?.name || (ancestor.type === 'ArrowFunctionExpression' ? 'arrow_func' : 'anonymous_func');
                } else if (ancestor.type === 'ClassDeclaration' || ancestor.type === 'ClassExpression') {
                    typePart = 'class';
                    namePart = ancestor.id?.name || 'anonymous_class';
                } else if (ancestor.type === 'MethodDefinition') {
                    typePart = 'method';
                    namePart = ancestor.key?.name || 'anonymous_method';
                } 
                // Add more scope types if needed
                if (typePart) {
                    currentScope = `${typePart}:${namePart} > ${currentScope}`;
                }
            }

            let isPrimary = false;
            let nodeName = null;
            let actualNodeType = type;
            let extendsClassName = null;
            let processNode = false; // Flag to indicate if we should process this node as primary

            if (type === 'FunctionDeclaration') {
                isPrimary = true;
                processNode = true;
                nodeName = node.id?.name || 'anonymous_function';
            } else if (type === 'ClassDeclaration') {
                isPrimary = true;
                processNode = true;
                nodeName = node.id?.name || 'anonymous_class';
                 if (node.superClass) {
                     extendsClassName = node.superClass.name || documentText.substring(node.superClass.start, node.superClass.end);
                 }
            } else if (type === 'MethodDefinition') {
                 isPrimary = true;
                 processNode = true;
                 nodeName = node.key?.name || 'anonymous_method';
            } else if (type === 'VariableDeclaration') {
                 // Check if its declarators are function/arrow functions
                 const primaryDeclarator = node.declarations.find(decl =>
                    decl.init && (decl.init.type === 'FunctionExpression' || decl.init.type === 'ArrowFunctionExpression')
                 );
                 if (primaryDeclarator) {
                     isPrimary = true;
                     processNode = true;
                     nodeName = primaryDeclarator.id?.name || 'anonymous_variable_function';
                     actualNodeType = primaryDeclarator.init.type; 
                 }
            } else if (type === 'AssignmentExpression') {
                // Check if assigning a function
                if (node.right.type === 'FunctionExpression' || node.right.type === 'ArrowFunctionExpression') {
                    isPrimary = true;
                    processNode = true;
                    // Attempt to get a name from the left side (e.g., identifier, member expression)
                    if (node.left.type === 'Identifier') {
                        nodeName = node.left.name;
                    } else if (node.left.type === 'MemberExpression' && node.left.property.type === 'Identifier') {
                         // Handle cases like obj.prop = function() { ... }
                         // For simplicity, just use the property name. Could traverse node.left fully for obj.prop.subprop etc.
                        nodeName = node.left.property.name;
                    } else {
                        nodeName = 'anonymous_assigned_function';
                    }
                    actualNodeType = node.right.type;
                }
            } else if (type === 'CallExpression') {
                // Check for IIFE pattern: (function(){...})()
                if (node.callee.type === 'FunctionExpression') {
                    isPrimary = true;
                    processNode = true;
                    nodeName = node.callee.id?.name || 'anonymous_iife'; 
                    actualNodeType = type; // Keep as CallExpression, JSDoc likely won't apply directly here
                }
            }

            if (processNode) {
                handlePrimaryNode(node, actualNodeType, nodeName, currentScope, extendsClassName);
                // DO NOT continue walk into children of primary nodes
            } else {
                 // If not processing this node as primary, DO NOTHING here.
                 // walk.fullAncestor will use walk.base to continue traversal into children automatically.
                 // Ensure offset is updated ONLY when a primary node is handled.
                 // The offset is managed within handlePrimaryNode.
                 /*
                 // Old logic - remove manual continuation attempts
                 if (node.start > st.lastProcessedEndOffset) {
                    walk.base[type](node, st, visitorCallback); // Manually continue walk for non-primary nodes
                 } else {
                    walk.base[type](node, st, visitorCallback); // Manually continue walk for non-primary nodes
                 }
                 */
            }
            // NOTE: Descent into children is now implicitly handled by fullAncestor + walk.base
            // for non-primary nodes, and explicitly stopped for primary nodes.
        };

        // Use fullAncestor to get scope, but the callback manually controls recursion depth
        this.log("[AST Recurse] Initiating controlled walk...");
        walk.fullAncestor(ast, visitorCallback, null, state);
        this.log("[AST Recurse] Controlled walk finished.");

        // Handle any trailing code after the last processed primary node/gap
        if (state.lastProcessedEndOffset < documentText.length) {
            const trailingText = documentText.substring(state.lastProcessedEndOffset);
            if (trailingText.trim()) {
                 // this.log(`[AST Recurse] Found TRAILING text (length: ${trailingText.length}) after last processed offset.`); // Comment out
                 allPotentialChunks.push({
                    text: trailingText,
                    metadata: {
                        sourceType: 'code-segment',
                        language: 'js',
                        filePath: this.config.filename || "",
                        scope: 'global', // Assume trailing is global
                        startLine: this.#getLineNumber(documentText, state.lastProcessedEndOffset), 
                        endLine: this.#getLineNumber(documentText, documentText.length), 
                        featureContext: this.#featureContext || ""
                    }
                 });
            }
        }

        this.log(`[AST Recurse] Finished walk and gap analysis. ${allPotentialChunks.length} potential chunks identified.`);
        // --- END REVISED JS AST TRAVERSAL ---

        // (Keep the rest: PHP/CSS blocks, chunk size checking, etc.)

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
          // this.log(`[AST] #splitTextWithAST: Processing PHP AST node ${index + 1}/${ast.children.length} - Kind: ${node.kind}`); // Comment out per-node log

          // --- PHP Hook Detection --- 
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
                  featureContext: this.#featureContext || "",
                  registersHooks: [],
                  triggersHooks: [],
              };

              let hookName = 'unknown_hook'; // Initialize hookName
              const isGfHook = funcName.startsWith('gf_');

              // Determine Hook Name based on function type
              if (isGfHook) {
                if (call.arguments[0]?.kind === 'array' && call.arguments[0]?.items?.length > 0) {
                  // GF hooks use an array [hook_name, form_id] as the first arg
                  hookName = call.arguments[0].items[0]?.value || 'unknown_gf_hook_name';
                  // this.log(`[AST PHP] Detected GF Hook Structure. Extracted Hook Name: ${hookName}`); // Comment out
                } else {
                  hookName = 'unknown_gf_hook_array';
                  this.log(`[AST PHP] [WARN] Detected GF Hook Call (${funcName}) but first argument was not the expected array structure.`);
                }
              } else if ([ 'add_action', 'add_filter', 'do_action', 'apply_filters' ].includes(funcName)) {
                 // Standard WP hooks use a string literal as the first arg
                 hookName = call.arguments[0]?.value || 'unknown_wp_hook_name';
                 // this.log(`[AST PHP] Detected WP Hook Structure. Extracted Hook Name: ${hookName}`); // Comment out
              }

              // --- Process Hook Registration (add_action, add_filter, gf_do_action, gf_apply_filters) --- 
              // Note: Using startsWith('add_') or startsWith('gf_') for broader matching
              if (funcName.startsWith('add_') || funcName === 'gf_apply_filters' || funcName === 'gf_do_action') {
                  isHookCall = true;
                  hookMetadata.nodeType = isGfHook ? 'gfHookRegistration' : 'wpHookRegistration';
                  // Use the correctly extracted hookName from above
                  
                  // Callback is arg 1 for WP add_, arg 1 for GF filter/action (after array)
                  const callbackArgIndex = 1; 
                  const priorityArgIndex = 2;
                  const acceptedArgsArgIndex = 3;
                  
                  const callbackNode = call.arguments[callbackArgIndex];
                  const callback = callbackNode ? this.#getCodeFromRange(documentText, callbackNode.loc?.start?.offset, callbackNode.loc?.end?.offset) : 'unknown_callback';
                  const priority = call.arguments[priorityArgIndex]?.value ?? 10; // Use nullish coalescing for default
                  const acceptedArgs = call.arguments[acceptedArgsArgIndex]?.value ?? 1;

                  let hookType = '';
                  if (funcName.includes('action')) hookType = 'action';
                  else if (funcName.includes('filter')) hookType = 'filter';
                  
                  hookMetadata.registersHooks.push({ 
                      hookName, 
                      callback, 
                      type: hookType, 
                      priority, 
                      acceptedArgs 
                  });
                  // this.log(`[AST PHP] Detected Hook Registration: ${funcName}('${hookName}')`); // Comment out
                  allPotentialChunks.push({ text: nodeText, metadata: hookMetadata });
              
              // --- Process Hook Trigger (do_action, apply_filters) --- 
              } else if (['do_action', 'apply_filters'].includes(funcName)) {
                  isHookCall = true;
                  hookMetadata.nodeType = 'wpHookTrigger';
                  // Use the correctly extracted hookName (already derived above)
                  hookMetadata.triggersHooks.push({ 
                      hookName, 
                      type: funcName === 'do_action' ? 'action' : 'filter'
                  });
                  // this.log(`[AST PHP] Detected Hook Trigger: ${funcName}('${hookName}')`); // Comment out
                  allPotentialChunks.push({ text: nodeText, metadata: hookMetadata });
              }
            }
          }

          if (isHookCall) return; // Skip generic processing if it was a hook call
          // --- END HOOK DETECTION --- 

          // Check for Class or Trait context first
          if (node.kind === 'class' || node.kind === 'trait') {
            const parentClassName = node.name?.name || (typeof node.name === 'string' ? node.name : null);
            // this.log(`[AST] #splitTextWithAST: Entering PHP ${node.kind} context: ${parentClassName}`); // Comment out
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
      } else if (language === 'css') {
        this.log("[AST] #splitTextWithAST: Attempting to parse CSS with PostCSS...");
        const ast = postcss.parse(documentText, { from: this.config.filename || 'unknown.css' });
        this.log(`[AST] #splitTextWithAST: Successfully parsed CSS AST. Found ${ast.nodes?.length || 0} top-level nodes.`);

        ast.walk(node => {
          // Process Rules (e.g., .class { ... })
          if (node.type === 'rule') {
            // this.log(`[AST] #splitTextWithAST: Processing CSS Rule: ${node.selector}`); // Comment out
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
              // this.log(`[AST] Helper: Final Chunk Metadata (CSS Rule ${metadata.selector}):`, JSON.stringify(metadata, null, 2)); // Comment out
              // --- END ADDED LOGGING ---
              if (text.trim()) {
                allPotentialChunks.push({ text, metadata });
              }
            } else {
                 // this.log(`[AST] Helper: Skipping CSS Rule (Selector: ${node.selector}) - No source location info.`); // Comment out
            }
          }
          // Process At-Rules (e.g., @media { ... })
          else if (node.type === 'atrule') {
            // this.log(`[AST] #splitTextWithAST: Processing CSS AtRule: @${node.name} ${node.params}`); // Comment out
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
              // this.log(`[AST] Helper: Final Chunk Metadata (CSS AtRule @${metadata.atRuleName}):`, JSON.stringify(metadata, null, 2)); // Comment out
              // --- END ADDED LOGGING ---
              if (text.trim()) {
                allPotentialChunks.push({ text, metadata });
              }
            } else {
                 // this.log(`[AST] Helper: Skipping CSS AtRule (@${node.name}) - No source location info.`); // Comment out
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
            // this.log(`[AST] #splitTextWithAST: Skipping empty or whitespace-only potential chunk.`); // Comment out
            continue;
        }

        // this.log(`[AST] #splitTextWithAST: Processing potential chunk (Type: ${potentialChunk.metadata.nodeType || potentialChunk.metadata.sourceType}, Scope: ${potentialChunk.metadata.scope}, Lines: ${potentialChunk.metadata.startLine}-${potentialChunk.metadata.endLine}), length ${potentialChunk.text.length}.`); // Comment out verbose chunk details
        if (potentialChunk.text.length > chunkSize) {
          // Keep WARN log for large chunks
          this.log(`\x1b[33m[AST] [WARN]\x1b[0m Chunk (Type: ${potentialChunk.metadata.nodeType || potentialChunk.metadata.sourceType}, Scope: ${potentialChunk.metadata.scope}, Lines: ${potentialChunk.metadata.startLine}-${potentialChunk.metadata.endLine}) for ${language} exceeds chunkSize (${potentialChunk.text.length}/${chunkSize}). Falling back to recursive splitting for this specific chunk.`);
          const recursiveSplitter = this.#getRecursiveSplitter();
          const subChunks = await recursiveSplitter.splitText(potentialChunk.text);
          // this.log(`[AST] #splitTextWithAST: Recursive fallback generated ${subChunks.length} sub-chunks.`); // Comment out sub-chunk count
          // Wrap sub-chunks in metadata structure
          subChunks.forEach(subChunkText => {
            if (subChunkText.trim()) { // Ensure sub-chunk is not just whitespace
              finalChunks.push({
                text: subChunkText,
                metadata: {
                  ...potentialChunk.metadata, // Inherit original metadata (like scope, nodeType etc.)
                  featureContext: this.#featureContext, // Ensure feature context
                  sourceType: 'ast-recursive-fallback', // Mark as recursive fallback
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
          // this.log(`[AST] #splitTextWithAST: Potential chunk (Type: ${potentialChunk.metadata.nodeType || potentialChunk.metadata.sourceType}, Scope: ${potentialChunk.metadata.scope}, Lines: ${potentialChunk.metadata.startLine}-${potentialChunk.metadata.endLine}) is within size limit. Adding directly.`); // Comment out
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
        const leadingComment = node.leadingComments[node.leadingComments.length - 1]; // Use the last comment block before the node
        if (leadingComment.type === 'CommentBlock' || leadingComment.type === 'Block') { // Check comment type
          docComment = leadingComment.value;
          try {
            const parsedDoc = doctrine.parse( `/**${docComment}*/`, { unwrap: true, sloppy: true });
             summary = parsedDoc.description || "";
             isDeprecated = parsedDoc.tags.some(tag => tag.title === 'deprecated');
             docParams = parsedDoc.tags.filter(tag => ['param', 'parameter', 'arg', 'argument'].includes(tag.title)).map(tag => ({
               name: tag.name || "",
               type: tag.type ? doctrine.type.stringify(tag.type) : "",
               description: tag.description || ""
             }));
             const returnTag = parsedDoc.tags.find(tag => ['return', 'returns'].includes(tag.title));
             if (returnTag) {
                docReturnType = {
                  type: returnTag.type ? doctrine.type.stringify(returnTag.type) : "",
                  description: returnTag.description || ""
                };
             }
             // this.log(`[AST] Helper: Parsed DocBlock for ${nodeName || node.kind}. Summary: ${summary ? 'Yes' : 'No'}, Params: ${docParams.length}, Returns: ${docReturnType ? 'Yes' : 'No'}`); // Comment out
          } catch (e) {
             this.log(`\x1b[33m[AST] [WARN]\x1b[0m Failed to parse DocBlock for ${nodeName || node.kind}: ${e.message}`); // Keep WARN
          }
        }
      }

      // Existing Signature Parameter logic
      if (node.params && Array.isArray(node.params)) {
        signatureParams = node.params.map(param => ({
          name: param.name?.name || "", // Get name safely
          type: param.type ? (typeof param.type === 'string' ? param.type : (param.type?.name || "")) : "", // Get type safely
          isOptional: param.nullable || param.value !== null, // Check if nullable or has default value
          defaultValue: param.value ? this.#getCodeFromRange(documentText, param.value.loc?.start?.offset, param.value.loc?.end?.offset) : null
        }));
      }

      // Existing Signature Return Type logic
      if (node.returnType) {
        signatureReturnType = typeof node.returnType === 'string' ? node.returnType : (node.returnType.name || "");
      }

      // Existing Class/Trait detail logic
      if (['class', 'interface', 'trait'].includes(node.kind)) {
        if (node.extends) {
          extendsClassName = node.extends.name || "";
        }
        if (node.implements && Array.isArray(node.implements)) {
          implementsInterfaces = node.implements.map(impl => impl.name || "");
        }
         if (node.kind === 'class' || node.kind === 'trait') { // Traits can use other traits
             const useGroup = node.body?.find(item => item.kind === 'usegroup');
             if (useGroup && useGroup.items) {
                 usesTraits = useGroup.items.map(item => item.name?.name || "");
             }
         }
      }

      // Existing Modifier logic
      if (['class', 'interface', 'trait', 'method', 'property', 'classconstant'].includes(node.kind) && node.flags !== undefined) {
        modifiers.isStatic = (node.flags & 1) !== 0; // FLAG_STATIC
        modifiers.isAbstract = (node.flags & 2) !== 0; // FLAG_ABSTRACT
        modifiers.isFinal = (node.flags & 4) !== 0; // FLAG_FINAL
        modifiers.visibility = (node.flags & 16) ? 'public' : ((node.flags & 32) ? 'protected' : ((node.flags & 64) ? 'private' : 'public')); // Simplified visibility check
      }
       // Add async for JS methods/functions if applicable (though flags are PHP specific)
       // In Acorn AST, async property is directly on FunctionDeclaration/MethodDefinition etc.
       if (node.async === true) { // Check JS async property
           modifiers.isAsync = true;
       }


      // Existing Metadata Consolidation logic
      const finalParameters = signatureParams.map(sigParam => {
        const docParam = docParams.find(dp => dp.name === sigParam.name);
        return {
          name: sigParam.name,
          type: sigParam.type || docParam?.type || "",
          description: docParam?.description || "",
          isOptional: sigParam.isOptional,
          defaultValue: sigParam.defaultValue
        };
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
        parentName: parentName || "", // Name of the parent class/trait if applicable
        startLine: startLine,
        endLine: endLine,
        featureContext: this.#featureContext || "", // Add feature context
        // --- Start: Adding specific metadata ---
        summary: summary,
        parameters: finalParameters, // Array of { name, type, description, isOptional, defaultValue }
        returnType: finalReturnType,
        returnDescription: finalReturnDescription,
        isDeprecated: isDeprecated,
        modifiers: modifiers, // Object like { isStatic: bool, visibility: 'public'|'protected'|'private', etc. }
        extendsClass: extendsClassName, // For classes
        implementsInterfaces: implementsInterfaces, // For classes/interfaces
        usesTraits: usesTraits, // For classes/traits
        registersHooks: node.registersHooks || [], // Add from hook detection if present
        triggersHooks: node.triggersHooks || [], // Add from hook detection if present
        // --- End: Adding specific metadata ---
      };

      // --- BEGIN ADDED LOGGING ---
      // this.log(`[AST] Helper: Final Chunk Metadata (PHP ${chunkMetadata.nodeType} ${chunkMetadata.nodeName || ''}):`, JSON.stringify(chunkMetadata, (key, value) => typeof value === 'bigint' ? value.toString() : value, 2)); // Comment out detailed metadata log
      // --- END ADDED LOGGING ---

      if (text.trim()) {
        chunkArray.push({ text, metadata: chunkMetadata });
      } else {
         // this.log(`[AST] Helper: Skipping PHP Node ${chunkMetadata.nodeType} - Extracted text is empty.`); // Comment out
      }
    } else {
       // this.log(`[AST] Helper: Skipping PHP Node - No location info.`); // Comment out
    }
  }


  // Helper to determine a "feature" context based on file path patterns
  #determineFeatureContext(filename) {
    if (!filename) {
      this.log("#determineFeatureContext: No filename provided. No feature context.");
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
          this.log(`#determineFeatureContext: Found 'includes' pattern. Feature context: \"${featureName}\"`);
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
          this.log(`#determineFeatureContext: Found 'assets/src' pattern. Feature context: \"${featureName}\"`);
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

  /**
   * Splits the input document text into chunks based on the strategy determined during construction.
   * @param {string} documentText - The text content of the document to split.
   * @returns {Promise<ChunkWithMetadata[] | string[]>} - An array of chunk strings or ChunkWithMetadata objects.
   */
  async splitText(documentText) {
    this.log(`splitText: Starting split process with strategy: ${this.#chunkingStrategy}`);
    
    if (this.#chunkingStrategy.startsWith('ast-')) {
      const language = this.#chunkingStrategy.split('-')[1]; // 'js', 'php', or 'css'
      try {
        // #splitTextWithAST now returns Promise<ChunkWithMetadata[]>
        const chunksWithMetadata = await this.#splitTextWithAST(documentText, language);
        this.log(`splitText: AST splitting for ${language} completed. Got ${chunksWithMetadata.length} chunks.`);
        return chunksWithMetadata; // Return the array of { text, metadata } objects
      } catch (error) {
        this.log(`\x1b[31m[ERROR]\x1b[0m splitText: AST splitting failed for ${language}. Falling back to recursive. Error: ${error.message}`);
        // Fallback to recursive if AST fails catastrophically (should be handled internally too, but belt-and-suspenders)
        const recursiveSplitter = this.#getRecursiveSplitter();
        const textChunks = await recursiveSplitter.splitText(documentText);
         // Wrap into ChunkWithMetadata for consistency? Or let Lance handle string[]?
         // For now, let's wrap it to match the expected output type potentially.
         return textChunks.map(chunk => ({
           text: chunk,
           metadata: { 
             sourceType: 'recursive-fallback', 
             featureContext: this.#featureContext || "",
             filePath: this.config.filename || "" 
           }
         }));
      }
    } else {
      // Default to recursive splitting
      this.log(`splitText: Using recursive splitting strategy.`);
      const recursiveSplitter = this.#getRecursiveSplitter();
      const textChunks = await recursiveSplitter.splitText(documentText);
       this.log(`splitText: Recursive splitting completed. Got ${textChunks.length} chunks.`);
       // Wrap into ChunkWithMetadata for consistency
       const header = this.stringifyHeader();
       return textChunks
         .filter(chunk => !!chunk.trim())
         .map(chunk => ({
           text: header ? `${header}${chunk}` : chunk, // Prepend header if exists
           metadata: { 
             sourceType: 'recursive', 
             featureContext: this.#featureContext || "",
             filePath: this.config.filename || "" 
            }
         }));
    }
  }
}

module.exports.TextSplitter = TextSplitter;
