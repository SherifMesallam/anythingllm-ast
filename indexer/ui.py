import streamlit as st
import requests
import json
import time
import pandas as pd
from datetime import datetime

st.set_page_config(page_title="AnythingLLM GitHub Org Import", layout="wide")

# App configuration
st.sidebar.title("Configuration")
api_base_url = st.sidebar.text_input("AnythingLLM API URL", value="http://localhost:3001/api")

# Authentication options
auth_method = st.sidebar.radio(
    "Authentication Method",
    ["JWT Token", "API Key"],
    help="Select the authentication method to use"
)

auth_token = st.sidebar.text_input(
    "Authentication Token", 
    type="password",
    help="JWT Token from localStorage.anythingllm_token or API Key from settings"
)

st.sidebar.markdown("""
#### JWT Token Instructions:
1. Log into AnythingLLM web interface
2. Open browser dev tools (F12)
3. Go to Application tab > Local Storage
4. Find the `anythingllm_token` value

#### API Key Instructions (if enabled):
1. Go to Settings > API Keys
2. Generate a new API key
""")

# Function to get headers based on auth method
def get_auth_headers(content_type=True):
    headers = {}
    if content_type:
        headers["Content-Type"] = "application/json"
    
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    
    return headers

# Function to display request and response
def display_request_response(request_method, request_url, request_headers, request_body, response):
    with st.expander("Show Request/Response Details", expanded=True):
        st.subheader("Request")
        st.code(f"{request_method} {request_url}", language="http")
        
        st.markdown("**Headers:**")
        headers_to_show = {**request_headers}
        # Mask sensitive headers
        for sensitive_key in ["Authorization"]:
            if sensitive_key in headers_to_show:
                headers_to_show[sensitive_key] = headers_to_show[sensitive_key].split(" ")[0] + " xxxxx" if " " in headers_to_show[sensitive_key] else "xxxxx"
        st.code(json.dumps(headers_to_show, indent=2), language="json")
        
        if request_body:
            st.markdown("**Body:**")
            body_to_show = json.loads(request_body) if isinstance(request_body, str) else request_body
            if 'accessToken' in body_to_show:
                body_to_show['accessToken'] = "xxxxx" # Mask the token
            st.code(json.dumps(body_to_show, indent=2), language="json")
        
        st.subheader("Response")
        st.markdown(f"**Status Code:** {response.status_code}")
        
        try:
            response_json = response.json()
            st.code(json.dumps(response_json, indent=2), language="json")
        except:
            st.text(response.text)

# Main app UI
st.title("GitHub Organization Repository Import")

# Tabs for different functionality
tab1, tab2, tab3 = st.tabs(["Start New Import", "Monitor Jobs", "View Logs"])

# Tab 1: Start new import
with tab1:
    st.header("Import GitHub Organization Repositories")
    
    with st.form("import_form"):
        gh_org = st.text_input("GitHub Organization Name", help="Name of the GitHub organization")
        gh_token = st.text_input("GitHub Access Token", type="password", 
                               help="Personal Access Token with read access to repositories")
        
        submitted = st.form_submit_button("Start Import")
        
        if submitted:
            if not gh_org or not gh_token or not auth_token:
                st.error("All fields are required!")
            else:
                with st.spinner("Starting import process..."):
                    try:
                        # Prepare request details
                        request_url = f"{api_base_url}/ext/github/org-import"
                        request_headers = get_auth_headers()
                        request_body = {
                            "accessToken": gh_token,
                            "orgName": gh_org
                        }
                        
                        # Make the request
                        response = requests.post(
                            request_url,
                            headers=request_headers,
                            json=request_body
                        )
                        
                        # Display request and response
                        display_request_response("POST", request_url, request_headers, request_body, response)
                        
                        if response.status_code == 200:
                            result = response.json()
                            if result.get("success"):
                                st.success(f"Import process started for {gh_org}!")
                                
                                # Store the progress file path in session state for monitoring
                                if not "import_jobs" in st.session_state:
                                    st.session_state.import_jobs = []
                                st.session_state.import_jobs.append({
                                    "orgName": gh_org,
                                    "progressFile": result.get("progressFile"),
                                    "logFile": result.get("logFile"),
                                    "startedAt": datetime.now().toISOString() if hasattr(datetime.now(), 'toISOString') else datetime.now().isoformat()
                                })
                            else:
                                st.error(f"Error: {result.get('error')}")
                        else:
                            st.error(f"API Error: {response.status_code} - {response.text}")
                    except Exception as e:
                        st.error(f"Request failed: {str(e)}")

