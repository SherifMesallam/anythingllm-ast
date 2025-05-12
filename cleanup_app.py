import streamlit as st
import requests
import json
import time
import pandas as pd

st.set_page_config(page_title="AnythingLLM Workspace Cleanup Tool", layout="wide")

st.title("AnythingLLM Workspace Cleanup Tool")

# Configuration section
with st.sidebar:
    st.header("Configuration")
    anythingllm_url = st.text_input("AnythingLLM URL", value="https://anythingllm-meta.onrender.com")
    
    st.info("Important: Enter the base AnythingLLM URL without '/api' at the end. The API endpoints will be added automatically.")
    
    auth_type = st.radio(
        "Authentication Type",
        ["JWT Token", "API Key", "Basic Auth", "No Auth"]
    )
    
    if auth_type == "JWT Token":
        jwt_token = st.text_area("JWT Token", height=100, help="Paste your full JWT token here. If token starts with 'Bearer', include it.")
        st.info("Make sure your JWT token is complete and includes 'Bearer ' prefix if that's how the server expects it.")
    elif auth_type == "API Key":
        api_key = st.text_input("API Key", type="password")
    elif auth_type == "Basic Auth":
        username = st.text_input("Username")
        password = st.text_input("Password", type="password")
    
    st.markdown("---")
    st.caption("This tool is used to clean up workspaces created by the GitHub organization import process.")

# Function to make authenticated requests
def make_request(endpoint, method="POST", json_data=None, auth=None):
    headers = {"Content-Type": "application/json"}
    
    # Authentication handling
    if auth_type == "JWT Token" and jwt_token:
        # JWT token authentication - make sure token is formatted correctly
        if jwt_token.strip().startswith("Bearer "):
            # User already included Bearer prefix
            headers["Authorization"] = jwt_token.strip()
        else:
            # Add Bearer prefix if not present
            headers["Authorization"] = f"Bearer {jwt_token.strip()}"
            
        # Log authentication attempt details
        st.info(f"Using JWT token authentication. Token length: {len(jwt_token)}")
    elif auth_type == "API Key" and api_key:
        # Try different auth header formats
        if "Bearer" in api_key:
            # User already included Bearer prefix
            headers["Authorization"] = api_key
        else:
            # Default format with Bearer prefix
            headers["Authorization"] = f"Bearer {api_key}"
            
        # Alternative header formats to try if the main one fails
        alt_headers = [
            {"Content-Type": "application/json", "Authorization": api_key},  # Direct token
            {"Content-Type": "application/json", "x-api-key": api_key},      # x-api-key format
            {"Content-Type": "application/json", "X-API-KEY": api_key}       # Uppercase format
        ]
    
    # Remove trailing slashes and add proper separator between base URL and endpoint
    base_url = anythingllm_url.rstrip('/')
    endpoint_path = endpoint.lstrip('/')
    url = f"{base_url}/{endpoint_path}"
    
    if auth_type == "Basic Auth" and username and password:
        auth = (username, password)
    else:
        auth = None
    
    with st.spinner(f"Making {method} request to {endpoint}..."):
        try:
            # Try the primary request
            if method == "GET":
                response = requests.get(url, headers=headers, auth=auth)
            else:
                response = requests.post(url, headers=headers, json=json_data, auth=auth)
            
            # If authentication failed with 401, try alternative header formats for API Key
            if response.status_code == 401 and auth_type == "API Key" and api_key:
                st.warning("Initial authentication failed. Trying alternative auth formats...")
                
                for alt_header in alt_headers:
                    st.info(f"Trying alternative auth format: {json.dumps(alt_header)}")
                    
                    if method == "GET":
                        alt_response = requests.get(url, headers=alt_header, auth=auth)
                    else:
                        alt_response = requests.post(url, headers=alt_header, json=json_data, auth=auth)
                    
                    if alt_response.status_code != 401:
                        st.success(f"Alternative auth format succeeded!")
                        response = alt_response
                        break
            
            # Display raw request and response for debugging
            with st.expander("Request/Response Details"):
                st.code(f"URL: {url}", language="text")
                st.code(f"Headers: {json.dumps({k: '***' if k.lower() == 'authorization' else v for k, v in headers.items()}, indent=2)}", language="json")
                if json_data:
                    st.code(f"Request Body: {json.dumps(json_data, indent=2)}", language="json")
                st.code(f"Response Status: {response.status_code}", language="text")
                try:
                    st.code(f"Response Body: {json.dumps(response.json(), indent=2)}", language="json")
                except:
                    st.code(f"Response Body: {response.text}", language="text")
            
            return response
        except Exception as e:
            st.error(f"Error making request: {str(e)}")
            return None

