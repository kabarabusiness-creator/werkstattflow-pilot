"""
Authentifizierung: Passwort- & PIN-Hashing (bcrypt) und JWT-Tokens.
"""
import os
import datetime
import bcrypt
import secrets
import warnings
from jose import jwt, JWTError
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

_DEV_DEFAULT_SECRET = "dev-only-secret-bitte-in-produktion-aendern"
SECRET_KEY = os.environ.get("WERKSTATTFLOW_SECRET_KEY", _DEV_DEFAULT_SECRET)
if SECRET_KEY == _DEV_DEFAULT_SECRET:
    warnings.warn(
        "\n\n*** WARNUNG: WERKSTATTFLOW_SECRET_KEY ist nicht gesetzt - es wird der unsichere "
        "Entwickler-Standardwert verwendet! ***\n"
        "Für echten Betrieb (Pilot, Produktion) unbedingt vorher setzen, z.B.:\n"
        f"  export WERKSTATTFLOW_SECRET_KEY={secrets.token_hex(32)}\n"
        "Sonst können Angreifer gültige Login-Tokens selbst erzeugen.\n",
        stacklevel=1,
    )
ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = 12

security = HTTPBearer()


def hash_secret(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_secret(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


def create_token(user_id: str, role: str) -> str:
    expire = datetime.datetime.utcnow() + datetime.timedelta(hours=TOKEN_EXPIRE_HOURS)
    payload = {"sub": user_id, "role": role, "exp": expire}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Ungültiger oder abgelaufener Token")


def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    payload = decode_token(credentials.credentials)
    return {"id": payload["sub"], "role": payload["role"]}


def require_role(*allowed_roles: str):
    def checker(user: dict = Depends(get_current_user)) -> dict:
        if user["role"] not in allowed_roles:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Keine Berechtigung für diese Aktion")
        return user
    return checker