# Tab 2: Monitor jobs
with tab2:
    st.header("Monitor Import Jobs")
    
    if st.button("Refresh Jobs List"):
        with st.spinner("Fetching jobs..."):
            try:
                # Prepare request details
                request_url = f"{api_base_url}/ext/github/org-import/jobs"
                request_headers = get_auth_headers(content_type=False)
                
                # Make the request
                response = requests.get(
                    request_url,
                    headers=request_headers
                )
                
                # Display request and response
                display_request_response("GET", request_url, request_headers, None, response)
                
                if response.status_code == 200:
                    result = response.json()
                    if result.get("success"):
                        st.session_state.all_jobs = result.get("jobs", [])
                    else:
                        st.error(f"Error: {result.get('error')}")
                else:
                    st.error(f"API Error: {response.status_code} - {response.text}")
            except Exception as e:
                st.error(f"Request failed: {str(e)}")
    
    # Test endpoint function
    st.subheader("Test Authentication")
    if st.button("Test Authentication"):
        with st.spinner("Testing connection..."):
            try:
                # Try a simple endpoint to verify authentication
                request_url = f"{api_base_url}/system/env"
                request_headers = get_auth_headers(content_type=False)
                
                response = requests.get(
                    request_url,
                    headers=request_headers
                )
                
                display_request_response("GET", request_url, request_headers, None, response)
                
                if response.status_code == 200:
                    st.success("Authentication successful!")
                else:
                    st.error(f"Authentication failed: {response.status_code} - {response.text}")
            except Exception as e:
                st.error(f"Connection test failed: {str(e)}")
    
    # Rest of code remains the same as before
    # Display jobs
    if "all_jobs" in st.session_state and st.session_state.all_jobs:
        jobs = st.session_state.all_jobs
        
        # Convert to DataFrame for better display
        jobs_df = pd.DataFrame([
            {
                "Organization": job["orgName"],
                "Job ID": job["jobId"],
                "Status": job["status"],
                "Total Repos": job["statistics"]["total"],
                "Completed": job["statistics"]["completed"],
                "Failed": job["statistics"]["failed"],
                "Skipped": job["statistics"]["skipped"],
                "Created At": job["createdAt"]
            } for job in jobs
        ])
        
        st.dataframe(jobs_df)
        
        # Job details and actions
        selected_job_idx = st.selectbox("Select job for details", range(len(jobs)), 
                                     format_func=lambda i: f"{jobs[i]['orgName']} ({jobs[i]['jobId']})")
        
        selected_job = jobs[selected_job_idx]
        
        st.subheader(f"Job Details: {selected_job['orgName']}")
        
        # Show progress bar
        total = selected_job["statistics"]["total"]
        completed = selected_job["statistics"]["completed"]
        failed = selected_job["statistics"]["failed"]
        skipped = selected_job["statistics"]["skipped"]
        progress = (completed + failed + skipped) / total if total > 0 else 0
        
        st.progress(progress)
        st.text(f"Progress: {progress*100:.1f}% ({completed} completed, {failed} failed, {skipped} skipped, {total} total)")
        
        # Resume job button
        if selected_job["status"] != "completed" and failed > 0:
            st.subheader("Resume Failed Jobs")
            gh_token_resume = st.text_input("GitHub Access Token for Resume", type="password", 
                                        help="Required to resume the job")
            
            if st.button("Resume Jobs") and gh_token_resume:
                with st.spinner("Resuming job..."):
                    try:
                        # Prepare request details
                        request_url = f"{api_base_url}/ext/github/org-import/status"
                        request_headers = get_auth_headers()
                        request_body = {
                            "progressFile": selected_job["progressFile"],
                            "resume": True,
                            "accessToken": gh_token_resume
                        }
                        
                        # Make the request
                        response = requests.post(
                            request_url,
                            headers=request_headers,
                            json=request_body
                        )
                        
                        # Display request and response
                        display_request_response("POST", request_url, request_headers, request_body, response)
                        
                        if response.status_code == 200:
                            result = response.json()
                            if result.get("success"):
                                st.success("Resume process started!")
                            else:
                                st.error(f"Error: {result.get('error')}")
                        else:
                            st.error(f"API Error: {response.status_code} - {response.text}")
                    except Exception as e:
                        st.error(f"Request failed: {str(e)}")
            
            # Check status without resuming
            if st.button("Check Status Without Resuming"):
                with st.spinner("Checking job status..."):
                    try:
                        # Prepare request details
                        request_url = f"{api_base_url}/ext/github/org-import/status"
                        request_headers = get_auth_headers()
                        request_body = {
                            "progressFile": selected_job["progressFile"],
                            "resume": False
                        }
                        
                        # Make the request
                        response = requests.post(
                            request_url,
                            headers=request_headers,
                            json=request_body
                        )
                        
                        # Display request and response
                        display_request_response("POST", request_url, request_headers, request_body, response)
                        
                        if response.status_code == 200:
                            result = response.json()
                            if result.get("success"):
                                st.success("Status retrieved successfully")
                            else:
                                st.error(f"Error: {result.get('error')}")
                        else:
                            st.error(f"API Error: {response.status_code} - {response.text}")
                    except Exception as e:
                        st.error(f"Request failed: {str(e)}")
    else:
        st.info("No jobs found. Click 'Refresh Jobs List' to check for jobs.")

