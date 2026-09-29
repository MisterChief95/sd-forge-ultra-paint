"""`/ultra_paint/api/styles` -- list and manage Forge's prompt styles.

Reads and writes through Forge's own `shared.prompt_styles` (`StyleDatabase`),
so styles saved here land in the same styles.csv the main Forge UI uses and
show up in its Styles dropdown after a refresh.
"""

from fastapi import HTTPException
from pydantic import BaseModel

from modules import shared
from modules.styles import PromptStyle

__all__ = [
    "STYLES_ROUTE",
    "StyleEntry",
    "delete_style",
    "get_styles",
    "save_style",
]

STYLES_ROUTE = "/ultra_paint/api/styles"


class StyleEntry(BaseModel):
    name: str
    prompt: str = ""
    negative_prompt: str = ""
    # Set when editing so a rename replaces the old entry instead of copying it.
    original_name: str | None = None


def _database():
    database = getattr(shared, "prompt_styles", None)
    if database is None:
        raise HTTPException(
            status_code=503, detail="Forge prompt styles are unavailable."
        )
    return database


def _entries(database) -> list[StyleEntry]:
    return [
        StyleEntry(
            name=style.name,
            prompt=style.prompt or "",
            negative_prompt=style.negative_prompt or "",
        )
        for style in database.styles.values()
        # Forge keeps CSV "divider" rows (path "do_not_save") out of its dropdown.
        if style.path != "do_not_save"
    ]


def get_styles() -> list[StyleEntry]:
    try:
        database = _database()
    except HTTPException:
        return []
    return _entries(database)


def save_style(entry: StyleEntry) -> list[StyleEntry]:
    database = _database()
    name = entry.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Style name is required.")
    previous = database.styles.get(entry.original_name or name)
    path = previous.path if previous and previous.path != "do_not_save" else None
    if entry.original_name and entry.original_name != name:
        database.styles.pop(entry.original_name, None)
    database.styles[name] = PromptStyle(
        name, entry.prompt, entry.negative_prompt, path or str(database.default_path)
    )
    database.save_styles()
    return _entries(database)


def delete_style(name: str) -> list[StyleEntry]:
    database = _database()
    if database.styles.pop(name, None) is None:
        raise HTTPException(status_code=404, detail=f"Style {name!r} was not found.")
    database.save_styles()
    return _entries(database)
