from agent.providers.gemini import (
    _get_gemini_api_model_name,
    _get_thinking_level_for_model,
)
from llm import GEMINI_MODELS, Llm


def test_gemini_3_6_flash_thinking_variants_map_to_same_api_model() -> None:
    expected_levels = {
        Llm.GEMINI_3_6_FLASH_MINIMAL: "minimal",
        Llm.GEMINI_3_6_FLASH_LOW: "low",
        Llm.GEMINI_3_6_FLASH_MEDIUM: "medium",
        Llm.GEMINI_3_6_FLASH_HIGH: "high",
    }

    for model, thinking_level in expected_levels.items():
        assert model in GEMINI_MODELS
        assert _get_gemini_api_model_name(model) == "gemini-3.6-flash"
        assert _get_thinking_level_for_model(model) == thinking_level
