const { v4: uuidv4 } = require("uuid");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { resetMemory } = require("./commands/reset");
const { convertToPromptHistory } = require("../helpers/chat/responses");
const { SlashCommandPresets } = require("../../models/slashCommandsPresets");
const { SystemPromptVariables } = require("../../models/systemPromptVariables");

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
  const basePrompt =
    workspace?.openAiPrompt ??
    "Given the following conversation, relevant context, and a follow up question, reply with an answer to the current question the user is asking. Return only your response to the question given the above information following the users instructions as needed.";

  const metadataInstructions = `\n\n---
CONTEXT & METADATA INSTRUCTIONS:
Context sources are provided in the following format. Note that not all metadata keys will be present for every chunk, as they depend on the language and type of code:
--- Context Chunk [N] ---
Source File: [Filename/Path of the original source file]
Language: [Detected programming language (e.g., js, php, css)]
Feature Context: [Inferred feature/plugin/theme name based on file path]
Element Type: [Type of code structure (e.g., CLASS, METHOD, FUNCTION, RULE, AT_RULE, code-segment)]
Element Name: [Name of the specific function, class, method, selector, etc.]
Parent Context: [Name of the parent structure, like a class containing a method]
Lines: [Start-End lines in the original file]
Summary: [Summary extracted from DocBlock/JSDoc comments, if available]
Parameters: [(For functions/methods) List of parameters with name, type, and description]
Returns: [(For functions/methods) Return type and description]
Modifiers: [Keywords like public, private, static, async, abstract, final]
Deprecated: [Indicates if the element is marked as deprecated]
Extends: [(PHP Classes) Name of the class being extended]
Implements: [(PHP Classes/Interfaces) List of interfaces being implemented]
Uses: [(PHP Classes/Traits) List of traits being used]
Registers Hooks: [(PHP) WordPress-style hooks (actions or filters) registered by this code, allowing other code to plug in.]
Triggers Hooks: [(PHP) WordPress-style hooks (actions or filters) executed by this code, allowing other code to run or modify data.]
CSS Selector: [(CSS Rules) The CSS selector (e.g., .my-class, #id)]
CSS At-Rule: [(CSS AtRules) The full at-rule (e.g., @media (min-width: 600px))]
Relevance Score: [Similarity score indicating relevance to the query]
--- Code/Text ---
[The actual code or text content of the chunk]
--- End Chunk [N] ---

When answering, pay close attention to ALL the metadata provided with each context chunk to understand the code's structure, origin, language features, and relationships (like inheritance, hooks, scope). Use this metadata to provide accurate, specific, and well-referenced answers. Prioritize information from chunks with higher relevance scores if applicable.
---
`;

  // Append the metadata instructions to the base prompt.
  const promptWithInstructions = basePrompt + metadataInstructions;

  // Expand any variables in the combined prompt.
  return await SystemPromptVariables.expandSystemPromptVariables(
    promptWithInstructions,
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
