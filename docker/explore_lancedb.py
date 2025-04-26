#!/usr/bin/env python3
import lancedb
import os
import sys
from pathlib import Path
import json

# Default path in AnythingLLM container
DEFAULT_LANCEDB_PATH = "/app/server/storage/lancedb"
DISPLAY_LIMIT = 10 # Limit how many rows to show at once

def print_rows(rows):
    """Helper to print rows nicely."""
    if not rows:
        print("  No rows found.")
        return
    print(f"  --- Displaying {len(rows)} row(s) --- ")
    for i, row in enumerate(rows):
        # Pretty print dicts for better readability
        print(f"  Row {i+1}: {json.dumps(row, indent=2)}")
    print("  --- End of rows --- ")

def inspect_table(db, table_name):
    """Interactive loop to inspect a specific table."""
    try:
        table = db.open_table(table_name)
        print(f"--- Inspecting table: {table_name} ---")
        while True:
            action = input(
                f"Table '{table_name}': Enter action [(s)chema, (a)ll rows (limit {DISPLAY_LIMIT}), (f)ilter rows (SQL), (q)uit table inspection]: "
            ).lower()

            if action == 's':
                print(f"  Schema: {table.schema}")
            elif action == 'a':
                print(f"  Fetching first {DISPLAY_LIMIT} rows...")
                try:
                    rows = table.limit(DISPLAY_LIMIT).to_list()
                    print_rows(rows)
                except Exception as e:
                    print(f"  Error fetching rows: {e}")
            elif action == 'f':
                filter_sql = input(f"  Enter SQL WHERE clause (e.g., id = 5 or price > 10.0): ")
                if not filter_sql:
                    print("  Filter cannot be empty.")
                    continue
                print(f"  Fetching rows where '{filter_sql}' (limit {DISPLAY_LIMIT})...")
                try:
                    rows = table.search().where(filter_sql).limit(DISPLAY_LIMIT).to_list()
                    print_rows(rows)
                except Exception as e:
                    print(f"  Error applying filter '{filter_sql}': {e}")
            elif action == 'q':
                print(f"--- Finished inspecting table: {table_name} ---")
                break
            else:
                print("  Invalid action.")
    except Exception as e:
        print(f"Error opening or inspecting table '{table_name}': {e}")

def explore_db(db_path_str):
    db_path = Path(db_path_str)
    if not db_path_str or not db_path.exists() or not db_path.is_dir():
        print(f"Error: LanceDB path '{db_path_str}' not found, is not a directory, or is invalid.")
        return False # Indicate failure

    try:
        print(f"Connecting to LanceDB at '{db_path_str}'...")
        db = lancedb.connect(db_path_str)
        table_names = db.table_names()

        if not table_names:
            print(f"No tables found in LanceDB database at '{db_path_str}'.")
            return True # Success, but no tables

        print(f"Found {len(table_names)} tables:")
        table_info = {}
        for name in table_names:
            try:
                table = db.open_table(name)
                count = table.count_rows()
                print(f"- Table '{name}': {count} rows")
                table_info[name] = count
            except Exception as e:
                print(f"- Error accessing table '{name}': {e}")

        # Ask to inspect tables
        while True:
            inspect_choice = input("Inspect a specific table? (y/N): ").lower()
            if inspect_choice != 'y':
                break
            
            table_to_inspect = input(f"Enter table name to inspect (available: {', '.join(table_info.keys())}) or q to quit: ")
            if table_to_inspect.lower() == 'q':
                break
            if table_to_inspect in table_info:
                inspect_table(db, table_to_inspect)
            else:
                print(f"Table '{table_to_inspect}' not found.")

        return True # Success

    except Exception as e:
        print(f"Error connecting to or exploring LanceDB at '{db_path_str}': {e}")
        return False # Indicate failure

if __name__ == "__main__":
    lancedb_uri = None
    if len(sys.argv) > 1:
        lancedb_uri = sys.argv[1]
        print(f"Using LanceDB path from command line argument: {lancedb_uri}")
        if not explore_db(lancedb_uri):
            sys.exit(1) # Exit if exploration fails immediately
    else:
        while True:
            try:
                # Prompt user for input
                user_input = input(f"Enter LanceDB path (leave blank for default: {DEFAULT_LANCEDB_PATH}): ")
                if not user_input:
                    lancedb_uri = DEFAULT_LANCEDB_PATH
                    print(f"Using default path: {lancedb_uri}")
                else:
                    lancedb_uri = user_input
                    print(f"Using provided path: {lancedb_uri}")
                
                # Try exploring with the determined path
                if explore_db(lancedb_uri):
                    break # Exit loop on successful exploration
                else:
                    # Ask if user wants to try again after failure
                    retry = input("Path invalid or exploration failed. Try again? (y/N): ").lower()
                    if retry != 'y':
                        print("Exiting.")
                        sys.exit(1)
            except EOFError: # Handle Ctrl+D
                 print("\nExiting.")
                 sys.exit(0)
            except KeyboardInterrupt: # Handle Ctrl+C
                 print("\nExiting.")
                 sys.exit(0)

    print("LanceDB exploration finished.")
    sys.exit(0) 