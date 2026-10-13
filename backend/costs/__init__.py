"""Model pricing and token accounting.

Leaf package: it must not import from agent/, fs_logging/, or routes/ so
that any layer (providers, logging, evals) can depend on it without
creating import cycles. Keep this __init__ empty for the same reason.
"""
