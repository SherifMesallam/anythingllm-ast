const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const {
  LLMPerformanceMonitor,
} = require("../../helpers/chat/LLMPerformanceMonitor");
const {
  handleDefaultStreamResponseV2,
  formatChatHistory,
} = require("../../helpers/chat/responses");
const { MODEL_MAP } = require("../modelMap");

class XAiLLM {
  constructor(embedder = null, modelPreference = null) {
    if (!process.env.XAI_LLM_API_KEY)
      throw new Error("No xAI API key was set.");
    const { OpenAI: OpenAIApi } = require("openai");

    this.openai = new OpenAIApi({
      baseURL: "https://api.x.ai/v1",
      apiKey: process.env.XAI_LLM_API_KEY,
    });
    this.model =
      modelPreference || process.env.XAI_LLM_MODEL_PREF || "grok-beta";
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
          
          let formattedChunk = `--- Context Chunk ${i + 1} ---\n`;
          if (metadata.title) formattedChunk += `Title: ${metadata.title}\n`;
          if (metadata.docSource) formattedChunk += `Source: ${metadata.docSource}\n`;
          const cleanedText = text.replace(/<document_metadata>[\s\S]*?<\/document_metadata>\n*\n*/, '');
          formattedChunk += `--- Text ---\n${cleanedText}\n`;
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
          return `--- Context Chunk ${i + 1} ---\nSource File: ${sourceFile}\n--- Text ---\n${cleanedText}\n--- End Context Chunk ${i + 1} ---\n\n`;
        })
        .join("");
    }
    return fullContextString;
  }

  streamingEnabled() {
    return "streamGetChatCompletion" in this;
  }

  static promptWindowLimit(modelName) {
    return MODEL_MAP.xai[modelName] ?? 131_072;
  }

  promptWindowLimit() {
    return MODEL_MAP.xai[this.model] ?? 131_072;
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
    contextDocuments = [],
    chatHistory = [],
    userPrompt = "",
    attachments = [], // This is the specific attachment for only this prompt
  }) {
    const prompt = {
      role: "system",
      content: `${systemPrompt}${this.#appendContext(contextDocuments, userPrompt)}`,
    };
    return [
      prompt,
      ...formatChatHistory(chatHistory, this.#generateContent),
      {
        role: "user",
        content: this.#generateContent({ userPrompt, attachments }),
      },
    ];
  }

  async getChatCompletion(messages = null, { temperature = 0.7 }) {
    if (!this.isValidChatCompletionModel(this.model))
      throw new Error(
        `xAI chat: ${this.model} is not valid for chat completion!`
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
    if (!this.isValidChatCompletionModel(this.model))
      throw new Error(
        `xAI chat: ${this.model} is not valid for chat completion!`
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
  XAiLLM,
};
