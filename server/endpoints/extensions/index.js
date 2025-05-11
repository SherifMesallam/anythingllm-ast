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
            progress.repositories[repoFullName].documents = {
              fileCount: responseFromProcessor.data.files,
              destination: responseFromProcessor.data.destination
            };
            updateProgress();

            // Embed files into workspace
            const destination = responseFromProcessor.data.destination;
            const documentsDir = path.join(process.cwd(), 'collector', 'hotdir', destination);
            if (!fs.existsSync(documentsDir)) {
              throw new Error(`Directory not found: ${documentsDir}`);
            }

            // Add files to workspace
            appendLog(`Adding files to workspace ${workspace.slug}`);
            const files = fs.readdirSync(documentsDir)
              .filter(file => file.endsWith(".json"))
              .map(file => `${destination}/${file}`);

            if (files.length === 0) {
              throw new Error(`No files found in ${destination}`);
            }

            await Workspace.modifyEmbeddings(workspace.slug, {
              adds: files,
              deletes: []
            });

            appendLog(`Successfully imported ${repoFullName} into workspace ${workspace.slug}`);
            progress.repositories[repoFullName].status = "completed";
            progress.completed++;
            updateProgress();
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
              repoData.documents = {
                fileCount: responseFromProcessor.data.files,
                destination: responseFromProcessor.data.destination
              };
              updateProgress();
            }

            // Embed files into workspace
            const destination = repoData.documents.destination;
            const documentsDir = path.join(process.cwd(), 'collector', 'hotdir', destination);
            if (!fs.existsSync(documentsDir)) {
              throw new Error(`Directory not found: ${documentsDir}`);
            }

            // Add files to workspace
            appendLog(`Adding files to workspace ${repoData.workspace.slug}`);
            const files = fs.readdirSync(documentsDir)
              .filter(file => file.endsWith(".json"))
              .map(file => `${destination}/${file}`);

            if (files.length === 0) {
              throw new Error(`No files found in ${destination}`);
            }

            await Workspace.modifyEmbeddings(repoData.workspace.slug, {
              adds: files,
              deletes: []
            });

            appendLog(`Successfully imported ${repoFullName} into workspace ${repoData.workspace.slug}`);
            repoData.status = "completed";
            progress.completed++;
            updateProgress();
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
}

module.exports = { extensionEndpoints };