# Add an authentication test button
st.sidebar.markdown("---")
if st.sidebar.button("Test Authentication"):
    test_response = make_request("/api/ping", method="GET")
    
    if test_response:
        if test_response.status_code == 200:
            st.sidebar.success("Authentication successful!")
            try:
                response_json = test_response.json()
                st.sidebar.json(response_json)
            except:
                st.sidebar.text(test_response.text)
        elif test_response.status_code == 401:
            st.sidebar.error("Authentication failed: Unauthorized (401)")
            st.sidebar.info("Tips to fix auth issues:")
            st.sidebar.markdown("""
            1. Make sure your JWT token or API key is correct
            2. Check if the AnythingLLM URL is correct
            3. Try using a browser to access AnythingLLM directly to verify it's running
            4. Check your AnythingLLM logs for auth-related errors
            """)
            
            # Detailed JWT debugging
            if auth_type == "JWT Token" and jwt_token:
                st.sidebar.warning("JWT Token Debugging:")
                token_parts = jwt_token.strip().split(".")
                if len(token_parts) == 3:
                    st.sidebar.success("✅ Token has correct JWT format (3 parts)")
                else:
                    st.sidebar.error("❌ Token does not have correct JWT format (should have 3 parts)")
                
                if jwt_token.strip().startswith("Bearer "):
                    st.sidebar.success("✅ Token has 'Bearer ' prefix")
                else:
                    st.sidebar.warning("⚠️ Token doesn't have 'Bearer ' prefix - added automatically")
                
                # Show Authorization header that was sent
                auth_header = f"Bearer {jwt_token.strip()}"
                if jwt_token.strip().startswith("Bearer "):
                    auth_header = jwt_token.strip()
                    
                st.sidebar.info(f"Authorization header used: {auth_header[:15]}...{auth_header[-10:] if len(auth_header) > 25 else ''}")
                
                # Attempt alternative authentication approaches
                st.sidebar.warning("Trying alternative authentication approaches...")
                
                # Try without Bearer prefix
                if jwt_token.strip().startswith("Bearer "):
                    raw_token = jwt_token.strip()[7:]
                    st.sidebar.info("Trying without 'Bearer ' prefix...")
                    headers = {"Authorization": raw_token, "Content-Type": "application/json"}
                else:
                    st.sidebar.info("Trying with explicit 'Bearer ' prefix...")
                    headers = {"Authorization": f"Bearer {jwt_token.strip()}", "Content-Type": "application/json"}
                
                try:
                    alt_url = f"{anythingllm_url.rstrip('/')}/api/ping"
                    alt_response = requests.get(alt_url, headers=headers)
                    st.sidebar.text(f"Alternative approach status: {alt_response.status_code}")
                    st.sidebar.text(f"Response: {alt_response.text[:100]}")
                except Exception as e:
                    st.sidebar.error(f"Alternative approach error: {str(e)}")
        else:
            st.sidebar.warning(f"Received status code: {test_response.status_code}")
            st.sidebar.text(test_response.text)
    else:
        st.sidebar.error("Request failed - check if AnythingLLM is running")

# Add server connection test
if st.sidebar.button("Test Server Connection"):
    try:
        # Basic connectivity test without auth
        conn_response = requests.get(f"{anythingllm_url.rstrip('/')}/health", timeout=5)
        st.sidebar.info(f"Server responded with status code: {conn_response.status_code}")
        st.sidebar.text(f"Response: {conn_response.text[:200]}")
        
        if conn_response.status_code == 200:
            st.sidebar.success("Server is reachable!")
        else:
            st.sidebar.warning("Server is reachable but returned an unexpected status")
    except Exception as e:
        st.sidebar.error(f"Connection failed: {str(e)}")
        st.sidebar.markdown("""
        **Troubleshooting tips:**
        1. Check if the URL is correct
        2. Verify if the server is running
        3. Check if there are network restrictions
        4. Try accessing the URL directly in a browser
        """)

# Main content
st.header("Workspace and Directory Cleanup")

