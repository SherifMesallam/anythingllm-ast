const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const {
  LLMPerformanceMonitor,
} = require("../../helpers/chat/LLMPerformanceMonitor");
const { v4: uuidv4 } = require("uuid");
const { MODEL_MAP } = require("../modelMap");
const {
  writeResponseChunk,
  clientAbortedHandler,
} = require("../../helpers/chat/responses");

class DeepSeekLLM {
  constructor(embedder = null, modelPreference = null) {
    if (!process.env.DEEPSEEK_API_KEY)
      throw new Error("No DeepSeek API key was set.");
    const { OpenAI: OpenAIApi } = require("openai");

    this.openai = new OpenAIApi({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com/v1",
    });
    this.model =
      modelPreference || process.env.DEEPSEEK_MODEL_PREF || "deepseek-chat";
    this.limits = {
      history: this.promptWindowLimit() * 0.15,
      system: this.promptWindowLimit() * 0.15,
      user: this.promptWindowLimit() * 0.7,
    };

    this.embedder = embedder ?? new NativeEmbedder();
    this.defaultTemp = 0.7;
    this.log("Initialized with model:", this.model);
  }

  log(text, ...args) {
    console.log(`\x1b[36m[${this.constructor.name}]\x1b[0m ${text}`, ...args);
  }

  #appendContext(contextDocuments = [], userPrompt = "") {
    if (!contextDocuments || !contextDocuments.length) return "";

    const includeMetadata = !userPrompt.includes('[nometa]');
    this.log(`#appendContext: Metadata inclusion flag '[nometa]' ${includeMetadata ? 'not found' : 'found'}. Including metadata: ${includeMetadata}`);

    let fullContextString = "\nContext:\n";

    if (includeMetadata) {
      fullContextString += contextDocuments
        .map((doc, i) => {
          const text = doc.text || doc.pageContent || "";
          const metadata = doc.metadata || doc;

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
            extendsClass: metadata.extendsClass || null, 
            implementsInterfaces: metadata.implementsInterfaces || null, 
            usesTraits: metadata.usesTraits || null, 
          };
          
          let parsedParameters = [];
          let parsedModifiers = {};
          let parsedImplementsInterfaces = [];
          let parsedUsesTraits = [];
          let parsedRegistersHooks = [];
          let parsedTriggersHooks = [];

          try { parsedParameters = relevantMeta.parameters ? JSON.parse(relevantMeta.parameters) : []; } catch (e) { console.error(`[DeepSeek Context] Failed to parse parameters: ${relevantMeta.parameters}`, e); }
          try { parsedModifiers = relevantMeta.modifiers ? JSON.parse(relevantMeta.modifiers) : {}; } catch (e) { console.error(`[DeepSeek Context] Failed to parse modifiers: ${relevantMeta.modifiers}`, e); }
          try { parsedImplementsInterfaces = relevantMeta.implementsInterfaces ? JSON.parse(relevantMeta.implementsInterfaces) : []; } catch (e) { console.error(`[DeepSeek Context] Failed to parse implementsInterfaces: ${relevantMeta.implementsInterfaces}`, e); }
          try { parsedUsesTraits = relevantMeta.usesTraits ? JSON.parse(relevantMeta.usesTraits) : []; } catch (e) { console.error(`[DeepSeek Context] Failed to parse usesTraits: ${relevantMeta.usesTraits}`, e); }
          try { parsedRegistersHooks = relevantMeta.registersHooks ? JSON.parse(relevantMeta.registersHooks) : []; } catch (e) { console.error(`[DeepSeek Context] Failed to parse registersHooks: ${relevantMeta.registersHooks}`, e); }
          try { parsedTriggersHooks = relevantMeta.triggersHooks ? JSON.parse(relevantMeta.triggersHooks) : []; } catch (e) { console.error(`[DeepSeek Context] Failed to parse triggersHooks: ${relevantMeta.triggersHooks}`, e); }
          
          let formattedChunk = `--- Context Chunk ${i + 1} ---\n`;
          formattedChunk += `Source File: ${relevantMeta.file}\n`;
          if (relevantMeta.language) formattedChunk += `Language: ${relevantMeta.language}\n`;
          if (relevantMeta.featureContext) formattedChunk += `Feature Context: ${relevantMeta.featureContext}\n`;
          if (relevantMeta.type) formattedChunk += `Element Type: ${relevantMeta.type}\n`;

          if (relevantMeta.language === 'css') {
              if (relevantMeta.type === 'rule' && relevantMeta.selector) {
                   formattedChunk += `CSS Selector: ${relevantMeta.selector}\n`;
              } else if (relevantMeta.type === 'atRule' && relevantMeta.atRuleName) {
                   const paramsStr = relevantMeta.atRuleParams ? ` ${relevantMeta.atRuleParams}` : '';
                   formattedChunk += `CSS At-Rule: @${relevantMeta.atRuleName}${paramsStr}\n`;
              }
          } 
          else {
              if (relevantMeta.name) formattedChunk += `Element Name: ${relevantMeta.name}\n`;
              if (relevantMeta.parent) formattedChunk += `Parent Context: ${relevantMeta.parent}\n`;
              if (parsedModifiers.visibility) formattedChunk += `Visibility: ${parsedModifiers.visibility}\n`;
          }
          
          if (relevantMeta.lines) formattedChunk += `Lines: ${relevantMeta.lines}\n`;

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
    } else {
      fullContextString += contextDocuments
        .map((doc, i) => {
          const text = doc.text || doc.pageContent || "";
          const metadata = doc.metadata || doc;
          const sourceFile = metadata.filePath || metadata.title || metadata.filename || metadata.source || 'Unknown';
          const cleanedText = text.replace(/<document_metadata>[\s\S]*?<\/document_metadata>\n*\n*/, '');
          return `--- Context Chunk ${i + 1} ---\nSource File: ${sourceFile}\n--- Code/Text ---\n${cleanedText}\n--- End Context Chunk ${i + 1} ---\n\n`;
        })
        .join("");
    }

    this.log("#appendContext: Generated formatted context string.");
    return fullContextString;
  }

