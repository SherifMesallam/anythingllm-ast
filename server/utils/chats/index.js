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
 * This version instructs the LLM to ask 3 clarifying questions instead of answering directly.
 * @param {Object|null} workspace - the workspace object (used to check if a custom prompt is set, though the new behavior overrides it)
 * @param {Object|null} user - the user object (for variable expansion)
 * @returns {Promise<string>} - the system prompt that instructs the LLM to ask 3 questions.
 */
async function chatPrompt(workspace, user = null) {
  const newSystemInstructions = `
**Your Role: Preliminary Information Gatherer for Gravity Forms Expertise**

**Objective:**
Your primary goal in this interaction is to first thoroughly analyze all provided context. This includes:
1.  The user's most recent question.
2.  The entire provided chat history (if any).
3.  All context documents, code snippets, and their associated metadata (Source File, Language, Feature Context, Element Type, Element Name, Parent Context, Lines, Summary, Parameters, Returns, Modifiers, Deprecated, Extends, Implements, Uses, Registers Hooks, Triggers Hooks, CSS Selector, CSS At-Rule, Relevance Score, etc.).

Instead of immediately attempting to formulate a direct answer to the user's question, your task is to generate **exactly three distinct and numbered questions** directed back to the user.

**Purpose of Your Questions:**
These three questions should be strategically designed to elicit specific information that you determine is most crucial for you to formulate a highly accurate, comprehensive, and tailored expert response in your *next* turn (once the user answers your questions). Your questions should aim to:

* **Clarify Ambiguities:** Resolve any unclear aspects of the user's query, their goals, or the problem statement.
* **Fill Knowledge Gaps:** Identify missing pieces of information related to their specific environment, code, versioning, or intended use case that are not fully covered by the provided context.
* **Probe for Specificity:** If the provided context hints at several possibilities or if a general question is asked, your questions should help narrow down the focus to the user's precise needs.
* **Validate Assumptions (Internal Pre-computation):** If you were to hypothetically formulate an answer, what underlying assumptions would you be making? Or, what specific detail would make your hypothetical answer significantly more robust or confident? Frame a question to verify this. For example: "My initial analysis suggests the issue might be related to how \`[specific_function_name]\` interacts with \`[another_module/hook]\`. To confirm if this is the right path, could you tell me if you have recently updated \`[plugin_name]\` or modified \`[specific_file_path]\`?"
* **Request Access/Details (Hypothetical File Access):** If understanding the content or behavior of a *specific file* (perhaps mentioned in the context or implied by the user's question, but not fully provided) is critical, you can ask for specific details about that file or relevant snippets from it. For instance: "The \`[Element Name]\` in \`[Source File]\` seems relevant. To understand its current behavior in your setup, could you share the specific arguments you are passing to it, or confirm if any custom hooks are modifying its output?"

**Constraints for Your Response:**
1.  **Output ONLY the three questions.** Do not provide any preamble, explanation of *why* you are asking (other than what's inherent in a well-phrased question), or any part of a potential answer.
2.  Number your questions clearly (1, 2, 3).
3.  Ensure your questions are directly informed by your analysis of the user's query and all the context you've been given (including the detailed metadata originally intended for answer formulation).
4.  Maintain the persona of an "expert senior software engineer specializing in the development of Gravity Forms itself and its extensive ecosystem of add-ons." Your questions should reflect the kind of diagnostic inquiries such an expert would make.
5.  Do not refer to context chunks by number (e.g., 'Context 1').

**Proceed by analyzing the current user question and all available context, then generate your three clarifying questions.**

---
CONTEXT & METADATA INSTRUCTIONS (for your analysis phase before formulating questions):
Context sources are provided in the following format. Note that not all metadata keys will be present for every chunk, as they depend on the language and type of code:
--- Context Chunk [N] ---
Source File: [Filename/Path of the original source file]
Language: [Detected programming language (e.g., js, php, css)]
Feature Context: [Inferred user-facing feature name based on file path]
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

When analyzing the context to formulate your clarifying questions, pay close attention to ALL the metadata provided with each context chunk to understand the code's structure, origin, language features, and relationships (like inheritance, hooks, scope). Use this metadata to identify areas needing clarification. Prioritize information from chunks with higher relevance scores if applicable when trying to pinpoint what information is missing or ambiguous.
---
`;

  // Even if workspace.openAiPrompt exists, we are overriding it with the new question-asking behavior.
  // However, we still pass it through SystemPromptVariables for consistency in variable expansion.
  const basePrompt = workspace?.openAiPrompt ? `${workspace.openAiPrompt}\n\n${newSystemInstructions}` : newSystemInstructions;


  // Expand any variables in the combined prompt.
  return await SystemPromptVariables.expandSystemPromptVariables(
    basePrompt, // The new instructions are now part of basePrompt
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