# Tab 3: View logs
with tab3:
    st.header("View Job Logs")
    
    # Show jobs for log selection
    if "all_jobs" in st.session_state and st.session_state.all_jobs:
        jobs = st.session_state.all_jobs
        
        log_job_idx = st.selectbox("Select job to view logs", range(len(jobs)), 
                                format_func=lambda i: f"{jobs[i]['orgName']} ({jobs[i]['jobId']})")
        
        selected_job = jobs[log_job_idx]
        
        if selected_job["logFile"]:
            if st.button("View Logs"):
                with st.spinner("Fetching logs..."):
                    try:
                        # Prepare request details
                        request_url = f"{api_base_url}/ext/github/org-import/log"
                        request_headers = get_auth_headers(content_type=False)
                        request_params = {
                            "logFile": selected_job["logFile"]
                        }
                        
                        # Make the request
                        response = requests.get(
                            request_url,
                            headers=request_headers,
                            params=request_params
                        )
                        
                        # Display request and response (partial)
                        st.subheader("Request")
                        st.code(f"GET {request_url}?logFile={selected_job['logFile']}", language="http")
                        
                        st.markdown("**Headers:**")
                        headers_to_show = {**request_headers}
                        for sensitive_key in ["Authorization"]:
                            if sensitive_key in headers_to_show:
                                headers_to_show[sensitive_key] = headers_to_show[sensitive_key].split(" ")[0] + " xxxxx" if " " in headers_to_show[sensitive_key] else "xxxxx"
                        st.code(json.dumps(headers_to_show, indent=2), language="json")
                        
                        st.subheader("Response")
                        st.markdown(f"**Status Code:** {response.status_code}")
                        
                        if response.status_code == 200:
                            result = response.json()
                            if result.get("success"):
                                st.subheader(f"Logs for {selected_job['orgName']} (Job ID: {selected_job['jobId']})")
                                st.text_area("Log Content", result.get("content", ""), height=400)
                                st.download_button(
                                    "Download Logs", 
                                    result.get("content", ""),
                                    file_name=f"github-import-{selected_job['orgName']}-{selected_job['jobId']}.log",
                                    mime="text/plain"
                                )
                                
                                # Only show metadata of response to avoid duplicating the log content
                                st.markdown("**Response Metadata:**")
                                metadata = {
                                    "success": result.get("success"),
                                    "lines": result.get("lines")
                                }
                                st.code(json.dumps(metadata, indent=2), language="json")
                            else:
                                st.error(f"Error: {result.get('error')}")
                                st.code(json.dumps(result, indent=2), language="json")
                        else:
                            st.error(f"API Error: {response.status_code} - {response.text}")
                            try:
                                st.code(json.dumps(response.json(), indent=2), language="json")
                            except:
                                st.text(response.text)
                    except Exception as e:
                        st.error(f"Request failed: {str(e)}")
        else:
            st.warning("No log file available for this job.")
    else:
        st.info("No jobs found. Go to 'Monitor Jobs' tab and click 'Refresh Jobs List'.")

# Manual log file viewer (if you have the path directly)
st.header("View Log File Directly")
direct_log_path = st.text_input("Log File Path")
if direct_log_path and st.button("View Direct Log"):
    with st.spinner("Fetching log..."):
        try:
            request_url = f"{api_base_url}/ext/github/org-import/log"
            request_headers = get_auth_headers(content_type=False)
            
            response = requests.get(
                request_url,
                headers=request_headers,
                params={"logFile": direct_log_path}
            )
            
            display_request_response("GET", request_url + f"?logFile={direct_log_path}", request_headers, None, response)
            
            if response.status_code == 200:
                result = response.json()
                if result.get("success"):
                    st.text_area("Log Content", result.get("content", ""), height=400)
                    st.download_button(
                        "Download Log", 
                        result.get("content", ""),
                        file_name=f"github-import-log.log",
                        mime="text/plain"
                    )
            else:
                st.error(f"API Error: {response.status_code}")
        except Exception as e:
            st.error(f"Request failed: {str(e)}")

# Footer
st.sidebar.markdown("---")
st.sidebar.info("""
This app interfaces with AnythingLLM's GitHub Organization Import API 
to manage repository imports into workspaces.
""")

# Debug information 
st.sidebar.markdown("---")
st.sidebar.subheader("Debug Info")
if st.sidebar.checkbox("Show Session State"):
    st.sidebar.json(st.session_state)