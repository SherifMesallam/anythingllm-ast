const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const {
  LLMPerformanceMonitor,
} = require("../../helpers/chat/LLMPerformanceMonitor");
const {
  handleDefaultStreamResponseV2,
  formatChatHistory,
} = require("../../helpers/chat/responses");

class MistralLLM {
  constructor(embedder = null, modelPreference = null) {
    if (!process.env.MISTRAL_API_KEY)
      throw new Error("No Mistral API key was set.");

    const { OpenAI: OpenAIApi } = require("openai");
    this.openai = new OpenAIApi({
      baseURL: "https://api.mistral.ai/v1",
      apiKey: process.env.MISTRAL_API_KEY ?? null,
    });
    this.model =
      modelPreference || process.env.MISTRAL_MODEL_PREF || "mistral-tiny";
    this.limits = {
      history: this.promptWindowLimit() * 0.15,
      system: this.promptWindowLimit() * 0.15,
      user: this.promptWindowLimit() * 0.7,
    };

    this.embedder = embedder ?? new NativeEmbedder();
    this.defaultTemp = 0.0;
    this.log("Initialized with model:", this.model);
  }

  log(text, ...args) {
    console.log(`\x1b[36m[${this.constructor.name}]\x1b[0m ${text}`, ...args);
  }

  #appendContext(contextDocuments = [], userPrompt = "") {
    if (!contextDocuments || !contextDocuments.length) return "";

    const includeMetadata = !userPrompt.includes('[nometa]');
    //this.log(`#appendContext: Metadata inclusion flag '[nometa]' ${includeMetadata ? 'not found' : 'found'}. Including metadata: ${includeMetadata}`);

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

          try { parsedParameters = relevantMeta.parameters ? JSON.parse(relevantMeta.parameters) : []; } catch (e) { console.error(`[Mistral Context] Failed to parse parameters: ${relevantMeta.parameters}`, e); }
          try { parsedModifiers = relevantMeta.modifiers ? JSON.parse(relevantMeta.modifiers) : {}; } catch (e) { console.error(`[Mistral Context] Failed to parse modifiers: ${relevantMeta.modifiers}`, e); }
          try { parsedImplementsInterfaces = relevantMeta.implementsInterfaces ? JSON.parse(relevantMeta.implementsInterfaces) : []; } catch (e) { console.error(`[Mistral Context] Failed to parse implementsInterfaces: ${relevantMeta.implementsInterfaces}`, e); }
          try { parsedUsesTraits = relevantMeta.usesTraits ? JSON.parse(relevantMeta.usesTraits) : []; } catch (e) { console.error(`[Mistral Context] Failed to parse usesTraits: ${relevantMeta.usesTraits}`, e); }
          try { parsedRegistersHooks = relevantMeta.registersHooks ? JSON.parse(relevantMeta.registersHooks) : []; } catch (e) { console.error(`[Mistral Context] Failed to parse registersHooks: ${relevantMeta.registersHooks}`, e); }
          try { parsedTriggersHooks = relevantMeta.triggersHooks ? JSON.parse(relevantMeta.triggersHooks) : []; } catch (e) { console.error(`[Mistral Context] Failed to parse triggersHooks: ${relevantMeta.triggersHooks}`, e); }

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

    //this.log("#appendContext: Generated formatted context string.");
    return fullContextString;
  }

  streamingEnabled() {
    return "streamGetChatCompletion" in this;
  }

  static promptWindowLimit() {
    return 32000;
  }

  promptWindowLimit() {
    return 32000;
  }

  async isValidChatCompletionModel(modelName = "") {
    return true;
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
        image_url: attachment.contentString,
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
    contextDocuments = [],
    chatHistory = [],
    userPrompt = "",
    attachments = [], // This is the specific attachment for only this prompt
  }) {
    const formattedContext = this.#appendContext(contextDocuments, userPrompt);

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
        content: this.#generateContent({ userPrompt: finalUserPrompt, attachments }),
      },
    ];
  }

  async getChatCompletion(messages = null, { temperature = 0.7 }) {
    if (!(await this.isValidChatCompletionModel(this.model)))
      throw new Error(
        `Mistral chat: ${this.model} is not valid for chat completion!`
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
    if (!(await this.isValidChatCompletionModel(this.model)))
      throw new Error(
        `Mistral chat: ${this.model} is not valid for chat completion!`
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
    const { messageArrayCompressor } = require("../../helpers/chat");
    const messageArray = this.constructPrompt(promptArgs);
    return await messageArrayCompressor(this, messageArray, rawHistory);
  }
}

module.exports = {
  MistralLLM,
};
