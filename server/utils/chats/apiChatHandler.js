const { v4: uuidv4 } = require("uuid");
const { DocumentManager } = require("../DocumentManager");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { getVectorDbClass, getLLMProvider } = require("../helpers");
const { writeResponseChunk } = require("../helpers/chat/responses");
const {
  chatPrompt,
  sourceIdentifier,
  recentChatHistory,
  grepAllSlashCommands,
} = require("./index");
const {
  EphemeralAgentHandler,
  EphemeralEventListener,
} = require("../agents/ephemeral");
const { Telemetry } = require("../../models/telemetry");
const { safeJsonParse } = require("../http");
const {
  executeAskUserTool,
  executeSearchDocumentsTool,
  executeGetFileContentTool,
} = require("./toolExecutor");

/**
 * @typedef ResponseObject
 * @property {string} id - uuid of response
 * @property {string} type - Type of response
 * @property {string|null} textResponse - full text response
 * @property {object[]} sources
 * @property {boolean} close
 * @property {string|null} error
 * @property {object} metrics
 */

function extractUserQuery(fullMessage) {
  if (!fullMessage || typeof fullMessage !== 'string') return '';

  // Attempt to find "User: " and extract text after it
  const userPrefix = 'User: ';
  const userPrefixIndex = fullMessage.indexOf(userPrefix);

  if (userPrefixIndex !== -1) {
    let query = fullMessage.substring(userPrefixIndex + userPrefix.length);

    // Attempt to remove the "\n\nIMPORTANT:" part if it exists
    const importantPrefix = '\n\nIMPORTANT:';
    const importantPrefixIndex = query.indexOf(importantPrefix);
    if (importantPrefixIndex !== -1) {
      query = query.substring(0, importantPrefixIndex);
    }
    return query.trim(); // Return the trimmed query
  }

  // Fallback: If "User: " not found, return the original message trimmed
  // (Consider if a more robust fallback is needed)
  return fullMessage.trim();
}

/**
 * Handle synchronous chats with your workspace via the developer API endpoint
 * @param {{
 *  workspace: import("@prisma/client").workspaces,
 *  message:string,
 *  mode: "chat"|"query",
 *  user: import("@prisma/client").users|null,
 *  thread: import("@prisma/client").workspace_threads|null,
 *  sessionId: string|null,
 *  attachments: { name: string; mime: string; contentString: string }[],
 *  reset: boolean,
 * }} parameters
 * @returns {Promise<ResponseObject>}
 */
