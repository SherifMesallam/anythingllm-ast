const fs = require('fs').promises;
const path = require('path');

// Log directory will be in project_root/logs
const LOG_DIR = path.join(__dirname, '../../../logs');
const LOG_FILE_PATH = process.env.LLM_PROMPT_LOG_PATH || path.join(LOG_DIR, 'llm_prompts.log');

async function ensureLogDirectoryExists() {
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
  } catch (err) {
    // If the directory already exists, EEXIST error is expected, so we can ignore it.
    if (err.code !== 'EEXIST') {
      console.error('Failed to create log directory:', LOG_DIR, err);
      // Depending on requirements, you might want to re-throw or handle differently
    }
  }
}

/**
 * Logs the prompt sent to the LLM to a file.
 * @param {object} params - The parameters for logging.
 * @param {string} params.source - The source of the request (e.g., 'UI_STREAM', 'API_SYNC', 'API_STREAM').
 * @param {number|string|null} [params.workspaceId=null] - The ID of the workspace.
 * @param {number|string|null} [params.threadId=null] - The ID of the thread.
 * @param {number|string|null} [params.userId=null] - The ID of the user.
 * @param {string|null} [params.sessionId=null] - The session ID (for API calls).
 * @param {Array|object} params.messages - The messages payload sent to the LLM.
 * @param {string|null} [params.error=null] - Optional error message if prompt preparation failed.
 */
async function logLlmPrompt({
  source,
  workspaceId = null,
  threadId = null,
  userId = null,
  sessionId = null,
  messages,
  error = null,
}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    source,
    workspaceId,
    threadId,
    userId,
    sessionId,
    messagesCount: Array.isArray(messages) ? messages.length : (messages ? 1 : 0), // Log message count
    // Storing the full 'messages' object can make log files very large.
    // Consider logging only a summary or specific parts if size is a concern.
    // For now, we'll log the whole thing as requested.
    messages,
    error,
  };

  try {
    await ensureLogDirectoryExists();
    await fs.appendFile(LOG_FILE_PATH, JSON.stringify(logEntry) + '\n');
  } catch (err) {
    console.error('Failed to write LLM prompt to log file:', LOG_FILE_PATH, err);
  }
}

module.exports = { logLlmPrompt }; 