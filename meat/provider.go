package meat

import (
	"context"
	"os"
	"strings"
)

// DefaultModel is meat's built-in default model.
const DefaultModel = DefaultOpenAIModel

// ResolveModel applies the CLI model fallback chain: the explicit value, then
// $MEAT_MODEL, then DefaultModel. It performs no network or credential work, so
// callers can resolve the cache identity cheaply and offline.
func ResolveModel(model string) string {
	return resolveModel(model, DefaultModel)
}

func resolveModel(model, fallback string) string {
	if model == "" {
		model = os.Getenv("MEAT_MODEL")
	}
	if model == "" {
		model = fallback
	}
	return model
}

// NewModelFromEnv constructs the configured backend. A pi session bridge takes
// precedence so extension runs use pi's active model and resolved authentication;
// standalone CLI runs continue to select the built-in provider from the model id.
func NewModelFromEnv(ctx context.Context, model string) (Model, error) {
	if bridgeURL := os.Getenv("PI_MEAT_MODEL_BRIDGE_URL"); bridgeURL != "" {
		return NewBridgeModel(bridgeURL, os.Getenv("PI_MEAT_MODEL_BRIDGE_TOKEN"))
	}
	model = ResolveModel(model)
	if isAnthropicModel(model) {
		return NewAnthropicFromEnv(ctx, model)
	}
	return NewOpenAIFromEnv(ctx, model)
}

func isAnthropicModel(model string) bool {
	model = strings.TrimPrefix(model, "anthropic/")
	return strings.HasPrefix(model, "claude-")
}
