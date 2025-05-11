/**
 * Cross-workspace search utility
 * Provides functions to search across all workspaces instead of a single workspace
 */
const axios = require('axios');
const { sanitizeBigInts } = require('./index');

/**
 * Search across all workspaces using the cross-workspace search endpoint
 * @param {Object} params Search parameters 
 * @param {string} params.input The search query
 * @param {number} params.similarityThreshold Minimum similarity score to include results
 * @param {number} params.topN Maximum number of results to return
 * @param {string[]} params.workspaceSlugs Optional array of workspace slugs to limit search to
 * @param {string[]} params.filterIdentifiers Array of document identifiers to filter out
 * @param {boolean} params.rerank Whether to apply reranking
 * @returns {Promise<{sources: Array, message: string|null}>} Search results
 */
async function performCrossWorkspaceSearch({
  input,
  similarityThreshold = 0.25,
  topN = 4,
  workspaceSlugs = [],
  filterIdentifiers = [],
  rerank = false,
}) {
  try {
    // Use the server's own API endpoint (internal request)
    // This avoids duplicating the search logic
    const baseUrl = process.env.API_ENDPOINT || 'http://localhost:3001';
    const endpoint = '/v1/workspaces/vector-search';
    
    // Get API key from environment
    const apiKey = process.env.ANYTHINGLLM_API_KEY;
    
    if (!apiKey) {
      throw new Error('ANYTHINGLLM_API_KEY is not defined in environment');
    }
    
    // Call the cross-workspace search endpoint
    const response = await axios.post(
      `${baseUrl}${endpoint}`, 
      {
        query: input,
        topN,
        scoreThreshold: similarityThreshold,
        workspaceSlugs: workspaceSlugs.length > 0 ? workspaceSlugs : undefined,
      },
      {
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json'
        }
      }
    );
    
    // Extract and format the results to match the format expected by chat handlers
    const results = response.data?.results || [];
    
    if (results.length === 0) {
      return {
        sources: [],
        message: 'No relevant information found across workspaces.'
      };
    }
    
    // Transform results to match the format expected by chat handlers
    const sources = results.map(result => {
      // Add text directly to the source object for consistency
      return {
        ...result,
        ...result.metadata,
        // Add standard source fields for LLM context
        text: result.text,
        score: result.score,
      };
    });
    
    // Apply filtering for pinned documents if needed
    const filteredSources = filterIdentifiers.length > 0
      ? sources.filter(source => !filterIdentifiers.includes(source.docSource))
      : sources;
    
    return {
      sources: filteredSources,
      message: null
    };
    
  } catch (error) {
    console.error('Error performing cross-workspace search:', error);
    return {
      sources: [],
      message: `Error searching across workspaces: ${error.message}`
    };
  }
}

module.exports = {
  performCrossWorkspaceSearch
}; 