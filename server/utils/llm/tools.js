const commonToolSchemas = {
  ask_user_for_clarification: {
    name: "ask_user_for_clarification",
    description: "Ask the user a clarifying question when the request or context is ambiguous.",
    parameters: {
      type: "object",
      properties: {
        question_for_user: {
          type: "string",
          description: "The specific question to ask the user.",
        },
      },
      required: ["question_for_user"],
    },
  },
  search_documents: {
     name: "search_documents",
     description: "Search the available documents for more information relevant to a specific query. Use context chunks like [CONTEXT 0]...[END CONTEXT 0] to understand the available information first.",
     parameters: {
       type: "object",
       properties: {
         search_query: {
           type: "string",
           description: "The specific query to search for in the documents.",
         },
       },
       required: ["search_query"],
     },
  },
  get_file_content: {
      name: "get_file_content",
      description: "Retrieves the content of a specific file from a GitHub repository.",
      parameters: {
        type: "object",
        properties: {
          repository: {
            type: "string",
            description: "The GitHub repository in 'owner/repo' format.",
          },
          file_path: {
            type: "string",
            description: "The full path to the file within the repository.",
          },
        },
        required: ["repository", "file_path"],
      },
  }
};

// Helper to format for OpenAI (adapt schema types if needed)
function formatToolsForOpenAI(schemas = commonToolSchemas) {
  return Object.values(schemas).map(schema => ({
     type: "function",
     function: {
        name: schema.name,
        description: schema.description,
        // Basic schema conversion (example: lowercase types)
        parameters: convertSchemaTypes(schema.parameters, type => type.toLowerCase()) 
     }
  }));
}

// Helper to format for Gemini FunctionDeclaration
function formatToolsForGemini(schemas = commonToolSchemas) {
   const declarations = Object.values(schemas).map(schema => ({
      name: schema.name,
      description: schema.description,
      // Basic schema conversion (example: uppercase types)
      parameters: convertSchemaTypes(schema.parameters, type => type.toUpperCase())
   }));
   // Gemini expects the declarations wrapped in an object/array structure for the API
   return [{ functionDeclarations: declarations }];
}

// Recursive helper to convert types within a JSON schema-like structure
function convertSchemaTypes(schema, typeConverter) {
   if (!schema || typeof schema !== 'object') return schema;

   const newSchema = Array.isArray(schema) ? [] : {};

   for (const key in schema) {
     if (key === 'type' && typeof schema[key] === 'string') {
       newSchema[key] = typeConverter(schema[key]);
     } else if (typeof schema[key] === 'object') {
       newSchema[key] = convertSchemaTypes(schema[key], typeConverter); // Recurse
     } else {
       newSchema[key] = schema[key];
     }
   }
   return newSchema;
}


module.exports = {
  commonToolSchemas,
  formatToolsForOpenAI,
  formatToolsForGemini,
}; 