# Input for workspaces to clean
workspace_input = st.text_area(
    "Workspaces to Clean (one per line)",
    height=200,
    help="Enter workspace slugs to clean up, one per line",
    value="""customer_map
ipn-tester
phpunit-docker
mercury
gemini-demo
gf-repeater
Project-Falcon
ops-scripts
phpstormsettings
phpstormstyles
backlog
zapier
feedback
gf-tests-command
wordpress-docker
gf-command-shell
gf-repos-command
mission-control
stripeapp
webops-backlog
trial-template
vendor-environments
marketing-backlog
support-backlog
terraform
make-something-better
datawarehouse
npmproxy
site-telemetry
reactapp-supportsite
reactapp-stripe-checkout
actions
site-rocketgenius.com
site-internal
gfcom-anonymizer
company-discussion
.github
.github-private
sites-docs
playwright
gfcom-verify-salesforce
gravitycrm
site-gapi-mock
stripeappproxy
theme-gravity
tracify
llm-lab"""
)

# Input for directories to clean
directory_input = st.text_area(
    "Directories to Clean (one per line)", 
    height=200,
    help="Enter directory names to clean up, one per line",
    value="""gravityforms-customer_map-master-f5d9
gravityforms-ipn-tester-master-b5cf
gravityforms-phpunit-docker-master-2f91
gravityforms-mercury-master-3311
gravityforms-gemini-demo-master-db26
gravityforms-gf-repeater-master-b3ae
gravityforms-project-falcon-master-4c1e
gravityforms-ops-scripts-master-d307
gravityforms-phpstormsettings-master-655b
gravityforms-phpstormstyles-master-500b
gravityforms-backlog-master-de02
gravityforms-zapier-master-556c
gravityforms-feedback-master-552b
gravityforms-gf-tests-command-master-2523
gravityforms-wordpress-docker-master-9a87
gravityforms-gf-command-shell-master-3c16
gravityforms-gf-repos-command-master-278a
gravityforms-mission-control-master-926b
gravityforms-stripeapp-master-bf38
gravityforms-webops-backlog-main-b03e
gravityforms-trial-template-main-635f"""
)

# Input for slug patterns to match
slug_patterns_input = st.text_area(
    "Slug Patterns to Clean (one per line)",
    height=150,
    help="Enter patterns to match against workspace slugs. Any workspace with a slug containing these patterns will be cleaned up.",
    value="""site
simple
customer
gf-
project"""
)

# Display the confirmation phrase requirement
st.warning("⚠️ This operation is destructive and cannot be undone!")
confirmation = st.text_input(
    "Type 'CONFIRM_WORKSPACE_DELETION' to confirm",
    help="You must type CONFIRM_WORKSPACE_DELETION to proceed"
)

# Clean button
if st.button("Clean Workspaces and Directories"):
    if confirmation != "CONFIRM_WORKSPACE_DELETION":
        st.error("You must type the confirmation phrase exactly to proceed")
    elif auth_type == "JWT Token" and not jwt_token:
        st.error("JWT Token is required")
    elif auth_type == "API Key" and not api_key:
        st.error("API Key is required")
    elif auth_type == "Basic Auth" and (not username or not password):
        st.error("Username and password are required for Basic Auth")
    else:
        # Parse input data
        workspaces = [w.strip() for w in workspace_input.strip().split("\n") if w.strip()]
        directories = [d.strip() for d in directory_input.strip().split("\n") if d.strip()]
        slug_patterns = [p.strip() for p in slug_patterns_input.strip().split("\n") if p.strip()]
        
        if not workspaces and not directories and not slug_patterns:
            st.error("You must provide at least one workspace, directory, or slug pattern to clean")
            st.stop()
        
        # Confirm the operation
        st.info(f"Will clean {len(workspaces)} explicitly named workspaces, {len(directories)} directories, and any workspace matching {len(slug_patterns)} patterns")
        
        # Make the API request
        json_data = {
            "workspaces": workspaces,
            "directories": directories,
            "slugPatterns": slug_patterns,
            "confirmPhrase": confirmation
        }
        
        response = make_request("/ext/github/cleanup-workspaces", method="POST", json_data=json_data)
        
        if response and response.status_code == 200:
            # Display the raw response text for debugging
            with st.expander("Raw Server Response"):
                st.text(response.text)
                
            # Safely try to parse the JSON response
            try:
                response_data = response.json()
                st.success("Cleanup process has been started!")
                
                # Display log file path
                if "logFile" in response_data:
                    st.info(f"Log file: {response_data['logFile']}")
                    
                    # Poll for log updates
                    st.subheader("Cleanup Progress")
                    progress_placeholder = st.empty()
                    
                    # Add a check log button
                    if st.button("Check Log File"):
                        log_filename = response_data["logFile"].split("/")[-1]
                        log_response = make_request(f"/ext/github/org-import/log?logFile={log_filename}", method="GET")
                        
                        if log_response and log_response.status_code == 200:
                            try:
                                log_data = log_response.json()
                                if log_data.get("success") and log_data.get("content"):
                                    st.code(log_data["content"], language="text")
                                else:
                                    st.error("Failed to retrieve log content")
                            except Exception as e:
                                st.error(f"Failed to parse log response: {str(e)}")
                                st.text("Raw log response:")
                                st.text(log_response.text)
                        else:
                            st.error(f"Failed to retrieve log: {log_response.status_code if log_response else 'No response'}")
            except Exception as e:
                st.error(f"Error parsing server response: {str(e)}")
                st.warning("The request may have been successful, but the response couldn't be parsed as JSON.")
                st.info("Check the server logs for more information about the cleanup process.")
        else:
            st.error(f"Failed to start cleanup process: {response.status_code if response else 'No response'}")
            if response:
                st.text("Server response:")
                st.text(response.text)

