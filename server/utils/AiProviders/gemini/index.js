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
const { formatToolsForGemini } = require("../../llm/tools");
const cacheFolder = path.resolve(
  process.env.STORAGE_DIR
    ? path.resolve(process.env.STORAGE_DIR, "models", "gemini")
    : path.resolve(__dirname, `../../../storage/models/gemini`)
);

// Import necessary components from Google Generative AI SDK
const {
  GoogleGenerativeAI,
  HarmCategory,
  HarmBlockThreshold,
} = require("@google/generative-ai");

// Define tools using FunctionDeclaration schema
const tools = [
  {
    functionDeclarations: [
      {
        name: "ask_user_for_clarification",
        description: "Ask the user a clarifying question when the request or context is ambiguous.",
        parameters: {
          type: "OBJECT",
          properties: {
            question_for_user: {
              type: "STRING",
              description: "The specific question to ask the user.",
            },
          },
          required: ["question_for_user"],
        },
      },
      {
        name: "search_documents",
        description: "Search the available documents for more information relevant to a specific query. Use context chunks like [CONTEXT 0]...[END CONTEXT 0] to understand the available information first.",
        parameters: {
          type: "OBJECT",
          properties: {
            search_query: {
              type: "STRING",
              description: "The specific query to search for in the documents.",
            },
          },
          required: ["search_query"],
        },
      },
      {
        name: "get_file_content",
        description: "Retrieves the content of a specific file from a GitHub repository.",
        parameters: {
          type: "OBJECT",
          properties: {
            repository: {
              type: "STRING",
              description: "The GitHub repository in 'owner/repo' format.",
            },
            file_path: {
              type: "STRING",
              description: "The full path to the file within the repository.",
            },
          },
          required: ["repository", "file_path"],
        },
      },
    ],
  },
];

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

    // Initialize GoogleGenerativeAI
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  }

  static supportsTools() {
    // Most recent Gemini models support function calling
    // We could add model-specific checks later if needed
    return true;
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

  #appendContext(contextTexts = []) {
    if (!contextTexts || !contextTexts.length) return "";
    return (
      "\nContext:\n" +
      contextTexts
        .map((text, i) => {
          return `[CONTEXT ${i}]:\n${text}\n[END CONTEXT ${i}]\n\n`;
        })
        .join("")
    );
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
    const models = await GeminiLLM.fetchModels(process.env.GEMINI_API_KEY);
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
   * @param {{attachments: import("../../helpers").Attachment[]}} param0
   * @returns
   */
  constructPrompt({
    systemPrompt = "",
    contextTexts = [],
    chatHistory = [],
    userPrompt = "",
    attachments = [], // This is the specific attachment for only this prompt
  }) {
    let prompt = [];
    if (this.supportsSystemPrompt) {
      prompt.push({
        role: "system",
        content: `${systemPrompt}${this.#appendContext(contextTexts)}`,
      });
    } else {
      this.#log(
        `${this.model} - does not support system prompts - emulating...`
      );
      prompt.push(
        {
          role: "user",
          content: `${systemPrompt}${this.#appendContext(contextTexts)}`,
        },
        {
          role: "assistant",
          content: "Okay.",
        }
      );
    }

    return [
      ...prompt,
      ...formatChatHistory(chatHistory, this.#generateContent),
      {
        role: "user",
        content: this.#generateContent({ userPrompt, attachments }),
      },
    ];
  }

  async getChatCompletion(messages = null, { temperature = 0.7 }) {
    if (!(await this.isValidChatCompletionModel(this.model)))
      throw new Error(
        `Gemini chat: ${this.model} is not valid for chat completion!`
      );

    // Convert message history to Gemini format (alternating user/model roles)
    // And handle system prompt based on model support
    const { history: geminiHistory, systemInstruction } = this.#formatMessagesForGemini(messages);

    // Define tools using formatter for this call
    const toolsForApi = formatToolsForGemini();

    // Prepare model instance with potential system instruction for this call
    const modelInstance = this.genAI.getGenerativeModel({
      model: this.model,
      ...(systemInstruction && { systemInstruction }),
    });

    const chat = modelInstance.startChat({
      history: geminiHistory,
    });

    // Get the last user message content
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== 'user') {
       throw new Error("Last message in history must be from user for Gemini chat.");
    }
    const lastUserContent = lastMessage.content; // Assuming content is string or compatible format

    this.#log(`Sending request to Gemini model ${this.model}...`);
    const result = await LLMPerformanceMonitor.measureAsyncFunction(
       chat.sendMessage(lastUserContent, { tools: toolsForApi }) // Pass formatted tools here
      .catch((e) => {
         console.error("Gemini API Error:", e);
         throw new Error(
          `Gemini::getChatCompletion failed. ${e.message || "Unknown error"}`
        );
      })
    );

    const response = result.output?.response;
    if (!response) {
      console.error("Gemini response was empty or invalid.");
      return null;
    }

    const candidate = response.candidates?.[0];
    if (!candidate) {
      console.error("No candidates found in Gemini response.", response);
       // Check for blocked prompt
       if (response.promptFeedback?.blockReason) {
         throw new Error(`Gemini prompt blocked: ${response.promptFeedback.blockReason}`);
       }
      return null;
    }

    // Check for function call
    const functionCallPart = candidate.content?.parts?.find(part => part.functionCall);
    if (functionCallPart?.functionCall) {
      this.#log("Gemini responded with a function call.");
      return {
        functionCall: functionCallPart.functionCall, // Return the functionCall object
        // We need the *assistant's response* containing the function call to add to history
        // Gemini's `response` object might contain this structure, let's assume it does for now.
        // The candidate.content object `{parts: [{functionCall: ...}], role: 'model'}` is likely what we need.
        message: candidate.content,
        metrics: {
          // Gemini API (REST) doesn't directly return token counts in the same way.
          // Need to estimate or omit if not available via the SDK/method used.
          prompt_tokens: response.usageMetadata?.promptTokenCount || 0,
          completion_tokens: response.usageMetadata?.candidatesTokenCount || 0,
          total_tokens: response.usageMetadata?.totalTokenCount || 0,
          outputTps: 0, // Cannot calculate without completion tokens / precise timing
          duration: result.duration,
        },
      };
    }

    // Check for blocked response
    if (candidate.finishReason === 'SAFETY') {
       console.error("Gemini response blocked due to safety settings.", candidate.safetyRatings);
       throw new Error(`Gemini response blocked due to safety settings: ${candidate.safetyRatings?.map(r => r.category).join(', ')}`);
    }
    if (candidate.finishReason === 'RECITATION') {
       console.error("Gemini response blocked due to recitation.", candidate.citationMetadata);
       throw new Error("Gemini response blocked due to recitation.");
    }

    // If no function call and not blocked, return text response
    const textResponse = response.text ? response.text() : null; // Use text() helper

    if (!textResponse) {
      console.error("No text content found in Gemini response candidate.", candidate);
      return null;
    }

    return {
      textResponse: textResponse,
      metrics: {
        prompt_tokens: response.usageMetadata?.promptTokenCount || 0,
        completion_tokens: response.usageMetadata?.candidatesTokenCount || 0, // Or .completionTokenCount if available
        total_tokens: response.usageMetadata?.totalTokenCount || 0,
        outputTps: (response.usageMetadata?.candidatesTokenCount || 0) / result.duration,
        duration: result.duration,
      },
    };
  }

  #formatMessagesForGemini(messages) {
    const history = [];
    let systemInstruction = null;
    let currentRole = null;
    let currentParts = [];

    for (const message of messages) {
      // Handle System Prompt based on model support
      if (message.role === 'system') {
         if (this.supportsSystemPrompt) {
            // Format according to Content object structure: { parts: [{ text: ... }] }
            systemInstruction = { parts: [{ text: message.content }] };
         } else {
            // Prepend system prompt to the first user message if not supported natively
            const firstUserIndex = messages.findIndex(m => m.role === 'user');
            if (firstUserIndex !== -1 && messages[firstUserIndex] === message) {
              messages[firstUserIndex].content = message.content + "\n\n" + messages[firstUserIndex].content;
            }
         }
         continue; // Skip adding system message to history array
      }

      // Gemini requires alternating user/model roles.
      // Combine consecutive messages of the same role if necessary (e.g., tool results)
      const role = message.role === 'assistant' || message.role === 'model' ? 'model' : 'user';

      // Handle tool calls (which come from 'assistant'/'model' role)
      if (message.tool_calls || message.functionCall) {
        // If previous message was also model, append parts, otherwise start new entry
        if (currentRole === 'model') {
          currentParts.push({ functionCall: message.functionCall || message.tool_calls[0].function }); // Adapt based on actual structure
        } else {
           if(currentRole) history.push({ role: currentRole, parts: currentParts }); // Push previous role first
           currentRole = 'model';
           currentParts = [{ functionCall: message.functionCall || message.tool_calls[0].function }]; // Adapt
        }
        continue;
      }

      // Handle tool results (which come from 'tool' role) -> map to functionResponse part
      if (message.role === 'tool') {
         // Tool results MUST follow a functionCall from the 'model'
         if (currentRole !== 'model' || !currentParts.some(p => p.functionCall)) {
            console.warn("Tool message received without preceding function call. Skipping.");
            continue;
         }
         currentParts.push({
           functionResponse: {
             name: message.name, // name comes from the tool message
             response: { content: message.content }, // Content needs to be nested
           }
         });
         // Do not switch role here, tool response is part of the 'model' turn
         continue;
      }

      // Regular text content
      const textContent = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

      if (role === currentRole) {
        // Same role as previous message, combine content
        currentParts.push({ text: textContent });
      } else {
        // Different role, push previous message block and start new one
        if (currentRole) {
          history.push({ role: currentRole, parts: currentParts });
        }
        currentRole = role;
        currentParts = [{ text: textContent }];
      }
    }

    // Push the last message block
    if (currentRole) {
      history.push({ role: currentRole, parts: currentParts });
    }

    // Ensure history ends with a user message for the actual chat.sendMessage call later
    // The actual last user message is handled separately by chat.sendMessage
    const lastUserMessageIndex = history.findIndex((item, index) => index === history.length -1 && item.role === 'user');
    if(lastUserMessageIndex !== -1) history.pop();

    return { history, systemInstruction };
  }

  async streamGetChatCompletion(messages = null, { temperature = 0.7 }) {
    if (!(await this.isValidChatCompletionModel(this.model)))
      throw new Error(
        `Gemini chat: ${this.model} is not valid for chat completion!`
      );

     // Convert message history to Gemini format (alternating user/model roles)
    // And handle system prompt based on model support
    const { history: geminiHistory, systemInstruction } = this.#formatMessagesForGemini(messages);

    // Define tools using formatter for this call
    const toolsForApi = formatToolsForGemini();

    // Prepare model instance with potential system instruction for this call
    const modelInstance = this.genAI.getGenerativeModel({
      model: this.model,
      ...(systemInstruction && { systemInstruction }),
    });

    // Get the last user message content
    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role !== 'user') {
       throw new Error("Last message in history must be from user for Gemini stream.");
    }
    const lastUserContent = lastMessage.content; // Assuming content is string or compatible format

    this.#log(`Streaming request to Gemini model ${this.model}...`);

    // Note: PerformanceMonitor needs adaptation for streams that yield multiple types (text, functionCall)
    // Call generateContentStream and await the initial response object containing stream and response promise
    const streamingResult = await modelInstance.generateContentStream({
        contents: [...geminiHistory, { role: 'user', parts: [{ text: lastUserContent }] }],
        tools: toolsForApi, // Pass formatted tools here
      }).catch((e) => {
         console.error("Gemini API Stream Error:", e);
         throw new Error(
          `Gemini::streamGetChatCompletion failed. ${e.message || "Unknown error"}`
        );
      });

    // Return the entire streaming result object, which includes both the
    // async iterator (`stream`) and a promise for the final aggregated response (`response`)
    return streamingResult;
  }

  // Modify handleStream to expect the full streamingResult object
  handleStream(response, streamResult, responseProps) {
     // Extract the stream iterator and the response promise
     const { stream, response: responsePromise } = streamResult;

     // Pass both stream and responsePromise to the generator
     return handleGeminiStreamResponseV2Generator(stream, responsePromise, responseProps);
  }

  async compressMessages(promptArgs = {}, rawHistory = []) {
    const { messageArrayCompressor } = require("../../helpers/chat");
    const messageArray = this.constructPrompt(promptArgs);
    return await messageArrayCompressor(this, messageArray, rawHistory);
  }

  // Simple wrapper for dynamic embedder & normalize interface for all LLM implementations
  async embedTextInput(textInput) {
    return await this.embedder.embedTextInput(textInput);
  }
  async embedChunks(textChunks = []) {
    return await this.embedder.embedChunks(textChunks);
  }
}

