const { v4: uuidv4 } = require("uuid");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { resetMemory } = require("./commands/reset");
const { convertToPromptHistory } = require("../helpers/chat/responses");
const { SlashCommandPresets } = require("../../models/slashCommandsPresets");
const { SystemPromptVariables } = require("../../models/systemPromptVariables");
const { getLLMProvider } = require("../helpers");

const VALID_COMMANDS = {
  "/reset": resetMemory,
};

async function grepCommand(message, user = null) {
  const userPresets = await SlashCommandPresets.getUserPresets(user?.id);
  const availableCommands = Object.keys(VALID_COMMANDS);

  // Check if the message starts with any built-in command
  for (let i = 0; i < availableCommands.length; i++) {
    const cmd = availableCommands[i];
    const re = new RegExp(`^(${cmd})`, "i");
    if (re.test(message)) {
      return cmd;
    }
  }

  // Replace all preset commands with their corresponding prompts
  // Allows multiple commands in one message
  let updatedMessage = message;
  for (const preset of userPresets) {
    const regex = new RegExp(
      `(?:\\b\\s|^)(${preset.command})(?:\\b\\s|$)`,
      "g"
    );
    updatedMessage = updatedMessage.replace(regex, preset.prompt);
  }

  return updatedMessage;
}

/**
 * @description This function will do recursive replacement of all slash commands with their corresponding prompts.
 * @notice This function is used for API calls and is not user-scoped. THIS FUNCTION DOES NOT SUPPORT PRESET COMMANDS.
 * @returns {Promise<string>}
 */
async function grepAllSlashCommands(message) {
  const allPresets = await SlashCommandPresets.where({});

  // Replace all preset commands with their corresponding prompts
  // Allows multiple commands in one message
  let updatedMessage = message;
  for (const preset of allPresets) {
    const regex = new RegExp(
      `(?:\\b\\s|^)(${preset.command})(?:\\b\\s|$)`,
      "g"
    );
    updatedMessage = updatedMessage.replace(regex, preset.prompt);
  }

  return updatedMessage;
}

async function recentChatHistory({
  user = null,
  workspace,
  thread = null,
  messageLimit = 20,
  apiSessionId = null,
}) {
  const rawHistory = (
    await WorkspaceChats.where(
      {
        workspaceId: workspace.id,
        user_id: user?.id || null,
        thread_id: thread?.id || null,
        api_session_id: apiSessionId || null,
        include: true,
      },
      messageLimit,
      { id: "desc" }
    )
  ).reverse();
  return { rawHistory, chatHistory: convertToPromptHistory(rawHistory) };
}

/**
 * Returns the base prompt for the chat. This method will also do variable
 * substitution on the prompt if there are any defined variables in the prompt.
 * @param {Object|null} workspace - the workspace object
 * @param {Object|null} user - the user object
 * @returns {Promise<string>} - the base prompt
 */
async function chatPrompt(workspace, user = null) {
  let finalPrompt =
    workspace?.openAiPrompt ??
    "Given the following conversation, relevant context, and a follow up question, reply with an answer to the current question the user is asking. Return only your response to the question given the above information following the users instructions as needed.";

  // Check if the selected provider supports tools
  let providerSupportsTools = false;
  try {
    const LLMConnector = getLLMProvider({ provider: workspace.chatProvider, model: workspace.chatModel });
    // Check if the static method exists and call it
    if (LLMConnector?.constructor?.supportsTools && LLMConnector.constructor.supportsTools()) {
      providerSupportsTools = true;
    }
  } catch (error) {
    console.error(`Error checking tool support for provider ${workspace.chatProvider}: ${error.message}`);
    // Assume no tool support if provider loading fails
  }

  if (providerSupportsTools) {
    console.log(`Provider ${workspace.chatProvider} supports tools. Adding tool instructions to system prompt.`);
    const toolInstructions = `\n\nYou have access to the following tools:\n\nTool: ask_user_for_clarification\nDescription: Ask the user a clarifying question when the request or context is ambiguous.\nParameters:\n  - question_for_user: string (The specific question to ask the user.)\n\nTool: search_documents\nDescription: Search the available documents for more information relevant to a specific query. Use context chunks like [CONTEXT 0]...[END CONTEXT 0] to understand the available information first.\nParameters:\n  - search_query: string (The specific query to search for in the documents.)\n\nTool: get_file_content\nDescription: Retrieves the content of a specific file from a GitHub repository.\nParameters:\n  - repository: string (The GitHub repository in 'owner/repo' format.)\n  - file_path: string (The full path to the file within the repository.)\n\nYou must use the provided tools when necessary to answer the user's question effectively. Only call one tool at a time. If you need to call a tool, respond *only* with the structured JSON tool call invocation required by the API. Do not add any other text before or after the tool call.\n`;
    finalPrompt += toolInstructions;
  } else {
     console.log(`Provider ${workspace.chatProvider || 'default'} does not support tools. Skipping tool instructions.`);
  }

  return await SystemPromptVariables.expandSystemPromptVariables(
    finalPrompt, // Use the potentially modified prompt
    user?.id
  );
}

// We use this util function to deduplicate sources from similarity searching
// if the document is already pinned.
// Eg: You pin a csv, if we RAG + full-text that you will get the same data
// points both in the full-text and possibly from RAG - result in bad results
// even if the LLM was not even going to hallucinate.
function sourceIdentifier(sourceDocument) {
  if (!sourceDocument?.title || !sourceDocument?.published) return uuidv4();
  return `title:${sourceDocument.title}-timestamp:${sourceDocument.published}`;
}

module.exports = {
  sourceIdentifier,
  recentChatHistory,
  chatPrompt,
  grepCommand,
  grepAllSlashCommands,
  VALID_COMMANDS,
};
