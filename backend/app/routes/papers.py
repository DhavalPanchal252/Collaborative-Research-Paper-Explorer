from fastapi import APIRouter, Request
from jose import jwt
from app.services.supabase_client import supabase

router = APIRouter(prefix="/api/v1", tags=["Papers"])


@router.get("/my-papers")
async def get_my_papers(request: Request):
    user_id = "anonymous"

    try:
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            token = auth_header.split(" ")[1]

            decoded = jwt.decode(
                token,
                key="",
                options={"verify_signature": False, "verify_aud": False}
            )
            user_id = decoded.get("sub", "anonymous")

    except Exception as e:
        print("JWT error:", e)

    try:
        response = supabase.table("papers")\
            .select("*")\
            .eq("user_id", user_id)\
            .execute()

        return response.data

    except Exception as e:
        return {"error": str(e)}