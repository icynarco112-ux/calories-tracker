import os
import json
import asyncio
import secrets
import time
import urllib.parse
from typing import Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException, Depends, Query, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse, JSONResponse
from sse_starlette.sse import EventSourceResponse
from pydantic import BaseModel

from database import init_db, get_db, SessionLocal
from tools import (
    add_meal,
    get_today_summary,
    get_weekly_summary,
    get_monthly_summary,
    get_meal_history,
)

MCP_API_KEY = os.getenv("MCP_API_KEY", "")
MCP_PORT = int(os.getenv("MCP_PORT", "8787"))
BASE_URL = os.getenv("BASE_URL", "https://calories.onlydating.me")

# Simple in-memory store for OAuth (auto-approve everything)
oauth_clients = {}  # Dynamic Client Registration
oauth_codes = {}
oauth_tokens = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    init_db()
    print("Database initialized")
    yield
    # Shutdown


app = FastAPI(title="Calories Tracker MCP Server", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# MCP Protocol Types
class MCPRequest(BaseModel):
    jsonrpc: str = "2.0"
    id: int | str | None = None
    method: str
    params: dict | None = None


# Tool definitions for MCP
TOOLS = [
    {
        "name": "add_meal",
        "description": "Add a new meal to the calories tracker. Use this when the user sends food photos or describes what they ate.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "meal_name": {
                    "type": "string",
                    "description": "Name of the meal or dish"
                },
                "calories": {
                    "type": "integer",
                    "description": "Estimated calories (kcal)"
                },
                "proteins": {
                    "type": "number",
                    "description": "Protein content in grams"
                },
                "fats": {
                    "type": "number",
                    "description": "Fat content in grams"
                },
                "carbs": {
                    "type": "number",
                    "description": "Carbohydrate content in grams"
                },
                "fiber": {
                    "type": "number",
                    "description": "Fiber content in grams"
                },
                "water_ml": {
                    "type": "integer",
                    "description": "Water content in milliliters"
                },
                "meal_type": {
                    "type": "string",
                    "enum": ["breakfast", "lunch", "dinner", "snack", "other"],
                    "description": "Type of meal"
                },
                "healthiness_score": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 10,
                    "description": "Health score from 1 (unhealthy) to 10 (very healthy)"
                },
                "notes": {
                    "type": "string",
                    "description": "Additional notes about the meal"
                }
            },
            "required": ["meal_name", "calories"]
        }
    },
    {
        "name": "get_today_summary",
        "description": "Get nutrition summary for today including total calories, macros, and all meals.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "get_weekly_summary",
        "description": "Get nutrition summary for the last 7 days with daily breakdown.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "get_monthly_summary",
        "description": "Get nutrition summary for the current month.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    {
        "name": "get_meal_history",
        "description": "Get recent meal history.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Number of meals to return (default: 10)"
                }
            },
            "required": []
        }
    }
]


def execute_tool(tool_name: str, arguments: dict) -> Any:
    """Execute a tool and return the result."""
    db = SessionLocal()
    try:
        if tool_name == "add_meal":
            return add_meal(db, **arguments)
        elif tool_name == "get_today_summary":
            return get_today_summary(db)
        elif tool_name == "get_weekly_summary":
            return get_weekly_summary(db)
        elif tool_name == "get_monthly_summary":
            return get_monthly_summary(db)
        elif tool_name == "get_meal_history":
            limit = arguments.get("limit", 10)
            return get_meal_history(db, limit)
        else:
            return {"error": f"Unknown tool: {tool_name}"}
    finally:
        db.close()


def handle_mcp_request(request: MCPRequest) -> dict:
    """Handle MCP JSON-RPC request."""
    method = request.method
    params = request.params or {}

    if method == "initialize":
        return {
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "calories-tracker",
                "version": "1.0.0"
            }
        }

    elif method == "tools/list":
        return {"tools": TOOLS}

    elif method == "tools/call":
        tool_name = params.get("name")
        arguments = params.get("arguments", {})

        result = execute_tool(tool_name, arguments)

        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(result, ensure_ascii=False, indent=2)
                }
            ]
        }

    elif method == "ping":
        return {}

    else:
        raise HTTPException(status_code=400, detail=f"Unknown method: {method}")


@app.get("/health")
async def health_check():
    return {"status": "ok"}


# OAuth endpoints for Claude custom connector compatibility
@app.get("/.well-known/oauth-authorization-server")
async def oauth_metadata():
    """OAuth 2.0 Authorization Server Metadata (RFC 8414)."""
    return {
        "issuer": BASE_URL,
        "authorization_endpoint": f"{BASE_URL}/oauth/authorize",
        "token_endpoint": f"{BASE_URL}/oauth/token",
        "registration_endpoint": f"{BASE_URL}/oauth/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256", "plain"],
        "token_endpoint_auth_methods_supported": ["client_secret_post", "none"],
        "scopes_supported": ["mcp"],
    }


