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
        this.log("[AST] #splitTextWithAST: Attempting to parse JavaScript...");
        const acorn = await import('acorn');
        const walk = await import('acorn-walk');

        // Use acorn-walk for easier traversal, especially for finding methods within classes
        const ast = acorn.parse(documentText, {
          sourceType: "module",
          ecmaVersion: "latest",
          locations: true,
          ranges: true // Required by some walkers or for easier text extraction
        });

        this.log(`[AST] #splitTextWithAST: Successfully parsed JS AST. Found ${ast.body?.length || 0} top-level nodes.`);

        // Use acorn-walk to visit relevant nodes
        walk.simple(ast, {
          // Top-level functions, classes, variables
          FunctionDeclaration: (node) => {
            this.#addJsNodeToChunks(node, documentText, astNodesToChunk, null);
          },
          ClassDeclaration: (node) => {
            const className = node.id?.name || null;
            // Add the class definition itself as a chunk
            this.#addJsNodeToChunks(node, documentText, astNodesToChunk, null);

            // Walk the class body for methods
            if (node.body && node.body.body) {
              node.body.body.forEach(classElement => {
                if (classElement.type === 'MethodDefinition') {
                  this.#addJsNodeToChunks(classElement, documentText, astNodesToChunk, className);
                }
              });
            }
          },
          VariableDeclaration: (node) => {
            // Could potentially iterate node.declarations if needed
            this.#addJsNodeToChunks(node, documentText, astNodesToChunk, null);
          },
          // Handle top-level exports containing the above
          ExportNamedDeclaration: (node) => {
            if (node.declaration) {
              // Need to determine type of declaration and call appropriate handler or generic one
              if (node.declaration.type === 'FunctionDeclaration' || node.declaration.type === 'ClassDeclaration' || node.declaration.type === 'VariableDeclaration') {
                // Recursively handle or extract logic from specific handlers
                // For now, just add the exported declaration as a chunk
                this.#addJsNodeToChunks(node.declaration, documentText, astNodesToChunk, null);
                // TODO: If it's a class, need to walk its body for methods like above
              } else {
                // Add the export statement itself if declaration is not chunkable type
                this.#addJsNodeToChunks(node, documentText, astNodesToChunk, null);
              }
            } else {
              // Handle export { ... } case if necessary, chunk the whole statement
              this.#addJsNodeToChunks(node, documentText, astNodesToChunk, null);
            }
          },
          ExportDefaultDeclaration: (node) => {
            if (node.declaration) {
              // Similar logic as ExportNamedDeclaration
              if (node.declaration.type === 'FunctionDeclaration' || node.declaration.type === 'ClassDeclaration' || node.declaration.type === 'VariableDeclaration') {
                this.#addJsNodeToChunks(node.declaration, documentText, astNodesToChunk, null);
                // TODO: If it's a class, need to walk its body for methods
              } else {
                // Chunk the export default statement + its expression/literal
                this.#addJsNodeToChunks(node, documentText, astNodesToChunk, null);
              }
            }
          },
          // Catch other top-level statements (like imports, expressions)
          ExpressionStatement: (node) => {
            this.#addJsNodeToChunks(node, documentText, astNodesToChunk, null);
          },
          ImportDeclaration: (node) => {
            this.#addJsNodeToChunks(node, documentText, astNodesToChunk, null);
          }
          // Add other node types as needed
        });

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

          // Check for Class or Trait context first
          if (node.kind === 'class' || node.kind === 'trait') {
            const parentClassName = node.name?.name || (typeof node.name === 'string' ? node.name : null);
            this.log(`[AST] #splitTextWithAST: Entering PHP ${node.kind} context: ${parentClassName}`);
            // Add the class/trait definition itself
            this.#addPhpNodeToChunks(node, documentText, astNodesToChunk, null);

            // Iterate through body for methods
            if (node.body) {
              node.body.forEach(bodyNode => {
                if (bodyNode.kind === 'method') {
                  this.#addPhpNodeToChunks(bodyNode, documentText, astNodesToChunk, parentClassName);
                }
                 // Can add handling for properties (propertystatement) if needed
              });
            }
             // After processing class body, continue to next top-level node
            return; // Skips the generic processing below for this class/trait node
          }

          // Process other top-level nodes (functions, namespaces, statements)
          this.#addPhpNodeToChunks(node, documentText, astNodesToChunk, null);
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
                filePath: this.config.filename || null,
                nodeType: 'rule',
                selector: node.selector,
                startLine: startLine,
                endLine: endLine,
                // featureContext added later
              };
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
                filePath: this.config.filename || null,
                nodeType: 'atRule',
                atRuleName: node.name,
                atRuleParams: node.params,
                startLine: startLine,
                endLine: endLine,
                // featureContext added later
              };
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
                  isSubChunk: true
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
            startLine: null, // No line info from recursive splitter
            endLine: null,
            featureContext: this.#featureContext
          }
        });
      });
    }

    this.log(`[AST] #splitTextWithAST: Finished AST splitting process for ${language}. Total final chunks generated: ${finalChunks.length}.`);
    return finalChunks.filter(chunkObject => !!chunkObject.text.trim()); // Filter empty text chunks
  }

  // Helper to add JS node chunk with metadata
  #addJsNodeToChunks(node, documentText, chunkArray, parentName) {
    if (node?.loc && node.start !== undefined && node.end !== undefined) {
      const start = node.start;
      const end = node.end;
      const text = documentText.substring(start, end);
      const startLine = node.loc.start.line;
      const endLine = node.loc.end.line;
      let nodeName = null;
      let extendsClassName = null;

      // Extract name based on common patterns
      if (node.id?.name) { // FunctionDeclaration, ClassDeclaration, VariableDeclarator (within VariableDeclaration)
        nodeName = node.id.name;
      } else if (node.key?.name) { // MethodDefinition
        nodeName = node.key.name;
      } else if (node.type === 'VariableDeclaration' && node.declarations?.length > 0) {
        // For VariableDeclaration, try to get name from the first declarator
        nodeName = node.declarations[0].id?.name;
      }

      // Extract extends info for classes
      if (node.type === 'ClassDeclaration' && node.superClass) {
        // Attempt to get name, fallback to source snippet
        extendsClassName = node.superClass.name || documentText.substring(node.superClass.start, node.superClass.end);
      }

      const chunkMetadata = {
        sourceType: 'ast',
        language: 'js',
        filePath: this.config.filename || null, // Add file path
        nodeType: node.type,
        nodeName: nodeName,
        parentName: parentName, // Pass parent name
        startLine: startLine,
        endLine: endLine,
        extendsClass: extendsClassName, // Add extends info
        // Consider adding async, generator flags if needed later
      };

      this.log(`[AST] Helper: Identified JS Node (Type: ${node.type}, Name: ${nodeName}, Parent: ${parentName}, Lines: ${startLine}-${endLine})`);
      if (text.trim()) {
        this.log(`[AST] Helper: Extracted JS text snippet (length: ${text.length}). Adding to potential chunks.`);
        chunkArray.push({ text, metadata: chunkMetadata });
      }
    } else {
      this.log(`[AST] Helper: Skipping JS Node (Type: ${node?.type}) - No location info.`);
    }
  }

  // Helper to add PHP node chunk with metadata
  #addPhpNodeToChunks(node, documentText, chunkArray, parentName) {
    if (node?.loc && node.loc.start?.offset !== undefined && node.loc.end?.offset !== undefined) {
      const start = node.loc.start.offset;
      const end = node.loc.end.offset;
      const text = documentText.substring(start, end);
      const startLine = node.loc.start.line;
      const endLine = node.loc.end.line;
      let nodeName = null;
      let extendsClassName = null;
      let implementsInterfaces = [];
      let usesTraits = [];
      let modifiers = {}; // Store visibility, static, abstract, etc.

      if (node.name) {
        nodeName = typeof node.name === 'string' ? node.name : node.name.name; // Handle Identifier object
      }

      // Extract details for class/interface/trait
      if (['class', 'interface', 'trait'].includes(node.kind)) {
        // Extends (for class/interface)
        if (node.extends) {
          const extendsNode = Array.isArray(node.extends) ? node.extends[0] : node.extends; // php-parser can return array or object
          extendsClassName = extendsNode?.name || documentText.substring(extendsNode?.loc.start.offset, extendsNode?.loc.end.offset);
        }
        // Implements (for class)
        if (node.implements && Array.isArray(node.implements)) {
          implementsInterfaces = node.implements.map(iface => iface?.name || documentText.substring(iface?.loc.start.offset, iface?.loc.end.offset));
        }
        // Traits Used (for class/trait)
        if (node.body && Array.isArray(node.body)) {
          node.body.forEach(bodyNode => {
            if (bodyNode.kind === 'traituse') {
              if (bodyNode.traits && Array.isArray(bodyNode.traits)) {
                usesTraits = usesTraits.concat(bodyNode.traits.map(trait => trait?.name || documentText.substring(trait?.loc.start.offset, trait?.loc.end.offset)));
              }
            }
          });
        }
      }

      // Extract Modifiers (visibility, static, abstract, final etc.) for relevant kinds
      if (['class', 'interface', 'trait', 'method', 'property', 'classconstant'].includes(node.kind) && node.flags !== undefined) {
         // Assuming flags are numeric constants from php-parser (need to verify exact values)
         // Example flags (might need adjustment based on php-parser version):
         const MODIFIER_PUBLIC = 1;
         const MODIFIER_PROTECTED = 2;
         const MODIFIER_PRIVATE = 4;
         const MODIFIER_STATIC = 8;
         const MODIFIER_ABSTRACT = 16;
         const MODIFIER_FINAL = 32;
         const MODIFIER_READONLY = 64; // Check if this flag exists

         if (node.flags & MODIFIER_STATIC) modifiers.isStatic = true;
         if (node.flags & MODIFIER_ABSTRACT) modifiers.isAbstract = true;
         if (node.flags & MODIFIER_FINAL) modifiers.isFinal = true;
         if (node.flags & MODIFIER_READONLY) modifiers.isReadonly = true; // Add check

         if (node.flags & MODIFIER_PROTECTED) modifiers.visibility = 'protected';
         else if (node.flags & MODIFIER_PRIVATE) modifiers.visibility = 'private';
         else modifiers.visibility = 'public'; // Default public
      }

      const chunkMetadata = {
        sourceType: 'ast',
        language: 'php',
        filePath: this.config.filename || null, // Add file path
        nodeType: node.kind,
        nodeName: nodeName,
        parentName: parentName, // Pass parent name
        startLine: startLine,
        endLine: endLine,
        extendsClass: extendsClassName, // Add extends info
        implementsInterfaces: implementsInterfaces.length > 0 ? implementsInterfaces : null, // Add implements info
        usesTraits: usesTraits.length > 0 ? usesTraits : null, // Add trait info
        modifiers: Object.keys(modifiers).length > 0 ? modifiers : null, // Add modifiers
      };

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
      return null;
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
    return null;
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
            startLine: null, // No line info from recursive splitter
            endLine: null,
            featureContext: this.#featureContext
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
}

module.exports.TextSplitter = TextSplitter;