async function chatSync({
  workspace,
  message = null,
  mode = "chat",
  user = null,
  thread = null,
  sessionId = null,
  attachments = [],
  reset = false,
}) {
  const uuid = uuidv4();
  const chatMode = mode ?? "chat";
  const rawUserMessage = message; // Keep original for saving later if needed

  // If the user wants to reset the chat history we do so pre-flight
  // and continue execution. If no message is provided then the user intended
  // to reset the chat history only and we can exit early with a confirmation.
  if (reset) {
    await WorkspaceChats.markThreadHistoryInvalidV2({
      workspaceId: workspace.id,
      user_id: user?.id,
      thread_id: thread?.id,
      api_session_id: sessionId,
    });
    if (!message?.length) {
      return {
        id: uuid,
        type: "textResponse",
        textResponse: "Chat history was reset!",
        sources: [],
        close: true,
        error: null,
        metrics: {},
      };
    }
  }

  // Process slash commands
  // Since preset commands are not supported in API calls, we can just process the message here
  const processedMessage = await grepAllSlashCommands(rawUserMessage);
  const cleanUserQuery = extractUserQuery(processedMessage); // Extract the core query after slash commands
  message = processedMessage;

  if (EphemeralAgentHandler.isAgentInvocation({ message })) {
    await Telemetry.sendTelemetry("agent_chat_started");

    // Initialize the EphemeralAgentHandler to handle non-continuous
    // conversations with agents since this is over REST.
    const agentHandler = new EphemeralAgentHandler({
      uuid,
      workspace,
      prompt: message,
      userId: user?.id || null,
      threadId: thread?.id || null,
      sessionId,
    });

    // Establish event listener that emulates websocket calls
    // in Aibitat so that we can keep the same interface in Aibitat
    // but use HTTP.
    const eventListener = new EphemeralEventListener();
    await agentHandler.init();
    await agentHandler.createAIbitat({ handler: eventListener });
    agentHandler.startAgentCluster();

    // The cluster has started and now we wait for close event since
    // this is a synchronous call for an agent, so we return everything at once.
    // After this, we conclude the call as we normally do.
    return await eventListener
      .waitForClose()
      .then(async ({ thoughts, textResponse }) => {
        await WorkspaceChats.new({
          workspaceId: workspace.id,
          prompt: String(message),
          response: {
            text: textResponse,
            sources: [],
            attachments,
            type: chatMode,
            thoughts,
          },
          include: false,
          apiSessionId: sessionId,
        });
        return {
          id: uuid,
          type: "textResponse",
          sources: [],
          close: true,
          error: null,
          textResponse,
          thoughts,
        };
      });
  }

  const LLMConnector = getLLMProvider({
    provider: workspace?.chatProvider,
    model: workspace?.chatModel,
  });
  const VectorDb = getVectorDbClass();
  const messageLimit = workspace?.openAiHistory || 20;
  const hasVectorizedSpace = await VectorDb.hasNamespace(workspace.slug);
  const embeddingsCount = await VectorDb.namespaceCount(workspace.slug);

  // User is trying to query-mode chat a workspace that has no data in it - so
  // we should exit early as no information can be found under these conditions.
  if ((!hasVectorizedSpace || embeddingsCount === 0) && chatMode === "query") {
    const textResponse =
      workspace?.queryRefusalResponse ??
      "There is no relevant information in this workspace to answer your query.";

    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: rawUserMessage, // Save original
      response: {
        text: textResponse,
        sources: [],
        attachments: attachments,
        type: chatMode,
        metrics: {},
      },
      include: false,
      apiSessionId: sessionId,
    });

    return {
      id: uuid,
      type: "textResponse",
      sources: [],
      close: true,
      error: null,
      textResponse,
      metrics: {},
    };
  }

  // If we are here we know that we are in a workspace that is:
  // 1. Chatting in "chat" mode and may or may _not_ have embeddings
  // 2. Chatting in "query" mode and has at least 1 embedding
  let contextTexts = [];
  let sources = [];
  let pinnedDocIdentifiers = [];
  const { rawHistory, chatHistory } = await recentChatHistory({
    user,
    workspace,
    thread,
    messageLimit,
    apiSessionId: sessionId,
  });

  await new DocumentManager({
    workspace,
    maxTokens: LLMConnector.promptWindowLimit(),
  })
    .pinnedDocs()
    .then((pinnedDocs) => {
      pinnedDocs.forEach((doc) => {
        const { pageContent, ...metadata } = doc;
        pinnedDocIdentifiers.push(sourceIdentifier(doc));
        contextTexts.push(doc.pageContent);
        sources.push({
          text:
            pageContent.slice(0, 1_000) +
            "...continued on in source document...",
          ...metadata,
        });
      });
    });

  const vectorSearchResults =
    embeddingsCount !== 0
      ? await VectorDb.performSimilaritySearch({
          namespace: workspace.slug,
          input: message,
          LLMConnector,
          similarityThreshold: workspace?.similarityThreshold,
          topN: workspace?.topN,
          filterIdentifiers: pinnedDocIdentifiers,
          rerank: workspace?.vectorSearchMode === "rerank",
        })
      : {
          contextTexts: [],
          sources: [],
          message: null,
        };

  // Failed similarity search if it was run at all and failed.
  if (!!vectorSearchResults.message) {
    return {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: vectorSearchResults.message,
      metrics: {},
    };
  }

  // <<< CORRECTED LOGGING HERE >>>
  try {
    // Access properties directly from the source object
    const sourceInfo = vectorSearchResults.sources.map(source => ({
      docSource: source?.docSource || 'N/A', // Corrected: No '.metadata'
      sourceType: source?.sourceType || 'N/A' // Corrected: No '.metadata'
    }));
    console.log("Retrieved Vector Search Source Info:", JSON.stringify(sourceInfo, null, 2));
  } catch (e) {
    console.log("Error logging source info:", e.message);
    // Log the original structure in case of error for easier debugging
    console.log("Original sources structure:", JSON.stringify(vectorSearchResults.sources, null, 2));
  }
  // <<< END LOGGING >>>

  const { fillSourceWindow } = require("../helpers/chat");
  const filledSources = fillSourceWindow({
    nDocs: workspace?.topN || 4,
    searchResults: vectorSearchResults.sources,
    history: rawHistory,
    filterIdentifiers: pinnedDocIdentifiers,
  });

  // Why does contextTexts get all the info, but sources only get current search?
  // This is to give the ability of the LLM to "comprehend" a contextual response without
  // populating the Citations under a response with documents the user "thinks" are irrelevant
  // due to how we manage backfilling of the context to keep chats with the LLM more correct in responses.
  // If a past citation was used to answer the question - that is visible in the history so it logically makes sense
  // and does not appear to the user that a new response used information that is otherwise irrelevant for a given prompt.
  // TLDR; reduces GitHub issues for "LLM citing document that has no answer in it" while keep answers highly accurate.
  contextTexts = [...contextTexts, ...filledSources.contextTexts];
  sources = [...sources, ...vectorSearchResults.sources];

  // If in query mode and no context chunks are found from search, backfill, or pins -  do not
  // let the LLM try to hallucinate a response or use general knowledge and exit early
  if (chatMode === "query" && contextTexts.length === 0) {
    const textResponse =
      workspace?.queryRefusalResponse ??
      "There is no relevant information in this workspace to answer your query.";

    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: rawUserMessage, // Save original
      response: {
        text: textResponse,
        sources: [],
        attachments: attachments,
        type: chatMode,
        metrics: {},
      },
      threadId: thread?.id || null,
      include: false,
      apiSessionId: sessionId,
      user,
    });

    return {
      id: uuid,
      type: "textResponse",
      sources: [],
      close: true,
      error: null,
      textResponse,
      metrics: {},
    };
  }

  // Compress & Assemble message to ensure prompt passes token limit with room for response
  // and build system messages based on inputs and history.
  const messages = await LLMConnector.compressMessages(
    {
      systemPrompt: await chatPrompt(workspace, user),
      userPrompt: cleanUserQuery, // Use cleaned query
      contextTexts,
      chatHistory,
      attachments,
    },
    rawHistory
  );

  // Log the complete request before sending to LLM
  console.log("LLM Request (sync):", JSON.stringify(messages, null, 2));

  let completionResult;
  let toolCallIteration = 0;
  const MAX_TOOL_CALL_ITERATIONS = 5;

  // Initial LLM call
  completionResult = await LLMConnector.getChatCompletion(messages, {
    temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
  });

  // Loop while the LLM wants to call tools
  while (
    (completionResult?.toolCalls || completionResult?.functionCall) &&
    toolCallIteration < MAX_TOOL_CALL_ITERATIONS
  ) {
    toolCallIteration++;
    const toolCalls = completionResult.toolCalls;
    const functionCall = completionResult.functionCall;

    // Append the assistant's message with tool calls/function call to the history
    if (completionResult.message) {
      messages.push(completionResult.message);
    } else {
      console.error("Assistant message object not found in completionResult");
      messages.push({ role: "assistant", content: null, tool_calls: toolCalls, functionCall: functionCall });
    }

    // Process either OpenAI toolCalls or Gemini functionCall
    if (toolCalls) {
      // --- OpenAI Tool Call Processing --- //
      for (const toolCall of toolCalls) {
        const functionName = toolCall.function.name;
        const functionArgs = safeJsonParse(toolCall.function.arguments || '{}');
        let toolResultContent = "";

        console.log(
          `Iteration ${toolCallIteration}: Executing OpenAI tool ${functionName} with args:`, functionArgs
        );

        if (functionName === "ask_user_for_clarification") {
           const clarificationResponse = executeAskUserTool(functionArgs, uuid, null, false, null);
           if (clarificationResponse) return clarificationResponse;
           toolResultContent = "Error processing clarification request.";
        } else if (functionName === "search_documents") {
          toolResultContent = await executeSearchDocumentsTool(functionArgs, workspace, LLMConnector);
        } else if (functionName === "get_file_content") {
          toolResultContent = await executeGetFileContentTool(functionArgs);
        } else {
          console.warn(`Unsupported OpenAI tool function: ${functionName}`);
          toolResultContent = `Tool function ${functionName} is not supported.`;
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: functionName,
          content: toolResultContent,
        });
      }
    } else if (functionCall) {
       // --- Gemini Function Call Processing --- //
       const functionName = functionCall.name;
       const functionArgs = functionCall.args;
       let toolResultContent = "";

       console.log(
         `Iteration ${toolCallIteration}: Executing Gemini function ${functionName} with args:`, functionArgs
       );

       if (functionName === "ask_user_for_clarification") {
          const clarificationResponse = executeAskUserTool(functionArgs, uuid, null, false, null);
          if (clarificationResponse) return clarificationResponse;
          toolResultContent = "Error processing clarification request.";
       } else if (functionName === "search_documents") {
          toolResultContent = await executeSearchDocumentsTool(functionArgs, workspace, LLMConnector);
       } else if (functionName === "get_file_content") {
          toolResultContent = await executeGetFileContentTool(functionArgs);
       } else {
         console.warn(`Unsupported Gemini function: ${functionName}`);
         toolResultContent = `Function ${functionName} is not supported.`;
       }

       messages.push({
         role: "tool",
         name: functionName,
         content: toolResultContent,
       });
    }

    // Call LLM again with the tool results
    console.log(`Re-invoking LLM after tool execution (Iteration ${toolCallIteration})`);
    completionResult = await LLMConnector.getChatCompletion(messages, {
      temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
    });
  }

  if (toolCallIteration >= MAX_TOOL_CALL_ITERATIONS) {
    console.error("Maximum tool call iterations reached.");
    return {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: "Failed to get response after maximum tool call iterations.",
      metrics: completionResult?.metrics || {},
    };
  }

  // Check if the final result is still a tool call (shouldn't happen ideally, but handle defensively)
  if (completionResult?.toolCalls || completionResult?.functionCall) {
     console.error("LLM responded with tool/function calls after loop finished.");
     return {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: "LLM failed to provide a final text response after tool execution.",
      metrics: completionResult.metrics || {},
    };
  }

  // Extract final response
  const textResponse = completionResult?.textResponse;
  const performanceMetrics = completionResult?.metrics;

  if (!textResponse) {
    console.error("No textResponse found in the final completion result.");
    return {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: "No text completion could be completed with this input.",
      metrics: performanceMetrics,
    };
  }

  const { chat } = await WorkspaceChats.new({
    workspaceId: workspace.id,
    prompt: rawUserMessage, // Save original
    response: {
      text: textResponse,
      sources,
      attachments,
      type: chatMode,
      metrics: performanceMetrics,
    },
    threadId: thread?.id || null,
    apiSessionId: sessionId,
    user,
  });

  return {
    id: uuid,
    type: "textResponse",
    close: true,
    error: null,
    chatId: chat.id,
    textResponse,
    sources,
    metrics: performanceMetrics,
  };
}

