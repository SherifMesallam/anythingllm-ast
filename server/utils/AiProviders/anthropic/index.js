const { v4 } = require("uuid");
const {
  writeResponseChunk,
  clientAbortedHandler,
  formatChatHistory,
} = require("../../helpers/chat/responses");
const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const { MODEL_MAP } = require("../modelMap");
const {
  LLMPerformanceMonitor,
} = require("../../helpers/chat/LLMPerformanceMonitor");

class AnthropicLLM {
  constructor(embedder = null, modelPreference = null) {
    if (!process.env.ANTHROPIC_API_KEY)
      throw new Error("No Anthropic API key was set.");

    // Docs: https://www.npmjs.com/package/@anthropic-ai/sdk
    const AnthropicAI = require("@anthropic-ai/sdk");
    const anthropic = new AnthropicAI({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    this.anthropic = anthropic;
    this.model =
      modelPreference ||
      process.env.ANTHROPIC_MODEL_PREF ||
      "claude-3-5-sonnet-20241022";
    this.limits = {
      history: this.promptWindowLimit() * 0.15,
      system: this.promptWindowLimit() * 0.15,
      user: this.promptWindowLimit() * 0.7,
    };

    this.embedder = embedder ?? new NativeEmbedder();
    this.defaultTemp = 0.7;
    this.log(`Initialized with ${this.model}`);
  }

  log(text, ...args) {
    console.log(`\x1b[36m[${this.constructor.name}]\x1b[0m ${text}`, ...args);
  }

  streamingEnabled() {
    return "streamGetChatCompletion" in this;
  }

  static promptWindowLimit(modelName) {
    return MODEL_MAP.anthropic[modelName] ?? 100_000;
  }

  promptWindowLimit() {
    return MODEL_MAP.anthropic[this.model] ?? 100_000;
  }

  isValidChatCompletionModel(_modelName = "") {
    return true;
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
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mime,
          data: attachment.contentString.split("base64,")[1],
        },
      });
    }
    return content.flat();
  }

  // Modified #appendContext to accept userPrompt and conditionally include metadata
  #appendContext(contextDocuments = [], userPrompt = "") {
    if (!contextDocuments || !contextDocuments.length) return "";

    const includeMetadata = !userPrompt.includes('[nometa]');
    //this.log(`#appendContext: Metadata inclusion flag '[nometa]' ${includeMetadata ? 'not found' : 'found'}. Including metadata: ${includeMetadata}`);

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

          try { parsedParameters = relevantMeta.parameters ? JSON.parse(relevantMeta.parameters) : []; } catch (e) { console.error(`[Anthropic Context] Failed to parse parameters: ${relevantMeta.parameters}`, e); }
          try { parsedModifiers = relevantMeta.modifiers ? JSON.parse(relevantMeta.modifiers) : {}; } catch (e) { console.error(`[Anthropic Context] Failed to parse modifiers: ${relevantMeta.modifiers}`, e); }
          try { parsedImplementsInterfaces = relevantMeta.implementsInterfaces ? JSON.parse(relevantMeta.implementsInterfaces) : []; } catch (e) { console.error(`[Anthropic Context] Failed to parse implementsInterfaces: ${relevantMeta.implementsInterfaces}`, e); }
          try { parsedUsesTraits = relevantMeta.usesTraits ? JSON.parse(relevantMeta.usesTraits) : []; } catch (e) { console.error(`[Anthropic Context] Failed to parse usesTraits: ${relevantMeta.usesTraits}`, e); }
          try { parsedRegistersHooks = relevantMeta.registersHooks ? JSON.parse(relevantMeta.registersHooks) : []; } catch (e) { console.error(`[Anthropic Context] Failed to parse registersHooks: ${relevantMeta.registersHooks}`, e); }
          try { parsedTriggersHooks = relevantMeta.triggersHooks ? JSON.parse(relevantMeta.triggersHooks) : []; } catch (e) { console.error(`[Anthropic Context] Failed to parse triggersHooks: ${relevantMeta.triggersHooks}`, e); }
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

    //this.log("#appendContext: Generated formatted context string."); // Simplified log message
    return fullContextString;
  }

  constructPrompt({
    systemPrompt = "",
    contextDocuments = [],
    chatHistory = [],
    userPrompt = "",
    attachments = [], // This is the specific attachment for only this prompt
  }) {
    // Pass userPrompt to #appendContext
    const formattedContext = this.#appendContext(contextDocuments, userPrompt);

    // Check and remove the flag from the userPrompt before using it
    const finalUserPrompt = userPrompt.includes('[nometa]')
                             ? userPrompt.replace('[nometa]', '').trim()
                             : userPrompt;

    const prompt = {
      role: "system",
      content: `${systemPrompt}${formattedContext}`,
    };

    return [
      prompt,
      ...formatChatHistory(chatHistory, this.#generateContent),
      {
        role: "user",
        // Use the potentially modified finalUserPrompt
        content: this.#generateContent({ userPrompt: finalUserPrompt, attachments }),
      },
    ];
  }

  async getChatCompletion(messages = null, { temperature = 0.7 }) {
    try {
      const result = await LLMPerformanceMonitor.measureAsyncFunction(
        this.anthropic.messages.create({
          model: this.model,
          max_tokens: 4096,
          system: messages[0].content, // Strip out the system message
          messages: messages.slice(1), // Pop off the system message
          temperature: Number(temperature ?? this.defaultTemp),
        })
      );

      const promptTokens = result.output.usage.input_tokens;
      const completionTokens = result.output.usage.output_tokens;
      return {
        textResponse: result.output.content[0].text,
        metrics: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
          outputTps: completionTokens / result.duration,
          duration: result.duration,
        },
      };
    } catch (error) {
      console.log(error);
      return { textResponse: error, metrics: {} };
    }
  }

  async streamGetChatCompletion(messages = null, { temperature = 0.7 }) {
    const measuredStreamRequest = await LLMPerformanceMonitor.measureStream(
      this.anthropic.messages.stream({
        model: this.model,
        max_tokens: 4096,
        system: messages[0].content, // Strip out the system message
        messages: messages.slice(1), // Pop off the system message
        temperature: Number(temperature ?? this.defaultTemp),
      }),
      messages,
      false
    );

    return measuredStreamRequest;
  }

  /**
   * Handles the stream response from the Anthropic API.
   * @param {Object} response - the response object
   * @param {import('../../helpers/chat/LLMPerformanceMonitor').MonitoredStream} stream - the stream response from the Anthropic API w/tracking
   * @param {Object} responseProps - the response properties
   * @returns {Promise<string>}
   */
  handleStream(response, stream, responseProps) {
    return new Promise((resolve) => {
      let fullText = "";
      const { uuid = v4(), sources = [] } = responseProps;
      let usage = {
        prompt_tokens: 0,
        completion_tokens: 0,
      };

      // Establish listener to early-abort a streaming response
      // in case things go sideways or the user does not like the response.
      // We preserve the generated text but continue as if chat was completed
      // to preserve previously generated content.
      const handleAbort = () => {
        stream?.endMeasurement(usage);
        clientAbortedHandler(resolve, fullText);
      };
      response.on("close", handleAbort);

      stream.on("error", (event) => {
        const parseErrorMsg = (event) => {
          const error = event?.error?.error;
          if (!!error)
            return `Anthropic Error:${error?.type || "unknown"} ${
              error?.message || "unknown error."
            }`;
          return event.message;
        };

        writeResponseChunk(response, {
          uuid,
          sources: [],
          type: "abort",
          textResponse: null,
          close: true,
          error: parseErrorMsg(event),
        });
        response.removeListener("close", handleAbort);
        stream?.endMeasurement(usage);
        resolve(fullText);
      });

      stream.on("streamEvent", (message) => {
        const data = message;

        if (data.type === "message_start")
          usage.prompt_tokens = data?.message?.usage?.input_tokens;
        if (data.type === "message_delta")
          usage.completion_tokens = data?.usage?.output_tokens;

        if (
          data.type === "content_block_delta" &&
          data.delta.type === "text_delta"
        ) {
          const text = data.delta.text;
          fullText += text;

          writeResponseChunk(response, {
            uuid,
            sources,
            type: "textResponseChunk",
            textResponse: text,
            close: false,
            error: false,
          });
        }

        if (
          message.type === "message_stop" ||
          (data.stop_reason && data.stop_reason === "end_turn")
        ) {
          writeResponseChunk(response, {
            uuid,
            sources,
            type: "textResponseChunk",
            textResponse: "",
            close: true,
            error: false,
          });
          response.removeListener("close", handleAbort);
          stream?.endMeasurement(usage);
          resolve(fullText);
        }
      });
    });
  }

  async compressMessages(promptArgs = {}, rawHistory = []) {
    const { messageStringCompressor } = require("../../helpers/chat");
    const compressedPrompt = await messageStringCompressor(
      this,
      promptArgs,
      rawHistory
    );
    return compressedPrompt;
  }

  // Simple wrapper for dynamic embedder & normalize interface for all LLM implementations
  async embedTextInput(textInput) {
    return await this.embedder.embedTextInput(textInput);
  }
  async embedChunks(textChunks = []) {
    return await this.embedder.embedChunks(textChunks);
  }
}

module.exports = {
  AnthropicLLM,
};
