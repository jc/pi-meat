package meat

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const maxBridgeResponseBytes = 32 << 20

// BridgeModel delegates model turns to an authenticated HTTP bridge. The pi
// extension uses this adapter so provider-specific requests and credentials stay
// inside the active pi session while the Go process continues to own abridging.
type BridgeModel struct {
	URL   string
	Token string
	HTTPC *http.Client
}

type bridgeBlock struct {
	Type         string          `json:"type"`
	Text         string          `json:"text,omitempty"`
	ID           string          `json:"id,omitempty"`
	ToolName     string          `json:"tool_name,omitempty"`
	ToolInput    json.RawMessage `json:"tool_input,omitempty"`
	ToolUseID    string          `json:"tool_use_id,omitempty"`
	ToolResult   string          `json:"tool_result,omitempty"`
	ToolError    bool            `json:"tool_error,omitempty"`
	Provider     string          `json:"provider,omitempty"`
	ProviderData json.RawMessage `json:"provider_data,omitempty"`
}

type bridgeMessage struct {
	Role    Role          `json:"role"`
	Content []bridgeBlock `json:"content"`
}

type bridgeTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
}

type bridgeRequest struct {
	System   string          `json:"system"`
	Messages []bridgeMessage `json:"messages"`
	Tools    []bridgeTool    `json:"tools"`
}

type bridgeResponse struct {
	Content      []bridgeBlock `json:"content"`
	InputTokens  int           `json:"input_tokens"`
	OutputTokens int           `json:"output_tokens"`
	Error        string        `json:"error,omitempty"`
}

// NewBridgeModel validates and constructs a bridge-backed Model.
func NewBridgeModel(url, token string) (*BridgeModel, error) {
	if strings.TrimSpace(url) == "" {
		return nil, fmt.Errorf("meat: model bridge URL is empty")
	}
	if token == "" {
		return nil, fmt.Errorf("meat: model bridge token is empty")
	}
	return &BridgeModel{URL: url, Token: token}, nil
}

func (m *BridgeModel) Generate(ctx context.Context, system string, messages []Message, tools []Tool) (*Response, error) {
	if m == nil || strings.TrimSpace(m.URL) == "" || m.Token == "" {
		return nil, fmt.Errorf("meat: model bridge is not configured")
	}

	wireMessages := make([]bridgeMessage, len(messages))
	for i, message := range messages {
		wireMessages[i] = bridgeMessage{Role: message.Role, Content: blocksToBridge(message.Content)}
	}
	wireTools := make([]bridgeTool, len(tools))
	for i, tool := range tools {
		wireTools[i] = bridgeTool{
			Name:        tool.Name,
			Description: tool.Description,
			InputSchema: tool.InputSchema,
		}
	}

	body, err := json.Marshal(bridgeRequest{System: system, Messages: wireMessages, Tools: wireTools})
	if err != nil {
		return nil, fmt.Errorf("meat: encode model bridge request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.URL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("meat: create model bridge request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+m.Token)
	req.Header.Set("Content-Type", "application/json")

	client := m.HTTPC
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Minute}
	}
	httpResp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("meat: call model bridge: %w", err)
	}
	defer httpResp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(httpResp.Body, maxBridgeResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("meat: read model bridge response: %w", err)
	}
	if len(raw) > maxBridgeResponseBytes {
		return nil, fmt.Errorf("meat: model bridge response exceeds %d bytes", maxBridgeResponseBytes)
	}

	var decoded bridgeResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, fmt.Errorf("meat: decode model bridge response: %w", err)
	}
	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		detail := strings.TrimSpace(decoded.Error)
		if detail == "" {
			detail = strings.TrimSpace(string(raw))
		}
		if detail == "" {
			detail = httpResp.Status
		}
		return nil, fmt.Errorf("meat: model bridge HTTP %d: %s", httpResp.StatusCode, detail)
	}
	if decoded.Error != "" {
		return nil, fmt.Errorf("meat: model bridge: %s", decoded.Error)
	}

	return &Response{
		Content:      blocksFromBridge(decoded.Content),
		InputTokens:  decoded.InputTokens,
		OutputTokens: decoded.OutputTokens,
	}, nil
}

func blocksToBridge(blocks []Block) []bridgeBlock {
	out := make([]bridgeBlock, len(blocks))
	for i, block := range blocks {
		out[i] = bridgeBlock{
			Type:         block.Type,
			Text:         block.Text,
			ID:           block.ID,
			ToolName:     block.ToolName,
			ToolInput:    block.ToolInput,
			ToolUseID:    block.ToolUseID,
			ToolResult:   block.ToolResult,
			ToolError:    block.ToolError,
			Provider:     block.Provider,
			ProviderData: block.ProviderData,
		}
	}
	return out
}

func blocksFromBridge(blocks []bridgeBlock) []Block {
	out := make([]Block, len(blocks))
	for i, block := range blocks {
		out[i] = Block{
			Type:         block.Type,
			Text:         block.Text,
			ID:           block.ID,
			ToolName:     block.ToolName,
			ToolInput:    block.ToolInput,
			ToolUseID:    block.ToolUseID,
			ToolResult:   block.ToolResult,
			ToolError:    block.ToolError,
			Provider:     block.Provider,
			ProviderData: block.ProviderData,
		}
	}
	return out
}
