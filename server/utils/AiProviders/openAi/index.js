const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const {
  handleDefaultStreamResponseV2,
  formatChatHistory,
} = require("../../helpers/chat/responses");
const { MODEL_MAP } = require("../modelMap");
const {
  LLMPerformanceMonitor,
} = require("../../helpers/chat/LLMPerformanceMonitor");

class OpenAiLLM {
  constructor(embedder = null, modelPreference = null) {
    // --- BEGIN ADDED LOGGING ---
    console.log(`\x1b[36m[DEBUG] OpenAiLLM: Constructor called. Model preference: ${modelPreference}, Using model: ${modelPreference || process.env.OPEN_MODEL_PREF || "gpt-4o"}\x1b[0m`);
    // --- END ADDED LOGGING ---
    if (!process.env.OPEN_AI_KEY) throw new Error("No OpenAI API key was set.");
    const { OpenAI: OpenAIApi } = require("openai");

    this.openai = new OpenAIApi({
      apiKey: process.env.OPEN_AI_KEY,
    });
    this.model = modelPreference || process.env.OPEN_MODEL_PREF || "gpt-4o";
    this.limits = {
      history: this.promptWindowLimit() * 0.15,
      system: this.promptWindowLimit() * 0.15,
      user: this.promptWindowLimit() * 0.7,
    };

    this.embedder = embedder ?? new NativeEmbedder();
    this.defaultTemp = 0.7;
  }

  /**
   * Check if the model is an o1 model.
   * @returns {boolean}
   */
  get isOTypeModel() {
    return this.model.startsWith("o");
  }

  // Modified to accept contextDocuments (array of objects)
  #appendContext(contextDocuments = []) {
    if (!contextDocuments || !contextDocuments.length) return "";

    // Start with the main context heading
    let fullContextString = "\nContext:\n";