# Add a section to check existing logs
st.header("Check Existing Cleanup Logs")

if st.button("List Cleanup Logs"):
    response = make_request("/ext/github/org-import/jobs", method="GET")
    
    if response and response.status_code == 200:
        try:
            jobs_data = response.json()
            if jobs_data.get("success") and jobs_data.get("jobs"):
                cleanup_logs = [job for job in jobs_data["jobs"] if "workspace-cleanup" in job]
                
                if cleanup_logs:
                    selected_log = st.selectbox("Select a log file to view:", cleanup_logs)
                    
                    if st.button("View Selected Log"):
                        log_response = make_request(f"/ext/github/org-import/log?logFile={selected_log}", method="GET")
                        
                        if log_response and log_response.status_code == 200:
                            try:
                                log_data = log_response.json()
                                if log_data.get("success") and log_data.get("content"):
                                    st.code(log_data["content"], language="text")
                                else:
                                    st.error("Failed to retrieve log content")
                            except Exception as e:
                                st.error(f"Failed to parse log response: {str(e)}")
                                st.text("Raw log response:")
                                st.text(log_response.text)
                        else:
                            st.error(f"Failed to retrieve log: {log_response.status_code if log_response else 'No response'}")
                else:
                    st.info("No cleanup logs found")
            else:
                st.warning("No jobs found or unexpected response format")
                st.text("Raw response:")
                st.text(response.text)
        except Exception as e:
            st.error(f"Error parsing jobs response: {str(e)}")
            st.text("Raw response:")
            st.text(response.text)
    else:
        st.error(f"Failed to list logs: {response.status_code if response else 'No response'}")
        if response:
            st.text("Server response:")
            st.text(response.text)

# Helper section with sample data
with st.expander("Help - Sample Data"):
    st.markdown("""
    ### Authentication Help
    
    #### JWT Token Format
    The JWT token should look something like this:
    ```
    eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwidXNlcm5hbWUiOiJhZG1pbiIsImVtYWlsIjpudWxsLCJyb2xlIjoiYWRtaW4iLCJwcm92aWRlciI6ImxvY2FsIiwiaWF0IjoxNjE5NzE4MzkwLCJleHAiOjE2MTk4MDQ3OTB9.AbCdEfGhIjKlMnOpQrStUvWxYz
    ```
    
    #### Example Data for Cleanup
    
    Here's a sample list of workspaces to clean:
    ```
    customer_map
    ipn-tester
    phpunit-docker
    mercury
    gemini-demo
    gf-repeater
    Project-Falcon
    ops-scripts
    phpstormsettings
    phpstormstyles
    backlog
    zapier
    feedback
    gf-tests-command
    wordpress-docker
    gf-command-shell
    gf-repos-command
    mission-control
    stripeapp
    webops-backlog
    trial-template
    vendor-environments
    marketing-backlog
    support-backlog
    terraform
    make-something-better
    datawarehouse
    npmproxy
    site-telemetry
    reactapp-supportsite
    reactapp-stripe-checkout
    actions
    site-rocketgenius.com
    site-internal
    gfcom-anonymizer
    company-discussion
    .github
    .github-private
    sites-docs
    playwright
    gfcom-verify-salesforce
    gravitycrm
    site-gapi-mock
    stripeappproxy
    theme-gravity
    tracify
    llm-lab
    ```
    
    And a sample list of directories to clean:
    ```
    gravityforms-customer_map-master-f5d9
    gravityforms-ipn-tester-master-b5cf
    gravityforms-phpunit-docker-master-2f91
    gravityforms-mercury-master-3311
    gravityforms-gemini-demo-master-db26
    gravityforms-gf-repeater-master-b3ae
    gravityforms-project-falcon-master-4c1e
    gravityforms-ops-scripts-master-d307
    gravityforms-phpstormsettings-master-655b
    gravityforms-phpstormstyles-master-500b
    gravityforms-backlog-master-de02
    gravityforms-zapier-master-556c
    gravityforms-feedback-master-552b
    gravityforms-gf-tests-command-master-2523
    gravityforms-wordpress-docker-master-9a87
    gravityforms-gf-command-shell-master-3c16
    gravityforms-gf-repos-command-master-278a
    gravityforms-mission-control-master-926b
    gravityforms-stripeapp-master-bf38
    gravityforms-webops-backlog-main-b03e
    gravityforms-trial-template-main-635f
    ```
    
    Slug patterns to match against workspaces:
    ```
    site
    simple
    customer
    gf-
    project
    ```
    
    Remember to type `CONFIRM_WORKSPACE_DELETION` in the confirmation field to proceed with deletion.
    """)

