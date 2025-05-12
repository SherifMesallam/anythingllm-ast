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
const express = require("express");
const multer = require("multer");

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
            
            // Get file destination from collector response
            const fileDestination = responseFromProcessor.data.destination;
            const fileCount = responseFromProcessor.data.files;
            
            appendLog(`Successfully fetched ${fileCount} files from ${repoFullName}`);
            appendLog(`File destination: ${fileDestination}`);
            
            // Check multiple possible locations for the destination
            const potentialBasePaths = [
              fileDestination, // Direct path from collector
              path.join(process.cwd(), 'collector', 'hotdir'),
              path.join(process.cwd(), 'server', 'collector', 'hotdir'),
              path.join('/app', 'collector', 'hotdir'),
              path.join('/app', 'server', 'collector', 'hotdir'),
              path.join('/data', 'collector', 'hotdir'),
              path.join('/opt/render', 'collector', 'hotdir'),
              path.join('/opt/render/project', 'collector', 'hotdir'),
              path.join('/storage', 'documents'),
              path.join(process.cwd(), 'storage', 'documents'),
              path.join('/app', 'storage', 'documents')
            ];
            
            // Look for alternative paths for the destination directory
            let validDestination = null;
            let destinationFiles = 0;
            
            // First, check if the direct destination path exists
            if (fs.existsSync(fileDestination)) {
              validDestination = fileDestination;
              try {
                const files = fs.readdirSync(fileDestination).filter(f => f.endsWith('.json'));
                destinationFiles = files.length;
                appendLog(`Found ${destinationFiles} JSON files directly in ${validDestination}`);
              } catch (err) {
                appendLog(`Error reading direct destination directory: ${err.message}`);
              }
            } else {
              appendLog(`Direct destination path does not exist: ${fileDestination}`);
            }
            
            // If direct path didn't work, look for the document directory in other locations
            if (!validDestination || destinationFiles === 0) {
              // Generate possible directory name patterns
              const repoName = repoFullName.replace('/', '-').toLowerCase();
              const repoOwner = repoFullName.split('/')[0].toLowerCase();
              const repoSlug = repoFullName.split('/')[1].toLowerCase();
              
              const possibleDirPatterns = [
                repoName,  // gravityforms-simpleaddon
                `${repoOwner}-${repoSlug}-master-`, // gravityforms-simpleaddon-master-
                `${repoOwner}-${repoSlug}-main-`,   // gravityforms-simpleaddon-main-
                repoSlug,  // simpleaddon
                `${repoSlug}-master-`, // simpleaddon-master-
                `${repoSlug}-main-`,   // simpleaddon-main-
                // Add more patterns for different branch names
                `${repoOwner}-${repoSlug}-${repo.default_branch}-`,
                `${repoSlug}-${repo.default_branch}-`
              ];
              
              // Check each base path for each pattern
              outerLoop: for (const basePath of potentialBasePaths) {
                if (!fs.existsSync(basePath)) {
                  appendLog(`Base path does not exist: ${basePath}`);
                  continue;
                }
                
                try {
                  // Get all directories in this base path
                  const dirs = fs.readdirSync(basePath);
                  appendLog(`Found ${dirs.length} directories in ${basePath}`);
                  
                  // Check each directory against our patterns
                  for (const dir of dirs) {
                    for (const pattern of possibleDirPatterns) {
                      if (dir.includes(pattern)) {
                        const candidatePath = path.join(basePath, dir);
                        try {
                          // Check if this directory has JSON files
                          const files = fs.readdirSync(candidatePath).filter(f => f.endsWith('.json'));
                          if (files.length > 0) {
                            validDestination = candidatePath;
                            destinationFiles = files.length;
                            appendLog(`Found alternative directory with ${files.length} JSON files: ${validDestination}`);
                            break outerLoop;
                          }
                        } catch (err) {
                          appendLog(`Error checking directory ${candidatePath}: ${err.message}`);
                        }
                      }
                    }
                  }
                } catch (error) {
                  appendLog(`Error reading directory ${basePath}: ${error.message}`);
                }
              }
            }
            
            // Store document destination in progress
            progress.repositories[repoFullName].documents = {
              fileCount: responseFromProcessor.data.files,
              reportedDestination: fileDestination,
              actualDestination: validDestination,
              destinationFiles: destinationFiles
            };
            updateProgress();
            
            // If we found a valid destination with files, embed it into the workspace
            if (validDestination && destinationFiles > 0) {
              try {
                appendLog(`Adding ${destinationFiles} files from ${validDestination} to workspace ${workspace.slug}`);
                
                // List all JSON files in the directory
                const documentFiles = [];
                try {
                  const files = fs.readdirSync(validDestination);
                  for (const file of files) {
                    if (file.endsWith('.json')) {
                      documentFiles.push(`${validDestination}/${file}`);
                    }
                  }
                  appendLog(`Found ${documentFiles.length} JSON files to add`);
                } catch (err) {
                  appendLog(`Error reading directory ${validDestination}: ${err.message}`);
                  throw new Error(`Failed to read directory: ${err.message}`);
                }
                
                // Add individual files to workspace (exactly like UI would)
                const result = await Document.addDocuments(
                  workspace,
                  documentFiles,
                  null // No userId for system operations
                );
                
                if (result.failedToEmbed && result.failedToEmbed.length > 0) {
                  appendLog(`Warning: ${result.failedToEmbed.length} files failed to embed: ${result.errors.join(', ')}`);
                }
                
                appendLog(`Successfully imported ${repoFullName} into workspace ${workspace.slug}`);
                progress.repositories[repoFullName].status = "completed";
                progress.completed++;
                updateProgress();
              } catch (error) {
                throw new Error(`Embedding failed: ${error.message}`);
              }
            } else {
              // No valid destination found
              throw new Error(`Directory not found: None of the potential locations contained the repository files`);
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
              
              // Get file destination from collector response
              const fileDestination = responseFromProcessor.data.destination;
              const fileCount = responseFromProcessor.data.files;
              
              appendLog(`Successfully fetched ${fileCount} files from ${repoFullName}`);
              appendLog(`File destination: ${fileDestination}`);
              
              // Check multiple possible locations for the destination
              const potentialBasePaths = [
                fileDestination, // Direct path from collector
                path.join(process.cwd(), 'collector', 'hotdir'),
                path.join(process.cwd(), 'server', 'collector', 'hotdir'),
                path.join('/app', 'collector', 'hotdir'),
                path.join('/app', 'server', 'collector', 'hotdir'),
                path.join('/data', 'collector', 'hotdir'),
                path.join('/opt/render', 'collector', 'hotdir'),
                path.join('/opt/render/project', 'collector', 'hotdir'),
                path.join('/storage', 'documents'),
                path.join(process.cwd(), 'storage', 'documents'),
                path.join('/app', 'storage', 'documents')
              ];
              
              // Look for alternative paths for the destination directory
              let validDestination = null;
              let destinationFiles = 0;
              
              // First, check if the direct destination path exists
              if (fs.existsSync(fileDestination)) {
                validDestination = fileDestination;
                try {
                  const files = fs.readdirSync(fileDestination).filter(f => f.endsWith('.json'));
                  destinationFiles = files.length;
                  appendLog(`Found ${destinationFiles} JSON files directly in ${validDestination}`);
                } catch (err) {
                  appendLog(`Error reading direct destination directory: ${err.message}`);
                }
              } else {
                appendLog(`Direct destination path does not exist: ${fileDestination}`);
              }
              
              // If direct path didn't work, look for the document directory in other locations
              if (!validDestination || destinationFiles === 0) {
                // Generate possible directory name patterns
                const repoName = repoFullName.replace('/', '-').toLowerCase();
                const repoOwner = repoFullName.split('/')[0].toLowerCase();
                const repoSlug = repoFullName.split('/')[1].toLowerCase();
                
                const possibleDirPatterns = [
                  repoName,  // gravityforms-simpleaddon
                  `${repoOwner}-${repoSlug}-master-`, // gravityforms-simpleaddon-master-
                  `${repoOwner}-${repoSlug}-main-`,   // gravityforms-simpleaddon-main-
                  repoSlug,  // simpleaddon
                  `${repoSlug}-master-`, // simpleaddon-master-
                  `${repoSlug}-main-`,   // simpleaddon-main-
                  // Add more patterns for different branch names
                  `${repoOwner}-${repoSlug}-${repo.default_branch}-`,
                  `${repoSlug}-${repo.default_branch}-`
                ];
                
                // Check each base path for each pattern
                outerLoop: for (const basePath of potentialBasePaths) {
                  if (!fs.existsSync(basePath)) {
                    appendLog(`Base path does not exist: ${basePath}`);
                    continue;
                  }
                  
                  try {
                    // Get all directories in this base path
                    const dirs = fs.readdirSync(basePath);
                    appendLog(`Found ${dirs.length} directories in ${basePath}`);
                    
                    // Check each directory against our patterns
                    for (const dir of dirs) {
                      for (const pattern of possibleDirPatterns) {
                        if (dir.includes(pattern)) {
                          const candidatePath = path.join(basePath, dir);
                          try {
                            // Check if this directory has JSON files
                            const files = fs.readdirSync(candidatePath).filter(f => f.endsWith('.json'));
                            if (files.length > 0) {
                              validDestination = candidatePath;
                              destinationFiles = files.length;
                              appendLog(`Found alternative directory with ${files.length} JSON files: ${validDestination}`);
                              break outerLoop;
                            }
                          } catch (err) {
                            appendLog(`Error checking directory ${candidatePath}: ${err.message}`);
                          }
                        }
                      }
                    }
                  } catch (error) {
                    appendLog(`Error reading directory ${basePath}: ${error.message}`);
                  }
                }
              }
              
              // Store document destination in progress
              repoData.documents = {
                fileCount: responseFromProcessor.data.files,
                reportedDestination: fileDestination,
                actualDestination: validDestination,
                destinationFiles: destinationFiles
              };
              updateProgress();
              
              // If we found a valid destination with files, embed it into the workspace
              if (validDestination && destinationFiles > 0) {
                try {
                  appendLog(`Adding ${destinationFiles} files from ${validDestination} to workspace ${repoData.workspace.slug}`);
                  
                  // List all JSON files in the directory
                  const documentFiles = [];
                  try {
                    const files = fs.readdirSync(validDestination);
                    for (const file of files) {
                      if (file.endsWith('.json')) {
                        documentFiles.push(`${validDestination}/${file}`);
                      }
                    }
                    appendLog(`Found ${documentFiles.length} JSON files to add`);
                  } catch (err) {
                    appendLog(`Error reading directory ${validDestination}: ${err.message}`);
                    throw new Error(`Failed to read directory: ${err.message}`);
                  }
                  
                  // Add individual files to workspace (exactly like UI would)
                  const result = await Document.addDocuments(
                    repoData.workspace,
                    documentFiles,
                    null // No userId for system operations
                  );
                  
                  if (result.failedToEmbed && result.failedToEmbed.length > 0) {
                    appendLog(`Warning: ${result.failedToEmbed.length} files failed to embed: ${result.errors.join(', ')}`);
                  }
                  
                  appendLog(`Successfully imported ${repoFullName} into workspace ${repoData.workspace.slug}`);
                  repoData.status = "completed";
                  progress.completed++;
                  updateProgress();
                } catch (error) {
                  throw new Error(`Embedding failed: ${error.message}`);
                }
              } else {
                // No valid destination found
                throw new Error(`Directory not found: None of the potential locations contained the repository files`);
              }
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

  // New endpoint to recover GitHub org import workspaces
  app.post(
    "/ext/github/org-import/recover",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
    ],
    async (request, response) => {
      try {
        const { accessToken, orgNameFilter, dryRun = true } = reqBody(request);
        
        // Create persistent log file
        const logDir = path.join(process.cwd(), "logs");
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
        
        const logId = uuidv4().substring(0, 8);
        const logFile = path.join(logDir, `github-org-import-recovery-${logId}.log`);
        
        // Write initial log
        fs.writeFileSync(logFile, `[${new Date().toISOString()}] Starting GitHub org import recovery process\n`);
        
        // Function to append to log
        const appendLog = (message) => {
          fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
          console.log(`[GitHub Org Import Recovery] ${message}`);
        };

        // Load required models
        const { Workspace } = require("../../models/workspace");
        const { Document } = require("../../models/documents");
        
        // Get all workspaces
        appendLog(`Fetching all workspaces...`);
        const allWorkspaces = await Workspace.where({});
        appendLog(`Found ${allWorkspaces.length} total workspaces`);
        
        // Filter workspaces if orgNameFilter is provided
        let workspacesToProcess = allWorkspaces;
        if (orgNameFilter) {
          workspacesToProcess = allWorkspaces.filter(workspace => 
            workspace.slug.includes(orgNameFilter.toLowerCase())
          );
          appendLog(`Filtered to ${workspacesToProcess.length} workspaces matching ${orgNameFilter}`);
        }
        
        // Check for workspaces with no documents
        const workspacesWithNoDocuments = [];
        for (const workspace of workspacesToProcess) {
          const documents = await Document.where({ workspaceId: workspace.id });
          if (!documents || documents.length === 0) {
            workspacesWithNoDocuments.push(workspace);
          }
        }
        
        appendLog(`Found ${workspacesWithNoDocuments.length} workspaces with no documents`);
        
        // Prepare to store results
        const results = {
          total: workspacesWithNoDocuments.length,
          found: 0,
          notFound: 0,
          fixed: 0,
          skipped: 0,
          details: []
        };
        
        // Check multiple possible locations for hotdir
        const potentialBasePaths = [
          path.join(process.cwd(), 'collector', 'hotdir'),
          path.join(process.cwd(), 'server', 'collector', 'hotdir'),
          path.join('/app', 'collector', 'hotdir'),
          path.join('/app', 'server', 'collector', 'hotdir'),
          path.join('/data', 'collector', 'hotdir'),
          path.join('/opt/render', 'collector', 'hotdir'),
          path.join('/opt/render/project', 'collector', 'hotdir'),
          path.join('/storage', 'documents'),
          path.join(process.cwd(), 'storage', 'documents'),
          path.join('/app', 'storage', 'documents')
        ];
        
        // Find all existing base directories
        const existingBasePaths = [];
        for (const basePath of potentialBasePaths) {
          if (fs.existsSync(basePath)) {
            existingBasePaths.push(basePath);
            appendLog(`Found base directory at: ${basePath}`);
          }
        }
        
        if (existingBasePaths.length === 0) {
          appendLog(`Warning: No base directories found in any of the expected locations`);
          return response.status(400).json({
            success: false,
            error: "No valid document directories found",
            logFile
          });
        }
        
        // Process each workspace with no documents
        for (const workspace of workspacesWithNoDocuments) {
          appendLog(`Processing workspace: ${workspace.slug} (ID: ${workspace.id})`);
          
          // Generate potential directory names
          const repoName = workspace.slug.replace(/-/g, '');
          const possibleDirPatterns = [
            // Exact match
            workspace.slug,
            // With master branch
            `${workspace.slug}-master-`,
            // With main branch
            `${workspace.slug}-main-`,
            // Organization prefix
            `gravityforms-${workspace.slug}-master-`,
            // Different delimiters
            workspace.slug.replace(/-/g, '_'),
            // Direct match without hyphens
            repoName,
            // Match variations with master
            `${repoName}-master-`,
            // Removing common prefixes if they exist
            workspace.slug.replace(/^gravityforms-/, ''),
            workspace.slug.replace(/^gravityforms/, '')
          ];
          
          let documentDir = null;
          let foundPattern = null;
          // Look in each base path for each possible pattern
          outerLoop: for (const basePath of existingBasePaths) {
            try {
              // Get all directories in this base path
              const dirs = fs.readdirSync(basePath);
              
              // Check each directory against our patterns
              for (const dir of dirs) {
                for (const pattern of possibleDirPatterns) {
                  if (dir.includes(pattern)) {
                    documentDir = path.join(basePath, dir);
                    foundPattern = pattern;
                    break outerLoop;
                  }
                }
              }
            } catch (error) {
              appendLog(`Error reading directory ${basePath}: ${error.message}`);
            }
          }
          
          const workspaceResult = {
            slug: workspace.slug,
            id: workspace.id,
            found: !!documentDir,
            directory: documentDir,
            pattern: foundPattern,
            fixed: false,
            error: null
          };
          
          if (documentDir) {
            appendLog(`Found matching directory for ${workspace.slug}: ${documentDir} (matched pattern: ${foundPattern})`);
            results.found++;
            
            // Find document files in the directory
            const documentFiles = [];
            try {
              const files = fs.readdirSync(documentDir);
              for (const file of files) {
                if (file.endsWith('.json')) {
                  documentFiles.push(`${documentDir}/${file}`);
                }
              }
              appendLog(`Found ${documentFiles.length} JSON files in ${documentDir} for workspace ${workspace.slug}`);
              workspaceResult.found = true;
            } catch (err) {
              appendLog(`Error reading directory ${documentDir}: ${err.message}`);
              workspaceResult.error = `Error reading directory: ${err.message}`;
              results.notFound++;
              results.details.push(workspaceResult);
              continue;
            }
            
            if (documentFiles.length === 0) {
              appendLog(`No JSON files found in ${documentDir} for workspace ${workspace.slug}`);
              workspaceResult.error = 'No JSON files found in directory';
              results.notFound++;
              results.details.push(workspaceResult);
              continue;
            }
            
            if (!dryRun) {
              try {
                appendLog(`Adding ${documentFiles.length} files to workspace ${workspace.slug}`);
                const result = await Document.addDocuments(
                  workspace,
                  documentFiles,
                  null // No userId for system operations
                );
                
                if (result.failedToEmbed && result.failedToEmbed.length > 0) {
                  appendLog(`Warning: ${result.failedToEmbed.length} files failed to embed: ${result.errors.join(', ')}`);
                }
                
                appendLog(`Successfully imported ${workspace.slug} into workspace ${workspace.slug}`);
                workspaceResult.fixed = true;
                results.fixed++;
              } catch (error) {
                appendLog(`Error adding files to workspace: ${error.message}`);
                workspaceResult.error = error.message;
              }
            } else {
              appendLog(`[DRY RUN] Would add ${documentFiles.length} files to workspace ${workspace.slug}`);
              results.skipped++;
            }
          } else {
            appendLog(`No matching directory found for workspace: ${workspace.slug}`);
            results.notFound++;
          }
          
          results.details.push(workspaceResult);
        }
        
        appendLog(`Recovery process completed: ${results.found} directories found, ${results.fixed} workspaces fixed, ${results.notFound} not found, ${results.skipped} skipped (dry run)`);
        
        response.status(200).json({
          success: true,
          results,
          dryRun,
          logFile
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

  // New endpoint to reimport GitHub repositories for empty workspaces
  app.post(
    "/ext/github/reimport-empty-workspaces",
    [
      validatedRequest,
      flexUserRoleValid([ROLES.admin, ROLES.manager]),
    ],
    async (request, response) => {
      try {
        const { accessToken, orgNameFilter, dryRun = true } = reqBody(request);
        
        if (!accessToken) {
          return response.status(400).json({
            success: false,
            error: "Missing required parameter: accessToken"
          });
        }

        // Create persistent log file
        const logDir = path.join(process.cwd(), "logs");
        if (!fs.existsSync(logDir)) {
          fs.mkdirSync(logDir, { recursive: true });
        }
        
        const logId = uuidv4().substring(0, 8);
        const logFile = path.join(logDir, `github-reimport-${logId}.log`);
        
        // Write initial log
        fs.writeFileSync(logFile, `[${new Date().toISOString()}] Starting GitHub reimport for empty workspaces\n`);
        
        // Function to append to log
        const appendLog = (message) => {
          fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
          console.log(`[GitHub Reimport] ${message}`);
        };

        // Load required models
        const { Workspace } = require("../../models/workspace");
        const { Document } = require("../../models/documents");
        const { CollectorApi } = require("../../utils/collectorApi");
        
        // Get all workspaces
        appendLog(`Fetching all workspaces...`);
        const allWorkspaces = await Workspace.where({});
        appendLog(`Found ${allWorkspaces.length} total workspaces`);
        
        // Filter workspaces if orgNameFilter is provided
        let workspacesToProcess = allWorkspaces;
        if (orgNameFilter) {
          const filter = orgNameFilter.toLowerCase();
          workspacesToProcess = allWorkspaces.filter(workspace => 
            workspace.slug.includes(filter) || 
            workspace.name.toLowerCase().includes(filter)
          );
          appendLog(`Filtered to ${workspacesToProcess.length} workspaces matching ${orgNameFilter}`);
        }
        
        // Check for workspaces with no documents
        const emptyWorkspaces = [];
        for (const workspace of workspacesToProcess) {
          const documents = await Document.where({ workspaceId: workspace.id });
          if (!documents || documents.length === 0) {
            emptyWorkspaces.push(workspace);
          }
        }
        
        appendLog(`Found ${emptyWorkspaces.length} empty workspaces to process`);
        
        // Prepare to store results
        const results = {
          total: emptyWorkspaces.length,
          processed: 0,
          successful: 0,
          failed: 0,
          skipped: dryRun ? emptyWorkspaces.length : 0,
          details: []
        };
        
        // Send immediate response to client
        response.status(200).json({
          success: true,
          message: "Reimport process started",
          logFile,
          emptyWorkspaces: emptyWorkspaces.length
        });
        
        if (dryRun) {
          appendLog(`[DRY RUN] Would process ${emptyWorkspaces.length} workspaces, but dry run is enabled`);
          
          // Log what would be processed
          for (const workspace of emptyWorkspaces) {
            appendLog(`[DRY RUN] Would reimport GitHub repository for workspace: ${workspace.slug}`);
            results.details.push({
              workspace: workspace.slug,
              status: "skipped",
              reason: "Dry run enabled"
            });
          }
          
          appendLog(`[DRY RUN] Reimport process completed: All ${emptyWorkspaces.length} workspaces skipped due to dry run`);
          return;
        }
        
        // Setup the collector API
        const collectorApi = new CollectorApi();
        
        // Process each empty workspace
        for (const workspace of emptyWorkspaces) {
          appendLog(`Processing workspace: ${workspace.slug} (ID: ${workspace.id})`);
          results.processed++;
          
          // Determine the GitHub repository from the workspace slug or name
          let repoName = workspace.slug;
          let orgName = orgNameFilter || ""; // Default to provided org filter
          
          // Attempt to extract organization name from slug if it's formatted like "orgname-reponame"
          const slugParts = workspace.slug.split('-');
          if (slugParts.length > 1 && !orgName) {
            // Make an educated guess - the first part might be the org name
            orgName = slugParts[0];
          }
          
          // Remove org name prefix from repo name if present (e.g., "gravityforms-repo" -> "repo")
          if (orgName && repoName.startsWith(`${orgName}-`)) {
            repoName = repoName.substring(orgName.length + 1);
          }
          
          // If slug follows pattern "org-repo-branch-hash", try to extract repo name
          const repoMatch = workspace.slug.match(/^([^-]+)-([^-]+)(-[^-]+-[^-]+)?$/);
          if (repoMatch) {
            orgName = repoMatch[1];
            repoName = repoMatch[2];
          }
          
          const repoFullName = `${orgName}/${repoName}`;
          appendLog(`Determined repository as: ${repoFullName}`);
          
          try {
            const repoUrl = `https://github.com/${repoFullName}`;
            appendLog(`Fetching GitHub repository: ${repoUrl}`);
            
            // Determine default branch - we'll try 'main' first, then 'master' if it fails
            let branches = ['main', 'master'];
            let success = false;
            let responseFromProcessor = null;
            
            for (const branch of branches) {
              try {
                appendLog(`Trying branch: ${branch}`);
                responseFromProcessor = await collectorApi.forwardExtensionRequest({
                  endpoint: `/ext/github-repo`,
                  method: "POST",
                  body: JSON.stringify({
                    repo: repoUrl,
                    accessToken,
                    branch,
                    ignorePaths: []
                  })
                });
                
                if (responseFromProcessor.success) {
                  success = true;
                  appendLog(`Successfully fetched repository with branch: ${branch}`);
                  break;
                }
              } catch (branchError) {
                appendLog(`Error fetching with branch ${branch}: ${branchError.message}`);
              }
            }
            
            if (!success || !responseFromProcessor.success) {
              throw new Error(`Failed to fetch repository content for ${repoFullName}`);
            }
            
            // Get file destination from collector response
            const fileDestination = responseFromProcessor.data.destination;
            const fileCount = responseFromProcessor.data.files;
            
            appendLog(`Successfully fetched ${fileCount} files from ${repoFullName}`);
            appendLog(`File destination: ${fileDestination}`);
            
            // Check multiple possible locations for the destination
            const potentialBasePaths = [
              fileDestination, // Direct path from collector
              path.join(process.cwd(), 'collector', 'hotdir'),
              path.join(process.cwd(), 'server', 'collector', 'hotdir'),
              path.join('/app', 'collector', 'hotdir'),
              path.join('/app', 'server', 'collector', 'hotdir'),
              path.join('/data', 'collector', 'hotdir'),
              path.join('/opt/render', 'collector', 'hotdir'),
              path.join('/opt/render/project', 'collector', 'hotdir'),
              path.join('/storage', 'documents'),
              path.join(process.cwd(), 'storage', 'documents'),
              path.join('/app', 'storage', 'documents')
            ];
            
            // Look for alternative paths for the destination directory
            let validDestination = null;
            let destinationFiles = 0;
            
            // First, check if the direct destination path exists
            if (fs.existsSync(fileDestination)) {
              validDestination = fileDestination;
              try {
                const files = fs.readdirSync(fileDestination).filter(f => f.endsWith('.json'));
                destinationFiles = files.length;
                appendLog(`Found ${destinationFiles} JSON files directly in ${validDestination}`);
              } catch (err) {
                appendLog(`Error reading direct destination directory: ${err.message}`);
              }
            } else {
              appendLog(`Direct destination path does not exist: ${fileDestination}`);
            }
            
            // If direct path didn't work, look for the document directory in other locations
            if (!validDestination || destinationFiles === 0) {
              // Generate possible directory name patterns
              const repoName = repoFullName.replace('/', '-').toLowerCase();
              const repoOwner = repoFullName.split('/')[0].toLowerCase();
              const repoSlug = repoFullName.split('/')[1].toLowerCase();
              
              const possibleDirPatterns = [
                repoName,  // gravityforms-simpleaddon
                `${repoOwner}-${repoSlug}-master-`, // gravityforms-simpleaddon-master-
                `${repoOwner}-${repoSlug}-main-`,   // gravityforms-simpleaddon-main-
                repoSlug,  // simpleaddon
                `${repoSlug}-master-`, // simpleaddon-master-
                `${repoSlug}-main-`,   // simpleaddon-main-
                // Add more patterns for different branch names
                `${repoOwner}-${repoSlug}-${repo.default_branch}-`,
                `${repoSlug}-${repo.default_branch}-`
              ];
              
              // Check each base path for each pattern
              outerLoop: for (const basePath of potentialBasePaths) {
                if (!fs.existsSync(basePath)) {
                  appendLog(`Base path does not exist: ${basePath}`);
                  continue;
                }
                
                try {
                  // Get all directories in this base path
                  const dirs = fs.readdirSync(basePath);
                  appendLog(`Found ${dirs.length} directories in ${basePath}`);
                  
                  // Check each directory against our patterns
                  for (const dir of dirs) {
                    for (const pattern of possibleDirPatterns) {
                      if (dir.includes(pattern)) {
                        const candidatePath = path.join(basePath, dir);
                        try {
                          // Check if this directory has JSON files
                          const files = fs.readdirSync(candidatePath).filter(f => f.endsWith('.json'));
                          if (files.length > 0) {
                            validDestination = candidatePath;
                            destinationFiles = files.length;
                            appendLog(`Found alternative directory with ${files.length} JSON files: ${validDestination}`);
                            break outerLoop;
                          }
                        } catch (err) {
                          appendLog(`Error checking directory ${candidatePath}: ${err.message}`);
                        }
                      }
                    }
                  }
                } catch (error) {
                  appendLog(`Error reading directory ${basePath}: ${error.message}`);
                }
              }
            }
            
            // Store document destination in progress
            progress.repositories[repoFullName].documents = {
              fileCount: responseFromProcessor.data.files,
              reportedDestination: fileDestination,
              actualDestination: validDestination,
              destinationFiles: destinationFiles
            };
            updateProgress();
            
            // If we found a valid destination with files, embed it into the workspace
            if (validDestination && destinationFiles > 0) {
              try {
                appendLog(`Adding ${destinationFiles} files from ${validDestination} to workspace ${workspace.slug}`);
                
                // List all JSON files in the directory
                const documentFiles = [];
                try {
                  const files = fs.readdirSync(validDestination);
                  for (const file of files) {
                    if (file.endsWith('.json')) {
                      documentFiles.push(`${validDestination}/${file}`);
                    }
                  }
                  appendLog(`Found ${documentFiles.length} JSON files to add`);
                } catch (err) {
                  appendLog(`Error reading directory ${validDestination}: ${err.message}`);
                  throw new Error(`Failed to read directory: ${err.message}`);
                }
                
                // Add individual files to workspace (exactly like UI would)
                const result = await Document.addDocuments(
                  workspace,
                  documentFiles,
                  null // No userId for system operations
                );
                
                if (result.failedToEmbed && result.failedToEmbed.length > 0) {
                  appendLog(`Warning: ${result.failedToEmbed.length} files failed to embed: ${result.errors.join(', ')}`);
                }
                
                appendLog(`Successfully imported ${repoFullName} into workspace ${workspace.slug}`);
                
                results.successful++;
                results.details.push({
                  workspace: workspace.slug,
                  repository: repoFullName,
                  status: "success",
                  fileCount,
                  destination: fileDestination
                });
              } catch (error) {
                appendLog(`Error processing workspace ${workspace.slug}: ${error.message}`);
                results.failed++;
                results.details.push({
                  workspace: workspace.slug,
                  repository: repoFullName,
                  status: "failed",
                  error: error.message
                });
              }
            } else {
              // No valid destination found
              throw new Error(`Directory not found: None of the potential locations contained the repository files`);
            }
          } catch (error) {
            appendLog(`Error processing workspace ${workspace.slug}: ${error.message}`);
            results.failed++;
            results.details.push({
              workspace: workspace.slug,
              repository: repoFullName,
              status: "failed",
              error: error.message
            });
          }
        }
        
        appendLog(`Reimport process completed: ${results.successful} successful, ${results.failed} failed, ${results.skipped} skipped`);
        
        // Write final results to log
        fs.appendFileSync(logFile, `\n[${new Date().toISOString()}] FINAL RESULTS:\n${JSON.stringify(results, null, 2)}\n`);
        
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
