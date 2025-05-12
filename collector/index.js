process.env.NODE_ENV === "development"
  ? require("dotenv").config({ path: `.env.${process.env.NODE_ENV}` })
  : require("dotenv").config();

require("./utils/logger")();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");
const { ACCEPTED_MIMES } = require("./utils/constants");
const { reqBody } = require("./utils/http");
const { processSingleFile } = require("./processSingleFile");
const { processLink, getLinkText } = require("./processLink");
const { wipeCollectorStorage } = require("./utils/files");
const extensions = require("./extensions");
const { processRawText } = require("./processRawText");
const { verifyPayloadIntegrity } = require("./middleware/verifyIntegrity");
const fs = require("fs");

const app = express();
const FILE_LIMIT = "3GB";

app.use(cors({ origin: true }));
app.use(
  bodyParser.text({ limit: FILE_LIMIT }),
  bodyParser.json({ limit: FILE_LIMIT }),
  bodyParser.urlencoded({
    limit: FILE_LIMIT,
    extended: true,
  })
);

app.post(
  "/process",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { filename, options = {} } = reqBody(request);
    try {
      const targetFilename = path
        .normalize(filename)
        .replace(/^(\.\.(\/|\\|$))+/, "");
      const {
        success,
        reason,
        documents = [],
      } = await processSingleFile(targetFilename, options);
      response
        .status(200)
        .json({ filename: targetFilename, success, reason, documents });
    } catch (e) {
      console.error(e);
      response.status(200).json({
        filename: filename,
        success: false,
        reason: "A processing error occurred.",
        documents: [],
      });
    }
    return;
  }
);

app.post(
  "/process-link",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { link } = reqBody(request);
    try {
      const { success, reason, documents = [] } = await processLink(link);
      response.status(200).json({ url: link, success, reason, documents });
    } catch (e) {
      console.error(e);
      response.status(200).json({
        url: link,
        success: false,
        reason: "A processing error occurred.",
        documents: [],
      });
    }
    return;
  }
);

app.post(
  "/util/get-link",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { link, captureAs = "text" } = reqBody(request);
    try {
      const { success, content = null } = await getLinkText(link, captureAs);
      response.status(200).json({ url: link, success, content });
    } catch (e) {
      console.error(e);
      response.status(200).json({
        url: link,
        success: false,
        content: null,
      });
    }
    return;
  }
);

app.post(
  "/process-raw-text",
  [verifyPayloadIntegrity],
  async function (request, response) {
    const { textContent, metadata } = reqBody(request);
    try {
      const {
        success,
        reason,
        documents = [],
      } = await processRawText(textContent, metadata);
      response
        .status(200)
        .json({ filename: metadata.title, success, reason, documents });
    } catch (e) {
      console.error(e);
      response.status(200).json({
        filename: metadata?.title || "Unknown-doc.txt",
        success: false,
        reason: "A processing error occurred.",
        documents: [],
      });
    }
    return;
  }
);

app.post("/document-paths", [verifyRequest], async (request, response) => {
  try {
    const { folderName } = request.body;
    console.log(`[Document Paths]: Looking up paths for folder ${folderName}`);
    
    if (!folderName) {
      return response.status(400).json({
        success: false,
        reason: "Missing folderName parameter",
      });
    }
    
    // Search for the folder in the hotdir
    const hotDirPath = path.join(__dirname, 'hotdir');
    const folderPath = path.join(hotDirPath, folderName);
    
    if (fs.existsSync(folderPath)) {
      console.log(`[Document Paths]: Found folder at ${folderPath}`);
      const files = fs.readdirSync(folderPath)
        .filter(file => file.endsWith('.json'))
        .map(file => `${folderName}/${file}`);
      
      return response.status(200).json({
        success: true,
        data: {
          paths: files,
          folder: folderName,
          count: files.length
        }
      });
    }
    
    // If not found directly, search recursively
    console.log(`[Document Paths]: Folder not found directly, searching recursively...`);
    const findJsonFiles = (dir) => {
      let results = [];
      const list = fs.readdirSync(dir);
      
      for (const file of list) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
          // If this is our target folder
          if (file === folderName) {
            console.log(`[Document Paths]: Found matching folder at ${filePath}`);
            return fs.readdirSync(filePath)
              .filter(f => f.endsWith('.json'))
              .map(f => `${folderName}/${f}`);
          }
          // Otherwise check inside this directory
          const subResults = findJsonFiles(filePath);
          if (subResults.length > 0) return subResults;
        }
      }
      
      return results;
    };
    
    const files = findJsonFiles(hotDirPath);
    
    if (files.length > 0) {
      return response.status(200).json({
        success: true,
        data: {
          paths: files,
          folder: folderName,
          count: files.length
        }
      });
    }
    
    // Last attempt - try to find any JSON files in a folder containing the folderName
    console.log(`[Document Paths]: Searching for folders containing ${folderName}...`);
    const allJsonFiles = [];
    
    const findAllJsonFiles = (dir, baseDir = '') => {
      const list = fs.readdirSync(dir);
      
      for (const file of list) {
        const filePath = path.join(dir, file);
        const relativePath = path.join(baseDir, file);
        const stat = fs.statSync(filePath);
        
        if (stat.isDirectory()) {
          if (file.includes(folderName)) {
            console.log(`[Document Paths]: Found folder containing name: ${filePath}`);
            const jsonFiles = fs.readdirSync(filePath)
              .filter(f => f.endsWith('.json'))
              .map(f => path.join(relativePath, f));
            allJsonFiles.push(...jsonFiles);
          }
          findAllJsonFiles(filePath, relativePath);
        }
      }
    };
    
    findAllJsonFiles(hotDirPath);
    
    if (allJsonFiles.length > 0) {
      return response.status(200).json({
        success: true,
        data: {
          paths: allJsonFiles,
          folder: folderName,
          count: allJsonFiles.length,
          note: "Found files in folders containing the target name"
        }
      });
    }
    
    return response.status(404).json({
      success: false,
      reason: `No document files found for folder ${folderName}`,
    });
  } catch (error) {
    console.error(`[Document Paths]: Error processing request`, error);
    return response.status(500).json({
      success: false,
      reason: error.message,
    });
  }
});

extensions(app);

app.get("/accepts", function (_, response) {
  response.status(200).json(ACCEPTED_MIMES);
});

app.all("*", function (_, response) {
  response.sendStatus(200);
});

app
  .listen(8888, async () => {
    await wipeCollectorStorage();
    console.log(`Document processor app listening on port 8888`);
  })
  .on("error", function (_) {
    process.once("SIGUSR2", function () {
      process.kill(process.pid, "SIGUSR2");
    });
    process.on("SIGINT", function () {
      process.kill(process.pid, "SIGINT");
    });
  });
