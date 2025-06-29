from fastapi import APIRouter, HTTPException, Depends
from typing import List, Optional
from app.models.schemas import User, UserCreate, UserUpdate

# Create router
router = APIRouter()

# Mock database - in a production app, this would be a real database
users_db = {}


@router.post("/", response_model=User)
async def create_user(user: UserCreate):
    """Create a new user."""
    if user.id in users_db:
        raise HTTPException(status_code=400, detail="User already registered")
    
    new_user = User(
        id=user.id,
        name=user.name,
        preferred_language=user.preferred_language,
    )
    users_db[user.id] = new_user
    return new_user


@router.get("/{user_id}", response_model=User)
async def get_user(user_id: str):
    """Get a user by ID."""
    if user_id not in users_db:
        raise HTTPException(status_code=404, detail="User not found")
    
    return users_db[user_id]


@router.put("/{user_id}", response_model=User)
async def update_user(user_id: str, user: UserUpdate):
    """Update a user."""
    if user_id not in users_db:
        raise HTTPException(status_code=404, detail="User not found")
    
    stored_user = users_db[user_id]
    update_data = user.dict(exclude_unset=True)
    
    for key, value in update_data.items():
        setattr(stored_user, key, value)
    
    users_db[user_id] = stored_user
    return stored_user
