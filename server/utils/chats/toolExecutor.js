const { getVectorDbClass } = require("../helpers");
const { safeJsonParse } = require("../http");

/**
 * Executes the 'ask_user_for_clarification' tool.
 * In sync mode, returns an object indicating clarification is needed.
 * In stream mode, sends a specific chunk and returns null.
 * @param {object} args - Tool arguments ({ question_for_user: string })
 * @param {string} uuid - Request/Response UUID
 * @param {object} response - Express response object (for streaming)
 * @param {boolean} isStreaming - Indicates if called during streaming
 * @param {function} writeResponseChunk - Function to write stream chunks
 * @returns {object|null} - Object for sync mode, null for stream mode
 */
function executeAskUserTool(args, uuid, response, isStreaming, writeResponseChunk) {
  const question = args.question_for_user;
  if (!question) {
    console.error("executeAskUserTool: Missing 'question_for_user' argument.");
    return isStreaming ? null : { error: "Missing question argument for clarification tool." };
  }

  console.log(`Tool requesting user clarification: ${question}`);
  const responsePayload = {
    id: uuid, // Use provided uuid for sync response
    uuid: uuid, // Use provided uuid for stream chunk
    type: "user_clarification_required",
    question: question,
    chatId: null,
    sources: [],
    close: true,
    error: null,
    metrics: {},
  };

  if (isStreaming) {
    writeResponseChunk(response, responsePayload);
    return null; // Signal stream to stop
  } else {
    return responsePayload;
  }
}

/**
 * Executes the 'search_documents' tool.
 * @param {object} args - Tool arguments ({ search_query: string })
 * @param {object} workspace - The current workspace object
 * @param {object} LLMConnector - The current LLM connector instance
 * @returns {Promise<string>} - A string containing the search results or an error message.
 */
async function executeSearchDocumentsTool(args, workspace, LLMConnector) {
  const query = args.search_query;
  if (!query) {
    console.error("executeSearchDocumentsTool: Missing 'search_query' argument.");
    return "Error: Missing search query argument.";
  }

  try {
    const VectorDb = getVectorDbClass();
    const { contextTexts: searchResults } = await VectorDb.performSimilaritySearch({
      namespace: workspace.slug,
      input: query,
      LLMConnector,
      topN: workspace?.topN ?? 4,
      filterIdentifiers: null, // Maybe pass pinned identifiers if needed?
    });

    if (searchResults && searchResults.length > 0) {
      const resultText = `Found ${searchResults.length} relevant document sections:\n${searchResults.join('\n\n')}`;
      console.log("Tool search_documents result (truncated):", resultText.substring(0, 100) + "...");
      return resultText;
    } else {
      console.log("Tool search_documents: No relevant sections found.");
      return "No relevant document sections found for that query.";
    }
  } catch (error) {
    console.error(`Error executing search_documents tool: ${error.message}`, error);
    return `Error searching documents: ${error.message}`;
  }
}

/**
 * Executes the 'get_file_content' tool using GitHub API.
 * @param {object} args - Tool arguments ({ repository: string, file_path: string })
 * @returns {Promise<string>} - A string containing the file content (possibly truncated) or an error message.
 */
async function executeGetFileContentTool(args) {
  const { repository, file_path } = args;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

  // Input validation
  if (!repository || !file_path) {
    console.error("executeGetFileContentTool: Missing repository or file_path argument.");
    return "Error: Repository and file path arguments are required.";
  }
  if (!repository.includes('/')) {
     console.error(`executeGetFileContentTool: Invalid repository format: ${repository}`);
     return "Error: Invalid repository format. Use 'owner/repo'.";
  }
  if (!GITHUB_TOKEN) {
    console.error("executeGetFileContentTool: GITHUB_TOKEN environment variable not set.");
    return "Error: GitHub token is not configured on the server.";
  }

  const apiUrl = `https://api.github.com/repos/${repository}/contents/${file_path}`;
  console.log(`Fetching file content from: ${apiUrl}`);

  try {
    const response = await fetch(apiUrl, {
      headers: {
        Accept: "application/vnd.github.v3.raw",
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      timeout: 10000, // Add a timeout (e.g., 10 seconds)
    });

    if (response.status === 404) {
        console.warn(`executeGetFileContentTool: File not found (404) at ${apiUrl}`);
        return `Error: File not found at path '${file_path}' in repository '${repository}'.`;
    }
    if (response.status === 403) {
       // Could be rate limit or permission issue
       console.error(`executeGetFileContentTool: Forbidden (403) accessing ${apiUrl}. Check token permissions or rate limits.`);
       return `Error: Access denied when trying to fetch file '${file_path}'. Check token permissions or GitHub rate limits.`;
    }
    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`GitHub API request failed with status ${response.status}: ${errorBody}`);
    }

    let content = await response.text();
    const MAX_FILE_SIZE = 50000; // ~50kb limit
    if (content.length > MAX_FILE_SIZE) {
      content = content.substring(0, MAX_FILE_SIZE) + "\n... [File content truncated] ...";
      console.log("GitHub file content fetched successfully (truncated).");
    } else {
      console.log("GitHub file content fetched successfully.");
    }
    return content;
  } catch (error) {
    console.error(`Error executing get_file_content tool: ${error.message}`, error);
    // Check for timeout explicitly if using node-fetch with AbortController, or rely on generic message
    if (error.name === 'AbortError' || error.message.includes('timeout')) {
        return `Error: Timeout while trying to fetch file content from GitHub.`;
    }
    return `Error fetching file content: ${error.message}`;
  }
}

module.exports = {
  executeAskUserTool,
  executeSearchDocumentsTool,
  executeGetFileContentTool,
}; 