# Add new section for GitHub organization import recovery
st.header("GitHub Organization Import Recovery")
st.markdown("""
If you've run a GitHub organization import that created workspaces but failed to process the files
(showing "Directory not found" errors), this tool can help recover those workspaces by finding 
the downloaded files and associating them with the workspaces.
""")

with st.expander("GitHub Organization Import Recovery", expanded=False):
    col1, col2 = st.columns(2)
    with col1:
        github_org_filter = st.text_input("Organization filter (optional)", 
                                         placeholder="e.g., gravityforms",
                                         help="Filter workspaces by name containing this text")
    
    with col2:
        gh_recovery_dry_run = st.checkbox("Dry run (test only, don't make changes)", value=True)
    
    if st.button("Recover GitHub Organization Import", type="primary"):
        with st.spinner("Recovering GitHub organization import..."):
            try:
                payload = {
                    "orgNameFilter": github_org_filter if github_org_filter else None,
                    "dryRun": gh_recovery_dry_run
                }
                
                response = make_request(
                    f"/ext/github/org-import/recover",
                    method="POST",
                    json_data=payload
                )
                
                if response and response.status_code == 200:
                    try:
                        recovery_response = response.json()
                        if recovery_response.get("success"):
                            results = recovery_response.get("results", {})
                            st.success(f"Recovery process completed!")
                            
                            # Show summary
                            st.write(f"Total workspaces to recover: {results.get('total', 0)}")
                            st.write(f"Matching directories found: {results.get('found', 0)}")
                            st.write(f"Workspaces fixed: {results.get('fixed', 0)}")
                            st.write(f"Workspaces not found: {results.get('notFound', 0)}")
                            st.write(f"Workspaces skipped (dry run): {results.get('skipped', 0)}")
                            
                            # Show log file path
                            if "logFile" in recovery_response:
                                st.info(f"Log file: {recovery_response['logFile']}")
                            
                            # Show detailed results
                            if results.get("details"):
                                st.subheader("Detailed Results")
                                
                                # Create a DataFrame for the results
                                df_data = []
                                for item in results["details"]:
                                    df_data.append({
                                        "Workspace": item["slug"],
                                        "Found": "✅" if item["found"] else "❌",
                                        "Fixed": "✅" if item["fixed"] else "❌" if not gh_recovery_dry_run else "⏩ (dry run)",
                                        "Directory": item["directory"] or "Not found",
                                        "Error": item["error"] or ""
                                    })
                                    
                                st.dataframe(pd.DataFrame(df_data))
                    except Exception as e:
                        st.error(f"Error parsing recovery response: {str(e)}")
                else:
                    st.error(f"Error: {response.status_code if response else 'No response'}")
                    if response:
                        try:
                            error_info = response.json()
                            st.error(f"Server error: {error_info.get('error', 'Unknown error')}")
                        except:
                            st.error(f"Failed to parse response: {response.text}")
                    
            except Exception as e:
                st.error(f"Error during recovery: {str(e)}")

# Leave an empty line for spacing
st.write("") 