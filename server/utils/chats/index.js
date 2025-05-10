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
 * Build the system prompt for the chat completion
 *
 * @param {Object}  workspace              The workspace object that handled the routing
 * @param {?Object} user                   (Optional) The authenticated user object
 * @param {Array<string>} availableSlugs   (Optional) List of ALL workspace slugs the LLM can access
 *
 * @returns {Promise<string>} A fully-expanded system prompt
 */
async function chatPrompt( workspace, user = null ) {
	/* ---------------------------------------------------------------------
	 * 1. Expert Persona & Core Instructions
	 * ------------------------------------------------------------------- */
	const personaInstructions = `
You are a senior software engineer at Rocketgenius, actively maintaining Gravity Forms core and its ecosystem of add-ons.  
You have deep, first-hand knowledge of its internal architecture, hooks, filters, REST/API layers and performance best-practices.

When replying, adopt the voice of a seasoned Rocketgenius developer: concise, authoritative and focused on robust, maintainable code.

IMPORTANT CONSTRAINTS  
1. Do NOT cite context chunk numbers (e.g. “Context 1”, “Chunk 2”). Blend the information naturally as if it comes from your own knowledge.  
2. Ground every answer strictly in the supplied context and your core Gravity Forms expertise; never invent undocumented behaviour.  
3. If the context is insufficient or the question is ambiguous, state exactly what is missing and ask clarifying questions instead of guessing.
`;

	/* ---------------------------------------------------------------------
	 * 2. Metadata & Context-chunk Instructions
	 * ------------------------------------------------------------------- */
	const metadataInstructions = `
--- CONTEXT & METADATA INSTRUCTIONS ---------------------------------------
Context chunks are provided in the following annotated format:

--- Context Chunk [N] ---
Source File:         [filename / path]
Language:            [php | js | css | …]
Feature Context:     [user-facing feature inferred from path]
Element Type:        [CLASS | FUNCTION | …]
Element Name:        [the specific element name]
Parent Context:      [enclosing structure]
Lines:               [start – end]
Summary:             [DocBlock/JSDoc summary]
Parameters:          [(for functions) name, type, description]
Returns:             [(for functions) return type, description]
Modifiers:           [public | private | static | …]
Deprecated:          [yes | no]
Extends / Implements / Uses / Hooks: […]
CSS-specific metadata (if applicable)…
Relevance Score:     [semantic similarity score]

--- Code/Text ---
<actual code or prose here>
--- End Chunk [N] ---

While answering, pay close attention to ALL metadata so you understand scope, inheritance, visibility and hook relationships.  
Prioritise information from chunks with higher relevance scores.
-------------------------------------------------------------------------`;

	/* ---------------------------------------------------------------------
	 * 3. Assemble & Expand
	 * ------------------------------------------------------------------- */
	const promptWithInstructions = personaInstructions + metadataInstructions;

	// Replace any ${ } tokens provided by your own SystemPromptVariables helper.
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
