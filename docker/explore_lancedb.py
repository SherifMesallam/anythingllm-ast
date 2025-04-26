#!/usr/bin/env python3
import lancedb
import os
import sys
from pathlib import Path

# Default path in AnythingLLM container
DEFAULT_LANCEDB_PATH = "/app/server/storage/lancedb"

def explore_db(db_path_str):
    db_path = Path(db_path_str)
    if not db_path.exists() or not db_path.is_dir():
        print(f"Error: LanceDB path '{db_path_str}' not found or is not a directory.")
        sys.exit(1)

    try:
        db = lancedb.connect(db_path_str)
        table_names = db.table_names()

        if not table_names:
            print(f"No tables found in LanceDB database at '{db_path_str}'.")
            return

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

    except Exception as e:
        print(f"Error connecting to or exploring LanceDB at '{db_path_str}': {e}")
        sys.exit(1)

if __name__ == "__main__":
    # Allow overriding path via command line argument, otherwise use default
    lancedb_uri = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_LANCEDB_PATH
    explore_db(lancedb_uri) 