/**
 * Handle streamable HTTP chunks for chats with your workspace via the developer API endpoint
 * @param {{
 * response: import("express").Response,
 *  workspace: import("@prisma/client").workspaces,
 *  message:string,
 *  mode: "chat"|"query",
 *  user: import("@prisma/client").users|null,
 *  thread: import("@prisma/client").workspace_threads|null,
 *  sessionId: string|null,
 *  attachments: { name: string; mime: string; contentString: string }[],
 *  reset: boolean,
 * }} parameters
 * @returns {Promise<VoidFunction>}
 */
async function streamChat({
  response,
  workspace,
  message = null,
  mode = "chat",
  user = null,
  thread = null,
  sessionId = null,
  attachments = [],
  reset = false,
}) {
  const uuid = uuidv4();
  const chatMode = mode ?? "chat";
  const rawUserMessage = message; // Keep original for saving later if needed

  // If the user wants to reset the chat history we do so pre-flight
  // and continue execution. If no message is provided then the user intended
  // to reset the chat history only and we can exit early with a confirmation.
  if (reset) {
    await WorkspaceChats.markThreadHistoryInvalidV2({
      workspaceId: workspace.id,
      user_id: user?.id,
      thread_id: thread?.id,
      api_session_id: sessionId,
    });
    if (!message?.length) {
      writeResponseChunk(response, {
        id: uuid,
        type: "textResponse",
        textResponse: "Chat history was reset!",
        sources: [],
        attachments: [],
        close: true,
        error: null,
        metrics: {},
      });
      return;
    }
  }

  // Check for and process slash commands
  // Since preset commands are not supported in API calls, we can just process the message here
  const processedMessage = await grepAllSlashCommands(rawUserMessage);
  const cleanUserQuery = extractUserQuery(processedMessage); // Extract the core query after slash commands
  message = processedMessage;

  if (EphemeralAgentHandler.isAgentInvocation({ message })) {
    await Telemetry.sendTelemetry("agent_chat_started");

    // Initialize the EphemeralAgentHandler to handle non-continuous
    // conversations with agents since this is over REST.
    const agentHandler = new EphemeralAgentHandler({
      uuid,
      workspace,
      prompt: message,
      userId: user?.id || null,
      threadId: thread?.id || null,
      sessionId,
    });

    // Establish event listener that emulates websocket calls
    // in Aibitat so that we can keep the same interface in Aibitat
    // but use HTTP.
    const eventListener = new EphemeralEventListener();
    await agentHandler.init();
    await agentHandler.createAIbitat({ handler: eventListener });
    agentHandler.startAgentCluster();

    // The cluster has started and now we wait for close event since
    // and stream back any results we get from agents as they come in.
    return eventListener
      .streamAgentEvents(response, uuid)
      .then(async ({ thoughts, textResponse }) => {
        console.log({ thoughts, textResponse });
        await WorkspaceChats.new({
          workspaceId: workspace.id,
          prompt: String(message),
          response: {
            text: textResponse,
            sources: [],
            attachments: attachments,
            type: chatMode,
            thoughts,
          },
          include: false,
          apiSessionId: sessionId,
        });
        writeResponseChunk(response, {
          uuid,
          type: "finalizeResponseStream",
          textResponse,
          thoughts,
          close: true,
          error: false,
        });
      });
  }

  const LLMConnector = getLLMProvider({
    provider: workspace?.chatProvider,
    model: workspace?.chatModel,
  });

  const VectorDb = getVectorDbClass();
  const messageLimit = workspace?.openAiHistory || 20;
  const hasVectorizedSpace = await VectorDb.hasNamespace(workspace.slug);
  const embeddingsCount = await VectorDb.namespaceCount(workspace.slug);

  // User is trying to query-mode chat a workspace that has no data in it - so
  // we should exit early as no information can be found under these conditions.
  if ((!hasVectorizedSpace || embeddingsCount === 0) && chatMode === "query") {
    const textResponse =
      workspace?.queryRefusalResponse ??
      "There is no relevant information in this workspace to answer your query.";
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      attachments: [],
      close: true,
      error: null,
      metrics: {},
    });
    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: rawUserMessage, // Save original
      response: {
        text: textResponse,
        sources: [],
        attachments: attachments,
        type: chatMode,
        metrics: {},
      },
      threadId: thread?.id || null,
      apiSessionId: sessionId,
      include: false,
      user,
    });
    return;
  }

  // If we are here we know that we are in a workspace that is:
  // 1. Chatting in "chat" mode and may or may _not_ have embeddings
  // 2. Chatting in "query" mode and has at least 1 embedding
  let completeText = "";
  let metrics = {};
  let contextTexts = [];
  let sources = [];
  let pinnedDocIdentifiers = [];
  const { rawHistory, chatHistory } = await recentChatHistory({
    user,
    workspace,
    thread,
    messageLimit,
    apiSessionId: sessionId,
  });

  // Look for pinned documents and see if the user decided to use this feature. We will also do a vector search
  // as pinning is a supplemental tool but it should be used with caution since it can easily blow up a context window.
  // However we limit the maximum of appended context to 80% of its overall size, mostly because if it expands beyond this
  // it will undergo prompt compression anyway to make it work. If there is so much pinned that the context here is bigger than
  // what the model can support - it would get compressed anyway and that really is not the point of pinning. It is really best
  // suited for high-context models.
  await new DocumentManager({
    workspace,
    maxTokens: LLMConnector.promptWindowLimit(),
  })
    .pinnedDocs()
    .then((pinnedDocs) => {
      pinnedDocs.forEach((doc) => {
        const { pageContent, ...metadata } = doc;
        pinnedDocIdentifiers.push(sourceIdentifier(doc));
        contextTexts.push(doc.pageContent);
        sources.push({
          text:
            pageContent.slice(0, 1_000) +
            "...continued on in source document...",
          ...metadata,
        });
      });
    });

  const vectorSearchResults =
    embeddingsCount !== 0
      ? await VectorDb.performSimilaritySearch({
          namespace: workspace.slug,
          input: message,
          LLMConnector,
          similarityThreshold: workspace?.similarityThreshold,
          topN: workspace?.topN,
          filterIdentifiers: pinnedDocIdentifiers,
          rerank: workspace?.vectorSearchMode === "rerank",
        })
      : {
          contextTexts: [],
          sources: [],
          message: null,
        };

  // Failed similarity search if it was run at all and failed.
  if (!!vectorSearchResults.message) {
    writeResponseChunk(response, {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: vectorSearchResults.message,
      metrics: {},
    });
    return;
  }

  // <<< CORRECTED LOGGING HERE >>>
  try {
    // Access properties directly from the source object
    const sourceInfo = vectorSearchResults.sources.map(source => ({
      docSource: source?.docSource || 'N/A', // Corrected: No '.metadata'
      sourceType: source?.sourceType || 'N/A' // Corrected: No '.metadata'
    }));
    console.log("Retrieved Vector Search Source Info:", JSON.stringify(sourceInfo, null, 2));
  } catch (e) {
    console.log("Error logging source info:", e.message);
    // Log the original structure in case of error for easier debugging
    console.log("Original sources structure:", JSON.stringify(vectorSearchResults.sources, null, 2));
  }
  // <<< END LOGGING >>>

  const { fillSourceWindow } = require("../helpers/chat");
  const filledSources = fillSourceWindow({
    nDocs: workspace?.topN || 4,
    searchResults: vectorSearchResults.sources,
    history: rawHistory,
    filterIdentifiers: pinnedDocIdentifiers,
  });

  // Why does contextTexts get all the info, but sources only get current search?
  // This is to give the ability of the LLM to "comprehend" a contextual response without
  // populating the Citations under a response with documents the user "thinks" are irrelevant
  // due to how we manage backfilling of the context to keep chats with the LLM more correct in responses.
  // If a past citation was used to answer the question - that is visible in the history so it logically makes sense
  // and does not appear to the user that a new response used information that is otherwise irrelevant for a given prompt.
  // TLDR; reduces GitHub issues for "LLM citing document that has no answer in it" while keep answers highly accurate.
  contextTexts = [...contextTexts, ...filledSources.contextTexts];
  sources = [...sources, ...vectorSearchResults.sources];

  // If in query mode and no context chunks are found from search, backfill, or pins -  do not
  // let the LLM try to hallucinate a response or use general knowledge and exit early
  if (chatMode === "query" && contextTexts.length === 0) {
    const textResponse =
      workspace?.queryRefusalResponse ??
      "There is no relevant information in this workspace to answer your query.";
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      close: true,
      error: null,
      metrics: {},
    });

    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: rawUserMessage, // Save original
      response: {
        text: textResponse,
        sources: [],
        attachments: attachments,
        type: chatMode,
        metrics: {},
      },
      threadId: thread?.id || null,
      apiSessionId: sessionId,
      include: false,
      user,
    });
    return;
  }

  // Compress & Assemble message to ensure prompt passes token limit with room for response
  // and build system messages based on inputs and history.
  let messages = await LLMConnector.compressMessages(
    {
      systemPrompt: await chatPrompt(workspace, user),
      userPrompt: cleanUserQuery, // Use cleaned query
      contextTexts,
      chatHistory,
      attachments,
    },
    rawHistory
  );

  // Log the initial request
  console.log("LLM Request (stream):", JSON.stringify(messages, null, 2));

  let toolCallIteration = 0;
  const MAX_TOOL_CALL_ITERATIONS = 5;
  let currentToolCall = null; // Store the tool call received from the stream
  let finalMetrics = {};
  let finalChatId = null;

  // --- Streaming Tool Call Loop --- //
  const startTime = Date.now(); // Start timing before the loop
  while (toolCallIteration < MAX_TOOL_CALL_ITERATIONS) {
    currentToolCall = null; // Reset tool call for this iteration
    let streamEnded = false;

    if (LLMConnector.streamingEnabled() !== true) {
      console.log(
        `\x1b[31m[STREAMING DISABLED][0m Streaming is not available for ${LLMConnector.constructor.name}. Cannot use tools in stream mode.`
      );
      // Attempt to get a sync response instead? Or just abort?
      // For now, aborting stream if tools might be needed but streaming isn't supported.
      writeResponseChunk(response, {
          uuid,
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: `Streaming is disabled for ${LLMConnector.constructor.name}, cannot process potential tool calls.`,
          metrics: {},
        });
      return;
    }

    console.log(`Starting LLM stream request (Iteration ${toolCallIteration + 1})`);
    const streamResult = await LLMConnector.streamGetChatCompletion(messages, {
      temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
    });

    // handleStream now returns a generator
    const streamGenerator = LLMConnector.handleStream(response, streamResult, {
      uuid,
      sources,
    });

    // Process the stream chunks from the generator
    let accumulatedTextForThisIteration = "";
    let finalMetrics = {}; // Initialize finalMetrics here for safety

    try {
      for await (const chunk of streamGenerator) {
        if (chunk.type === "textResponseChunk") {
          writeResponseChunk(response, chunk); // Stream text chunk to client
          accumulatedTextForThisIteration += chunk.textResponse;
        } else if (chunk.type === "tool_call_chunk") {
          console.log("Tool call chunk received from stream handler");
          currentToolCall = chunk.toolCall; // Store the tool call info
          // Metrics are now handled by finalizeStreamMetrics chunk
          streamEnded = true; // Signal that main generation is done, tool call pending
          break; // Exit stream processing to handle the tool call
        } else if (chunk.type === "finalizeTextStream") {
          console.log("Finalize text stream chunk received");
          completeText = chunk.fullText || accumulatedTextForThisIteration; // Assign to outer variable
          // Metrics are now handled by finalizeStreamMetrics chunk
          streamEnded = true; // Signal that main generation is done
          break; // Exit stream processing, text response is complete
        } else if (chunk.type === "finalizeStreamMetrics") {
          console.log("Finalize stream metrics chunk received");
          if (chunk.metrics) {
             finalMetrics = chunk.metrics;
             console.log("Metrics extracted from finalizeStreamMetrics chunk:", finalMetrics);
          }
          // Note: This chunk does NOT end the stream processing loop itself.
          // The loop continues until a break from tool_call or finalizeTextStream, or an abort.
        } else if (chunk.type === "abort") {
          console.error("Abort chunk received from stream handler:", chunk.error);
          writeResponseChunk(response, { ...chunk, close: true }); // Send abort to client
          return; // Stop the entire streamChat process
        }
      }
    } catch (streamError) {
      console.error("Error iterating stream generator:", streamError);
      writeResponseChunk(response, {
        uuid,
        type: "abort",
        sources: [],
        close: true,
        error: `Stream processing error: ${streamError.message}`,
        metrics: {},
      });
      return;
    }

    // --- Tool Execution Logic (If a tool call was received) --- //
    if (currentToolCall) {
      toolCallIteration++;

      // Determine structure based on provider (checking presence of toolCalls vs functionCall in the chunk)
      let toolCallId, functionName, functionArgsString, functionArgs, assistantMessageForHistory;
      if (currentToolCall.toolCalls && currentToolCall.assistantMessage) { // OpenAI structure from chunk
         // Assuming toolCalls is an array, process the first one? Or handle multiple?
         // For simplicity, let's assume the LLM calls one tool at a time for now.
         if (currentToolCall.toolCalls.length > 1) {
            console.warn("Multiple tool calls in one streaming response not fully handled yet. Processing first call.");
         }
         const firstToolCall = currentToolCall.toolCalls[0];
         toolCallId = firstToolCall.id;
         functionName = firstToolCall.function.name;
         functionArgsString = firstToolCall.function.arguments;
         assistantMessageForHistory = currentToolCall.assistantMessage; // Use the message from the chunk
      } else if (currentToolCall.toolCall) { // Gemini structure from chunk
         // The chunk structure was defined as { type: "tool_call_chunk", toolCall: { id: ..., function: { name: ..., arguments: ... } } }
         const geminiToolCall = currentToolCall.toolCall;
         toolCallId = geminiToolCall.id; // Use the generated ID
         functionName = geminiToolCall.function.name;
         functionArgsString = geminiToolCall.function.arguments;
         functionArgs = safeJsonParse(functionArgsString || '{}'); // Parse here for Gemini reconstruction
         // Reconstruct Gemini assistant message for history
         assistantMessageForHistory = {
             role: 'model',
             parts: [{ functionCall: { name: functionName, args: functionArgs } }],
         };
      } else {
         console.error("Invalid tool_call_chunk structure received:", currentToolCall);
         // Handle error - maybe abort?
         continue; // Skip this iteration
      }

      // Parse arguments if not already parsed (mainly for OpenAI)
      if (!functionArgs) {
         functionArgs = safeJsonParse(functionArgsString || '{}');
      }
      let toolResultContent = "";

      // Append the *correct* assistant message to history BEFORE executing tool
      if (assistantMessageForHistory) {
          messages.push(assistantMessageForHistory);
      } else {
          // This shouldn't happen if providers yield the message correctly
          console.error("Could not determine assistant message for tool call history!");
          // Construct a very basic placeholder - this might break subsequent calls
          messages.push({ role: "assistant", content: `[Placeholder: requesting tool ${functionName}]` });
      }

      console.log(
        `Iteration ${toolCallIteration}: Executing streamed tool ${functionName} with args:`, functionArgs
      );

       if (functionName === "ask_user_for_clarification") {
         // Executor handles writing chunk and returns null to signal stop
         executeAskUserTool(functionArgs, uuid, response, true, writeResponseChunk);
         return; // Stop processing the stream
       } else if (functionName === "search_documents") {
          toolResultContent = await executeSearchDocumentsTool(functionArgs, workspace, LLMConnector);
       } else if (functionName === "get_file_content") {
          toolResultContent = await executeGetFileContentTool(functionArgs);
       } else {
         console.warn(`Unsupported tool function: ${functionName}`);
         toolResultContent = `Tool function ${functionName} is not supported.`;
       }

      // Append the tool result message (using standard 'tool' role)
      messages.push({
        role: "tool",
        tool_call_id: toolCallId, // Use the ID from the tool call
        name: functionName,
        content: toolResultContent,
      });

      // Continue to the next iteration of the while loop to call LLM again
      console.log("Continuing stream loop after tool execution...")

    } else if (streamEnded) {
      // Stream finished with text, break the loop
      console.log("Stream ended with text response.")
      // finalMetrics = ??? // Need metrics from finalizeTextStream chunk if available
      break;
    } else {
       // Should not happen if generator always yields finalize or abort
       console.error("Stream generator finished without finalizeTextStream or tool_call_chunk");
       writeResponseChunk(response, {
          uuid,
          type: "abort",
          error: "Stream ended unexpectedly.",
          close: true,
       });
       return;
    }
  } // --- End of Streaming Tool Call Loop --- //

  const endTime = Date.now(); // End timing after the loop
  const duration = (endTime - startTime) / 1000; // Duration in seconds

  // Add duration and potentially TPS to metrics
  if (finalMetrics) {
    finalMetrics.duration = duration;
    if (finalMetrics.completionTokenCount && duration > 0) {
       finalMetrics.outputTps = finalMetrics.completionTokenCount / duration;
    } else {
       finalMetrics.outputTps = 0;
    }
    console.log("Final metrics including duration:", finalMetrics);
  }

  // Handle Max Iterations Reached
  if (toolCallIteration >= MAX_TOOL_CALL_ITERATIONS) {
    console.error("Maximum tool call iterations reached in stream.");
    writeResponseChunk(response, {
      uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: "Failed to get response after maximum tool call iterations.",
      metrics: finalMetrics || {},
    });
    return;
  }

   // --- Finalization --- //
   // If loop finished normally (via break after finalizeTextStream)
  if (completeText?.length > 0) {
    console.log("Saving final streamed response to database.")
    const { chat } = await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: rawUserMessage, // Save original
      response: {
        text: completeText,
        sources, // Use sources gathered initially
        type: chatMode,
        metrics: finalMetrics, // Use metrics gathered
        attachments,
      },
      threadId: thread?.id || null,
      apiSessionId: sessionId,
      user,
    });
    finalChatId = chat.id;
  } else if (!currentToolCall) {
     // Stream ended, but no text and no pending tool call (e.g., LLM just stopped)
     console.warn("Stream ended without generating text or calling a tool.")
  }

  console.log("Finalizing stream response.")
  writeResponseChunk(response, {
    uuid,
    type: "finalizeResponseStream",
    chatId: finalChatId,
    close: true,
    error: false,
    metrics: finalMetrics,
  });
  return;
}

module.exports.ApiChatHandler = {
  chatSync,
  streamChat,
};
