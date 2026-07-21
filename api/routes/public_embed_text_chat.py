"""Public, token-gated text-chat endpoints for the embed widget.

These endpoints expose the authenticated text-chat flow publicly via
embed-token + embed-session auth, mirroring the voice embed in
``api.routes.public_embed``. No user auth is required; access is gated by
the embed token's allowed domains and the session token.
"""

from datetime import UTC, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from loguru import logger
from pydantic import BaseModel, Field

from api.db import db_client
from api.enums import WorkflowRunMode
from api.routes.public_embed import (
    _allow_embed_origin,
    _cors_response,
    _text_chat_preflight_response,
    generate_session_token,
    get_request_origin,
    validate_origin,
)
from api.services.workflow.run_creation import prepare_workflow_run_inputs
from api.services.workflow.text_chat_session_service import (
    TextChatPendingTurnLostError,
    TextChatSessionExecutionError,
    TextChatSessionRevisionConflictError,
    append_text_chat_user_message,
    default_text_chat_checkpoint,
    default_text_chat_session_data,
    execute_pending_text_chat_turn,
    initialize_text_chat_session,
    normalize_text_chat_session_data,
)
from pipecat.utils.run_context import set_current_run_id

router = APIRouter(prefix="/public/embed/text-chat", tags=["public-embed-text-chat"])


class InitPublicTextChatRequest(BaseModel):
    """Request model for initializing a public text-chat embed session."""

    token: str
    context_variables: Optional[dict] = None


class PublicTextChatInitResponse(BaseModel):
    """Response model for public text-chat initialization."""

    session_token: str
    workflow_run_id: int
    revision: int
    status: str
    turns: list


class PublicTextChatStateResponse(BaseModel):
    """Response model for public text-chat state."""

    workflow_run_id: int
    revision: int
    status: str
    turns: list


class AppendPublicTextChatMessageRequest(BaseModel):
    """Request model for appending a user message to a public text-chat session."""

    text: str = Field(min_length=1)
    expected_revision: Optional[int] = None


def _revision_conflict_detail(e: object) -> dict:
    return {
        "message": "Text chat session revision conflict",
        "expected_revision": getattr(e, "expected_revision", None),
        "actual_revision": getattr(e, "actual_revision", None),
    }


def _state_response(
    workflow_run_id: int, text_session
) -> PublicTextChatStateResponse:
    normalized = normalize_text_chat_session_data(text_session.session_data)
    return PublicTextChatStateResponse(
        workflow_run_id=workflow_run_id,
        revision=text_session.revision,
        status=normalized["status"],
        turns=normalized["turns"],
    )


async def _resolve_text_chat_session_or_403(
    session_token: str, origin: str, response: Response
):
    """Resolve and validate an embed session for text-chat access.

    Returns ``(embed_session, embed_token)``. Raises HTTPException on failure.
    """
    embed_session = await db_client.get_embed_session_by_token(session_token)
    if not embed_session:
        raise HTTPException(status_code=404, detail="Invalid session token")

    if embed_session.expires_at and embed_session.expires_at < datetime.now(UTC):
        raise HTTPException(status_code=403, detail="Session expired")

    embed_token = await db_client.get_embed_token_by_id(embed_session.embed_token_id)
    if not embed_token:
        raise HTTPException(status_code=404, detail="Invalid embed token")

    if not validate_origin(origin, embed_token.allowed_domains or []):
        logger.warning(
            f"Domain validation failed for text chat: {origin} not in "
            f"{embed_token.allowed_domains}"
        )
        raise HTTPException(status_code=403, detail=f"Domain not allowed: {origin}")

    if origin:
        _allow_embed_origin(response, origin)

    return embed_session, embed_token


async def _load_text_chat_session_or_error(
    embed_session, embed_token
):
    """Load the text-chat session for the embed session and validate its mode."""
    set_current_run_id(embed_session.workflow_run_id)
    text_session = await db_client.get_workflow_run_text_session(
        embed_session.workflow_run_id, organization_id=embed_token.organization_id
    )
    if not text_session or not text_session.workflow_run:
        raise HTTPException(status_code=404, detail="Text chat session not found")
    if text_session.workflow_run.mode != WorkflowRunMode.TEXTCHAT.value:
        raise HTTPException(
            status_code=400, detail="Workflow run is not a text chat session"
        )
    return text_session