// Update handleGeminiStreamResponseV2Generator to accept responsePromise and handle metrics
async function* handleGeminiStreamResponseV2Generator(stream, responsePromise, responseProps) {
  let fullText = "";
  let functionCallName = null;
  let functionCallArgs = "";
  let toolCallId = uuidv4(); // Generate a unique ID for the potential tool call
  let usageMetadata = null; // To store usage metadata

  try {
    for await (const chunk of stream) {
      // Check for safety ratings or blocks early
      if (chunk.promptFeedback?.blockReason) {
         console.error("Gemini stream prompt blocked:", chunk.promptFeedback.blockReason);
         // Yield an error chunk instead of writing directly
         yield {
           ...responseProps, // Include base props like uuid
           type: "abort",
           error: `Stream prompt blocked: ${chunk.promptFeedback.blockReason}`         };
         return; // Stop generation
      }
      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason === 'SAFETY') {
        console.error("Gemini stream response blocked due to safety.", candidate.safetyRatings);
        yield {
           ...responseProps,
           type: "abort",
           error: "Stream response blocked due to safety settings.",
         };
        return;
      }
       if (candidate?.finishReason === 'RECITATION') {
        console.error("Gemini stream response blocked due to recitation.", candidate.citationMetadata);
        yield {
           ...responseProps,
           type: "abort",
           error: "Stream response blocked due to recitation.",
         };
        return;
      }

      const functionCallChunk = candidate?.content?.parts?.find(part => part.functionCall);
      if (functionCallChunk?.functionCall) {
         // Aggregate function call parts
         if(functionCallChunk.functionCall.name) {
           functionCallName = functionCallChunk.functionCall.name;
         }
         // Gemini SDK provides args as object directly, aggregate carefully if chunked
         // Assuming for now args come in one chunk or SDK handles aggregation.
         // If args can be chunked, this aggregation needs refinement.
         if(functionCallChunk.functionCall.args) {
           // Attempt to merge args if received partially (simple merge, might need deeper logic)
           const currentArgs = safeJsonParse(functionCallArgs || '{}');
           functionCallArgs = JSON.stringify({ ...currentArgs, ...functionCallChunk.functionCall.args });
         }
      } else {
        // Process text chunk
        const textChunk = chunk.text ? chunk.text() : null; // Use text() method to get text
        if (textChunk !== null && textChunk !== undefined) { // Ensure textChunk is not null/undefined
          fullText += textChunk;
          // Yield a text chunk
          yield {
            ...responseProps,
            type: "textResponseChunk",
            textResponse: textChunk,
          };
        }
      }
    } // End of stream loop

    // After stream finishes, resolve the response promise to get final data like usageMetadata
    try {
      const finalResponse = await responsePromise;
      usageMetadata = finalResponse.usageMetadata;
      // Log the received usage metadata
      console.log("Gemini final response metadata:", JSON.stringify(usageMetadata || {}, null, 2));
    } catch (error) {
      console.error("Error awaiting Gemini final response:", error);
      // Decide if we should abort or just proceed without metrics
      // For now, let's log and continue, yielding metrics as null
    }


    // Check if a function call was received
    if (functionCallName) {
        console.log(`Gemini stream finished with function call: ${functionCallName}`);
        try {
           const parsedArgs = JSON.parse(functionCallArgs || '{}'); // Parse aggregated args string
           // Yield a tool call chunk
           yield {
             ...responseProps,
             type: "tool_call_chunk",
             toolCall: {
                id: toolCallId,
                function: {
                  name: functionCallName,
                  arguments: JSON.stringify(parsedArgs), // Send arguments as string
                },
             },
             // Include usageMetadata here if available
             usageMetadata: usageMetadata || null,
           };
           // Generator finishes, signaling the calling function to handle the tool call
         } catch (e) {
            console.error("Error parsing function call arguments from stream:", e);
            yield {
              ...responseProps,
              type: "abort",
              error: "Failed to parse tool call arguments.",
            };
         }
    } else {
       // If no function call, yield a finalize chunk containing the full text and metrics
       yield {
         ...responseProps,
         type: "finalizeTextStream", // Custom type to signal text completion
         fullText: fullText, // Include full text if needed by caller
         // Include usageMetadata here
         usageMetadata: usageMetadata || null,
       };
    }

  } catch (error) {
      console.error("Error processing Gemini stream:", error);
      yield {
          ...responseProps,
          type: "abort",
          error: `Error processing stream: ${error.message}`,
      };
  } finally {
    // Yield a final metrics chunk regardless of text/tool call outcome (unless aborted)
    // This standardizes how the caller receives final metrics.
    // Check if we aborted early; if so, usageMetadata might be null or incomplete.
    if (usageMetadata) {
       yield {
         ...responseProps,
         type: "finalizeStreamMetrics",
         metrics: {
             promptTokenCount: usageMetadata.promptTokenCount || 0,
             completionTokenCount: usageMetadata.candidatesTokenCount || 0, // Assuming candidateTokenCount maps to completion
             totalTokenCount: usageMetadata.totalTokenCount || 0,
         },
       };
    } else {
       // Yield empty metrics if not available or error occurred fetching them
       // We can still calculate duration in the caller.
       yield {
         ...responseProps,
         type: "finalizeStreamMetrics",
         metrics: {
             promptTokenCount: 0,
             completionTokenCount: 0,
             totalTokenCount: 0,
         },
       };
    }
  }
}

module.exports = {
  GeminiLLM,
  NO_SYSTEM_PROMPT_MODELS,
};
