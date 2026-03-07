"""
Bulk upload jobs via API using admin credentials.
1. Log in with email/password -> get token
2. POST CSV to /api/v1/jobs/bulk-upload

Usage:
  python bulk_upload_jobs.py
  python bulk_upload_jobs.py path/to/jobs.csv
"""
import json
import os
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

API_BASE = os.environ.get("WANA_API_BASE", "http://localhost:8000")
DEFAULT_CSV = os.path.join(
    os.path.dirname(__file__),
    "..",
    "JobScraping",
    "outputs",
    "api-ready",
    "latest",
    "results_jobs_api.csv",
)


def login(email: str, password: str) -> str:
    url = f"{API_BASE.rstrip('/')}/api/v1/auth/login"
    body = json.dumps({"email": email, "password": password}).encode("utf-8")
    req = Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
    except HTTPError as e:
        body_str = e.read().decode() if e.fp else ""
        err = json.loads(body_str) if body_str.strip().startswith("{") else {}
        msg = err.get("error", body_str[:200]) or f"{e.code} {e.reason}"
        sys.exit(f"Login failed: {msg}")
    except URLError as e:
        sys.exit(f"Login failed: {e} (is the API server running at {API_BASE}?)")
    token = (data.get("data") or {}).get("accessToken")
    if not token:
        sys.exit("Login failed: no accessToken in response")
    return token


def bulk_upload(csv_path: str, token: str) -> None:
    url = f"{API_BASE.rstrip('/')}/api/v1/jobs/bulk-upload"
    boundary = "----FormBoundary" + str(abs(hash(csv_path)) % 10**10)
    with open(csv_path, "rb") as f:
        csv_bytes = f.read()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="jobs.csv"\r\n'
        f"Content-Type: text/csv\r\n\r\n"
    ).encode("utf-8") + csv_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")
    req = Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    try:
        with urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode())
    except HTTPError as e:
        body_str = e.read().decode() if e.fp else ""
        err = json.loads(body_str) if body_str.strip().startswith("{") else {}
        msg = err.get("error", body_str[:300]) or f"{e.code} {e.reason}"
        sys.exit(f"Upload failed: {msg}")
    except URLError as e:
        sys.exit(f"Upload failed: {e}")
    jobs = data.get("data") or []
    print(f"Uploaded {len(jobs)} jobs successfully.")
    if jobs:
        print(f"  First: {jobs[0].get('title', '')} (id: {jobs[0].get('uid', '')})")


def main():
    csv_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CSV
    csv_path = os.path.abspath(csv_path)
    if not os.path.isfile(csv_path):
        sys.exit(f"CSV not found: {csv_path}")

    print(f"API: {API_BASE}")
    print(f"CSV: {csv_path}\n")
    print("Admin login required.\n")
    email = input("Email: ").strip()
    password = input("Password: ").strip()
    if not email or not password:
        sys.exit("Email and password required.")

    print("Logging in...")
    token = login(email, password)
    print("Uploading...")
    bulk_upload(csv_path, token)


if __name__ == "__main__":
    main()