@router.post("/init", response_model=PublicTextChatInitResponse)
async def init_public_text_chat(
    request: Request, init_request: InitPublicTextChatRequest, response: Response
):
    """Initialize a public text-chat embed session.

    Validates the embed token and origin, creates a TEXTCHAT workflow run,
    issues a session token, and executes the initial pending assistant turn.
    """
    origin = get_request_origin(request)

    embed_token = await db_client.get_embed_token_by_token(init_request.token)
    if not embed_token:
        raise HTTPException(status_code=404, detail="Invalid embed token")

    if not embed_token.is_active:
        raise HTTPException(status_code=403, detail="Embed token is inactive")

    if embed_token.expires_at and embed_token.expires_at < datetime.now(UTC):
        raise HTTPException(status_code=403, detail="Embed token has expired")

    if embed_token.usage_limit and embed_token.usage_count >= embed_token.usage_limit:
        raise HTTPException(status_code=403, detail="Embed token usage limit exceeded")

    if not validate_origin(origin, embed_token.allowed_domains or []):
        logger.warning(
            f"Domain validation failed: {origin} not in {embed_token.allowed_domains}"
        )
        raise HTTPException(status_code=403, detail=f"Domain not allowed: {origin}")

    if origin:
        _allow_embed_origin(response, origin)

    try:
        workflow = await db_client.get_workflow(
            embed_token.workflow_id, organization_id=embed_token.organization_id
        )
        if not workflow:
            raise ValueError("Workflow not found")
        run_inputs = await prepare_workflow_run_inputs(db_client, workflow)
        workflow_run = await db_client.create_workflow_run(
            name=f"Embed Text Chat - {datetime.now(UTC).isoformat()}",
            workflow_id=embed_token.workflow_id,
            mode=WorkflowRunMode.TEXTCHAT.value,
            user_id=embed_token.created_by,
            organization_id=embed_token.organization_id,
            initial_context={
                **(init_request.context_variables or {}),
                "provider": WorkflowRunMode.TEXTCHAT.value,
            },
            definition_id=run_inputs.definition_id,
        )
    except Exception as e:
        logger.error(f"Failed to create workflow run: {e}")
        raise HTTPException(status_code=500, detail="Failed to create workflow run")

    session_token = generate_session_token()

    try:
        await db_client.create_embed_session(
            session_token=session_token,
            embed_token_id=embed_token.id,
            workflow_run_id=workflow_run.id,
            client_ip=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent", "")[:500],
            origin=origin[:255],
            expires_at=datetime.now(UTC) + timedelta(hours=1),
        )
    except Exception as e:
        logger.error(f"Failed to create embed session: {e}")
        raise HTTPException(status_code=500, detail="Failed to create session")

    await db_client.increment_embed_token_usage(embed_token.id)

    set_current_run_id(workflow_run.id)

    text_session = await db_client.ensure_workflow_run_text_session(
        workflow_run.id,
        session_data=default_text_chat_session_data(),
        checkpoint=default_text_chat_checkpoint(),
    )

    try:
        text_session = await initialize_text_chat_session(
            run_id=workflow_run.id, text_session=text_session
        )
    except TextChatSessionRevisionConflictError as e:
        raise HTTPException(status_code=409, detail=_revision_conflict_detail(e))

    try:
        text_session = await execute_pending_text_chat_turn(
            workflow_id=embed_token.workflow_id,
            run_id=workflow_run.id,
            text_session=text_session,
        )
    except TextChatSessionRevisionConflictError as e:
        raise HTTPException(status_code=409, detail=_revision_conflict_detail(e))
    except TextChatSessionExecutionError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except TextChatPendingTurnLostError as e:
        raise HTTPException(status_code=500, detail=str(e))

    normalized = normalize_text_chat_session_data(text_session.session_data)
    return PublicTextChatInitResponse(
        session_token=session_token,
        workflow_run_id=workflow_run.id,
        revision=text_session.revision,
        status=normalized["status"],
        turns=normalized["turns"],
    )


@router.options("/init")
async def options_init(request: Request):
    """Fallback OPTIONS handler for the public text-chat init endpoint.

    Browser preflights are handled by PublicEmbedCORSMiddleware before global
    CORS. OPTIONS has no body, so we stay permissive here; the POST validates.
    """
    origin = request.headers.get("origin", "*")
    return _cors_response(origin, "POST, OPTIONS")


@router.get("/{session_token}", response_model=PublicTextChatStateResponse)
async def get_public_text_chat_state(
    session_token: str, request: Request, response: Response
):
    """Return the current state of a public text-chat embed session."""
    origin = get_request_origin(request)
    embed_session, embed_token = await _resolve_text_chat_session_or_403(
        session_token, origin, response
    )
    text_session = await _load_text_chat_session_or_error(embed_session, embed_token)
    return _state_response(embed_session.workflow_run_id, text_session)


@router.options("/{session_token}")
async def options_state(session_token: str, request: Request):
    """Fallback OPTIONS handler for the public text-chat state endpoint."""
    return await _text_chat_preflight_response(
        session_token, request.headers.get("origin", "")
    )


@router.post(
    "/{session_token}/messages", response_model=PublicTextChatStateResponse
)
async def append_public_text_chat_message(
    session_token: str,
    request: Request,
    message_request: AppendPublicTextChatMessageRequest,
    response: Response,
):
    """Append a user message to a public text-chat session and run the turn."""
    origin = get_request_origin(request)
    embed_session, embed_token = await _resolve_text_chat_session_or_403(
        session_token, origin, response
    )
    text_session = await _load_text_chat_session_or_error(embed_session, embed_token)

    try:
        text_session = await append_text_chat_user_message(
            run_id=embed_session.workflow_run_id,
            text_session=text_session,
            user_text=message_request.text,
            expected_revision=message_request.expected_revision,
        )
    except TextChatSessionRevisionConflictError as e:
        raise HTTPException(status_code=409, detail=_revision_conflict_detail(e))

    try:
        text_session = await execute_pending_text_chat_turn(
            workflow_id=embed_token.workflow_id,
            run_id=embed_session.workflow_run_id,
            text_session=text_session,
        )
    except TextChatSessionRevisionConflictError as e:
        raise HTTPException(status_code=409, detail=_revision_conflict_detail(e))
    except TextChatSessionExecutionError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except TextChatPendingTurnLostError as e:
        raise HTTPException(status_code=500, detail=str(e))

    return _state_response(embed_session.workflow_run_id, text_session)


@router.options("/{session_token}/messages")
async def options_messages(session_token: str, request: Request):
    """Fallback OPTIONS handler for the public text-chat messages endpoint."""
    return await _text_chat_preflight_response(
        session_token, request.headers.get("origin", "")
    )
