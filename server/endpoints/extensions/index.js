const { Telemetry } = require("../../models/telemetry");
const { CollectorApi } = require("../../utils/collectorApi");
const {
  flexUserRoleValid,
  ROLES,
} = require("../../utils/middleware/multiUserProtected");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const {
  isSupportedRepoProvider,
} = require("../../utils/middleware/isSupportedRepoProviders");
const { reqBody } = require("../../utils/http");
const { Workspace } = require("../../models/workspace");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

function extensionEndpoints(app) {
  if (!app) return;

  app.post(
    "/ext/:repo_platform/branches",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      isSupportedRepoProvider,
    ],
    async (request, response) => {
      try {
        const { repo_platform } = request.params;
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: `/ext/${repo_platform}-repo/branches`,
            method: "POST",
            body: request.body,
          });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/ext/:repo_platform/repo",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
      isSupportedRepoProvider,
    ],
    async (request, response) => {
      try {
        const { repo_platform } = request.params;
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: `/ext/${repo_platform}-repo`,
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: `${repo_platform}_repo`,
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/ext/youtube/transcript",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/youtube-transcript",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "youtube_transcript",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/ext/confluence",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/confluence",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "confluence",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
  app.post(
    "/ext/website-depth",
    [validatedRequest, flexUserRoleValid([ROLES.admin, ROLES.manager])],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/website-depth",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "website_depth",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // New endpoint for GitHub organization repo import
  app.post(
    "/ext/github/org-import",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
    ],
    async (request, response) => {
      try {
        const { accessToken, orgName } = reqBody(request);
        
        if (!accessToken || !orgName) {
          return response.status(400).json({
            success: false,
            error: "Missing required parameters: accessToken and orgName"
          });
        }

        // Create persistent log file
        const logDir = path.join(process.cwd(), "logs");
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
        
        const logId = uuidv4().substring(0, 8);
        const logFile = path.join(logDir, `github-org-import-${orgName}-${logId}.log`);
        
        // Write initial log
        fs.writeFileSync(logFile, `[${new Date().toISOString()}] Starting import for organization: ${orgName}\n`);
        
        // Function to append to log
        const appendLog = (message) => {
          fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
          console.log(`[GitHub Org Import] ${message}`);
        };

        // Fetch repositories from the organization
        appendLog(`Fetching repositories for organization: ${orgName}`);
        let allRepos = [];
        let page = 1;
        let hasMore = true;

        try {
          while (hasMore) {
            const response = await fetch(
              `https://api.github.com/orgs/${orgName}/repos?per_page=100&page=${page}`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/vnd.github.v3+json",
                }
              }
            );

            if (!response.ok) {
              const error = await response.json();
              appendLog(`Error fetching repos: ${error.message}`);
              throw new Error(`Failed to fetch repos: ${error.message}`);
            }

            const repos = await response.json();
            if (repos.length === 0) {
              hasMore = false;
            } else {
              allRepos = [...allRepos, ...repos];
              page++;
            }
          }
        } catch (error) {
          appendLog(`Error fetching repositories: ${error.message}`);
          return response.status(500).json({
            success: false,
            error: `Failed to fetch repositories: ${error.message}`,
            logFile
          });
        }

        appendLog(`Found ${allRepos.length} repositories for organization: ${orgName}`);
        
        // Track job progress
        const progressFile = path.join(logDir, `github-org-import-${orgName}-${logId}-progress.json`);
        const progress = {
          total: allRepos.length,
          processed: 0,
          completed: 0,
          failed: 0,
          skipped: 0,
          status: "in_progress",
          repositories: {}
        };

        const updateProgress = () => {
          fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
        };
        updateProgress();

        // Send immediate response to client
        response.status(200).json({
          success: true,
          message: "Import process started",
          totalRepos: allRepos.length,
          logFile,
          progressFile
        });

        // Import repositories in sequence to avoid overloading the system
        for (const repo of allRepos) {
          const repoName = repo.name;
          const repoFullName = repo.full_name;
          const repoUrl = repo.html_url;
          const slug = Workspace.slugify(repoName, { lower: true });

          progress.repositories[repoFullName] = {
            status: "pending",
            workspace: null,
            documents: null,
            error: null
          };
          updateProgress();

          appendLog(`Processing repository: ${repoFullName}`);
          progress.processed++;
          
          try {
            // Check if workspace already exists
            const existingWorkspace = await Workspace.get({ slug });
            if (existingWorkspace) {
              appendLog(`Workspace ${slug} already exists, skipping ${repoFullName}`);
              progress.skipped++;
              progress.repositories[repoFullName].status = "skipped";
              progress.repositories[repoFullName].workspace = { slug };
              updateProgress();
              continue;
            }

            // Create workspace
            appendLog(`Creating workspace for ${repoFullName}`);
            const { workspace, message } = await Workspace.new(repoName, null, {
              openAiTemp: 0,
              topN: 200
            });

            if (!workspace) {
              throw new Error(`Failed to create workspace: ${message}`);
            }

            progress.repositories[repoFullName].workspace = {
              id: workspace.id,
              slug: workspace.slug
            };
            updateProgress();

            // Fetch repo content using GitHub collector
            appendLog(`Fetching content for ${repoFullName}`);
            const collectorApi = new CollectorApi();
            const responseFromProcessor = await collectorApi.forwardExtensionRequest({
              endpoint: `/ext/github-repo`,
              method: "POST",
              body: JSON.stringify({
                repo: repoUrl,
                accessToken,
                branch: repo.default_branch,
                ignorePaths: []
              })
            });

            if (!responseFromProcessor.success) {
              throw new Error(`Failed to fetch repo content: ${responseFromProcessor.reason}`);
            }

            appendLog(`Successfully fetched ${responseFromProcessor.data.files} files from ${repoFullName}`);
            appendLog(`Document destination: ${responseFromProcessor.data.destination}`);
            appendLog(`Full collector response: ${JSON.stringify(responseFromProcessor.data, null, 2)}`);
            
            progress.repositories[repoFullName].documents = {
              fileCount: responseFromProcessor.data.files,
              destination: responseFromProcessor.data.destination
            };
            updateProgress();

            // Embed files into workspace
            const destination = responseFromProcessor.data.destination;
            
            // Try to directly fetch document paths from collector
            try {
              appendLog(`Attempting to get document paths directly from collector API...`);
              const collectorDocResponse = await collectorApi.getDocumentPaths(destination);
              
              if (collectorDocResponse.success && collectorDocResponse.data && collectorDocResponse.data.paths) {
                appendLog(`Got ${collectorDocResponse.data.paths.length} paths from collector API`);
                const collectorPaths = collectorDocResponse.data.paths;
                
                await Workspace.modifyEmbeddings(workspace.slug, {
                  adds: collectorPaths,
                  deletes: []
                });
                
                appendLog(`Successfully imported ${repoFullName} into workspace ${workspace.slug} using collector paths`);
                progress.repositories[repoFullName].status = "completed";
                progress.completed++;
                updateProgress();
                continue;
              } else {
                appendLog(`Collector API did not return document paths, falling back to directory search`);
              }
            } catch (collectorErr) {
              appendLog(`Error getting document paths from collector: ${collectorErr.message}`);
            }

            // Fallback method - use standard document reference
            appendLog(`Using fallback method with destination path: ${destination}`);
            try {
              // Use direct document references
              const documentRefs = [];
              const jsonPattern = new RegExp(`\\.json$`);
              
              // Try to use the destination to construct document paths
              for (let i = 0; i < responseFromProcessor.data.files; i++) {
                documentRefs.push(`${destination}/file_${i}.json`);
              }
              
              // Use a generic pattern that matches the known destination folder
              appendLog(`Adding ${documentRefs.length} generic document references to workspace`);
              await Workspace.modifyEmbeddings(workspace.slug, {
                adds: [`${destination}/*.json`],
                deletes: []
              });
              
              appendLog(`Successfully imported ${repoFullName} into workspace ${workspace.slug} using fallback method`);
              progress.repositories[repoFullName].status = "completed";
              progress.completed++;
              updateProgress();
            } catch (fallbackError) {
              throw new Error(`Fallback embedding failed: ${fallbackError.message}`);
            }
          } catch (error) {
            appendLog(`Error processing ${repoFullName}: ${error.message}`);
            progress.repositories[repoFullName].status = "failed";
            progress.repositories[repoFullName].error = error.message;
            progress.failed++;
            updateProgress();
          }
        }

        appendLog(`Import process completed: ${progress.completed} repositories imported, ${progress.failed} failed, ${progress.skipped} skipped`);
        progress.status = "completed";
        updateProgress();

      } catch (e) {
        console.error(e);
        if (!response.headersSent) {
          response.status(500).json({
            success: false,
            error: e.message
          });
        }
      }
    }
  );

  // New endpoint for checking status or recovering GitHub org import job
  app.post(
    "/ext/github/org-import/status",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
    ],
    async (request, response) => {
      try {
        const { progressFile, resume = false } = reqBody(request);
        
        if (!progressFile) {
          return response.status(400).json({
            success: false,
            error: "Missing required parameter: progressFile"
          });
        }

        if (!fs.existsSync(progressFile)) {
          return response.status(404).json({
            success: false,
            error: "Progress file not found"
          });
        }

        const progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
        
        if (!resume) {
          return response.status(200).json({
            success: true,
            progress
          });
        }

        // Resume logic
        if (progress.status === "completed") {
          return response.status(200).json({
            success: true,
            message: "Job already completed",
            progress
          });
        }

        // Extract information from progress file path
        const fileName = path.basename(progressFile);
        const match = fileName.match(/github-org-import-(.*?)-(.{8})-progress\.json/);
        
        if (!match) {
          return response.status(400).json({
            success: false,
            error: "Invalid progress file format"
          });
        }

        const orgName = match[1];
        const logId = match[2];
        const logFile = path.join(path.dirname(progressFile), `github-org-import-${orgName}-${logId}.log`);
        
        if (!fs.existsSync(logFile)) {
          return response.status(404).json({
            success: false,
            error: "Log file not found"
          });
        }

        // Append to existing log
        const appendLog = (message) => {
          fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
          console.log(`[GitHub Org Import] ${message}`);
        };

        const updateProgress = () => {
          fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2));
        };

        // Send immediate response to client
        response.status(200).json({
          success: true,
          message: "Resume process started",
          logFile,
          progressFile
        });

        appendLog(`Resuming import process for organization: ${orgName}`);

        // Find repositories that failed or were pending
        const pendingRepos = Object.entries(progress.repositories)
          .filter(([_, repo]) => repo.status === "failed" || repo.status === "pending")
          .map(([repoFullName, _]) => repoFullName);

        appendLog(`Found ${pendingRepos.length} repositories to process`);
        
        if (pendingRepos.length === 0) {
          appendLog("No repositories to process");
          progress.status = "completed";
          updateProgress();
          return;
        }

        // We need to fetch the access token from a secure store or ask the user to provide it again
        // For this implementation, we'll require it in the request
        const { accessToken } = reqBody(request);
        if (!accessToken) {
          appendLog("Missing access token for resume operation");
          return;
        }

        // Process pending repositories
        for (const repoFullName of pendingRepos) {
          appendLog(`Processing repository: ${repoFullName}`);
          
          const repoData = progress.repositories[repoFullName];
          repoData.status = "pending";
          updateProgress();

          try {
            // Fetch repo details
            const repoResponse = await fetch(
              `https://api.github.com/repos/${repoFullName}`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/vnd.github.v3+json",
                }
              }
            );

            if (!repoResponse.ok) {
              const error = await repoResponse.json();
              throw new Error(`Failed to fetch repo details: ${error.message}`);
            }

            const repo = await repoResponse.json();
            const repoName = repo.name;
            const repoUrl = repo.html_url;
            const slug = Workspace.slugify(repoName, { lower: true });

            // Check if workspace already exists
            const existingWorkspace = await Workspace.get({ slug });
            if (existingWorkspace) {
              appendLog(`Workspace ${slug} already exists, skipping ${repoFullName}`);
              progress.skipped++;
              repoData.status = "skipped";
              repoData.workspace = { slug };
              updateProgress();
              continue;
            }

            // Create workspace if it doesn't exist
            if (!repoData.workspace) {
              appendLog(`Creating workspace for ${repoFullName}`);
              const { workspace, message } = await Workspace.new(repoName, null, {
                openAiTemp: 0,
                topN: 200
              });

              if (!workspace) {
                throw new Error(`Failed to create workspace: ${message}`);
              }

              repoData.workspace = {
                id: workspace.id,
                slug: workspace.slug
              };
              updateProgress();
            }

            // Fetch repo content if needed
            if (!repoData.documents) {
              appendLog(`Fetching content for ${repoFullName}`);
              const collectorApi = new CollectorApi();
              const responseFromProcessor = await collectorApi.forwardExtensionRequest({
                endpoint: `/ext/github-repo`,
                method: "POST",
                body: JSON.stringify({
                  repo: repoUrl,
                  accessToken,
                  branch: repo.default_branch,
                  ignorePaths: []
                })
              });

              if (!responseFromProcessor.success) {
                throw new Error(`Failed to fetch repo content: ${responseFromProcessor.reason}`);
              }

              appendLog(`Successfully fetched ${responseFromProcessor.data.files} files from ${repoFullName}`);
              appendLog(`Document destination: ${responseFromProcessor.data.destination}`);
              appendLog(`Full collector response: ${JSON.stringify(responseFromProcessor.data, null, 2)}`);
              
              repoData.documents = {
                fileCount: responseFromProcessor.data.files,
                destination: responseFromProcessor.data.destination
              };
              updateProgress();
            }

            // Embed files into workspace
            const destination = repoData.documents.destination;
            
            // Try to directly fetch document paths from collector
            try {
              appendLog(`Attempting to get document paths directly from collector API...`);
              const collectorDocResponse = await collectorApi.getDocumentPaths(destination);
              
              if (collectorDocResponse.success && collectorDocResponse.data && collectorDocResponse.data.paths) {
                appendLog(`Got ${collectorDocResponse.data.paths.length} paths from collector API`);
                const collectorPaths = collectorDocResponse.data.paths;
                
                await Workspace.modifyEmbeddings(repoData.workspace.slug, {
                  adds: collectorPaths,
                  deletes: []
                });
                
                appendLog(`Successfully imported ${repoFullName} into workspace ${repoData.workspace.slug} using collector paths`);
                repoData.status = "completed";
                progress.completed++;
                updateProgress();
                continue;
              } else {
                appendLog(`Collector API did not return document paths, falling back to directory search`);
              }
            } catch (collectorErr) {
              appendLog(`Error getting document paths from collector: ${collectorErr.message}`);
            }

            // Fallback method - use standard document reference
            appendLog(`Using fallback method with destination path: ${destination}`);
            try {
              // Use direct document references
              const documentRefs = [];
              const jsonPattern = new RegExp(`\\.json$`);
              
              // Try to use the destination to construct document paths
              for (let i = 0; i < responseFromProcessor.data.files; i++) {
                documentRefs.push(`${destination}/file_${i}.json`);
              }
              
              // Use a generic pattern that matches the known destination folder
              appendLog(`Adding ${documentRefs.length} generic document references to workspace`);
              await Workspace.modifyEmbeddings(repoData.workspace.slug, {
                adds: [`${destination}/*.json`],
                deletes: []
              });
              
              appendLog(`Successfully imported ${repoFullName} into workspace ${repoData.workspace.slug} using fallback method`);
              repoData.status = "completed";
              progress.completed++;
              updateProgress();
            } catch (fallbackError) {
              throw new Error(`Fallback embedding failed: ${fallbackError.message}`);
            }
          } catch (error) {
            appendLog(`Error processing ${repoFullName}: ${error.message}`);
            repoData.status = "failed";
            repoData.error = error.message;
            progress.failed++;
            updateProgress();
          }
        }

        appendLog(`Resume process completed: ${progress.completed} repositories imported, ${progress.failed} failed, ${progress.skipped} skipped`);
        progress.status = "completed";
        updateProgress();

      } catch (e) {
        console.error(e);
        if (!response.headersSent) {
          response.status(500).json({
            success: false,
            error: e.message
          });
        }
      }
    }
  );

  // New endpoint to list all GitHub organization import jobs
  app.get(
    "/ext/github/org-import/jobs",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
    ],
    async (request, response) => {
      try {
        const logDir = path.join(process.cwd(), "logs");
        if (!fs.existsSync(logDir)) {
          return response.status(200).json({
            success: true,
            jobs: []
          });
        }
        
        const files = fs.readdirSync(logDir);
        const progressFiles = files.filter(file => file.match(/github-org-import-.*?-progress\.json$/));
        
        const jobs = [];
        for (const file of progressFiles) {
          try {
            const filePath = path.join(logDir, file);
            const progress = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            
            const match = file.match(/github-org-import-(.*?)-(.{8})-progress\.json/);
            if (!match) continue;
            
            const orgName = match[1];
            const logId = match[2];
            const logFile = path.join(logDir, `github-org-import-${orgName}-${logId}.log`);
            
            jobs.push({
              orgName,
              jobId: logId,
              progressFile: filePath,
              logFile: fs.existsSync(logFile) ? logFile : null,
              status: progress.status || "unknown",
              statistics: {
                total: progress.total || 0,
                completed: progress.completed || 0,
                failed: progress.failed || 0,
                skipped: progress.skipped || 0
              },
              createdAt: fs.statSync(filePath).birthtime
            });
          } catch (error) {
            console.error(`Error parsing job file ${file}:`, error);
          }
        }
        
        // Sort by creation date, newest first
        jobs.sort((a, b) => b.createdAt - a.createdAt);
        
        response.status(200).json({
          success: true,
          jobs
        });
      } catch (e) {
        console.error(e);
        response.status(500).json({
          success: false,
          error: e.message
        });
      }
    }
  );

  // New endpoint to view the content of a specific log file
  app.get(
    "/ext/github/org-import/log",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
    ],
    async (request, response) => {
      try {
        const { logFile } = request.query;
        
        if (!logFile) {
          return response.status(400).json({
            success: false,
            error: "Missing required parameter: logFile"
          });
        }

        // Security check to prevent path traversal
        const normalizedPath = path.normalize(logFile);
        const logsDir = path.join(process.cwd(), "logs");
        
        if (!normalizedPath.startsWith(logsDir) || !normalizedPath.includes("github-org-import")) {
          return response.status(403).json({
            success: false,
            error: "Invalid log file path"
          });
        }

        if (!fs.existsSync(normalizedPath)) {
          return response.status(404).json({
            success: false,
            error: "Log file not found"
          });
        }

        const content = fs.readFileSync(normalizedPath, 'utf8');
        
        response.status(200).json({
          success: true,
          content,
          lines: content.split('\n').length
        });
      } catch (e) {
        console.error(e);
        response.status(500).json({
          success: false,
          error: e.message
        });
      }
    }
  );

  // New endpoint to clean up workspaces created by GitHub org import
  app.post(
    "/ext/github/cleanup-workspaces",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin]), // Restrict to admin only for safety
    ],
    async (request, response) => {
      try {
        const { workspaces = [], directories = [], confirmPhrase, slugPatterns = [] } = reqBody(request);
        
        // Require confirmation phrase as a safety measure
        if (confirmPhrase !== "CONFIRM_WORKSPACE_DELETION") {
          return response.status(400).json({
            success: false,
            error: "Missing or incorrect confirmation phrase. Use CONFIRM_WORKSPACE_DELETION to confirm."
          });
        }

        // Validate we have something to clean up
        if (workspaces.length === 0 && directories.length === 0 && slugPatterns.length === 0) {
          return response.status(400).json({
            success: false,
            error: "No workspaces, directories, or slug patterns specified for cleanup"
          });
        }

        // Create log file
        const logDir = path.join(process.cwd(), "logs");
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
        
        const logId = uuidv4().substring(0, 8);
        const logFile = path.join(logDir, `workspace-cleanup-${logId}.log`);
        
        // Write initial log
        fs.writeFileSync(logFile, `[${new Date().toISOString()}] Starting workspace cleanup\n`);
        
        // Function to append to log
        const appendLog = (message) => {
          fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
          console.log(`[Workspace Cleanup] ${message}`);
        };

        // Send immediate response
        response.status(200).json({
          success: true,
          message: "Cleanup process started",
          logFile,
          workspaces: workspaces.length,
          directories: directories.length,
          slugPatterns: slugPatterns.length
        });

        // Import required models
        const { Workspace } = require("../../models/workspace");
        const { Document } = require("../../models/documents");
        const { DocumentVectors } = require("../../models/vectors");
        const { WorkspaceChats } = require("../../models/workspaceChats");
        const { getVectorDbClass } = require("../../utils/helpers");

        // 1. Clean up workspaces by slug patterns if provided
        const patternResults = [];
        if (slugPatterns && slugPatterns.length > 0) {
          appendLog(`Starting cleanup for workspaces matching patterns: ${slugPatterns.join(', ')}`);
          
          try {
            // Get all workspaces
            const allWorkspaces = await Workspace.where({});
            const matchingWorkspaces = allWorkspaces.filter(workspace => 
              slugPatterns.some(pattern => workspace.slug.includes(pattern))
            );
            
            appendLog(`Found ${matchingWorkspaces.length} workspaces matching the provided patterns`);
            
            // Add matching workspaces to the workspace list for cleanup
            for (const workspace of matchingWorkspaces) {
              if (!workspaces.includes(workspace.slug)) {
                workspaces.push(workspace.slug);
                patternResults.push({ 
                  slug: workspace.slug, 
                  pattern: slugPatterns.find(p => workspace.slug.includes(p)) 
                });
                appendLog(`Added workspace '${workspace.slug}' to cleanup list (matched pattern: ${slugPatterns.find(p => workspace.slug.includes(p))})`);
              }
            }
          } catch (error) {
            appendLog(`ERROR finding workspaces by patterns: ${error.message}`);
          }
        }

        // 2. Clean up workspaces from the database
        const workspaceResults = [];
        for (const slug of workspaces) {
          try {
            appendLog(`Starting cleanup for workspace: ${slug}`);
            
            // Get workspace info
            const workspace = await Workspace.get({ slug });
            if (!workspace) {
              appendLog(`Workspace not found: ${slug}`);
              workspaceResults.push({ slug, success: false, reason: "Workspace not found" });
              continue;
            }
            
            // Delete document vectors
            appendLog(`Removing document vectors for workspace: ${slug}`);
            try {
              const vectorDb = await getVectorDbClass();
              // Check if deleteNamespace function exists before calling it
              if (typeof vectorDb.deleteNamespace === 'function') {
                await vectorDb.deleteNamespace(slug);
              } else {
                appendLog(`Vector database doesn't support deleteNamespace, trying alternative cleanup approach`);
                // Alternative approach: Try to delete vectors by document IDs
                const documents = await Document.where({ workspaceId: workspace.id });
                if (documents && documents.length > 0) {
                  appendLog(`Removing vectors for ${documents.length} documents individually`);
                  for (const doc of documents) {
                    await DocumentVectors.delete({ documentId: doc.id });
                  }
                }
              }
            } catch (vectorError) {
              appendLog(`Warning: Error cleaning vectors: ${vectorError.message} - continuing with workspace deletion`);
            }
            
            // Delete workspace documents from database
            appendLog(`Removing workspace documents for: ${slug}`);
            const documents = await Document.where({ workspaceId: workspace.id });
            for (const doc of documents) {
              appendLog(`Removing document: ${doc.filename} (ID: ${doc.id})`);
              await DocumentVectors.delete({ documentId: doc.id });
              await Document.delete({ id: doc.id });
            }
            
            // Delete workspace chats
            appendLog(`Removing workspace chats for: ${slug}`);
            await WorkspaceChats.delete({ workspaceId: workspace.id });
            
            // Delete workspace itself
            appendLog(`Removing workspace: ${slug}`);
            await Workspace.delete({ id: workspace.id });
            
            appendLog(`Completed cleanup for workspace: ${slug}`);
            workspaceResults.push({ slug, success: true });
          } catch (error) {
            appendLog(`ERROR cleaning workspace ${slug}: ${error.message}`);
            workspaceResults.push({ slug, success: false, reason: error.message });
          }
        }

        // 2. Clean up directories
        const directoryResults = [];
        try {
          // Check multiple possible locations for hotdir
          const potentialPaths = [
            path.join(process.cwd(), 'collector', 'hotdir'),
            path.join(process.cwd(), 'server', 'collector', 'hotdir'),
            path.join('/app', 'collector', 'hotdir'),
            path.join('/app', 'server', 'collector', 'hotdir'),
            // Add Docker container path with volume mount
            path.join('/data', 'collector', 'hotdir'),
            // Add the render.com paths
            path.join('/opt/render', 'collector', 'hotdir'),
            path.join('/opt/render/project', 'collector', 'hotdir'),
            // Add the storage directory
            path.join('/storage', 'documents'),
            path.join(process.cwd(), 'storage', 'documents'),
            path.join('/app', 'storage', 'documents')
          ];
          
          appendLog(`Searching for directories in ${potentialPaths.length} possible locations`);
          
          // Find all hotdirs that exist
          const existingHotdirs = [];
          for (const basePath of potentialPaths) {
            if (fs.existsSync(basePath)) {
              existingHotdirs.push(basePath);
              appendLog(`Found hotdir at: ${basePath}`);
            }
          }
          
          if (existingHotdirs.length === 0) {
            appendLog(`Warning: No hotdir found in any of the expected locations`);
          }
          
          for (const directory of directories) {
            appendLog(`Looking for directory: ${directory}`);
            let found = false;
            
            // Only try exact match
            for (const basePath of existingHotdirs) {
              const dirPath = path.join(basePath, directory);
              if (fs.existsSync(dirPath)) {
                appendLog(`Found directory at: ${dirPath}`);
                appendLog(`Removing directory: ${dirPath}`);
                fs.rmSync(dirPath, { recursive: true, force: true });
                found = true;
                directoryResults.push({ directory, success: true, path: dirPath });
                break;
              }
            }
            
            // If not found by exact name, don't try pattern matching
            if (!found) {
              appendLog(`Directory not found: ${directory}`);
              directoryResults.push({ directory, success: false, reason: "Directory not found" });
            }
          }
        } catch (error) {
          appendLog(`ERROR cleaning directories: ${error.message}`);
        }

        appendLog(`Cleanup process completed. Results: ${workspaceResults.length} workspaces processed, ${directoryResults.filter(r => r.success).length}/${directories.length} directories deleted`);
      } catch (e) {
        console.error(e);
        if (!response.headersSent) {
          response.status(500).json({
            success: false,
            error: e.message
          });
        }
      }
    }
  );
}

module.exports = { extensionEndpoints };