@app.post("/oauth/register")
async def oauth_register(request: Request):
    """RFC 7591 Dynamic Client Registration - Claude registers itself here."""
    data = await request.json()

    # Generate client credentials
    client_id = secrets.token_urlsafe(16)
    client_secret = secrets.token_urlsafe(32)

    # Store client
    oauth_clients[client_id] = {
        "client_secret": client_secret,
        "redirect_uris": data.get("redirect_uris", []),
        "client_name": data.get("client_name", "Claude"),
        "grant_types": data.get("grant_types", ["authorization_code", "refresh_token"]),
        "response_types": data.get("response_types", ["code"]),
        "token_endpoint_auth_method": data.get("token_endpoint_auth_method", "client_secret_post"),
    }

    return {
        "client_id": client_id,
        "client_secret": client_secret,
        "client_id_issued_at": int(time.time()),
        "client_secret_expires_at": 0,  # Never expires
        "redirect_uris": data.get("redirect_uris", []),
        "client_name": data.get("client_name", "Claude"),
        "token_endpoint_auth_method": "client_secret_post",
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
    }


@app.get("/oauth/authorize")
async def oauth_authorize(
    response_type: str = Query(...),
    client_id: str = Query(...),
    redirect_uri: str = Query(...),
    scope: str = Query(default=""),
    state: str = Query(default=""),
    code_challenge: str = Query(default=""),
    code_challenge_method: str = Query(default=""),
):
    """OAuth authorization endpoint - auto-approves and redirects back."""
    # Generate auth code
    code = secrets.token_urlsafe(32)
    oauth_codes[code] = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "code_challenge": code_challenge,
    }

    # Build redirect URL with code
    params = {"code": code}
    if state:
        params["state"] = state

    redirect_url = f"{redirect_uri}?{urllib.parse.urlencode(params)}"
    return RedirectResponse(url=redirect_url, status_code=302)


@app.post("/oauth/token")
async def oauth_token(request: Request):
    """OAuth token endpoint."""
    # Handle both form and JSON
    content_type = request.headers.get("content-type", "")
    if "application/json" in content_type:
        data = await request.json()
    else:
        form = await request.form()
        data = dict(form)

    grant_type = data.get("grant_type")

    if grant_type == "authorization_code":
        code = data.get("code")
        if code not in oauth_codes:
            return JSONResponse({"error": "invalid_grant"}, status_code=400)

        # Generate tokens
        access_token = secrets.token_urlsafe(32)
        refresh_token = secrets.token_urlsafe(32)

        oauth_tokens[access_token] = True
        del oauth_codes[code]

        return {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": refresh_token,
        }

    elif grant_type == "refresh_token":
        # Always return new tokens
        access_token = secrets.token_urlsafe(32)
        refresh_token = secrets.token_urlsafe(32)
        oauth_tokens[access_token] = True

        return {
            "access_token": access_token,
            "token_type": "Bearer",
            "expires_in": 3600,
            "refresh_token": refresh_token,
        }

    return JSONResponse({"error": "unsupported_grant_type"}, status_code=400)


@app.get("/sse")
async def sse_endpoint(request: Request):
    """SSE endpoint for MCP protocol."""

    async def event_generator():
        # Send initial connection message
        yield {
            "event": "endpoint",
            "data": "/messages"
        }

        # Keep connection alive
        while True:
            if await request.is_disconnected():
                break
            await asyncio.sleep(30)
            yield {
                "event": "ping",
                "data": ""
            }

    return EventSourceResponse(event_generator())


@app.post("/messages")
async def handle_message(request: Request):
    """Handle MCP messages."""
    body = await request.json()

    # Handle batch requests
    if isinstance(body, list):
        responses = []
        for req in body:
            mcp_req = MCPRequest(**req)
            result = handle_mcp_request(mcp_req)
            responses.append({
                "jsonrpc": "2.0",
                "id": mcp_req.id,
                "result": result
            })
        return responses

    # Handle single request
    mcp_req = MCPRequest(**body)
    result = handle_mcp_request(mcp_req)

    return {
        "jsonrpc": "2.0",
        "id": mcp_req.id,
        "result": result
    }


@app.post("/sse")
async def sse_post_endpoint(request: Request):
    """POST endpoint for Streamable HTTP MCP transport."""
    # Read body once
    body_bytes = await request.body()

    # Handle empty body for initialization
    if not body_bytes or body_bytes == b'{}' or body_bytes == b'':
        return {"endpoint": "/sse", "capabilities": {"tools": {}}}

    # Parse MCP message
    try:
        body = json.loads(body_bytes)
    except json.JSONDecodeError:
        return {"endpoint": "/sse"}

    # Handle as MCP message if it has method field
    if body.get("method"):
        # Handle batch requests
        if isinstance(body, list):
            responses = []
            for req in body:
                mcp_req = MCPRequest(**req)
                result = handle_mcp_request(mcp_req)
                responses.append({
                    "jsonrpc": "2.0",
                    "id": mcp_req.id,
                    "result": result
                })
            return responses

        # Handle single request
        mcp_req = MCPRequest(**body)
        result = handle_mcp_request(mcp_req)

        return {
            "jsonrpc": "2.0",
            "id": mcp_req.id,
            "result": result
        }

    return {"endpoint": "/sse"}


# OAuth protected resource metadata (RFC 9470)
@app.get("/.well-known/oauth-protected-resource")
async def oauth_protected_resource():
    """OAuth 2.0 Protected Resource Metadata."""
    return {
        "resource": BASE_URL,
        "authorization_servers": [BASE_URL],
        "scopes_supported": ["mcp"],
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=MCP_PORT)
