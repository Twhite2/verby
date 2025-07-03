import asyncio
from typing import Optional
import httpx
import logging
from app.config import settings

# Set up logging
logger = logging.getLogger(__name__)

# Flag to track if translation is available
ARGOS_AVAILABLE = False

# Try to import optional dependencies
try:
    import argostranslate.package
    import argostranslate.translate
    
    # Check if we can initialize Argos Translate
    try:
        argostranslate.package.update_package_index()
        available_packages = argostranslate.package.get_available_packages()
        ARGOS_AVAILABLE = True
        
        # Try to install language packages if needed but don't block startup
        try:
            for from_lang, from_name in settings.AVAILABLE_LANGUAGES.items():
                for to_lang, to_name in settings.AVAILABLE_LANGUAGES.items():
                    if from_lang != to_lang:
                        package = next(
                            (p for p in available_packages if p.from_code == from_lang and p.to_code == to_lang),
                            None
                        )
                        # Skip the is_installed check that's causing problems
                        if package:
                            try:
                                print(f"Installing translation package: {from_lang} -> {to_lang}")
                                argostranslate.package.install_from_path(package.download())
                            except Exception as e:
                                print(f"Error installing translation package {from_lang}->{to_lang}: {e}")
        except Exception as e:
            logger.warning(f"Error setting up translation packages: {e}")
            # We still mark Argos as available if the imports worked
    except Exception as e:
        logger.warning(f"Error initializing argostranslate: {e}")
        ARGOS_AVAILABLE = False
except ImportError as e:
    logger.warning(f"argostranslate not available: {e}")
    ARGOS_AVAILABLE = False


async def translate_text(text: str, source_lang: str, target_lang: str) -> str:
    """
    Translate text from source language to target language.
    
    Args:
        text: Text to translate
        source_lang: Source language ISO code
        target_lang: Target language ISO code
        
    Returns:
        Translated text
    """
    if source_lang == target_lang:
        return text
    
    # Run the potentially CPU-intensive translation in a thread pool
    return await asyncio.to_thread(_translate_text_sync, text, source_lang, target_lang)


def _translate_text_sync(text: str, source_lang: str, target_lang: str) -> str:
    """Synchronous implementation of text translation."""
    # Try Argos Translate first if available
    if ARGOS_AVAILABLE:
        try:
            installed_languages = argostranslate.translate.get_installed_languages()
            from_lang = next((l for l in installed_languages if l.code == source_lang), None)
            to_lang = next((l for l in installed_languages if l.code == target_lang), None)
            
            if from_lang and to_lang:
                translation = from_lang.get_translation(to_lang)
                return translation.translate(text)
        except Exception as e:
            print(f"Argos Translate error: {e}")
    
    # Fall back to external API
    try:
        # Using LibreTranslate API as a fallback (no API key required for some instances)
        with httpx.Client(timeout=10.0) as client:
            response = client.post(
                "https://libretranslate.com/translate",
                json={
                    "q": text,
                    "source": source_lang,
                    "target": target_lang,
                    "format": "text",
                    "api_key": ""  # Some instances allow empty API key
                }
            )
            if response.status_code == 200:
                result = response.json()
                return result.get("translatedText", text)
    except Exception as e:
        print(f"Translation API error: {e}")
    
    # If all else fails, return the original text
    return text