  streamingEnabled() {
    return "streamGetChatCompletion" in this;
  }

  static promptWindowLimit(modelName) {
    return MODEL_MAP.deepseek[modelName] ?? 8192;
  }

  promptWindowLimit() {
    return MODEL_MAP.deepseek[this.model] ?? 8192;
  }

  async isValidChatCompletionModel(modelName = "") {
    const models = await this.openai.models.list().catch(() => ({ data: [] }));
    return models.data.some((model) => model.id === modelName);
  }

  constructPrompt({
    systemPrompt = "",
    contextDocuments = [],
    chatHistory = [],
    userPrompt = "",
  }) {
    const formattedContext = this.#appendContext(contextDocuments, userPrompt);

    const finalUserPrompt = userPrompt.includes('[nometa]') 
                             ? userPrompt.replace('[nometa]', '').trim() 
                             : userPrompt;
    
    const prompt = {
      role: "system",
      content: `${systemPrompt}${formattedContext}`,
    };
    return [prompt, ...chatHistory, { role: "user", content: finalUserPrompt }];
  }

  /**
   * Parses and prepends reasoning from the response and returns the full text response.
   * @param {Object} response
   * @returns {string}
   */
  #parseReasoningFromResponse({ message }) {
    let textResponse = message?.content;
    if (
      !!message?.reasoning_content &&
      message.reasoning_content.trim().length > 0
    )
      textResponse = `<think>${message.reasoning_content}</think>${textResponse}`;
    return textResponse;
  }

  async getChatCompletion(messages = null, { temperature = 0.7 }) {
    if (!(await this.isValidChatCompletionModel(this.model)))
      throw new Error(
        `DeepSeek chat: ${this.model} is not valid for chat completion!`
      );

    const result = await LLMPerformanceMonitor.measureAsyncFunction(
      this.openai.chat.completions
        .create({
          model: this.model,
          messages,
          temperature,
        })
        .catch((e) => {
          throw new Error(e.message);
        })
    );

    if (
      !result?.output?.hasOwnProperty("choices") ||
      result?.output?.choices?.length === 0
    )
      throw new Error(
        `Invalid response body returned from DeepSeek: ${JSON.stringify(result.output)}`
      );

    return {
      textResponse: this.#parseReasoningFromResponse(result.output.choices[0]),
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
    if (!(await this.isValidChatCompletionModel(this.model)))
      throw new Error(
        `DeepSeek chat: ${this.model} is not valid for chat completion!`
      );

    const measuredStreamRequest = await LLMPerformanceMonitor.measureStream(
      this.openai.chat.completions.create({
        model: this.model,
        stream: true,
        messages,
        temperature,
      }),
      messages,
      false
    );

    return measuredStreamRequest;
  }

  // TODO: This is a copy of the generic handleStream function in responses.js
  // to specifically handle the DeepSeek reasoning model `reasoning_content` field.
  // When or if ever possible, we should refactor this to be in the generic function.
  handleStream(response, stream, responseProps) {
    const { uuid = uuidv4(), sources = [] } = responseProps;
    let hasUsageMetrics = false;
    let usage = {
      completion_tokens: 0,
    };

    return new Promise(async (resolve) => {
      let fullText = "";
      let reasoningText = "";

      // Establish listener to early-abort a streaming response
      // in case things go sideways or the user does not like the response.
      // We preserve the generated text but continue as if chat was completed
      // to preserve previously generated content.
      const handleAbort = () => {
        stream?.endMeasurement(usage);
        clientAbortedHandler(resolve, fullText);
      };
      response.on("close", handleAbort);

      try {
        for await (const chunk of stream) {
          const message = chunk?.choices?.[0];
          const token = message?.delta?.content;
          const reasoningToken = message?.delta?.reasoning_content;

          if (
            chunk.hasOwnProperty("usage") && // exists
            !!chunk.usage && // is not null
            Object.values(chunk.usage).length > 0 // has values
          ) {
            if (chunk.usage.hasOwnProperty("prompt_tokens")) {
              usage.prompt_tokens = Number(chunk.usage.prompt_tokens);
            }

            if (chunk.usage.hasOwnProperty("completion_tokens")) {
              hasUsageMetrics = true; // to stop estimating counter
              usage.completion_tokens = Number(chunk.usage.completion_tokens);
            }
          }

          // Reasoning models will always return the reasoning text before the token text.
          if (reasoningToken) {
            // If the reasoning text is empty (''), we need to initialize it
            // and send the first chunk of reasoning text.
            if (reasoningText.length === 0) {
              writeResponseChunk(response, {
                uuid,
                sources: [],
                type: "textResponseChunk",
                textResponse: `<think>${reasoningToken}`,
                close: false,
                error: false,
              });
              reasoningText += `<think>${reasoningToken}`;
              continue;
            } else {
              writeResponseChunk(response, {
                uuid,
                sources: [],
                type: "textResponseChunk",
                textResponse: reasoningToken,
                close: false,
                error: false,
              });
              reasoningText += reasoningToken;
            }
          }

          // If the reasoning text is not empty, but the reasoning token is empty
          // and the token text is not empty we need to close the reasoning text and begin sending the token text.
          if (!!reasoningText && !reasoningToken && token) {
            writeResponseChunk(response, {
              uuid,
              sources: [],
              type: "textResponseChunk",
              textResponse: `</think>`,
              close: false,
              error: false,
            });
            fullText += `${reasoningText}</think>`;
            reasoningText = "";
          }

          if (token) {
            fullText += token;
            // If we never saw a usage metric, we can estimate them by number of completion chunks
            if (!hasUsageMetrics) usage.completion_tokens++;
            writeResponseChunk(response, {
              uuid,
              sources: [],
              type: "textResponseChunk",
              textResponse: token,
              close: false,
              error: false,
            });
          }

          // LocalAi returns '' and others return null on chunks - the last chunk is not "" or null.
          // Either way, the key `finish_reason` must be present to determine ending chunk.
          if (
            message?.hasOwnProperty("finish_reason") && // Got valid message and it is an object with finish_reason
            message.finish_reason !== "" &&
            message.finish_reason !== null
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
            break; // Break streaming when a valid finish_reason is first encountered
          }
        }
      } catch (e) {
        console.log(`\x1b[43m\x1b[34m[STREAMING ERROR]\x1b[0m ${e.message}`);
        writeResponseChunk(response, {
          uuid,
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: e.message,
        });
        stream?.endMeasurement(usage);
        resolve(fullText); // Return what we currently have - if anything.
      }
    });
  }

  async embedTextInput(textInput) {
    return await this.embedder.embedTextInput(textInput);
  }
  async embedChunks(textChunks = []) {
    return await this.embedder.embedChunks(textChunks);
  }

  async compressMessages(promptArgs = {}, rawHistory = []) {
    const { messageArrayCompressor } = require("../../helpers/chat");
    const messageArray = this.constructPrompt(promptArgs);
    return await messageArrayCompressor(this, messageArray, rawHistory);
  }
}

module.exports = {
  DeepSeekLLM,
};
