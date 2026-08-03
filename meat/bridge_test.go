package meat

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBridgeModelGenerate(t *testing.T) {
	const token = "test-secret"
	var got bridgeRequest
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer "+token {
			t.Errorf("Authorization = %q", auth)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(bridgeResponse{
			Content: []bridgeBlock{
				{Type: "text", Text: "working"},
				{Type: "tool_use", ID: "call-1", ToolName: "submit", ToolInput: json.RawMessage(`{"summary":"done"}`)},
				{Type: "provider_state", Provider: "pi", ProviderData: json.RawMessage(`{"role":"assistant"}`)},
			},
			InputTokens:  123,
			OutputTokens: 45,
		})
	}))
	defer server.Close()

	model, err := NewBridgeModel(server.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	response, err := model.Generate(context.Background(), "system", []Message{
		{Role: RoleUser, Content: []Block{{Type: "text", Text: "hello"}}},
		{Role: RoleAssistant, Content: []Block{{Type: "tool_use", ID: "old", ToolName: "preview", ToolInput: json.RawMessage(`{"x":1}`)}}},
		{Role: RoleUser, Content: []Block{{Type: "tool_result", ToolUseID: "old", ToolResult: "ok", ToolError: true}}},
	}, []Tool{{Name: "submit", Description: "Submit", InputSchema: json.RawMessage(`{"type":"object"}`)}})
	if err != nil {
		t.Fatal(err)
	}

	if got.System != "system" || len(got.Messages) != 3 || len(got.Tools) != 1 {
		t.Fatalf("unexpected request: %#v", got)
	}
	if block := got.Messages[2].Content[0]; block.ToolUseID != "old" || block.ToolResult != "ok" || !block.ToolError {
		t.Fatalf("tool result block = %#v", block)
	}
	if got.Tools[0].Name != "submit" || string(got.Tools[0].InputSchema) != `{"type":"object"}` {
		t.Fatalf("tool = %#v", got.Tools[0])
	}
	if response.InputTokens != 123 || response.OutputTokens != 45 || len(response.Content) != 3 {
		t.Fatalf("response = %#v", response)
	}
	if call := response.Content[1]; call.Type != "tool_use" || call.ID != "call-1" || call.ToolName != "submit" {
		t.Fatalf("tool call = %#v", call)
	}
	if state := response.Content[2]; state.Provider != "pi" || string(state.ProviderData) != `{"role":"assistant"}` {
		t.Fatalf("provider state = %#v", state)
	}
}

func TestBridgeModelErrors(t *testing.T) {
	t.Run("configuration", func(t *testing.T) {
		if _, err := NewBridgeModel("", "token"); err == nil {
			t.Fatal("expected empty URL error")
		}
		if _, err := NewBridgeModel("http://127.0.0.1", ""); err == nil {
			t.Fatal("expected empty token error")
		}
	})

	t.Run("http", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(bridgeResponse{Error: "provider unavailable"})
		}))
		defer server.Close()
		model, _ := NewBridgeModel(server.URL, "token")
		_, err := model.Generate(context.Background(), "", nil, nil)
		if err == nil || !strings.Contains(err.Error(), "provider unavailable") {
			t.Fatalf("error = %v", err)
		}
	})

	t.Run("invalid json", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Write([]byte("not json"))
		}))
		defer server.Close()
		model, _ := NewBridgeModel(server.URL, "token")
		_, err := model.Generate(context.Background(), "", nil, nil)
		if err == nil || !strings.Contains(err.Error(), "decode model bridge response") {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestNewModelFromEnvPrefersBridge(t *testing.T) {
	t.Setenv("PI_MEAT_MODEL_BRIDGE_URL", "http://127.0.0.1:1234/generate")
	t.Setenv("PI_MEAT_MODEL_BRIDGE_TOKEN", "token")
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "")

	model, err := NewModelFromEnv(context.Background(), "claude-opus-4-8")
	if err != nil {
		t.Fatal(err)
	}
	bridge, ok := model.(*BridgeModel)
	if !ok {
		t.Fatalf("model = %T, want *BridgeModel", model)
	}
	if bridge.URL != "http://127.0.0.1:1234/generate" || bridge.Token != "token" {
		t.Fatalf("bridge = %#v", bridge)
	}
}
