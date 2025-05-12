import streamlit as st
import requests
import json
import time

st.set_page_config(page_title="AnythingLLM Workspace Cleanup Tool", layout="wide")

st.title("AnythingLLM Workspace Cleanup Tool")

# Configuration section
with st.sidebar:
    st.header("Configuration")
    anythingllm_url = st.text_input("AnythingLLM URL", value="http://localhost:3001")
    api_key = st.text_input("API Key", type="password")
    
    auth_type = st.radio(
        "Authentication Type",
        ["API Key", "Basic Auth", "No Auth"]
    )
    
    if auth_type == "Basic Auth":
        username = st.text_input("Username")
        password = st.text_input("Password", type="password")
    
    st.markdown("---")
    st.caption("This tool is used to clean up workspaces created by the GitHub organization import process.")

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
marketing-backlog"""
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

# Display the confirmation phrase requirement
st.warning("⚠️ This operation is destructive and cannot be undone!")
confirmation = st.text_input(
    "Type 'CONFIRM_WORKSPACE_DELETION' to confirm",
    help="You must type CONFIRM_WORKSPACE_DELETION to proceed"
)

# Function to make authenticated requests
def make_request(endpoint, method="POST", json_data=None, auth=None):
    headers = {"Content-Type": "application/json"}
    
    if auth_type == "API Key" and api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    
    url = f"{anythingllm_url.rstrip('/')}{endpoint}"
    
    if auth_type == "Basic Auth" and username and password:
        auth = (username, password)
    else:
        auth = None
    
    with st.spinner(f"Making {method} request to {endpoint}..."):
        try:
            if method == "GET":
                response = requests.get(url, headers=headers, auth=auth)
            else:
                response = requests.post(url, headers=headers, json=json_data, auth=auth)
            
            # Display raw request and response for debugging
            with st.expander("Request/Response Details"):
                st.code(f"URL: {url}", language="text")
                st.code(f"Headers: {json.dumps(headers, indent=2)}", language="json")
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

# Clean button
if st.button("Clean Workspaces and Directories"):
    if confirmation != "CONFIRM_WORKSPACE_DELETION":
        st.error("You must type the confirmation phrase exactly to proceed")
    elif not api_key and auth_type == "API Key":
        st.error("API Key is required")
    elif auth_type == "Basic Auth" and (not username or not password):
        st.error("Username and password are required for Basic Auth")
    else:
        # Parse input data
        workspaces = [w.strip() for w in workspace_input.strip().split("\n") if w.strip()]
        directories = [d.strip() for d in directory_input.strip().split("\n") if d.strip()]
        
        if not workspaces and not directories:
            st.error("You must provide at least one workspace or directory to clean")
            st.stop()
        
        # Confirm the operation
        st.info(f"Will clean {len(workspaces)} workspaces and {len(directories)} directories")
        
        # Make the API request
        json_data = {
            "workspaces": workspaces,
            "directories": directories,
            "confirmPhrase": confirmation
        }
        
        response = make_request("/ext/github/cleanup-workspaces", method="POST", json_data=json_data)
        
        if response and response.status_code == 200:
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
                        log_data = log_response.json()
                        if log_data.get("success") and log_data.get("content"):
                            st.code(log_data["content"], language="text")
                        else:
                            st.error("Failed to retrieve log content")
                    else:
                        st.error("Failed to retrieve log")
        else:
            st.error("Failed to start cleanup process")

# Add a section to check existing logs
st.header("Check Existing Cleanup Logs")

if st.button("List Cleanup Logs"):
    response = make_request("/ext/github/org-import/jobs", method="GET")
    
    if response and response.status_code == 200:
        jobs_data = response.json()
        if jobs_data.get("success") and jobs_data.get("jobs"):
            cleanup_logs = [job for job in jobs_data["jobs"] if "workspace-cleanup" in job]
            
            if cleanup_logs:
                selected_log = st.selectbox("Select a log file to view:", cleanup_logs)
                
                if st.button("View Selected Log"):
                    log_response = make_request(f"/ext/github/org-import/log?logFile={selected_log}", method="GET")
                    
                    if log_response and log_response.status_code == 200:
                        log_data = log_response.json()
                        if log_data.get("success") and log_data.get("content"):
                            st.code(log_data["content"], language="text")
                        else:
                            st.error("Failed to retrieve log content")
                    else:
                        st.error("Failed to retrieve log")
            else:
                st.info("No cleanup logs found")
        else:
            st.warning("No jobs found")
    else:
        st.error("Failed to list logs")

# Helper section with sample data
with st.expander("Help - Sample Data"):
    st.markdown("""
    ### Example Data for Cleanup
    
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
    
    Remember to type `CONFIRM_WORKSPACE_DELETION` in the confirmation field to proceed with deletion.
    """) 