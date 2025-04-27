const { NativeEmbedder } = require("../../EmbeddingEngines/native");
const {
  handleDefaultStreamResponseV2,
  formatChatHistory,
} = require("../../helpers/chat/responses");
const { MODEL_MAP } = require("../modelMap");
const {
  LLMPerformanceMonitor,
} = require("../../helpers/chat/LLMPerformanceMonitor");
const { v4: uuidv4 } = require("uuid");
const { formatToolsForOpenAI } = require("../../llm/tools");

class OpenAiLLM {
  constructor(embedder = null, modelPreference = null) {
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
    contextTexts = [],
    chatHistory = [],
    userPrompt = "",
    attachments = [], // This is the specific attachment for only this prompt
  }) {
    // o1 Models do not support the "system" role
    // in order to combat this, we can use the "user" role as a replacement for now
    // https://community.openai.com/t/o1-models-do-not-support-system-role-in-chat-completion/953880
    const prompt = {
      role: this.isOTypeModel ? "user" : "system",
      content: `${systemPrompt}${this.#appendContext(contextTexts)}`,
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
    if (!(await this.isValidChatCompletionModel(this.model)))
      throw new Error(
        `OpenAI chat: ${this.model} is not valid for chat completion!`
      );

    // Define the tools the LLM can call using the formatter
    const tools = formatToolsForOpenAI();

    const result = await LLMPerformanceMonitor.measureAsyncFunction(
      this.openai.chat.completions
        .create({
          model: this.model,
          messages,
          temperature: this.isOTypeModel ? 1 : temperature, // o1 models only accept temperature 1
          tools: tools, // Pass defined tools
          tool_choice: "auto", // Let the model decide whether to use tools
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

    const responseMessage = result.output.choices[0].message;

    // Check if the model wants to call a tool
    if (responseMessage.tool_calls) {
       // Return the tool calls information instead of a text response
       // The calling code will need to handle this, execute the tool, and call back.
       return {
         message: responseMessage,
         toolCalls: responseMessage.tool_calls,
         metrics: {
           prompt_tokens: result.output.usage?.prompt_tokens || 0,
           completion_tokens: result.output.usage?.completion_tokens || 0,
           total_tokens: result.output.usage?.total_tokens || 0,
           outputTps: 0,
           duration: result.duration,
         },
       };
    }

    // If no tool call, return the text response as before
    return {
      textResponse: responseMessage.content,
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
        `OpenAI chat: ${this.model} is not valid for chat completion!`
      );

    // Define tools here as well for the streaming call using the formatter
    const tools = formatToolsForOpenAI();

    // Directly return the stream from the OpenAI API call
    // Performance Monitor needs careful integration with generators; handle metrics later if possible.
    try {
      const stream = await this.openai.chat.completions.create({
        model: this.model,
        stream: true,
        messages,
        temperature: this.isOTypeModel ? 1 : temperature,
        tools: tools,
        tool_choice: "auto",
      });
      return { stream }; // Return the raw stream
    } catch (e) {
      console.error("OpenAI API Stream Error:", e);
      throw new Error(
        `OpenAI::streamGetChatCompletion failed. ${e.message || "Unknown error"}`
      );
    }
  }

  // Return the generator function
  handleStream(response, streamObject, responseProps) {
    const { stream } = streamObject;
    return handleOpenAIStreamResponseV2Generator(stream, responseProps);
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

  static supportsTools() {
    return true; // OpenAI supports function calling
  }
}

// Async generator function to handle OpenAI streaming response with tool calls
async function* handleOpenAIStreamResponseV2Generator(stream, responseProps) {
  let fullText = "";
  let currentToolCalls = [];
  let toolCallStarted = false;

  try {
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      const finishReason = chunk.choices?.[0]?.finish_reason;

      if (delta?.content) {
        const textChunk = delta.content;
        fullText += textChunk;
        yield {
          ...responseProps,
          type: "textResponseChunk",
          textResponse: textChunk,
        };
      }

      // Check for tool call start and chunks
      if (delta?.tool_calls) {
        toolCallStarted = true;
        for (const toolCallChunk of delta.tool_calls) {
          if (toolCallChunk.index >= currentToolCalls.length) {
            // Start of a new tool call
            currentToolCalls.push({
              id: toolCallChunk.id || `tool_${uuidv4()}`, // Ensure ID exists
              function: {
                name: toolCallChunk.function?.name || "",
                arguments: toolCallChunk.function?.arguments || "",
              },
              type: toolCallChunk.type || "function", // Usually 'function'
            });
          } else {
            // Append arguments to existing tool call
            const tc = currentToolCalls[toolCallChunk.index];
            if(toolCallChunk.function?.arguments) {
              tc.function.arguments += toolCallChunk.function.arguments;
            }
            // Update name if it arrives later (less common)
            if(toolCallChunk.function?.name) {
               tc.function.name = toolCallChunk.function.name;
            }
             // Update id if it arrives later (less common)
            if(toolCallChunk.id) {
               tc.id = toolCallChunk.id;
            }
          }
        }
      }

      // Stream finished
      if (finishReason) {
        if (finishReason === "tool_calls") {
          if (!toolCallStarted || currentToolCalls.length === 0) {
             throw new Error("Stream finished with 'tool_calls' but no tool call data was received.");
          }
          // Construct the assistant message that contained these tool calls
          const assistantMessage = {
             role: 'assistant',
             content: null,
             tool_calls: currentToolCalls.map(tc => ({ // Ensure structure matches API expectation
                 id: tc.id,
                 type: tc.type,
                 function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                 },
             }))
          };

          console.log("OpenAI stream finished with tool calls:", currentToolCalls);
          yield {
            ...responseProps,
            type: "tool_call_chunk",
            toolCalls: currentToolCalls, // Send the aggregated tool calls
            assistantMessage: assistantMessage // Send the reconstructed assistant message
          };
          return; // End generation after tool call
        } else if (finishReason === "stop") {
          console.log("OpenAI stream finished normally.");
          yield {
            ...responseProps,
            type: "finalizeTextStream",
            fullText: fullText,
          };
          return; // End generation
        } else {
           // Handle other finish reasons (length, content_filter, etc.) as errors/aborts
           console.error(`OpenAI stream finished unexpectedly: ${finishReason}`);
           yield {
             ...responseProps,
             type: "abort",
             error: `Stream finished unexpectedly: ${finishReason}`,
           };
           return;
        }
      }
    }
  } catch (error) {
    console.error("Error processing OpenAI stream:", error);
    yield {
      ...responseProps,
      type: "abort",
      error: `Error processing stream: ${error.message}`,
    };
  }
}

module.exports = {
  OpenAiLLM,
};
