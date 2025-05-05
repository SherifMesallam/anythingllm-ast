const fs = require("fs");
const path = require("path");
const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const {
  LLMPerformanceMonitor,
} = require("../../helpers/chat/LLMPerformanceMonitor");
const {
  formatChatHistory,
  handleDefaultStreamResponseV2,
} = require("../../helpers/chat/responses");
const { MODEL_MAP } = require("../modelMap");
const { defaultGeminiModels, v1BetaModels } = require("./defaultModels");
const { safeJsonParse } = require("../../http");
const cacheFolder = path.resolve(
  process.env.STORAGE_DIR
    ? path.resolve(process.env.STORAGE_DIR, "models", "gemini")
    : path.resolve(__dirname, `../../../storage/models/gemini`)
);

const NO_SYSTEM_PROMPT_MODELS = [
  "gemma-3-1b-it",
  "gemma-3-4b-it",
  "gemma-3-12b-it",
  "gemma-3-27b-it",
];

class GeminiLLM {
  constructor(embedder = null, modelPreference = null) {
    if (!process.env.GEMINI_API_KEY)
      throw new Error("No Gemini API key was set.");

    const { OpenAI: OpenAIApi } = require("openai");
    this.model =
      modelPreference ||
      process.env.GEMINI_LLM_MODEL_PREF ||
      "gemini-2.0-flash-lite";

    const isExperimental = this.isExperimentalModel(this.model);
    this.openai = new OpenAIApi({
      apiKey: process.env.GEMINI_API_KEY,
      // Even models that are v1 in gemini API can be used with v1beta/openai/ endpoint and nobody knows why.
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    });

    this.limits = {
      history: this.promptWindowLimit() * 0.15,
      system: this.promptWindowLimit() * 0.15,
      user: this.promptWindowLimit() * 0.7,
    };

    this.embedder = embedder ?? new NativeEmbedder();
    this.defaultTemp = 0.7;

    if (!fs.existsSync(cacheFolder))
      fs.mkdirSync(cacheFolder, { recursive: true });
    this.cacheModelPath = path.resolve(cacheFolder, "models.json");
    this.cacheAtPath = path.resolve(cacheFolder, ".cached_at");
    this.#log(
      `Initialized with model: ${this.model} ${isExperimental ? "[Experimental v1beta]" : "[Stable v1]"} - ctx: ${this.promptWindowLimit()}`
    );
  }

  /**
   * Checks if the model supports system prompts
   * This is a static list of models that are known to not support system prompts
   * since this information is not available in the API model response.
   * @returns {boolean}
   */
  get supportsSystemPrompt() {
    return !NO_SYSTEM_PROMPT_MODELS.includes(this.model);
  }

  #log(text, ...args) {
    console.log(`\x1b[32m[GeminiLLM]\x1b[0m ${text}`, ...args);
  }

  // This checks if the .cached_at file has a timestamp that is more than 1Week (in millis)
  // from the current date. If it is, then we will refetch the API so that all the models are up
  // to date.
  static cacheIsStale() {
    const MAX_STALE = 8.64e7; // 1 day in MS
    if (!fs.existsSync(path.resolve(cacheFolder, ".cached_at"))) return true;
    const now = Number(new Date());
    const timestampMs = Number(
      fs.readFileSync(path.resolve(cacheFolder, ".cached_at"))
    );
    return now - timestampMs > MAX_STALE;
  }

  // Modified #appendContext to accept userPrompt and conditionally include metadata
  #appendContext(contextDocuments = [], userPrompt = "") {
    if (!contextDocuments || !contextDocuments.length) return "";

    const includeMetadata = !userPrompt.includes('[nometa]');
    this.#log(`#appendContext: Metadata inclusion flag '[nometa]' ${includeMetadata ? 'not found' : 'found'}. Including metadata: ${includeMetadata}`);

    // Start with the main context heading
    let fullContextString = "\nContext:\n";

    if (includeMetadata) {
      // --- BEGIN METADATA-RICH FORMATTING ---
      fullContextString += contextDocuments
        .map((doc, i) => {
          const text = doc.text || doc.pageContent || ""; // Get the text content
          const metadata = doc.metadata || doc; // Metadata might be top-level or nested
          
          // --- Extract Existing and New Metadata --- 
          const relevantMeta = {
            file: metadata.filePath || metadata.title || metadata.filename || metadata.source || 'Unknown',
            type: metadata.nodeType || (text.length > 0 ? 'Text' : 'Metadata'),
            name: metadata.nodeName || null,
            lines: (metadata.startLine && metadata.endLine) ? `${metadata.startLine}-${metadata.endLine}` : null,
            parent: metadata.parentName || null,
            score: metadata.score?.toFixed(4) || null,
            language: metadata.language || null,
            featureContext: metadata.featureContext || null,
            summary: metadata.summary || null,
            parameters: metadata.parameters || null,
            returnType: metadata.returnType || null,
            returnDescription: metadata.returnDescription || null,
            visibility: metadata.modifiers?.visibility || null,
            isDeprecated: metadata.isDeprecated || false,
            isStatic: metadata.modifiers?.isStatic || false,
            isAbstract: metadata.modifiers?.isAbstract || false,
            isFinal: metadata.modifiers?.isFinal || false,
            isAsync: metadata.modifiers?.isAsync || false,
            registersHooks: metadata.registersHooks || null,
            triggersHooks: metadata.triggersHooks || null,
            selector: metadata.selector || null,
            atRuleName: metadata.atRuleName || null,
            atRuleParams: metadata.atRuleParams || null,
            // Add PHP/other specific fields if needed based on TextSplitter capabilities
            extendsClass: metadata.extendsClass || null, 
            implementsInterfaces: metadata.implementsInterfaces || null, 
            usesTraits: metadata.usesTraits || null, 
          };
          // --- End Metadata Extraction ---
          
          // -- Safely parse JSON string fields --
          let parsedParameters = [];
          let parsedModifiers = {};
          let parsedImplementsInterfaces = [];
          let parsedUsesTraits = [];
          let parsedRegistersHooks = [];
          let parsedTriggersHooks = [];
  
          try { parsedParameters = relevantMeta.parameters ? JSON.parse(relevantMeta.parameters) : []; } catch (e) { console.error(`[Gemini Context] Failed to parse parameters: ${relevantMeta.parameters}`, e); }
          try { parsedModifiers = relevantMeta.modifiers ? JSON.parse(relevantMeta.modifiers) : {}; } catch (e) { console.error(`[Gemini Context] Failed to parse modifiers: ${relevantMeta.modifiers}`, e); }
          try { parsedImplementsInterfaces = relevantMeta.implementsInterfaces ? JSON.parse(relevantMeta.implementsInterfaces) : []; } catch (e) { console.error(`[Gemini Context] Failed to parse implementsInterfaces: ${relevantMeta.implementsInterfaces}`, e); }
          try { parsedUsesTraits = relevantMeta.usesTraits ? JSON.parse(relevantMeta.usesTraits) : []; } catch (e) { console.error(`[Gemini Context] Failed to parse usesTraits: ${relevantMeta.usesTraits}`, e); }
          try { parsedRegistersHooks = relevantMeta.registersHooks ? JSON.parse(relevantMeta.registersHooks) : []; } catch (e) { console.error(`[Gemini Context] Failed to parse registersHooks: ${relevantMeta.registersHooks}`, e); }
          try { parsedTriggersHooks = relevantMeta.triggersHooks ? JSON.parse(relevantMeta.triggersHooks) : []; } catch (e) { console.error(`[Gemini Context] Failed to parse triggersHooks: ${relevantMeta.triggersHooks}`, e); }
          // -- End Parsing --
  
          // --- Build the formatted string for this chunk ---
          let formattedChunk = `--- Context Chunk ${i + 1} ---\n`;
          formattedChunk += `Source File: ${relevantMeta.file}\n`;
          if (relevantMeta.language) formattedChunk += `Language: ${relevantMeta.language}\n`;
          if (relevantMeta.featureContext) formattedChunk += `Feature Context: ${relevantMeta.featureContext}\n`;
          if (relevantMeta.type) formattedChunk += `Element Type: ${relevantMeta.type}\n`;
  
          // Specific CSS Formatting
          if (relevantMeta.language === 'css') {
              if (relevantMeta.type === 'rule' && relevantMeta.selector) {
                   formattedChunk += `CSS Selector: ${relevantMeta.selector}\n`;
              } else if (relevantMeta.type === 'atRule' && relevantMeta.atRuleName) {
                   const paramsStr = relevantMeta.atRuleParams ? ` ${relevantMeta.atRuleParams}` : '';
                   formattedChunk += `CSS At-Rule: @${relevantMeta.atRuleName}${paramsStr}\n`;
              }
          } 
          // Generic/Other Language Formatting
          else {
              if (relevantMeta.name) formattedChunk += `Element Name: ${relevantMeta.name}\n`;
              if (relevantMeta.parent) formattedChunk += `Parent Context: ${relevantMeta.parent}\n`;
              if (parsedModifiers.visibility) formattedChunk += `Visibility: ${parsedModifiers.visibility}\n`;
          }
          
          if (relevantMeta.lines) formattedChunk += `Lines: ${relevantMeta.lines}\n`;
  
          // --- Resume formatting for fields common to all or already handled ----
          const modifierFlags = [];
          if (parsedModifiers.isStatic) modifierFlags.push('static');
          if (parsedModifiers.isAbstract) modifierFlags.push('abstract');
          if (parsedModifiers.isFinal) modifierFlags.push('final');
          if (parsedModifiers.isAsync) modifierFlags.push('async'); 
          if (modifierFlags.length > 0 && relevantMeta.language !== 'css') formattedChunk += `Modifiers: ${modifierFlags.join(', ')}\n`;
  
          if (relevantMeta.isDeprecated && relevantMeta.language !== 'css') formattedChunk += `Deprecated: Yes\n`;
  
          if (relevantMeta.summary && relevantMeta.language !== 'css') formattedChunk += `Summary: ${relevantMeta.summary}\n`;
  
          if (parsedParameters && parsedParameters.length > 0 && relevantMeta.language !== 'css') {
             formattedChunk += `Parameters:\n`;
             parsedParameters.forEach(p => {
                 const typeStr = p.type ? `: ${p.type}` : '';
                 const descStr = p.description ? ` - ${p.description}` : '';
                 formattedChunk += `  - ${p.name}${typeStr}${descStr}\n`;
             });
          } 
  
          if (relevantMeta.returnType && relevantMeta.language !== 'css') {
              const descStr = relevantMeta.returnDescription ? ` - ${relevantMeta.returnDescription}` : '';
              formattedChunk += `Returns: ${relevantMeta.returnType}${descStr}\n`;
          } 
  
           if (parsedRegistersHooks && parsedRegistersHooks.length > 0 && relevantMeta.language === 'php') {
             formattedChunk += `Registers Hooks:\n`;
             parsedRegistersHooks.forEach(h => {
                 formattedChunk += `  - [${h.type}] ${h.hookName} -> ${h.callback} (P:${h.priority}, A:${h.acceptedArgs})\n`;
             });
          } 
  
          if (parsedTriggersHooks && parsedTriggersHooks.length > 0 && relevantMeta.language === 'php') {
              formattedChunk += `Triggers Hooks:\n`;
              parsedTriggersHooks.forEach(h => {
                  formattedChunk += `  - [${h.type}] ${h.hookName}\n`;
              });
          } 
  
          if (relevantMeta.extendsClass && relevantMeta.language === 'php') {
              formattedChunk += `Extends: ${relevantMeta.extendsClass}\n`;
          }
          if (parsedImplementsInterfaces && parsedImplementsInterfaces.length > 0 && relevantMeta.language === 'php') {
              formattedChunk += `Implements: ${parsedImplementsInterfaces.join(', ')}\n`;
          }
          if (parsedUsesTraits && parsedUsesTraits.length > 0 && relevantMeta.language === 'php') {
              formattedChunk += `Uses Traits: ${parsedUsesTraits.join(', ')}\n`;
          }
  
          if (relevantMeta.score) formattedChunk += `Relevance Score: ${relevantMeta.score}\n`;
          
          const cleanedText = text.replace(/<document_metadata>[\s\S]*?<\/document_metadata>\n*\n*/, '');
          
          formattedChunk += `--- Code/Text ---\n${cleanedText}\n`;
          formattedChunk += `--- End Context Chunk ${i + 1} ---\n\n`; 
  
          return formattedChunk;
        })
        .join("");
      // --- END METADATA-RICH FORMATTING ---
    } else {
      // --- BEGIN SIMPLE FORMATTING ([nometa] detected) ---
      fullContextString += contextDocuments
        .map((doc, i) => {
          const text = doc.text || doc.pageContent || ""; // Get the text content only
          const metadata = doc.metadata || doc;
          const sourceFile = metadata.filePath || metadata.title || metadata.filename || metadata.source || 'Unknown';
          const cleanedText = text.replace(/<document_metadata>[\s\S]*?<\/document_metadata>\n*\n*/, '');
          return `--- Context Chunk ${i + 1} ---\nSource File: ${sourceFile}\n--- Code/Text ---\n${cleanedText}\n--- End Context Chunk ${i + 1} ---\n\n`;
        })
        .join("");
      // --- END SIMPLE FORMATTING ---
    }

    this.#log("#appendContext: Generated formatted context string."); // Simplified log message
    return fullContextString;
  }

  streamingEnabled() {
    return "streamGetChatCompletion" in this;
  }

  static promptWindowLimit(modelName) {
    try {
      const cacheModelPath = path.resolve(cacheFolder, "models.json");
      if (!fs.existsSync(cacheModelPath))
        return MODEL_MAP.gemini[modelName] ?? 30_720;

      const models = safeJsonParse(fs.readFileSync(cacheModelPath));
      const model = models.find((model) => model.id === modelName);
      if (!model)
        throw new Error(
          "Model not found in cache - falling back to default model."
        );
      return model.contextWindow;
    } catch (e) {
      console.error(`GeminiLLM:promptWindowLimit`, e.message);
      return MODEL_MAP.gemini[modelName] ?? 30_720;
    }
  }

  promptWindowLimit() {
    try {
      if (!fs.existsSync(this.cacheModelPath))
        return MODEL_MAP.gemini[this.model] ?? 30_720;

      const models = safeJsonParse(fs.readFileSync(this.cacheModelPath));
      const model = models.find((model) => model.id === this.model);
      if (!model)
        throw new Error(
          "Model not found in cache - falling back to default model."
        );
      return model.contextWindow;
    } catch (e) {
      console.error(`GeminiLLM:promptWindowLimit`, e.message);
      return MODEL_MAP.gemini[this.model] ?? 30_720;
    }
  }

  /**
   * Checks if a model is experimental by reading from the cache if available, otherwise it will perform
   * a blind check against the v1BetaModels list - which is manually maintained and updated.
   * @param {string} modelName - The name of the model to check
   * @returns {boolean} A boolean indicating if the model is experimental
   */
  isExperimentalModel(modelName) {
    if (
      fs.existsSync(cacheFolder) &&
      fs.existsSync(path.resolve(cacheFolder, "models.json"))
    ) {
      const models = safeJsonParse(
        fs.readFileSync(path.resolve(cacheFolder, "models.json"))
      );
      const model = models.find((model) => model.id === modelName);
      if (!model) return false;
      return model.experimental;
    }

    return modelName.includes("exp") || v1BetaModels.includes(modelName);
  }

  /**
   * Fetches Gemini models from the Google Generative AI API
   * @param {string} apiKey - The API key to use for the request
   * @param {number} limit - The maximum number of models to fetch
   * @param {string} pageToken - The page token to use for pagination
   * @returns {Promise<[{id: string, name: string, contextWindow: number, experimental: boolean}]>} A promise that resolves to an array of Gemini models
   */
  static async fetchModels(apiKey, limit = 1_000, pageToken = null) {
    if (!apiKey) return [];
    if (fs.existsSync(cacheFolder) && !this.cacheIsStale()) {
      console.log(
        `\x1b[32m[GeminiLLM]\x1b[0m Using cached models API response.`
      );
      return safeJsonParse(
        fs.readFileSync(path.resolve(cacheFolder, "models.json"))
      );
    }

    const stableModels = [];
    const allModels = [];

    // Fetch from v1
    try {
      const url = new URL(
        "https://generativelanguage.googleapis.com/v1/models"
      );
      url.searchParams.set("pageSize", limit);
      url.searchParams.set("key", apiKey);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      await fetch(url.toString(), {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.error) throw new Error(data.error.message);
          return data.models ?? [];
        })
        .then((models) => {
          return models
            .filter(
              (model) => !model.displayName?.toLowerCase()?.includes("tuning")
            ) // remove tuning models
            .filter(
              (model) =>
                !model.description?.toLowerCase()?.includes("deprecated")
            ) // remove deprecated models (in comment)
            .filter((model) =>
              //  Only generateContent is supported
              model.supportedGenerationMethods.includes("generateContent")
            )
            .map((model) => {
              stableModels.push(model.name);
              allModels.push({
                id: model.name.split("/").pop(),
                name: model.displayName,
                contextWindow: model.inputTokenLimit,
                experimental: false,
              });
            });
        })
        .catch((e) => {
          console.error(`Gemini:getGeminiModelsV1`, e.message);
          return;
        });
    } catch (e) {
      console.error(`Gemini:getGeminiModelsV1`, e.message);
    }

    // Fetch from v1beta
    try {
      const url = new URL(
        "https://generativelanguage.googleapis.com/v1beta/models"
      );
      url.searchParams.set("pageSize", limit);
      url.searchParams.set("key", apiKey);
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      await fetch(url.toString(), {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      })
        .then((res) => res.json())
        .then((data) => {
          if (data.error) throw new Error(data.error.message);
          return data.models ?? [];
        })
        .then((models) => {
          return models
            .filter((model) => !stableModels.includes(model.name)) // remove stable models that are already in the v1 list
            .filter(
              (model) => !model.displayName?.toLowerCase()?.includes("tuning")
            ) // remove tuning models
            .filter(
              (model) =>
                !model.description?.toLowerCase()?.includes("deprecated")
            ) // remove deprecated models (in comment)
            .filter((model) =>
              //  Only generateContent is supported
              model.supportedGenerationMethods.includes("generateContent")
            )
            .map((model) => {
              allModels.push({
                id: model.name.split("/").pop(),
                name: model.displayName,
                contextWindow: model.inputTokenLimit,
                experimental: true,
              });
            });
        })
        .catch((e) => {
          console.error(`Gemini:getGeminiModelsV1beta`, e.message);
          return;
        });
    } catch (e) {
      console.error(`Gemini:getGeminiModelsV1beta`, e.message);
    }

    if (allModels.length === 0) {
      console.error(`Gemini:getGeminiModels - No models found`);
      return defaultGeminiModels;
    }

    console.log(
      `\x1b[32m[GeminiLLM]\x1b[0m Writing cached models API response to disk.`
    );
    if (!fs.existsSync(cacheFolder))
      fs.mkdirSync(cacheFolder, { recursive: true });
    fs.writeFileSync(
      path.resolve(cacheFolder, "models.json"),
      JSON.stringify(allModels)
    );
    fs.writeFileSync(
      path.resolve(cacheFolder, ".cached_at"),
      new Date().getTime().toString()
    );

    return allModels;
  }

  /**
   * Checks if a model is valid for chat completion (unused)
   * @deprecated
   * @param {string} modelName - The name of the model to check
   * @returns {Promise<boolean>} A promise that resolves to a boolean indicating if the model is valid
   */
  async isValidChatCompletionModel(modelName = "") {
    const models = await this.fetchModels(process.env.GEMINI_API_KEY);
    return models.some((model) => model.id === modelName);
  }

  /**
   * Generates appropriate content array for a message + attachments.
   * @param {{userPrompt:string, attachments: import("../../helpers").Attachment[]}}
   * @returns {string|object[]}
   */
  #generateContent({ userPrompt, attachments = [] }) {
    if (!attachments.length) return userPrompt;
    const content = [{ type: "text", text: userPrompt }];
    for (let attachment of attachments) {
      content.push({
        type: "image_url",
        image_url: {
          url: attachment.contentString,
          detail: "high",
        },
      });
    }
    return content.flat();
  }

  /**
   * Construct the user prompt for this model.
   * Signature reverted to accept components.
   * @param {{systemPrompt?: string, contextDocuments?: object[], chatHistory?: object[], userPrompt?: string, attachments?: object[]}} promptArgs
   * @returns {object[]} The final array of messages for the API call.
   */
  constructPrompt({
    systemPrompt = "",
    contextDocuments = [],
    chatHistory = [],
    userPrompt = "",
    attachments = [], // This is the specific attachment for only this prompt
  }) {
    this.#log("Constructing prompt for Gemini...");
    let _systemPrompt = systemPrompt;

    // Pass userPrompt to #appendContext
    const formattedContext = this.#appendContext(contextDocuments, userPrompt);

    // Check and remove the flag from the userPrompt before using it
    const finalUserPrompt = userPrompt.includes('[nometa]') 
                             ? userPrompt.replace('[nometa]', '').trim() 
                             : userPrompt;

    // Gemini is fussier than OpenAI and does not allow for a top-level system prompt
    // so we mimic one appropriately based on the chat history length.
    let finalMessages = [];

    // 1. Add Initial System Prompt (if it exists)
    if (this.supportsSystemPrompt) {
      if (systemPrompt) {
        finalMessages.push({ role: "system", content: systemPrompt });
      }
    } else {
      // Fallback logic
      if (systemPrompt) {
         finalMessages.push({ role: "user", content: systemPrompt });
         finalMessages.push({ role: "assistant", content: "Okay, I will follow those instructions." });
      }
    }

    // 2. Insert Formatted Context as a separate system message (if it exists)
    if (formattedContext.length > 0) {
       finalMessages.push({ role: "system", content: `Relevant Context:\\n${formattedContext}` });
    }

    // 3. Add Chat History (use helper to format attachments correctly)
    finalMessages = finalMessages.concat(
      formatChatHistory(chatHistory, this.#generateContent)
    ); 

    // 4. Add Current User Prompt (if it exists)
    if (finalUserPrompt) {
        // Use helper to format attachments for the current prompt
        finalMessages.push({ 
          role: "user", 
          content: this.#generateContent({ userPrompt: finalUserPrompt, attachments }) 
        }); 
    } else {
        console.error("[ERROR] constructPrompt: User prompt was empty or not provided!");
    }

    this.#log(`constructPrompt: Returning ${finalMessages.length} final messages.`);
    return finalMessages;
  }

  async getChatCompletion(messages = null, { temperature = 0.7 }) {
    // --- BEGIN ADDED LOGGING ---
    console.log("\x1b[34m[LLM_REQUEST_PAYLOAD][0m [Gemini - getChatCompletion]");
    console.log(JSON.stringify({ model: this.model, messages: messages }, null, 2));
    // --- END ADDED LOGGING ---

    const result = await LLMPerformanceMonitor.measureAsyncFunction(
      this.openai.chat.completions
        .create({
          model: this.model,
          messages,
          temperature: temperature,
        })
        .catch((e) => {
          console.error(e);
          throw new Error(e.message);
        })
    );

    if (
      !result.output.hasOwnProperty("choices") ||
      result.output.choices.length === 0
    )
      return null;

    return {
      textResponse: result.output.choices[0].message.content,
      metrics: {
        prompt_tokens: result.output.usage.prompt_tokens || 0,
        completion_tokens: result.output.usage.completion_tokens || 0,
        total_tokens: result.output.usage.total_tokens || 0,
        outputTps: result.output.usage.completion_tokens / result.duration,
        duration: result.duration,
      },
    };
  }

  // Add contextDocuments to parameters
  async streamGetChatCompletion(
    messages = null,
    // Note: contextDocuments might be large, pass it separately from simple options like temperature
    contextDocuments = [],
    { temperature = 0.7 }
  ) {
    // --- BEGIN MORE DETAILED LOGGING ---
    console.log("\\x1b[36m[DEBUG] GeminiLLM: Entered streamGetChatCompletion. [0m");
    console.log(`  [DEBUG] GeminiLLM: Received ${messages?.length || 0} messages.`);
    console.log(`  [DEBUG] GeminiLLM: Received ${contextDocuments?.length || 0} context documents.`);
    console.log(`  [DEBUG] GeminiLLM: Temperature: ${temperature}`);
    
    console.log("  [DEBUG] GeminiLLM: About to log LLM Request Payload...");
    // --- END MORE DETAILED LOGGING ---

    // Log the messages PAYLOAD received (already potentially compressed)
    console.log("\x1b[34m[LLM_REQUEST_PAYLOAD] [0m [Gemini - streamGetChatCompletion]");
    // Log the 'messages' array directly as it's the final payload for the API
    // Also log contextDocuments for reference, though it's not directly sent in this structure anymore
    try {
      console.log(JSON.stringify({ 
        model: this.model, 
        messages: messages, // Log the final messages array that will be sent
        _contextDocumentsInput: contextDocuments.map(({ vector, ...rest }) => rest) // Log original context for debug visibility
      }, 
        (key, value) => typeof value === 'bigint' ? value.toString() : value, // <-- ADD REPLACER HERE
        2
      )); 
    } catch (e) {
      console.error("  [DEBUG] GeminiLLM: Error stringifying payload for logging:", e);
    }

    // --- BEGIN MORE DETAILED LOGGING ---
    console.log("  [DEBUG] GeminiLLM: Finished logging LLM Request Payload.");
    console.log("  [DEBUG] GeminiLLM: About to call openai.chat.completions.create...");
    // --- END MORE DETAILED LOGGING ---
    
    // REMOVE the call to this.constructPrompt here.
    // The 'messages' variable already holds the final, potentially compressed, message array.
    // const finalMessages = this.constructPrompt(messages, contextDocuments); // <-- REMOVE/COMMENT OUT

    const stream = await this.openai.chat.completions.create({
      model: this.model,
      messages: messages, // <-- Use the 'messages' array received as input directly
      temperature,
      stream: true,
    });

    // --- BEGIN MORE DETAILED LOGGING ---
    console.log("  [DEBUG] GeminiLLM: openai.chat.completions.create call successful, returning stream.");
    // --- END MORE DETAILED LOGGING ---
    return stream;
  }

  handleStream(response, stream, responseProps) {
    return handleDefaultStreamResponseV2(response, stream, responseProps);
  }

  async compressMessages(promptArgs = {}, rawHistory = []) {
    const { messageArrayCompressor } = require("../../helpers/chat");
    
    // 1. Construct the full message array using the components from promptArgs
    console.log("  [DEBUG] compressMessages: Calling constructPrompt with promptArgs...");
    const messageArray = this.constructPrompt(promptArgs); // Call with the object
    console.log(`  [DEBUG] compressMessages: constructPrompt returned ${messageArray?.length || 0} messages.`);

    // 2. Pass the constructed array to the compressor
    console.log("  [DEBUG] compressMessages: Calling messageArrayCompressor...");
    const compressedMessages = await messageArrayCompressor(this, messageArray, rawHistory);
    console.log(`  [DEBUG] compressMessages: messageArrayCompressor returned ${compressedMessages?.length || 0} messages.`);
    return compressedMessages;
  }

  // Simple wrapper for dynamic embedder & normalize interface for all LLM implementations
  async embedTextInput(textInput) {
    return await this.embedder.embedTextInput(textInput);
  }
  async embedChunks(textChunks = []) {
    return await this.embedder.embedChunks(textChunks);
  }

  // Helper function to ensure context chunks are properly formatted
  #formatContextChunks(contextDocuments = []) {
    // Implementation of #formatContextChunks method
  }
}

module.exports = {
  GeminiLLM,
  NO_SYSTEM_PROMPT_MODELS,
};
