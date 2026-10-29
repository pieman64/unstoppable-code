import os
from datetime import datetime, timezone

message = os.environ.get("INPUT_MESSAGE", "")
output_file = os.environ.get("{{BRAND_ENV_PREFIX}}_OUTPUT", "")

timestamp = datetime.now(timezone.utc).isoformat()
tag = f"{timestamp}-py"

print(f"Hello, World! {message}".strip())
print(f"Timestamp tag: {tag}")

if output_file:
    with open(output_file, "a") as f:
        f.write(f"timestamp={tag}\n")
