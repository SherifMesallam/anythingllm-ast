#!/usr/bin/env python3
import lancedb
import os
import sys
from pathlib import Path

# Default path in AnythingLLM container
DEFAULT_LANCEDB_PATH = "/app/server/storage/lancedb"

def explore_db(db_path_str):
    db_path = Path(db_path_str)
    if not db_path_str or not db_path.exists() or not db_path.is_dir():
        print(f"Error: LanceDB path '{db_path_str}' not found, is not a directory, or is invalid.")
        # Optionally exit, or allow re-entry depending on desired flow
        # sys.exit(1) 
        return False # Indicate failure

    try:
        db = lancedb.connect(db_path_str)
        table_names = db.table_names()

        if not table_names:
            print(f"No tables found in LanceDB database at '{db_path_str}'.")
            return True # Success, but no tables

        print(f"Found {len(table_names)} tables in '{db_path_str}':")
        for name in table_names:
            try:
                table = db.open_table(name)
                count = table.count_rows()
                print(f"- Table '{name}': {count} rows")
                # Optionally, add code here to show schema or sample data
                # print(f"  Schema: {table.schema}")
                # sample_data = table.limit(3).to_pandas() # Requires pandas
                # print(f"  Sample data:\n{sample_data}")
            except Exception as e:
                print(f"- Error accessing table '{name}': {e}")
        return True # Success

    except Exception as e:
        print(f"Error connecting to or exploring LanceDB at '{db_path_str}': {e}")
        # sys.exit(1)
        return False # Indicate failure

if __name__ == "__main__":
    lancedb_uri = None
    if len(sys.argv) > 1:
        lancedb_uri = sys.argv[1]
        print(f"Using LanceDB path from command line argument: {lancedb_uri}")
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