    // Map each document/chunk object to a formatted string with metadata
    fullContextString += contextDocuments
      .map((doc, i) => {
        const text = doc.text || doc.pageContent || ""; // Get the text content
        const metadata = doc.metadata || doc; // Metadata might be top-level or nested

        // --- Extract Existing and New Metadata ---
        const relevantMeta = {
          // Existing Fields
          file: metadata.filePath || metadata.title || metadata.filename || metadata.source || 'Unknown', // Use filePath from AST if available
          type: metadata.nodeType || (text.length > 0 ? 'Text' : 'Metadata'), // Use nodeType from AST
          name: metadata.nodeName || null, // Use nodeName from AST
          lines: (metadata.startLine && metadata.endLine) ? `${metadata.startLine}-${metadata.endLine}` : null, // Use start/endLine from AST
          parent: metadata.parentName || null, // Use parentName from AST
          score: metadata.score?.toFixed(4) || null, // Include similarity score if available
          language: metadata.language || null, // e.g., 'php', 'js'
          
          // Explicitly OMIT BigInt fields from context sent to LLM
          // wordCount: metadata.wordCount, 
          // token_count_estimate: metadata.token_count_estimate,

          // New Phase 1 Fields
          featureContext: metadata.featureContext || null, // From path analysis
          summary: metadata.summary || null, // From DocBlock
          parameters: metadata.parameters || null, // Keep original string here for now
          returnType: metadata.returnType || null, // From DocBlock/Signature
          returnDescription: metadata.returnDescription || null, // From DocBlock @return
          visibility: metadata.modifiers?.visibility || null, // From AST Modifiers
          isDeprecated: metadata.isDeprecated || false, // From DocBlock @deprecated
          isStatic: metadata.modifiers?.isStatic || false, // From AST Modifiers
          isAbstract: metadata.modifiers?.isAbstract || false, // From AST Modifiers
          isFinal: metadata.modifiers?.isFinal || false, // From AST Modifiers
          isAsync: metadata.modifiers?.isAsync || false, // <-- Add isAsync extraction (primarily for JS)
          registersHooks: metadata.registersHooks || null, // Array from WP Hook analysis [{hookName, callback, type, priority, acceptedArgs}]
          triggersHooks: metadata.triggersHooks || null, // Array from WP Hook analysis [{hookName, type}]

          // New CSS Fields
          selector: metadata.selector || null,       // From CSS AST
          atRuleName: metadata.atRuleName || null,   // From CSS AST
          atRuleParams: metadata.atRuleParams || null, // From CSS AST

          // Add other potentially useful fields from existing metadata if needed
        };
        // --- End Metadata Extraction ---
        
        // -- Safely parse JSON string fields from relevantMeta before use --
        let parsedParameters = [];
        let parsedModifiers = {};
        let parsedImplementsInterfaces = [];
        let parsedUsesTraits = [];
        let parsedRegistersHooks = [];
        let parsedTriggersHooks = [];

        // Note: Added error logging context specific to OpenAI provider
        try { parsedParameters = relevantMeta.parameters ? JSON.parse(relevantMeta.parameters) : []; } catch (e) { console.error(`[OpenAI Context] Failed to parse parameters: ${relevantMeta.parameters}`, e); }
        try { parsedModifiers = relevantMeta.modifiers ? JSON.parse(relevantMeta.modifiers) : {}; } catch (e) { console.error(`[OpenAI Context] Failed to parse modifiers: ${relevantMeta.modifiers}`, e); }
        try { parsedImplementsInterfaces = relevantMeta.implementsInterfaces ? JSON.parse(relevantMeta.implementsInterfaces) : []; } catch (e) { console.error(`[OpenAI Context] Failed to parse implementsInterfaces: ${relevantMeta.implementsInterfaces}`, e); }
        try { parsedUsesTraits = relevantMeta.usesTraits ? JSON.parse(relevantMeta.usesTraits) : []; } catch (e) { console.error(`[OpenAI Context] Failed to parse usesTraits: ${relevantMeta.usesTraits}`, e); }
        try { parsedRegistersHooks = relevantMeta.registersHooks ? JSON.parse(relevantMeta.registersHooks) : []; } catch (e) { console.error(`[OpenAI Context] Failed to parse registersHooks: ${relevantMeta.registersHooks}`, e); }
        try { parsedTriggersHooks = relevantMeta.triggersHooks ? JSON.parse(relevantMeta.triggersHooks) : []; } catch (e) { console.error(`[OpenAI Context] Failed to parse triggersHooks: ${relevantMeta.triggersHooks}`, e); }
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
            // ... (other modifier flags, deprecated, summary, parameters, return, hooks formatting needs placing)
        }
        
        if (relevantMeta.lines) formattedChunk += `Lines: ${relevantMeta.lines}\n`;

        // --- Resume formatting for fields common to all or already handled ----
        // Add modifier flags if true (mostly for PHP/JS)
        const modifierFlags = [];
        if (parsedModifiers.isStatic) modifierFlags.push('static');
        if (parsedModifiers.isAbstract) modifierFlags.push('abstract');
        if (parsedModifiers.isFinal) modifierFlags.push('final');
        if (parsedModifiers.isAsync) modifierFlags.push('async'); 
        if (modifierFlags.length > 0 && relevantMeta.language !== 'css') formattedChunk += `Modifiers: ${modifierFlags.join(', ')}\n`; // Avoid showing for CSS

        if (relevantMeta.isDeprecated && relevantMeta.language !== 'css') formattedChunk += `Deprecated: Yes\n`; // Avoid showing for CSS

        // Add Summary if available (mostly PHP/JS)
        if (relevantMeta.summary && relevantMeta.language !== 'css') formattedChunk += `Summary: ${relevantMeta.summary}\n`;

        // Format Parameters (if any - mostly PHP/JS)
        if (parsedParameters && parsedParameters.length > 0 && relevantMeta.language !== 'css') {
           formattedChunk += `Parameters:\n`;
           parsedParameters.forEach(p => {
               const typeStr = p.type ? `: ${p.type}` : '';
               const descStr = p.description ? ` - ${p.description}` : '';
               formattedChunk += `  - ${p.name}${typeStr}${descStr}\n`;
           });
        } 

        // Format Return Info (mostly PHP/JS)
        if (relevantMeta.returnType && relevantMeta.language !== 'css') {
            const descStr = relevantMeta.returnDescription ? ` - ${relevantMeta.returnDescription}` : '';
            formattedChunk += `Returns: ${relevantMeta.returnType}${descStr}\n`;
        } 

         // Format Registered Hooks (PHP Only)
        if (parsedRegistersHooks && parsedRegistersHooks.length > 0 && relevantMeta.language === 'php') {
           formattedChunk += `Registers Hooks:\n`;
           parsedRegistersHooks.forEach(h => {
               formattedChunk += `  - [${h.type}] ${h.hookName} -> ${h.callback} (P:${h.priority}, A:${h.acceptedArgs})\n`;
           });
        } 

        // Format Triggered Hooks (PHP Only)
        if (parsedTriggersHooks && parsedTriggersHooks.length > 0 && relevantMeta.language === 'php') {
            formattedChunk += `Triggers Hooks:\n`;
            parsedTriggersHooks.forEach(h => {
                formattedChunk += `  - [${h.type}] ${h.hookName}\n`;
            });
        } 

        // Add Extends/Implements/Uses (PHP specific)
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
        
        // --- Clean the text content --- 
        const cleanedText = text.replace(/<document_metadata>[\s\S]*?<\/document_metadata>\n*\n*/, '');
        // --- End text cleaning ---
        
        formattedChunk += `--- Code/Text ---\n${cleanedText}\n`; // <-- Use cleanedText 
        formattedChunk += `--- End Context Chunk ${i + 1} ---\n\n`; 

        return formattedChunk;
      })
      .join("");

    // Note: Added logging context specific to OpenAI provider
    console.log("\x1b[36m[DEBUG] OpenAiLLM:#appendContext: Generated formatted context string:\x1b[0m\n", fullContextString);
    return fullContextString;
  }

  streamingEnabled() {
    // o3-mini is the only o-type model that supports streaming
    if (this.isOTypeModel && this.model !== "o3-mini") return false;
    return "streamGetChatCompletion" in this;
  }

  static promptWindowLimit(modelName) {
    return MODEL_MAP.openai[modelName] ?? 4_096;
  }

  promptWindowLimit() {
    return MODEL_MAP.openai[this.model] ?? 4_096;
  }

  // Short circuit if name has 'gpt' since we now fetch models from OpenAI API
  // via the user API key, so the model must be relevant and real.
  // and if somehow it is not, chat will fail but that is caught.
  // we don't want to hit the OpenAI api every chat because it will get spammed
  // and introduce latency for no reason.
  async isValidChatCompletionModel(modelName = "") {
    const isPreset =
      modelName.toLowerCase().includes("gpt") ||
      modelName.toLowerCase().startsWith("o");
    if (isPreset) return true;

    const model = await this.openai.models
      .retrieve(modelName)
      .then((modelObj) => modelObj)
      .catch(() => null);
    return !!model;
  }

  /**
   * Generates appropriate content array for a message + attachments.
   * @param {{userPrompt:string, attachments: import("../../helpers").Attachment[]}}
   * @returns {string|object[]}
   */
  #generateContent({ userPrompt, attachments = [] }) {
    if (!attachments.length) {
      return userPrompt;
    }

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
   * @param {{attachments: import("../../helpers").Attachment[]}} param0
   * @returns
   */
  constructPrompt({
    systemPrompt = "",
    contextDocuments = [], // Changed from contextTexts
    chatHistory = [],
    userPrompt = "",
    attachments = [], // This is the specific attachment for only this prompt
  }) {
    let finalMessages = [];
    const formattedContext = this.#appendContext(contextDocuments);
    const role = this.isOTypeModel ? "user" : "system";

    // Original Logic: Append context to the system prompt content.
    // The messageArrayCompressor expects context to be part of the first system message.
    let systemMessageContent = systemPrompt;
    if (formattedContext.length > 0) {
      // Ensure the specific "Context:\n" prefix is used, as expected by the compressor.
      systemMessageContent += `\n\nContext:\n${formattedContext}`;
    }

    if (systemMessageContent.length > 0) {
       finalMessages.push({ role: role, content: systemMessageContent });
    }

    // Add Chat History (formatted)
    finalMessages = finalMessages.concat(
       formatChatHistory(chatHistory, this.#generateContent)
    );

    // Add Final User Prompt
    finalMessages.push({
      role: "user",
      content: this.#generateContent({ userPrompt, attachments }),
    });
    
    // Logging added previously...
    console.log("\x1b[34m[LLM_REQUEST_PREP] [0m [OpenAI - constructPrompt Final Messages]");
    try {
      // Use JSON.stringify for clear structure, handle potential circular refs/BigInts if necessary
      console.log(JSON.stringify(finalMessages, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value, // Basic BigInt handler
      2)); 
    } catch (e) {
      console.error("  [DEBUG] OpenAI constructPrompt: Error stringifying finalMessages for logging:", e);
      console.log("  [DEBUG] OpenAI constructPrompt: finalMessages raw object:", finalMessages); // Fallback log
    }

    return finalMessages;
  }

  async getChatCompletion(messages = null, { temperature = 0.7 }) {
    // --- BEGIN ADDED LOGGING ---
    console.log("\x1b[36m[DEBUG] OpenAiLLM: getChatCompletion called.\x1b[0m");
    // --- END ADDED LOGGING ---
    if (!(await this.isValidChatCompletionModel(this.model)))
      throw new Error(
        `OpenAI chat: ${this.model} is not valid for chat completion!`
      );

    // --- BEGIN ADDED LOGGING (BEFORE API CALL) ---
    console.log(`\x1b[35m[API_CALL_PREP] [OpenAI - getChatCompletion] Sending ${messages?.length} messages to model ${this.model}:\x1b[0m`);
    try {
      console.log(JSON.stringify(messages, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value, 
      2));
    } catch (e) {
      console.error("  [API_CALL_PREP] OpenAI getChatCompletion: Error stringifying messages for logging:", e);
      console.log("  [API_CALL_PREP] OpenAI getChatCompletion: messages raw object:", messages);
    }
    // --- END ADDED LOGGING ---

    const result = await LLMPerformanceMonitor.measureAsyncFunction(
      this.openai.chat.completions
        .create({
          model: this.model,
          messages,
          temperature: this.isOTypeModel ? 1 : temperature, // o1 models only accept temperature 1
        })
        .catch((e) => {
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

  async streamGetChatCompletion(messages = null, { temperature = 0.7 }) {
    // --- BEGIN ADDED LOGGING ---
    console.log("\x1b[36m[DEBUG] OpenAiLLM: streamGetChatCompletion called.\x1b[0m");
    // --- END ADDED LOGGING ---
    if (!(await this.isValidChatCompletionModel(this.model)))
      throw new Error(
        `OpenAI chat: ${this.model} is not valid for chat completion!`
      );

    // --- BEGIN ADDED LOGGING (BEFORE API CALL) ---
    console.log(`\x1b[35m[API_CALL_PREP] [OpenAI - streamGetChatCompletion] Sending ${messages?.length} messages to model ${this.model}:\x1b[0m`);
    try {
      console.log(JSON.stringify(messages, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value, 
      2));
    } catch (e) {
      console.error("  [API_CALL_PREP] OpenAI streamGetChatCompletion: Error stringifying messages for logging:", e);
      console.log("  [API_CALL_PREP] OpenAI streamGetChatCompletion: messages raw object:", messages);
    }
    // --- END ADDED LOGGING ---

    const measuredStreamRequest = await LLMPerformanceMonitor.measureStream(
      this.openai.chat.completions.create({
        model: this.model,
        stream: true,
        messages,
        temperature: this.isOTypeModel ? 1 : temperature, // o1 models only accept temperature 1
      }),
      messages
      // runPromptTokenCalculation: true - We manually count the tokens because OpenAI does not provide them in the stream
      // since we are not using the OpenAI API version that supports this `stream_options` param.
    );

    return measuredStreamRequest;
  }

  handleStream(response, stream, responseProps) {
    return handleDefaultStreamResponseV2(response, stream, responseProps);
  }

  // Simple wrapper for dynamic embedder & normalize interface for all LLM implementations
  async embedTextInput(textInput) {
    return await this.embedder.embedTextInput(textInput);
  }
  async embedChunks(textChunks = []) {
    return await this.embedder.embedChunks(textChunks);
  }

  async compressMessages(promptArgs = {}, rawHistory = []) {
    // Wrap initial logging and constructPrompt call in try/catch
    let messageArray;
    let compressedMessages; // Declare compressedMessages here
    try {
      const { messageArrayCompressor } = require("../../helpers/chat");
      
      // --- BEGIN SIMPLIFIED LOGGING ---
      console.log("\x1b[36m[DEBUG] OpenAiLLM.compressMessages: Entered function.\x1b[0m");
      console.log(`\x1b[36m[DEBUG] OpenAiLLM.compressMessages: Received contextDocuments count: ${promptArgs?.contextDocuments?.length ?? 'undefined'}\x1b[0m`);
      // --- END SIMPLIFIED LOGGING ---
  
      messageArray = this.constructPrompt(promptArgs);
  
      // --- BEGIN SIMPLIFIED LOGGING ---
      console.log(`\x1b[36m[DEBUG] OpenAiLLM.compressMessages: Message array length BEFORE compression: ${messageArray?.length ?? 'undefined'}\x1b[0m`);
      console.log(`\x1b[36m[DEBUG] OpenAiLLM.compressMessages: Calling messageArrayCompressor...\x1b[0m`);
      // --- END SIMPLIFIED LOGGING ---
      
      // Call the compressor
      // Now assigns to the outer variable
      compressedMessages = await messageArrayCompressor(this, messageArray, rawHistory);
  
      // --- BEGIN ADDED LOGGING (AFTER COMPRESSION) ---
      console.log("\x1b[36m[DEBUG] OpenAiLLM.compressMessages: Message array AFTER compression:\x1b[0m");
      try {
        // Log structure briefly, focus on roles and context presence in system message
        const structureSummary = compressedMessages.map(msg => ({
          role: msg.role,
          hasContent: !!msg.content,
          contentLength: typeof msg.content === 'string' ? msg.content.length : (Array.isArray(msg.content) ? JSON.stringify(msg.content).length : 0),
          // Check specifically if the system message STILL has context
          hasContext: (msg.role === 'system' || msg.role === 'user') && typeof msg.content === 'string' && msg.content.includes('\nContext:'),
        }));
        console.log(JSON.stringify(structureSummary, null, 2));
      } catch (e) {
        console.error("  [DEBUG] OpenAiLLM.compressMessages: Error logging message structure AFTER compression:", e);
      }
      // --- END ADDED LOGGING (AFTER COMPRESSION) ---
    } catch (compressError) {
      // --- BEGIN SIMPLIFIED ERROR LOGGING ---
      console.error("--- ERROR CAUGHT IN OpenAiLLM.compressMessages ---");
      console.error("Error message:", compressError?.message);
      // console.error("\x1b[31m[ERROR] OpenAiLLM.compressMessages: Failed during initial processing or logging!\x1b[0m", compressError); // Original complex log
      // --- END SIMPLIFIED ERROR LOGGING ---
      
      // Fallback: If compression fails, just return the original constructed prompt
      // This might be too large, but it's better than crashing.
      // Ensure messageArray is defined in this scope if an error happened before its assignment
      if (typeof messageArray === 'undefined') { 
        console.error("--- ERROR: messageArray was undefined during error handling in OpenAiLLM.compressMessages ---");
        // Attempt to reconstruct or return a minimal error state if possible
         messageArray = this.constructPrompt(promptArgs); // Try constructing again, might fail if args are bad
         if (!messageArray) return [{ role: 'user', content: promptArgs?.userPrompt || "Error during prompt compression." }];
      }
      // Now assigns to the outer variable
      compressedMessages = messageArray; 
    }

    return compressedMessages; // Returns the outer variable
  }
}

module.exports = {
  OpenAiLLM,
};
