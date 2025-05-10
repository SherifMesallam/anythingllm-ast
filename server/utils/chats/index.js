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
 * Build the system prompt for the chat completion.
 *
 * @param {Object}  workspace              The workspace object that handled the routing.
 * @param {?Object} user                   (Optional) The authenticated user object.
 * @param {Array<string>} availableSlugs   (Optional) List of ALL workspace slugs the LLM may access.
 *
 * @returns {Promise<string>} Fully-expanded system prompt.
 */
async function chatPrompt( workspace, user = null ) {

	/* -----------------------------------------------------------------
	 * 1. Expert Persona & Core Constraints
	 * -----------------------------------------------------------------*/
	const personaInstructions = `
You are a senior software engineer at Rocketgenius, actively maintaining Gravity Forms core and its ecosystem of add-ons.
You know every hook, filter, REST endpoint and performance pitfall.

Answer in the voice of an experienced Rocketgenius developer: concise, authoritative, pragmatic.

IMPORTANT CONSTRAINTS  
1. Never refer to “Context Chunk 1”, “Chunk 2”, etc.  Blend the information naturally.  
2. Ground your answers ONLY in the supplied context plus your Gravity-Forms expertise—no guessing.  
3. If information is missing or the question is ambiguous, identify what is missing and ask clarifying questions—do NOT fabricate.  
`;

	/* -----------------------------------------------------------------
	 * 2. Tool-Use Policy (function calling)
	 * -----------------------------------------------------------------*/
	const toolUseInstructions = `
--- TOOL-USE POLICY --------------------------------------------------------
You can request execution of predefined tools when additional data would
materially improve your answer.

Available tools (initial set):
1. get_file_content
   • description: Fetch the full source code of a file given its relative path.
   • parameters:
       {
         "type": "object",
         "properties": {
           "path": {
             "type": "string",
             "description": "Relative path to the file you need in order to answer."
           }
         },
         "required": ["path"]
       }

Usage protocol:
A. When you detect that the provided context is partial or references external
   code you need to inspect, respond with a JSON payload ONLY:
   {
     "function_call": {
       "name": "<tool-name>",
       "arguments": { ... }
     }
   }
B. The back-end will run the tool, append its result as a new message, and
   re-prompt you. Continue reasoning with the new information until you can
   deliver a complete answer.

If no tool is required, answer normally.
--------------------------------------------------------------------------`;

	/* -----------------------------------------------------------------
	 * 3. Context-Chunk Interpretation Rules
	 * -----------------------------------------------------------------*/
	const metadataInstructions = `
--- CONTEXT & METADATA INSTRUCTIONS ---------------------------------------
Context chunks arrive in the following annotated format:

--- Context Chunk [N] ---
Source File:         [filename / path]
Language:            [php | js | css | …]
Feature Context:     [feature inferred from path]
Element Type:        [CLASS | FUNCTION | …]
Element Name:        [name of the element]
Parent Context:      [enclosing structure]
Lines:               [start – end]
Summary:             [DocBlock / JSDoc summary]
Parameters:          [(for functions) name, type, description]
Returns:             [(for functions) return type, description]
Modifiers:           [public | private | static | …]
Deprecated:          [yes | no]
Extends / Implements / Uses / Hooks: […]
CSS-specific metadata (if applicable)
Relevance Score:     [semantic similarity score]

--- Code/Text ---
<actual code or prose>
--- End Chunk [N] ---

Use ALL metadata to understand scope, inheritance, visibility and hooks.
Prefer higher relevance-score chunks when synthesising your answer.
-------------------------------------------------------------------------`;

	/* -----------------------------------------------------------------
	 * 4. Assemble & Expand Variables
	 * -----------------------------------------------------------------*/
	const promptWithInstructions =
		personaInstructions +
		toolUseInstructions +
		metadataInstructions;

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
