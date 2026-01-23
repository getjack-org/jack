# ChatGPT App Template - AI Agent Guide

This document provides context for AI agents working with this ChatGPT MCP server project.

## Important: Use Jack, Not Wrangler

**Always use `jack` commands instead of `wrangler` directly.**

```bash
# Deploy
jack deploy

# View logs
jack logs

# Check status
jack status
```

Jack handles authentication, managed mode, and project configuration automatically.

## Project Structure

```
├── src/
│   ├── worker.ts             # MCP server entry point (Hono + Workers)
│   ├── mcp/                  # MCP protocol implementation
│   │   ├── handler.ts        # JSON-RPC 2.0 handler
│   │   └── tools.ts          # Tool definitions with widget output
│   ├── lib/
│   │   └── widget-server.ts  # Widget serving utility
│   ├── widgets/              # React widgets rendered in ChatGPT
│   │   ├── greeting/         # Greeting widget
│   │   │   ├── index.html
│   │   │   ├── main.tsx
│   │   │   └── GreetingWidget.tsx
│   │   └── chart/            # Chart widget
│   │       ├── index.html
│   │       ├── main.tsx
│   │       └── ChartWidget.tsx
│   ├── styles/
│   │   └── widget.css        # Shared Tailwind styles
│   ├── styles/
│   │   └── widget.css        # Shared Tailwind styles
│   └── types/
│       └── openai.d.ts       # TypeScript definitions for window.openai
├── wrangler.jsonc            # Cloudflare Workers config
├── vite.config.ts            # Vite build config for widgets (auto-discovers widgets)
└── package.json
```

## Adding New Tools

Tools are MCP functions that ChatGPT can call. Edit `src/mcp/tools.ts`:

1. Add tool definition to the `tools` array:

```typescript
{
  name: "my_tool",
  description: "Description shown to ChatGPT",
  inputSchema: {
    type: "object",
    properties: {
      param1: { type: "string", description: "Parameter description" },
    },
    required: ["param1"],
  },
},
```

2. Add case to `executeTool` function:

```typescript
case "my_tool": {
  const param1 = args.param1 as string;
  return {
    content: [{ type: "text", text: `Result: ${param1}` }],
    _meta: {
      "openai/outputTemplate": {
        url: `${baseUrl}/widgets/mywidget`,
        params: { param1 },
      },
    },
  };
}
```

## Adding New Widgets

Widgets are React components that ChatGPT renders inline. Create a new directory in `src/widgets/`:

### 1. Create the widget directory

```bash
mkdir -p src/widgets/mywidget
```

### 2. Create index.html

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My Widget</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

### 3. Create main.tsx

```tsx
import { createRoot } from "react-dom/client";
import { MyWidget } from "./MyWidget";
import "../../styles/widget.css";

const container = document.getElementById("root");
if (container) {
  const root = createRoot(container);
  root.render(<MyWidget />);
}
```

### 4. Create MyWidget.tsx

```tsx
import { useState, useEffect } from "react";

export function MyWidget() {
  // Parse URL params for widget configuration
  const params = new URLSearchParams(window.location.search);
  const myParam = params.get("myParam") || "default";

  return (
    <div className="p-4">
      <h1>My Widget</h1>
      <p>Parameter: {myParam}</p>
    </div>
  );
}
```

### 5. Build and test

Widgets are auto-discovered by Vite. Just run:

```bash
bun run build:widgets
```

Any directory in `src/widgets/` with an `index.html` file will be automatically included.

## Widget Communication with ChatGPT

Widgets can communicate with ChatGPT via `window.openai`:

### Send a message to ChatGPT

```typescript
window.openai?.sendMessage("User clicked the button!");
```

### Receive messages from ChatGPT

```typescript
useEffect(() => {
  window.openai?.onMessage((message) => {
    console.log("ChatGPT said:", message);
  });
}, []);
```

### Call a tool from the widget

```typescript
const result = await window.openai?.callTool("greet", {
  name: "Alice",
  style: "fun",
});
```

### Access theme and display mode

```typescript
const theme = window.openai?.theme; // "light" | "dark"
const mode = window.openai?.displayMode; // "inline" | "popup" | "fullscreen"
```

### Persist widget state

```typescript
// Save state
window.openai?.setWidgetState({ count: 5 });

// Read state
const state = window.openai?.widgetState;
```

## Build Process

The project uses Vite to build widgets and esbuild for the worker:

```bash
# Development (runs worker + widget dev servers)
bun run dev

# Build everything
bun run build

# Build only widgets
bun run build:widgets

# Build only worker
bun run build:worker
```

## Environment Variables

Set secrets using jack:

```bash
jack secret set MY_SECRET
```

Access in your worker:

```typescript
export default {
  async fetch(request: Request, env: Env) {
    const secret = env.MY_SECRET;
  },
};
```

## Testing Locally

```bash
# Start dev server
bun run dev

# The MCP server runs at http://localhost:8787
# Widgets are served from the worker
```

## Deployment

```bash
# Deploy to production
jack deploy

# View deployment status
jack status

# Stream logs
jack logs
```
