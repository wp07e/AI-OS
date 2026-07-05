import os
import sys
from dotenv import load_dotenv
from src import main

load_dotenv("example.env")

if __name__ == "__main__":
    if not os.getenv("LAYERRE_API_KEY"):
        print("LAYERRE_API_KEY not found in environment.", file=sys.stderr)
        print(
            "Please set your API key in example_env file or export it: "
            "export LAYERRE_API_KEY='your_api_key'",
            file=sys.stderr,
        )
    else:
        print("LAYERRE_API_KEY found", file=sys.stderr)
        print("Started Layerre MCP server", file=sys.stderr)

    main()
